import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { uploadToConsentUrl as uploadConsentFile } from "./file-consent.js";
import { resolveMSTeamsSharePointUploadTimeoutMs } from "./request-timeout.js";
import { buildUserAgent } from "./user-agent.js";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  lookupMock.mockReset();
});

const publicResolve = async () => ({ address: "13.107.136.10" });
const privateResolve = (ip: string) => async () => ({ address: ip });
const multiResolve = (ips: string[]) => async () => ips.map((address) => ({ address }));
const failingResolve = async () => {
  throw new Error("DNS failure");
};

type ConsentValidationOptions = {
  resolveFn?: (hostname: string) => Promise<{ address: string } | { address: string }[]>;
};

function uploadToConsentUrl({
  url = "https://contoso.sharepoint.com/upload",
  buffer = Buffer.from("test"),
  fetchFn = async () => new Response(null, { status: 200 }),
  validationOpts,
  ...params
}: Partial<Parameters<typeof uploadConsentFile>[0]> & {
  fetchFn?: typeof fetch;
  validationOpts?: ConsentValidationOptions;
}) {
  vi.stubGlobal("fetch", fetchFn);
  lookupMock.mockImplementation(async (hostname: string) => {
    const result = await (validationOpts?.resolveFn ?? publicResolve)(hostname);
    return Array.isArray(result) ? result : [result];
  });
  return uploadConsentFile({ url, buffer, ...params });
}

const responseWithCancel = (status: number, statusText?: string) => {
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({ cancel });
  return { response: new Response(body, { status, statusText }), cancel };
};

function timedFetch(completionMs?: number) {
  let signal: AbortSignal | undefined;
  const fetchFn = vi.fn<typeof fetch>(
    (_url, init) =>
      new Promise<Response>((resolve, reject) => {
        signal = init?.signal ?? undefined;
        signal?.addEventListener("abort", () => reject(signal?.reason), { once: true });
        if (completionMs !== undefined) {
          setTimeout(() => resolve(new Response(null, { status: 200 })), completionMs);
        }
      }),
  );
  return {
    fetchFn,
    get aborted() {
      return signal?.aborted;
    },
  };
}

describe("validateConsentUploadUrl", () => {
  const dnsUrl = "https://evil.sharepoint.com/path";
  it.each([
    ["invalid URLs", "not a url", publicResolve, "not a valid URL"],
    ["IPv6 loopback", dnsUrl, privateResolve("::1"), "private/reserved IP"],
    [
      "mixed DNS answers",
      dnsUrl,
      multiResolve(["13.107.136.10", "10.0.0.1"]),
      "private/reserved IP",
    ],
    ["DNS failures", dnsUrl, failingResolve, "Failed to resolve"],
    [
      "suffix tricks",
      "https://notsharepoint.com/file",
      publicResolve,
      "not in the allowed domains",
    ],
  ] as const)("rejects %s", async (_name, url, resolveFn, error) => {
    await expect(uploadToConsentUrl({ url, validationOpts: { resolveFn } })).rejects.toThrow(error);
  });
});

describe("uploadToConsentUrl", () => {
  it("aborts consent uploads that do not finish before the request timeout", async () => {
    vi.useFakeTimers();
    const request = timedFetch();

    const uploadPromise = uploadToConsentUrl({
      buffer: Buffer.from("hello"),
      fetchFn: request.fetchFn,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(request.fetchFn).toHaveBeenCalledOnce();
    expect(request.aborted).toBe(false);
    const uploadRejection = expect(uploadPromise).rejects.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });

    await vi.advanceTimersByTimeAsync(resolveMSTeamsSharePointUploadTimeoutMs(5));
    await uploadRejection;
    expect(request.aborted).toBe(true);
  });

  it("allows size-budgeted consent uploads that complete after the base upload deadline", async () => {
    vi.useFakeTimers();
    const buffer = Buffer.alloc(512 * 1024);
    const resolvedTimeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(buffer.length);
    const baseTimeoutMs = resolveMSTeamsSharePointUploadTimeoutMs(0);
    const completionMs = baseTimeoutMs + 1_000;
    const request = timedFetch(completionMs);

    expect(completionMs).toBeGreaterThan(baseTimeoutMs);
    expect(completionMs).toBeLessThan(resolvedTimeoutMs);

    const uploadPromise = uploadToConsentUrl({
      buffer,
      fetchFn: request.fetchFn,
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(request.fetchFn).toHaveBeenCalledOnce();
    expect(request.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(completionMs);
    await expect(uploadPromise).resolves.toBeUndefined();
    expect(request.aborted).toBe(false);
  });

  it("allows upload to a valid SharePoint URL and performs PUT", async () => {
    const { response, cancel } = responseWithCancel(200);
    const backing = Buffer.from([0xfe, 0xfd, 1, 2, 3, 0xfc]);
    const buffer = backing.subarray(2, 5);
    const expectedBytes = Buffer.from([0, 0x80, 0xff]);
    let finishResolution: () => void = () => {};
    const resolutionReady = new Promise<void>((resolve) => {
      finishResolution = resolve;
    });
    const resolveFn = vi.fn(async () => {
      await resolutionReady;
      return { address: "13.107.136.10" };
    });
    const mockFetch = vi.fn<typeof fetch>(async (_url, init) => {
      backing.fill(0);
      expect(Buffer.from(await new Response(init?.body).arrayBuffer())).toEqual(expectedBytes);
      return response;
    });

    const upload = uploadToConsentUrl({
      url: "https://contoso.sharepoint.com/sites/uploads/file.pdf",
      buffer,
      contentType: "application/pdf",
      fetchFn: mockFetch,
      validationOpts: { resolveFn },
    });
    await vi.waitFor(() => expect(resolveFn).toHaveBeenCalledOnce());
    expect(mockFetch).not.toHaveBeenCalled();
    expectedBytes.copy(buffer);
    finishResolution();
    await expect(upload).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = expectDefined(mockFetch.mock.calls[0], "fetch call");
    expect(url).toBe("https://contoso.sharepoint.com/sites/uploads/file.pdf");
    expect(opts?.method).toBe("PUT");
    expect(opts?.headers).toEqual({
      "User-Agent": buildUserAgent(),
      "Content-Type": "application/pdf",
      "Content-Range": "bytes 0-2/3",
    });
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(opts?.signal?.aborted).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("throws on non-OK response after passing validation", async () => {
    const { response, cancel } = responseWithCancel(403, "Forbidden");
    const mockFetch = vi.fn<typeof fetch>(async () => response);

    await expect(
      uploadToConsentUrl({
        fetchFn: mockFetch,
      }),
    ).rejects.toThrow("File upload to consent URL failed: 403 Forbidden");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("blocks HTTP (non-HTTPS) upload before fetch is called", async () => {
    const mockFetch = vi.fn();
    await expect(
      uploadToConsentUrl({
        url: "http://contoso.sharepoint.com/upload",
        fetchFn: mockFetch,
      }),
    ).rejects.toThrow("must use HTTPS");

    expect(mockFetch).not.toHaveBeenCalled();
  });
});
