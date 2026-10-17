// Real delivery, SSRF and token-exchange stack, with Google fetches rerouted to
// loopback. The in-process RSA key is synthetic; no live credentials are used.
import { generateKeyPairSync } from "node:crypto";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import type { ResolvedGoogleChatAccount } from "./accounts.js";
import { deliverGoogleChatReply } from "./monitor-reply-delivery.js";
import type { GoogleChatCoreRuntime } from "./monitor-types.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const account = {
  accountId: "default",
  enabled: true,
  credentialSource: "inline",
  credentials: {
    type: "service_account",
    client_email: "stub-bot@stub-project.iam.gserviceaccount.com",
    private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url:
      "https://www.googleapis.com/robot/v1/metadata/x509/stub-bot%40stub-project.iam.gserviceaccount.com",
  },
  config: {},
} as unknown as ResolvedGoogleChatAccount;

const CHUNKS = ["First chunk.", "Second chunk.", "Third chunk."] as const;
const thread = "spaces/AAA/threads/root";
const typingMessage = {
  placement: "thread" as const,
  name: "spaces/AAA/messages/typing",
  requestedThreadName: thread,
  deliveredThreadName: thread,
};

const core = {
  channel: {
    text: {
      resolveChunkMode: () => "markdown",
      chunkMarkdownTextWithMode: () => CHUNKS,
    },
  },
} as unknown as GoogleChatCoreRuntime;

type CreateAttempt = { text?: string; status: number };

function createStubHandler(params: { failCreateIndexes: Set<number>; patchStatus?: number }) {
  const createAttempts: CreateAttempt[] = [];
  const patchAttempts: string[] = [];
  const handler = (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub.invalid");
      const json = (status: number, payload: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(payload));
      };
      if (req.method === "POST" && url.pathname === "/token") {
        json(200, { access_token: "ya29.stub-token", token_type: "Bearer", expires_in: 3600 });
        return;
      }
      const messagesMatch = url.pathname.match(/^\/v1\/(spaces\/[^/]+)\/messages$/);
      if (req.method === "POST" && messagesMatch) {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: string };
        const index = createAttempts.length + 1;
        const status = params.failCreateIndexes.has(index) ? 500 : 200;
        createAttempts.push({ text: body.text, status });
        if (status === 500) {
          json(500, {
            error: { code: 500, message: "stub: backend unavailable", status: "INTERNAL" },
          });
        } else {
          json(200, { name: `${messagesMatch[1]}/messages/stub-m${index}` });
        }
        return;
      }
      const messageMatch = url.pathname.match(/^\/v1\/(spaces\/[^/]+\/messages\/[^/]+)$/);
      if (req.method === "PATCH" && messageMatch?.[1]) {
        patchAttempts.push(messageMatch[1]);
        const status = params.patchStatus ?? 200;
        json(
          status,
          status === 200
            ? { name: messageMatch[1] }
            : { error: { code: status, message: "stub: message not found", status: "NOT_FOUND" } },
        );
        return;
      }
      json(400, { error: { code: 400, message: "stub: unhandled request" } });
    });
  };
  return { handler, createAttempts, patchAttempts };
}

function expectPartialDelivery(
  error: unknown,
  deliveryResult: { messageIds: string[]; content: string; visibleReplySent: true },
) {
  if (!isChannelPartialDeliveryError(error)) {
    throw new Error("expected partial delivery error");
  }
  expect(error.deliveryResult).toEqual(deliveryResult);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function deliver(
  failures: number[],
  options: {
    withTypingMessage?: boolean;
    statusSink?: Parameters<typeof deliverGoogleChatReply>[0]["statusSink"];
  } = {},
  patchStatus?: number,
) {
  const stub = createStubHandler({ failCreateIndexes: new Set(failures), patchStatus });
  const errorLines: string[] = [],
    requestedUrls: string[] = [];
  let outcome: "delivered" | "failed-deliver" = "delivered",
    deliverError: unknown;
  const realFetch = globalThis.fetch;
  await withServer(stub.handler, async (baseUrl) => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const rawUrl = input instanceof Request ? input.url : String(input);
      requestedUrls.push(rawUrl);
      const url = new URL(rawUrl);
      return realFetch(
        ["chat.googleapis.com", "oauth2.googleapis.com"].includes(url.hostname)
          ? baseUrl + url.pathname + url.search
          : input,
        init,
      );
    });
    await deliverGoogleChatReply({
      payload: { text: CHUNKS.join("\n\n"), replyToId: thread },
      account,
      spaceId: "spaces/AAA",
      core,
      config: {},
      runtime: {
        error: (line) => {
          errorLines.push(line);
        },
      },
      statusSink: options.statusSink,
      typingMessage: options.withTypingMessage ? typingMessage : undefined,
    }).catch((error: unknown) => {
      outcome = "failed-deliver";
      deliverError = error;
    });
  });
  return { result: { outcome, deliverError, errorLines }, stub, requestedUrls };
}

it("surfaces a failed non-first chunk send as a dispatcher-visible delivery failure", async () => {
  const { result, stub, requestedUrls } = await deliver([2]);

  expect(result.outcome).toBe("failed-deliver");
  expect(result.deliverError).toBeInstanceOf(Error);
  expect((result.deliverError as Error).message).toContain("Google Chat API 500");
  expect((result.deliverError as Error).message).toContain("stub: backend unavailable");
  expectPartialDelivery(result.deliverError, {
    messageIds: ["spaces/AAA/messages/stub-m1"],
    content: CHUNKS[0],
    visibleReplySent: true,
  });
  // The failing create rejects the whole delivery: the third chunk is never attempted.
  expect(stub.createAttempts.map((attempt) => attempt.status)).toEqual([200, 500]);
  expect(stub.createAttempts.map((attempt) => attempt.text)).toEqual([CHUNKS[0], CHUNKS[1]]);
  // Both Google hosts went through the production fetch path.
  expect(requestedUrls.some((url) => url.startsWith("https://oauth2.googleapis.com/"))).toBe(true);
  expect(
    requestedUrls.filter((url) => url.startsWith("https://chat.googleapis.com/")),
  ).toHaveLength(2);
});

it.each([200, 404])(
  "preserves delivery state when create fails after typing PATCH %i",
  async (patchStatus) => {
    const { result, stub } = await deliver([1], { withTypingMessage: true }, patchStatus);
    expect(result.outcome).toBe("failed-deliver");
    expect((result.deliverError as Error).message).toContain("Google Chat API 500");
    expect(stub.patchAttempts).toEqual(["spaces/AAA/messages/typing"]);
    expect(stub.createAttempts.map((attempt) => attempt.status)).toEqual([500]);
    if (patchStatus === 200) {
      expectPartialDelivery(result.deliverError, {
        messageIds: ["spaces/AAA/messages/typing"],
        content: CHUNKS[0],
        visibleReplySent: true,
      });
    } else {
      expect(isChannelPartialDeliveryError(result.deliverError)).toBe(false);
      expect(result.errorLines.some((line) => line.includes("Google Chat API 404"))).toBe(true);
    }
  },
);

it("recovers from a missing typing placeholder without duplicating any chunk", async () => {
  const { result, stub } = await deliver([], { withTypingMessage: true }, 404);

  expect(result.outcome).toBe("delivered");
  expect(stub.patchAttempts).toEqual(["spaces/AAA/messages/typing"]);
  expect(stub.createAttempts.map((attempt) => attempt.status)).toEqual([200, 200, 200]);
  expect(stub.createAttempts.map((attempt) => attempt.text)).toEqual(CHUNKS);
  expect(result.errorLines.some((line) => line.includes("Google Chat API 404"))).toBe(true);
});

it("does not resend a delivered chunk when outbound status reporting fails", async () => {
  const statusSink = vi.fn(() => {
    throw new Error("status unavailable");
  });
  const { result, stub } = await deliver([], { withTypingMessage: true, statusSink });

  expect(result.outcome).toBe("delivered");
  expect(stub.patchAttempts).toEqual(["spaces/AAA/messages/typing"]);
  expect(stub.createAttempts.map((attempt) => attempt.status)).toEqual([200, 200]);
  expect(stub.createAttempts.map((attempt) => attempt.text)).toEqual(CHUNKS.slice(1));
  expect(statusSink).toHaveBeenCalledTimes(CHUNKS.length);
  expect(result.errorLines).toEqual(
    Array(3).fill("Google Chat outbound status update failed: Error: status unavailable"),
  );
});
