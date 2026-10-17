import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { setReplyPayloadMetadata } from "../../auto-reply/reply-payload.js";
import { createReplyDispatcher } from "../../auto-reply/reply/reply-dispatcher.js";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
} from "../../infra/outbound/deliver-types.js";
import {
  settleDurableDelivery,
  settlePendingFinalDelivery,
} from "../../infra/outbound/delivery-completion.js";
import { createStructuredOutboundPayloadPlan } from "../../infra/outbound/payloads.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../../state/openclaw-agent-db.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { dispatchRoutedChannelTurn } from "./lifecycle.js";
import type { ChannelTurnDeliveryAdapter } from "./types.js";

const dispatchReplyWithRoutedChannelDispatcherCore = vi.hoisted(() => vi.fn());
const sendRecoveryNotice = vi.hoisted(() => vi.fn());
const appendAssistantMessageToSessionTranscript = vi.hoisted(() => vi.fn());
const recordInboundSessionCore = vi.hoisted(() => vi.fn(async () => undefined));
const withDurableDeliveryRuntime = vi.hoisted(() => vi.fn());

vi.mock("../../auto-reply/dispatch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auto-reply/dispatch.js")>();
  return {
    ...actual,
    dispatchInboundMessageWithRoutedChannelDispatcher: dispatchReplyWithRoutedChannelDispatcherCore,
  };
});
vi.mock("../session.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../session.js")>();
  return { ...actual, recordInboundSession: recordInboundSessionCore };
});
vi.mock("../../gateway/server-recovery-runtime-context.js", () => ({
  getGatewayRecoveryRuntime: () => ({ sendRecoveryNotice }),
}));
vi.mock("./durable-delivery-runtime.js", () => ({ withDurableDeliveryRuntime }));
vi.mock("../../config/sessions/transcript.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config/sessions/transcript.js")>();
  return {
    ...actual,
    appendAssistantMessageToSessionTranscript,
    readRecentUserAssistantTextForSession: vi.fn(async () => []),
  };
});

// Injected ambiguous final-send trace: turn 1 fails after the pre-I/O claim and
// must persist owed notice debt; turn 2 on the same route must deliver exactly
// one uncertainty notice and acknowledge the debt. Store, settlement, and turn
// lifecycle are real; only transport ends are stubbed.
describe("pending delivery notice end to end", () => {
  const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-notice-e2e-");
  let storePath: string;
  let cfg: OpenClawConfig;
  const sessionKey = "agent:main:telegram:direct:chat-1";
  const context = { channel: "telegram", to: "chat-1", accountId: "default" };
  let completion = {
    deliveryId: "delivery-e2e",
    intentId: "intent-e2e",
    sessionId: "session-e2e",
    sessionKey,
    storePath: "",
  };
  const locator = () => ({ sessionKey, storePath });
  const entry = () => loadSessionEntry(locator());
  const finalPayload = (bindCustody = true) =>
    bindCustody
      ? setReplyPayloadMetadata(
          { text: "the final answer" },
          { pendingFinalDeliveryCompletion: completion },
        )
      : { text: "the final answer" };
  const dispatch = (delivery: ChannelTurnDeliveryAdapter) =>
    dispatchRoutedChannelTurn({
      cfg,
      channel: "telegram",
      accountId: "default",
      route: { agentId: "main", sessionKey },
      ctxPayload: {
        Body: "hello",
        RawBody: "hello",
        CommandBody: "hello",
        CommandAuthorized: false,
        From: "sender",
        To: "chat-1",
        SessionKey: sessionKey,
        Provider: "telegram",
        Surface: "telegram",
        OriginatingTo: "chat-1",
      },
      delivery,
    });
  const expectNoticeState = (suppressed: boolean) =>
    expect(entry()?.pendingDeliveryNotice?.state).toBe(suppressed ? "unresolved" : "acknowledged");

  beforeEach(async () => {
    vi.clearAllMocks();
    sendRecoveryNotice.mockResolvedValue({ suppressed: false });
    appendAssistantMessageToSessionTranscript.mockResolvedValue({ ok: true });
    storePath = path.join(sessionDirs.make(), "sessions.json");
    completion = { ...completion, storePath };
    cfg = { session: { store: storePath } };
    await replaceSessionEntry(locator(), {
      sessionId: completion.sessionId,
      status: "done",
      updatedAt: Date.now(),
      delivery: {
        kind: "external",
        route: { channel: "telegram", accountId: "default" },
        context,
        origin: {},
      },
      pendingFinalDelivery: {
        kind: "replayable",
        text: "the final answer",
        createdAt: Date.now(),
        context,
        intentId: completion.intentId,
        deliveries: [{ id: completion.deliveryId, state: "prepared" }],
      },
    });
  });

  const runTurn = (
    deliver: () => Promise<{ visibleReplySent: boolean }>,
    options?: { bindCustody?: boolean },
  ) => {
    dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
      await params.dispatcherOptions.deliver(finalPayload(options?.bindCustody), { kind: "final" });
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });
    return dispatch({ deliver });
  };
  const freshTurn = () => runTurn(async () => ({ visibleReplySent: true }), { bindCustody: false });

  it.each(["prepared", "queued"] as const)(
    "does not announce an in-flight %s final on a concurrent inbound turn",
    async (state) => {
      if (state === "queued") {
        await settlePendingFinalDelivery({ kind: "pending-final", ...completion }, "queued", [
          "prepared",
        ]);
      }
      const sending = createDeferred();
      const finish = createDeferred();
      const attempt = runTurn(async () => {
        sending.resolve();
        const finalization = finish.promise.then(() => ({ visibleReplySent: true }));
        return state === "queued" ? { visibleReplySent: false, finalization } : await finalization;
      });
      await sending.promise;
      try {
        await freshTurn();
        expect(sendRecoveryNotice).not.toHaveBeenCalled();
        expect(appendAssistantMessageToSessionTranscript).not.toHaveBeenCalled();
        expect(entry()?.pendingDeliveryNotice?.state).toBe("owed");

        // A refused duplicate admission cannot release the original send's custody.
        const duplicate = vi.fn(async () => ({ visibleReplySent: true }));
        await runTurn(duplicate);
        expect(duplicate).not.toHaveBeenCalled();
        await freshTurn();
        expect(sendRecoveryNotice).not.toHaveBeenCalled();
      } finally {
        finish.resolve();
        await attempt;
      }
      await freshTurn();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
      expect(entry()?.pendingDeliveryNotice).toBeUndefined();
    },
  );

  it("preserves an earlier ambiguous send when deferred provider admission is refused", async () => {
    await settlePendingFinalDelivery({ kind: "pending-final", ...completion }, "unknown", [
      "prepared",
    ]);
    const admittedEntry = await readSessionEntryReadOnlyInWorker(locator());
    const platformSend = vi.fn();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const buffered = createDeferred();
      const flush = createDeferred();
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
        const dispatcher = createReplyDispatcher(params.dispatcherOptions);
        dispatcher.sendFinalReply(
          setReplyPayloadMetadata(
            { text: "the final answer" },
            { pendingFinalDeliveryCompletion: { ...completion } },
          ),
        );
        dispatcher.markComplete();
        await buffered.promise;
        flush.resolve();
        const settledReceipt = await dispatcher.waitForIdle();
        return { queuedFinal: true, counts: dispatcher.getQueuedCounts(), settledReceipt };
      });
      const error = await dispatch({
        deliverWithProviderMessageSending: async (_payload, info) => {
          buffered.resolve();
          return {
            visibleReplySent: false,
            finalization: flush.promise.then(async () => {
              await info.onPlatformSendDispatch();
              platformSend();
              return { visibleReplySent: true };
            }),
          };
        },
      }).then(
        () => undefined,
        (failure: unknown) => failure,
      );
      const afterReplay = await readSessionEntryReadOnlyInWorker(locator());
      expect(afterReplay?.pendingFinalDelivery).toEqual(admittedEntry?.pendingFinalDelivery);
      expect(afterReplay?.pendingDeliveryNotice).toEqual({
        ...admittedEntry?.pendingDeliveryNotice,
        state: "acknowledged",
      });
      expect(error).toBeUndefined();
    }
    expect(platformSend).not.toHaveBeenCalled();
    expect(sendRecoveryNotice).toHaveBeenCalledOnce();
  });

  it.each([
    { failure: "rejected", operation: "raw", state: "suppressed" },
    { failure: "rejected", operation: "prepared", state: "suppressed" },
    { failure: "retryable", operation: "raw", state: "prepared" },
    { failure: "retryable", operation: "prepared", state: "prepared" },
    { failure: "queue-owned", operation: "raw", state: "queued" },
    { failure: "queue-owned", operation: "prepared", state: "queued" },
  ] as const)(
    "does not owe a notice after $failure durable $operation delivery",
    async ({ failure, operation, state }) => {
      const notDispatched = new PlatformMessageNotDispatchedError("sender preflight failed", {
        cause: undefined,
        retryable: failure !== "rejected",
      });
      const error =
        failure === "queue-owned"
          ? Object.assign(
              new OutboundDeliveryError(notDispatched.message, { cause: notDispatched }),
              {
                queueCustody: "held",
              },
            )
          : notDispatched;
      withDurableDeliveryRuntime.mockImplementationOnce(async () => {
        if (failure === "queue-owned") {
          await settlePendingFinalDelivery({ kind: "pending-final", ...completion }, "queued", [
            "prepared",
          ]);
        }
        throw error;
      });
      dispatchReplyWithRoutedChannelDispatcherCore.mockImplementationOnce(async (params) => {
        const payload = finalPayload();
        const dispatcher = createReplyDispatcher(params.dispatcherOptions);
        if (operation === "prepared") {
          const [plan] = createStructuredOutboundPayloadPlan([payload]);
          if (!plan) {
            throw new Error("expected prepared final");
          }
          dispatcher.sendPreparedReply("final", plan);
        } else {
          dispatcher.sendFinalReply(payload);
        }
        dispatcher.markComplete();
        const settledReceipt = await dispatcher.waitForIdle();
        return { queuedFinal: true, counts: dispatcher.getQueuedCounts(), settledReceipt };
      });
      const deliver = vi.fn(async () => ({ visibleReplySent: true }));
      const onError = vi.fn();
      await dispatch({ deliver, durable: {}, onError });

      const current = entry();
      expect(current?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state },
      ]);
      expect(current?.pendingDeliveryNotice).toBeUndefined();
      expect(deliver).not.toHaveBeenCalled();
      expect(onError).toHaveBeenCalledExactlyOnceWith(error, { kind: "final" });

      await freshTurn();
      expect(sendRecoveryNotice).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "keeps a settled notice final when suppression is %s",
    async (suppressed) => {
      sendRecoveryNotice.mockResolvedValue({ suppressed });
      const ambiguous = new Error("socket closed before response");
      await expect(
        runTurn(async () => {
          throw ambiguous;
        }),
      ).rejects.toBe(ambiguous);

      const afterLoss = entry();
      expect(afterLoss?.pendingFinalDelivery?.deliveries).toEqual([
        { id: completion.deliveryId, state: "unknown" },
      ]);
      expect(afterLoss?.pendingDeliveryNotice).toMatchObject({
        intentId: completion.intentId,
        state: "owed",
      });
      expect(sendRecoveryNotice).not.toHaveBeenCalled();

      // The next turn carries its own fresh custody; the stale intent stays put.
      await freshTurn();

      expect(sendRecoveryNotice).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          channel: "telegram",
          to: "chat-1",
          text: expect.stringContaining("couldn’t confirm"),
        }),
      );
      expectNoticeState(suppressed);

      // Reopen the canonical store so normalization must preserve the terminal fact.
      await closeOpenClawAgentDatabasesAsync(path.dirname(storePath));
      closeOpenClawAgentDatabasesForTest(path.dirname(storePath));
      // A queue restart can repeat owner settlement after its first write committed.
      await settleDurableDelivery(
        { kind: "pending-final", ...completion },
        { platformSendStarted: true },
      );
      await freshTurn();
      expect(sendRecoveryNotice).toHaveBeenCalledTimes(1);
      expectNoticeState(suppressed);
    },
  );
});
