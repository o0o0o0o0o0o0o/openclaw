// Wire-level Matrix lifecycle goldens through the real monitor handler.
import { MatrixEvent, type IEvent } from "matrix-js-sdk/lib/matrix.js";
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenario,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import {
  implicitMentionKindWhen,
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-mention-gating";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import {
  chunkMarkdownTextWithMode,
  resolveChunkMode,
  resolveTextChunkLimit,
} from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { beforeAll, describe, it, vi } from "vitest";
import {
  createMatrixHandlerTestHarness,
  createMatrixTextMessageEvent,
} from "./matrix/monitor/handler.test-helpers.js";
import type { MatrixClient } from "./matrix/sdk.js";
import { installMatrixTestRuntime } from "./test-runtime.js";

const ROOM_ID = "!room:example.org";
const BOT_USER_ID = "@openclaw:example.org";
const INBOUND_EVENT_ID = "$inbound-1";

beforeAll(() => {
  // Use real text/mention helpers; these scenarios deliberately have no media runtime.
  installMatrixTestRuntime({
    logging: { shouldLogVerbose: () => false },
    channel: {
      inbound: createPluginRuntimeMock().channel.inbound,
      text: {
        resolveMarkdownTableMode,
        convertMarkdownTables,
        resolveTextChunkLimit,
        resolveChunkMode,
        chunkMarkdownTextWithMode,
      },
      mentions: {
        buildMentionRegexes: () => [],
        matchesMentionPatterns: (text: string, patterns: RegExp[]) =>
          patterns.some((pattern) => pattern.test(text)),
        matchesMentionWithExplicit: () => false,
        implicitMentionKindWhen,
        resolveInboundMentionDecision,
      },
    } as unknown as PluginRuntime["channel"],
  });
});

function createRecordingMatrixClient(recorder: WireRecorder): Partial<MatrixClient> {
  // Each wire event (including edits/redactions) consumes a deterministic event ID.
  const eventsById = new Map<string, IEvent>();
  let eventCount = 0;
  const mintEventId = () => {
    eventCount += 1;
    return `$e${eventCount}`;
  };
  const client: Partial<MatrixClient> = {
    getUserId: async () => BOT_USER_ID,
    prepareRoomForMessageSend: async () => "m.room.message",
    sendMessage: async (roomId: string, content: Record<string, unknown>) => {
      const eventId = mintEventId();
      // Snapshot before recording: edit flows reuse content structures, and the
      // recorder serializes at compare time.
      const payload = structuredClone(content);
      eventsById.set(eventId, {
        event_id: eventId,
        sender: BOT_USER_ID,
        type: "m.room.message",
        origin_server_ts: Date.now(),
        content: payload,
        unsigned: {},
      });
      recorder.recordWireCall({
        method: "sendMessage",
        target: roomId,
        payload,
        result: { event_id: eventId },
      });
      return eventId;
    },
    // Mention diffing and requested thread validation read the prior event;
    // quiet previews without a thread skip this otherwise unused round trip.
    getEvent: async (_roomId: string, eventId: string) => {
      recorder.recordWireCall({
        method: "getEvent",
        target: eventId,
        result: { found: eventsById.has(eventId) },
      });
      const event = eventsById.get(eventId);
      if (!event) {
        throw new Error(`Unknown recorded Matrix event: ${eventId}`);
      }
      return { ...structuredClone(event) };
    },
    getRelations: async (_roomId, eventId, relationType, eventType, opts) => {
      const originalEvent = eventsById.get(eventId);
      const events = [...eventsById.values()].filter((event) => {
        const relation = new MatrixEvent(event).getRelation();
        return (
          relation?.event_id === eventId &&
          relation.rel_type === relationType &&
          (!eventType || event.type === eventType) &&
          (relationType !== "m.replace" || event.sender === originalEvent?.sender)
        );
      });
      recorder.recordWireCall({
        method: "getRelations",
        target: eventId,
        payload: { relationType, eventType: eventType ?? null, limit: opts?.limit },
        result: { count: events.length },
      });
      return { originalEvent: originalEvent ?? null, events, nextBatch: null, prevBatch: null };
    },
    redactEvent: async (_roomId: string, eventId: string) => {
      // Redactions are events too: abandoning a draft consumes an event id.
      const redactionEventId = mintEventId();
      recorder.recordWireCall({
        method: "redactEvent",
        target: eventId,
        result: { event_id: redactionEventId },
      });
      return redactionEventId;
    },
    setTyping: async (roomId: string, typing: boolean, timeoutMs: number) => {
      recorder.recordWireCall({
        method: "setTyping",
        target: roomId,
        payload: { typing, timeoutMs },
      });
    },
    sendReadReceipt: async (_roomId: string, eventId: string) => {
      recorder.recordWireCall({ method: "sendReadReceipt", target: eventId });
    },
  };
  return client;
}

type MatrixTraceDeliver = (payload: ReplyPayload, info: { kind: string }) => Promise<void>;

type MatrixTraceReplyOptions = {
  onPartialReply?: (payload: { text: string }) => void;
  onBlockReplyQueued?: (
    payload: { text?: string },
    context?: { assistantMessageIndex?: number },
  ) => Promise<void> | void;
  onAssistantMessageStart?: () => void;
};

async function setupMatrixTrace(recorder: WireRecorder) {
  const client = createRecordingMatrixClient(recorder);

  let capturedDeliver: MatrixTraceDeliver | undefined;
  let capturedOnReplyStart: (() => Promise<void> | void) | undefined;
  let capturedOnIdle: (() => void) | undefined;
  let capturedReplyOptions: MatrixTraceReplyOptions | undefined;
  const { promise: captured, resolve: resolveCaptured } = Promise.withResolvers<void>();
  const notifyCaptured = () => {
    if (capturedDeliver && capturedReplyOptions) {
      resolveCaptured();
    }
  };

  // Hold dispatch until final/cancel so the real handler performs settlement and cleanup.
  type DispatchResult = { queuedFinal: boolean; counts: { final: number; block: number } };
  const { promise: runGate, resolve: releaseRun } = Promise.withResolvers<DispatchResult>();

  const { handler } = createMatrixHandlerTestHarness({
    streaming: "partial",
    blockStreamingEnabled: true,
    client,
    resolveMarkdownTableMode: () => resolveMarkdownTableMode({ cfg: {}, channel: "matrix" }),
    createReplyDispatcherWithTyping: (options: Record<string, unknown> | undefined) => {
      capturedDeliver = options?.deliver as MatrixTraceDeliver | undefined;
      capturedOnReplyStart = options?.onReplyStart as typeof capturedOnReplyStart;
      capturedOnIdle = options?.onIdle as typeof capturedOnIdle;
      notifyCaptured();
      return {
        dispatcher: { markComplete: () => {}, waitForIdle: async () => {} },
        replyOptions: {},
        markDispatchIdle: () => {},
        markRunComplete: () => {},
      };
    },
    dispatchInboundMessage: (async (args: { replyOptions?: MatrixTraceReplyOptions }) => {
      capturedReplyOptions = args?.replyOptions;
      notifyCaptured();
      const result = await runGate;
      return { queuedFinal: result.queuedFinal, counts: { ...result.counts, tool: 0 } };
    }) as never,
  });

  const handlerDone = handler(
    ROOM_ID,
    createMatrixTextMessageEvent({
      eventId: INBOUND_EVENT_ID,
      body: "deploy status?",
      originServerTs: Date.now(),
    }),
  );
  await Promise.race([
    captured,
    handlerDone.then(() => {
      throw new Error("matrix handler settled before capturing dispatcher wiring");
    }),
  ]);
  // Drain the fire-and-forget inbound read receipt so it lands at a fixed
  // position (before the first scripted step) in every recording.
  await vi.advanceTimersByTimeAsync(0);

  // A tool result begins the next assistant message and resets cumulative offsets.
  let assistantMessageIndex = 0;
  const startAssistantMessage = () => {
    assistantMessageIndex += 1;
    capturedReplyOptions?.onAssistantMessageStart?.();
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await capturedOnReplyStart?.();
        startAssistantMessage();
        break;
      case "partial":
        capturedReplyOptions?.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        await capturedReplyOptions?.onBlockReplyQueued?.(
          { text: step.text },
          { assistantMessageIndex },
        );
        await capturedDeliver?.({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        if (step.phase === "result") {
          startAssistantMessage();
        }
        break;
      case "final":
        await capturedDeliver?.(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          { kind: "final" },
        );
        releaseRun({ queuedFinal: true, counts: { final: 1, block: 0 } });
        await handlerDone;
        break;
      case "cancel":
        // Settlement without a final triggers draft cleanup.
        releaseRun({ queuedFinal: false, counts: { final: 0, block: 0 } });
        await handlerDone;
        break;
      case "idle":
        capturedOnIdle?.();
        break;
      case "wire-fault":
        throw new Error("matrix trace scenarios do not script wire faults");
    }
  };
}

const GEN_ONE_PARTIAL = "Build check:";
const GEN_ONE_BLOCK = "Build check: all suites green.";
const GEN_TWO_PARTIAL = "Deploying to production now.";
const GEN_TWO_PREVIEW = "Deploying to production now. Watching health checks.";
const GEN_TWO_FINAL = "Deploying to production now. Health checks green.";
const IN_PLACE_PARTIAL = "Ship checklist complete.";
const IN_PLACE_FINAL = "Ship checklist complete. Tagging the release.";
const MENTION_PARTIAL = "Paging @oncall:example.org";
const MENTION_FINAL = "Paging @oncall:example.org for the deploy review.";

// Each generation creates a preview and flushes one throttled edit after 1000ms.
function previewSteps(partial: string, complete: string): DeliveryTraceInStep[] {
  return [
    { kind: "partial", text: partial },
    { kind: "advance", ms: 400 },
    { kind: "partial", text: complete },
    { kind: "advance", ms: 700 },
  ];
}
const MATRIX_TRACE_SCENARIOS: readonly DeliveryTraceScenario[] = [
  {
    name: "streaming-happy-multi-generation",
    steps: [
      { kind: "reply-start" },
      ...previewSteps(GEN_ONE_PARTIAL, GEN_ONE_BLOCK),
      { kind: "block-final", text: GEN_ONE_BLOCK },
      { kind: "tool-progress", name: "deploy", phase: "start" },
      { kind: "tool-progress", name: "deploy", phase: "result" },
      ...previewSteps(GEN_TWO_PARTIAL, GEN_TWO_PREVIEW),
      { kind: "final", text: GEN_TWO_FINAL },
      { kind: "idle" },
    ],
  },
  {
    name: "final-in-place",
    steps: [
      { kind: "reply-start" },
      ...previewSteps(IN_PLACE_PARTIAL, IN_PLACE_FINAL),
      { kind: "final", text: IN_PLACE_FINAL },
      { kind: "idle" },
    ],
  },
  // Mention-bearing finals must be sent fresh before redacting the inert preview.
  {
    name: "final-mentions-fresh",
    steps: [
      { kind: "reply-start" },
      ...previewSteps(MENTION_PARTIAL, MENTION_FINAL),
      { kind: "final", text: MENTION_FINAL },
      { kind: "idle" },
    ],
  },
  deliveryTraceScenarios["cancel-mid-stream"],
];

describe("matrix delivery trace goldens", () => {
  for (const scenario of MATRIX_TRACE_SCENARIOS) {
    it(`records ${scenario.name}`, async () => {
      const events = await runDeliveryTraceScenario({ scenario, setup: setupMatrixTrace });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${scenario.name}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
