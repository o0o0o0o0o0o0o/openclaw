import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { deliverPendingDeliveryNotice } from "./pending-delivery-notice.js";

const PENDING_DELIVERY_NOTICE =
  "I couldn’t confirm whether my previous reply reached this chat, so I won’t resend it automatically. Please ask for any missing remainder.";

const sendRecoveryNotice = vi.hoisted(() => vi.fn());
const appendAssistantMessageToSessionTranscript = vi.hoisted(() => vi.fn());
const findDeliveryIntentOwner = vi.hoisted(() => vi.fn());

vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));
vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  return { ...actual, appendAssistantMessageToSessionTranscript };
});
vi.mock("../../infra/outbound/delivery-queue-storage.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../infra/outbound/delivery-queue-storage.js")>();
  return { ...actual, findDeliveryIntentOwner };
});

describe("pending delivery notice", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-pending-notice-");
  let storePath: string;
  const sessionKey = "agent:main:telegram:direct:chat-1";
  const context = { channel: "telegram", to: "chat-1", accountId: "default", threadId: 42 };
  const locator = () => ({ sessionKey, storePath });
  const entry = () => loadSessionEntry(locator())!;
  const deliver = () => deliverPendingDeliveryNotice(sessionKey, storePath);
  const expectNotice = (state: string) =>
    expect(entry().pendingDeliveryNotice).toMatchObject({ intentId: "intent-1", state });
  const expectTranscript = () =>
    expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledWith(
      expect.objectContaining({ expectedSessionId: "session-1", text: PENDING_DELIVERY_NOTICE }),
    );
  function pendingNotice() {
    const started = createDeferred();
    const result = createDeferred<{ suppressed: boolean }>();
    sendRecoveryNotice.mockImplementationOnce(() => {
      started.resolve();
      return result.promise;
    });
    return { started: started.promise, ...result };
  }
  function failNotice(status: string) {
    sendRecoveryNotice.mockRejectedValue(new Error("notice send failed"));
    findDeliveryIntentOwner.mockReturnValue({ status });
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    sendRecoveryNotice.mockReset().mockResolvedValue({ suppressed: false });
    findDeliveryIntentOwner.mockReturnValue(null);
    appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true });
    storePath = path.join(sessionDirs.make(), "sessions.json");
    await replaceSessionEntry(locator(), {
      sessionId: "session-1",
      status: "done",
      updatedAt: Date.now(),
      delivery: {
        kind: "external",
        route: { channel: "telegram", accountId: "default" },
        context,
        origin: {},
      },
      pendingDeliveryNotice: {
        createdAt: Date.now(),
        context,
        intentId: "intent-1",
        state: "owed",
      },
    });
  });

  it("retains acknowledgment after the stable notice is recorded", async () => {
    await deliver();

    expect(sendRecoveryNotice).toHaveBeenCalledWith({
      ...context,
      text: PENDING_DELIVERY_NOTICE,
      idempotencyKey: "main-session-restart-recovery:pending-final:intent-1",
    });
    expectTranscript();
    expectNotice("acknowledged");
  });

  it("does not cross an account or thread route", async () => {
    const current = entry();
    await replaceSessionEntry(locator(), {
      ...current,
      delivery: { ...current.delivery!, context: { ...context, accountId: "other" } },
    });

    await deliver();

    expect(sendRecoveryNotice).not.toHaveBeenCalled();
    expectNotice("owed");
  });

  it("retains debt terminally when the notice send is suppressed", async () => {
    sendRecoveryNotice.mockResolvedValue({ suppressed: true });

    await deliver();

    expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
    expectNotice("unresolved");
  });

  it("retains unresolved debt after a terminal notice delivery failure", async () => {
    failNotice("failed");
    await deliver();
    expectNotice("unresolved");
  });

  it("records acknowledgment when the stable notice receipt completed before an error", async () => {
    failNotice("completed");
    await deliver();
    expectTranscript();
    expectNotice("acknowledged");
  });

  it("retains owed debt while the durable notice remains pending", async () => {
    failNotice("pending");
    await deliver();
    expectNotice("owed");
  });
  it.each([false, true])(
    "keeps acknowledgment when suppression finishes first=%s",
    async (suppressedFirst) => {
      const first = pendingNotice();
      const second = pendingNotice();
      const attempts = [deliver(), deliver()];
      await Promise.all([first.started, second.started]);
      first.resolve({ suppressed: suppressedFirst });
      await Promise.race(attempts);
      second.resolve({ suppressed: !suppressedFirst });
      await Promise.all(attempts);
      expectNotice("acknowledged");
      expect(appendAssistantMessageToSessionTranscript).toHaveBeenCalledTimes(1);
    },
  );

  it("leaves a replacement notice owed when an earlier send finishes", async () => {
    const sent = pendingNotice();
    const attempt = deliver();
    await sent.started;
    const current = entry();
    const replacement = { ...current.pendingDeliveryNotice!, intentId: "intent-2" };
    await replaceSessionEntry(locator(), { ...current, pendingDeliveryNotice: replacement });
    sent.resolve({ suppressed: false });
    await attempt;
    expect(entry().pendingDeliveryNotice).toEqual(replacement);
  });
});
