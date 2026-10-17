// Googlechat tests cover google auth plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getGoogleAuthTransport,
  resolveValidatedGoogleChatCredentials,
} from "./google-auth.runtime.js";

const mocks = vi.hoisted(() => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist: vi.fn((hosts: string[]) => ({
    hostnameAllowlist: hosts,
  })),
  fetchWithSsrFGuard: vi.fn(),
  gaxiosCtor: vi.fn(function MockGaxios(
    this: {
      defaults: Record<string, unknown>;
      interceptors: {
        request: { add: ReturnType<typeof vi.fn> };
        response: { add: ReturnType<typeof vi.fn> };
      };
    },
    defaults,
  ) {
    this.defaults = defaults as Record<string, unknown>;
    this.interceptors = {
      request: { add: vi.fn() },
      response: { add: vi.fn() },
    };
  }),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  buildHostnameAllowlistPolicyFromSuffixAllowlist:
    mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist,
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuard,
}));

vi.mock("google-auth-library", () => ({
  gaxios: { Gaxios: mocks.gaxiosCtor },
}));

beforeEach(() => {
  mocks.buildHostnameAllowlistPolicyFromSuffixAllowlist.mockClear();
  mocks.fetchWithSsrFGuard.mockReset();
  mocks.gaxiosCtor.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.doUnmock("google-auth-library");
  vi.resetModules();
});

function mockCallArg(mock: ReturnType<typeof vi.fn>, callIndex = 0, argIndex = 0): unknown {
  const call = mock.mock.calls[callIndex];
  if (!call) {
    throw new Error(`Expected mock call ${callIndex}`);
  }
  return call[argIndex];
}

function stubIsolatedProcessEnv(patch: NodeJS.ProcessEnv): void {
  const isolatedProcess = Object.create(process) as NodeJS.Process;
  Object.defineProperty(isolatedProcess, "env", {
    configurable: true,
    value: { ...process.env, ...patch },
  });
  // Test files share the host process environment. Replace only this file's
  // global view so proxy-policy coverage cannot redirect sibling transports.
  vi.stubGlobal("process", isolatedProcess);
}

type GoogleAuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function createGoogleAuthTransportFetch(): Promise<GoogleAuthFetch> {
  const transport = await getGoogleAuthTransport();
  const fetchImplementation = (transport.defaults as { fetchImplementation?: GoogleAuthFetch })
    .fetchImplementation;
  if (!fetchImplementation) {
    throw new Error("Expected Google auth transport fetch implementation");
  }
  return fetchImplementation;
}

function mockGuardedResponse(response = new Response("ok", { status: 200 })) {
  const release = vi.fn();
  mocks.fetchWithSsrFGuard.mockResolvedValueOnce({ response, release });
  return release;
}

function createUnstreamedAuthResponse(headers?: HeadersInit) {
  const arrayBuffer = vi.fn(async () => new ArrayBuffer(16));
  return {
    arrayBuffer,
    response: {
      arrayBuffer,
      body: null,
      headers: new Headers(headers),
      status: 200,
      statusText: "OK",
    } as unknown as Response,
  };
}

const validCredentials = {
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  client_email: "bot@example.iam.gserviceaccount.com",
  private_key: "key",
  token_uri: "https://oauth2.googleapis.com/token",
  type: "service_account",
  universe_domain: "googleapis.com",
};

function credentialAccount(
  overrides: Partial<Parameters<typeof resolveValidatedGoogleChatCredentials>[0]>,
) {
  return {
    accountId: "default",
    enabled: true,
    config: {},
    credentialSource: "inline" as const,
    ...overrides,
  };
}

const tokenUrl = "https://oauth2.googleapis.com/token";
async function authFetch(init: RequestInit = { method: "POST" }) {
  return (await createGoogleAuthTransportFetch())(tokenUrl, init);
}

function expectGuardCall(overrides: Record<string, unknown>) {
  expect(mocks.fetchWithSsrFGuard).toHaveBeenCalledWith({
    auditContext: "googlechat.auth.google-auth",
    init: { method: "POST" },
    policy: { hostnameAllowlist: ["accounts.google.com", "googleapis.com"] },
    timeoutMs: 30_000,
    url: tokenUrl,
    ...overrides,
  });
}

describe("googlechat google auth runtime", () => {
  it.each([
    {
      name: "routes Google auth fetches through the SSRF guard and preserves explicit proxy mTLS",
      init: {
        agent: { proxy: new URL("http://proxy.example:8080") },
        proxy: "http://proxy.example:8080",
      },
      policy: {
        allowPrivateProxy: true,
        mode: "explicit-proxy",
        proxyUrl: "http://proxy.example:8080",
      },
      env: undefined,
      withSignal: true,
    },
    {
      name: "bypasses explicit proxy when noProxy excludes the Google auth host",
      init: { noProxy: ["oauth2.googleapis.com"], proxy: "http://proxy.example:8080" },
      policy: { mode: "direct" },
      env: undefined,
      withSignal: false,
    },
    {
      name: "preserves env-proxy transport when HTTPS proxy is configured",
      init: {},
      policy: { mode: "env-proxy" },
      env: {
        HTTPS_PROXY: "http://env-proxy.example:8080",
        https_proxy: "http://lower-proxy.example:8080",
      },
      withSignal: false,
    },
  ])("$name", async ({ init, policy, env, withSignal }) => {
    if (env) {
      stubIsolatedProcessEnv(env);
    }
    const release = mockGuardedResponse();
    const signal = withSignal ? new AbortController().signal : undefined;
    const request = {
      method: "POST",
      ...(signal ? { headers: { "content-type": "application/json" }, signal } : {}),
    };
    const tls = { cert: "CLIENT_CERT", key: "CLIENT_KEY" };
    const response = await authFetch({ ...request, ...tls, ...init } as RequestInit);
    expectGuardCall({
      dispatcherPolicy: {
        ...policy,
        ...(policy.mode === "direct" ? { connect: tls } : { proxyTls: tls }),
      },
      init: request,
      ...(signal ? { signal } : {}),
    });
    await expect(response.text()).resolves.toBe("ok");
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps using the guard-selected runtime fetch even if global fetch changes later", async () => {
    const release = mockGuardedResponse();
    const originalFetch = globalThis.fetch;

    const guardedFetch = await createGoogleAuthTransportFetch();
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => new Response("patched"));

    try {
      await guardedFetch("https://oauth2.googleapis.com/token", {
        method: "POST",
      } as RequestInit);
    } finally {
      (globalThis as Record<string, unknown>).fetch = originalFetch;
    }

    expect(mockCallArg(mocks.fetchWithSsrFGuard)).not.toHaveProperty("fetchImpl");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects non-stream guarded auth responses instead of buffering them unbounded", async () => {
    const { response, arrayBuffer } = createUnstreamedAuthResponse();
    const release = mockGuardedResponse(response);

    await expect(authFetch()).rejects.toThrow(
      "Google auth response body stream unavailable; refusing to buffer unbounded response.",
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects oversized auth responses from content-length before reading the body", async () => {
    const { response, arrayBuffer } = createUnstreamedAuthResponse({
      "content-length": String(2 * 1024 * 1024),
    });
    const release = mockGuardedResponse(response);

    await expect(authFetch()).rejects.toThrow("Google auth response exceeds 1048576 bytes.");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("keeps auth transports isolated from google-auth interceptor mutations", async () => {
    const first = await getGoogleAuthTransport();
    const second = await getGoogleAuthTransport();

    expect(first).not.toBe(second);
    expect(mocks.gaxiosCtor).toHaveBeenCalledTimes(2);
    expect(first.interceptors.request["add"]).toHaveBeenCalledOnce();
    expect(first.interceptors.response["add"]).toHaveBeenCalledOnce();
    expect(second.interceptors.request["add"]).toHaveBeenCalledOnce();
    expect(second.interceptors.response["add"]).toHaveBeenCalledOnce();
  });

  it("normalizes Google auth request headers before upstream interceptors run", async () => {
    const transport = await getGoogleAuthTransport();
    const requestInterceptorAdd = transport.interceptors.request["add"] as unknown as ReturnType<
      typeof vi.fn
    >;
    const requestInterceptor = mockCallArg(requestInterceptorAdd) as {
      resolved: (config: RequestInit & { url: URL }) => Promise<RequestInit & { headers: Headers }>;
    };
    const config = {
      headers: { "x-test": "1" },
      url: new URL("https://www.googleapis.com/oauth2/v1/certs"),
    };

    const normalized = await requestInterceptor.resolved(config);

    expect(normalized.headers).toBeInstanceOf(Headers);
    expect(normalized.headers.has("x-test")).toBe(true);
    expect(normalized.headers.get("x-test")).toBe("1");
  });

  it("normalizes Google auth response headers before upstream cache-control reads", async () => {
    const transport = await getGoogleAuthTransport();
    const responseInterceptorAdd = transport.interceptors.response["add"] as unknown as ReturnType<
      typeof vi.fn
    >;
    const responseInterceptor = mockCallArg(responseInterceptorAdd) as {
      resolved: (response: { data: object; headers: object }) => Promise<{
        data: object;
        headers: Headers;
      }>;
    };
    const response = {
      data: {},
      headers: {
        "cache-control": "public, max-age=3600",
      },
    };

    const normalized = await responseInterceptor.resolved(response);

    expect(normalized.headers).toBeInstanceOf(Headers);
    expect(normalized.headers.get("cache-control")).toBe("public, max-age=3600");
  });

  it("rejects service-account credentials that override Google auth endpoints", async () => {
    await expect(
      resolveValidatedGoogleChatCredentials(
        credentialAccount({
          credentials: {
            client_email: "bot@example.iam.gserviceaccount.com",
            private_key: "key",
            token_uri: "https://evil.example/token",
            type: "service_account",
          },
        }),
      ),
    ).rejects.toThrow(/token_uri/);
  });

  it("reads and validates service-account files before passing them to google-auth", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "googlechat-auth-"));
    try {
      const credentialsPath = path.join(tempDir, "service-account.json");
      await fs.writeFile(credentialsPath, JSON.stringify(validCredentials), "utf8");

      const credentials = await resolveValidatedGoogleChatCredentials(
        credentialAccount({ credentialSource: "file", credentialsFile: credentialsPath }),
      );
      expect(credentials).toMatchObject({
        client_email: "bot@example.iam.gserviceaccount.com",
        token_uri: tokenUrl,
        type: "service_account",
      });
    } finally {
      await fs.rm(tempDir, { force: true, recursive: true });
    }
  });

  it("does not disclose raw credential paths or OS errors when file reads fail", async () => {
    const missingPath = path.join(os.tmpdir(), "googlechat-auth-missing", "service-account.json");

    let thrown: unknown;
    try {
      await resolveValidatedGoogleChatCredentials(
        credentialAccount({ credentialSource: "file", credentialsFile: missingPath }),
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("Failed to load Google Chat service account file.");
    expect((thrown as Error).message).not.toMatch(
      /ENOENT|service-account\.json|googlechat-auth-missing/,
    );
  });
});
