// Exercise Google Chat requests through a real guarded HTTP transport.
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { deleteGoogleChatMessage, GoogleChatApiError } from "./api.js";

const proofToken = "googlechat-transport-test-token";

const loopback = vi.hoisted(() => ({
  baseUrl: "",
  cloneResponse: false,
  rejectCancellation: false,
  releases: [] as Array<{ bodyIsNull: boolean; bodyUsed: boolean }>,
  signal: undefined as AbortSignal | undefined,
  onResponse: undefined as ((status: number) => void) | undefined,
}));

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: async (...args: Parameters<typeof actual.fetchWithSsrFGuard>) => {
      fetchWithSsrFGuardMock(...args);
      const [params] = args;
      if (!loopback.baseUrl || new URL(params.url).origin !== "https://chat.googleapis.com") {
        throw new Error("Unexpected request in Google Chat transport fixture");
      }
      const guarded = await actual.fetchWithSsrFGuard({
        ...params,
        url: params.url.replace("https://chat.googleapis.com", loopback.baseUrl),
        policy: { allowPrivateNetwork: true },
        onResponse: loopback.onResponse,
        ...(loopback.signal ? { signal: loopback.signal } : {}),
      });

      if (loopback.cloneResponse) {
        // A debug-proxy tee can keep cancellation pending until release.
        const capture = guarded.response.clone();
        void capture.arrayBuffer().catch(() => undefined);
      }

      if (loopback.rejectCancellation && guarded.response.body) {
        vi.spyOn(guarded.response.body, "cancel").mockRejectedValueOnce(new Error("cancel failed"));
      }

      return {
        ...guarded,
        release: async () => {
          loopback.releases.push({
            bodyIsNull: guarded.response.body === null,
            bodyUsed: guarded.response.bodyUsed,
          });
          await guarded.release();
        },
      };
    },
  };
});

vi.mock("./auth.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth.js")>()),
  getGoogleChatAccessToken: vi.fn(async () => proofToken),
}));

const account = {
  accountId: "default",
  enabled: true,
  config: {},
  credentialSource: "env",
} as ResolvedGoogleChatAccount;

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }
  // A stalled response is an active connection, which server.close() cannot close.
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await withinDeadline(closed);
}

function deleteMessage(id: string) {
  return withinDeadline(
    deleteGoogleChatMessage({ account, messageName: `spaces/AAA/messages/${id}` }),
  );
}

function expectReleased(bodyUsed = true) {
  expect(loopback.releases).toEqual([{ bodyIsNull: false, bodyUsed }]);
}

async function withinDeadline<T>(promise: Promise<T>, timeoutMs = 2_000): Promise<T> {
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(
    () => deadline.reject(new Error("Google Chat transport proof timed out")),
    timeoutMs,
  );
  try {
    return await Promise.race([promise, deadline.promise]);
  } finally {
    clearTimeout(timer);
  }
}

let server: Server;
let handler: RequestListener;
let state: {
  socketClosed: boolean;
  request?: Parameters<RequestListener>[0];
  response?: ServerResponse;
};
beforeEach(async () => {
  fetchWithSsrFGuardMock.mockClear();
  loopback.baseUrl = "";
  loopback.cloneResponse = false;
  loopback.rejectCancellation = false;
  loopback.releases = [];
  loopback.signal = undefined;
  loopback.onResponse = undefined;
  state = { socketClosed: false };
  handler = (_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write("{}");
  };
  server = createServer((request, response) => {
    state.request = request;
    state.response = response;
    request.socket.once("close", () => {
      state.socketClosed = true;
    });
    handler(request, response);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  loopback.baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  try {
    await closeServer(server);
  } finally {
    vi.restoreAllMocks();
  }
});

it("preserves an authoritative 404 when its response body is truncated", async () => {
  loopback.onResponse = () => state.response?.destroy();
  handler = (_request, response) => {
    response.writeHead(404, {
      "Content-Type": "application/json",
      "Content-Length": "100",
    });
    response.write("{}");
  };

  const outcome = await deleteMessage("MISSING").catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(GoogleChatApiError);
  expect(outcome).toMatchObject({ status: 404 });
  expectReleased();
});

it("delivers task-list fallback at the default chunk limit through the SDK", async () => {
  const { withOpenClawTestState } = await import("openclaw/plugin-sdk/test-state");
  await withOpenClawTestState(
    { label: "googlechat-markdown-delivery", layout: "state-only" },
    async () => {
      const [
        { sendDurableMessageBatch },
        { createTestRegistry, withPluginRuntimeRegistryScope },
        { googlechatPlugin },
      ] = await Promise.all([
        import("openclaw/plugin-sdk/channel-outbound"),
        import("openclaw/plugin-sdk/channel-test-helpers"),
        import("../api.js"),
      ]);
      const requests: Array<{
        method: string | undefined;
        path: string | undefined;
        body: string;
      }> = [];
      handler = async (request, response) => {
        let body = "";
        request.setEncoding("utf8");
        for await (const chunk of request) {
          body += chunk;
        }
        requests.push({ method: request.method, path: request.url, body });
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ name: `spaces/AAA/messages/${requests.length}` }));
      };
      const paragraph = "A".repeat(31_998);
      const serviceAccount = {
        client_email: "transport@example.test",
        private_key: "not-a-real-key",
      };
      const result = await withPluginRuntimeRegistryScope(
        createTestRegistry([{ pluginId: "googlechat", plugin: googlechatPlugin, source: "test" }]),
        () =>
          sendDurableMessageBatch({
            cfg: { channels: { googlechat: { serviceAccount } } },
            channel: "googlechat",
            accountId: "default",
            to: "spaces/AAA",
            payloads: [{ text: `**${paragraph}**\n\n- [x] done` }],
          }),
      );
      expect(result).toMatchObject({
        status: "sent",
        deliveryIntent: { queuePolicy: "required" },
        receipt: {
          platformMessageIds: ["spaces/AAA/messages/1", "spaces/AAA/messages/2"],
        },
      });
      expect(requests.map(({ method, path }) => ({ method, path }))).toEqual([
        { method: "POST", path: "/v1/spaces/AAA/messages" },
        { method: "POST", path: "/v1/spaces/AAA/messages" },
      ]);
      const messages: Array<{ text: string }> = requests.map(({ body }) => JSON.parse(body));
      expect(messages).toEqual([{ text: `*${paragraph}*` }, { text: "\n\n[x] done" }]);
      expect(messages.every(({ text }) => Buffer.byteLength(text, "utf8") <= 32_000)).toBe(true);
    },
  );
});

it("cancels a streaming authenticated DELETE before releasing its real dispatcher", async () => {
  await expect(deleteMessage("BBB")).resolves.toBeUndefined();

  expect(state.request).toMatchObject({
    headers: { authorization: `Bearer ${proofToken}` },
    url: "/v1/spaces/AAA/messages/BBB",
  });
  expectReleased();
  expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
    expect.objectContaining({
      auditContext: "googlechat.api.ok",
      init: expect.objectContaining({ method: "DELETE" }),
    }),
  );
  await vi.waitFor(() => expect(state.socketClosed).toBe(true), { timeout: 1_000 });
});

it.each([
  ["cloneResponse", "CAPTURED", true],
  ["rejectCancellation", "CANCEL", false],
] as const)("releases a streaming response with %s", async (mode, id, bodyUsed) => {
  loopback[mode] = true;
  await expect(deleteMessage(id)).resolves.toBeUndefined();
  expectReleased(bodyUsed);
  await closeServer(server);
  await vi.waitFor(() => expect(state.socketClosed).toBe(true), { timeout: 1_000 });
});

it("preserves Google Chat errors without exposing the bearer token", async () => {
  handler = (request, response) => {
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        error: { message: "Chat permission denied" },
        reflectedHeader: `Authorization: ${request.headers.authorization}`,
      }),
    );
  };

  const outcome = await deleteMessage("FORBIDDEN").catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  expect(state.request?.headers.authorization).toBe(`Bearer ${proofToken}`);
  expect((outcome as Error).message).toContain("Google Chat API 403");
  expect((outcome as Error).message).toContain("Chat permission denied");
  expect((outcome as Error).message).toContain("Authorization: Bearer");
  expect((outcome as Error).message).not.toContain(proofToken);
  expectReleased();
});

it("aborts an authenticated in-flight DELETE and closes the real socket", async () => {
  const controller = new AbortController();
  loopback.signal = controller.signal;
  handler = () => {
    controller.abort(new Error("Google Chat transport proof aborted"));
  };

  const outcome = await deleteMessage("ABORT").catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(Error);
  expect((outcome as Error).message).toMatch(/abort/i);
  expect((outcome as Error).message).not.toContain(proofToken);
  expect(state.request?.headers.authorization).toBe(`Bearer ${proofToken}`);
  expect(loopback.releases).toEqual([]);
  await vi.waitFor(() => expect(state.socketClosed).toBe(true), { timeout: 1_000 });
});
