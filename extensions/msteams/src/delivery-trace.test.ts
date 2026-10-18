// Real dispatcher/stream-controller wiring, recorded at the Bot Framework boundary.
import {
  deliveryTraceScenarios,
  expectDeliveryTraceMatchesGolden,
  runDeliveryTraceScenario,
  type DeliveryTraceInStep,
  type DeliveryTraceScenarioName,
  type WireRecorder,
} from "openclaw/plugin-sdk/channel-contract-testing";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { chunkMarkdownTextWithMode, resolveChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { describe, it } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { createMSTeamsReplyDispatcher } from "./reply-dispatcher.js";
import { setMSTeamsRuntime } from "./runtime.js";
import type { MSTeamsTurnContext } from "./sdk-types.js";

type StreamWriteFault = { atWrite: number };

function createStreamCancelledError(): Error {
  const err = new Error("stream cancelled by user Stop");
  err.name = "StreamCancelledError";
  return err;
}

function createRecordingStream(recorder: WireRecorder, fault?: StreamWriteFault) {
  let writes = 0;
  let canceled = false;
  const applyFault = (method: string, payload?: unknown): boolean => {
    writes += 1;
    if (!fault || writes < fault.atWrite) {
      return false;
    }
    // HttpStream observes the rejected POST asynchronously, not inside emit/update.
    queueMicrotask(() => {
      canceled = true;
    });
    recorder.recordWireCall({
      method,
      ...(payload !== undefined ? { payload } : {}),
      result: { error: "StreamCancelledError" },
    });
    return true;
  };
  const write = (method: string, payload: unknown) => {
    if (!applyFault(method, payload)) {
      recorder.recordWireCall({ method, payload });
    }
  };
  return {
    emit(activity: unknown): void {
      write("stream.emit", typeof activity === "string" ? { text: activity } : activity);
    },
    update(text: string): void {
      write("stream.update", { text });
    },
    clearText(): void {},
    async close(): Promise<unknown> {
      if (applyFault("stream.close")) {
        throw createStreamCancelledError();
      }
      recorder.recordWireCall({ method: "stream.close", result: { id: "stream-final" } });
      return { id: "stream-final" };
    },
    get canceled(): boolean {
      return canceled;
    },
  };
}

function createRecordingTurnContext(
  recorder: WireRecorder,
  { conversationId, conversationType }: MSTeamsTraceCase,
  stream: ReturnType<typeof createRecordingStream>,
): MSTeamsTurnContext {
  let activityCount = 0;
  const reject = (method: string) => async () => {
    throw new Error(`unexpected turn-context call: ${method}`);
  };
  return {
    activity: {
      type: "message",
      conversation: { id: conversationId, conversationType },
    },
    sendActivity: async (activity) => {
      activityCount += 1;
      const id = `activity-${activityCount}`;
      recorder.recordWireCall({
        method: "context.sendActivity",
        target: conversationId,
        payload: typeof activity === "string" ? { text: activity } : activity,
        result: { id },
      });
      return { id };
    },
    sendActivities: reject("sendActivities"),
    updateActivity: reject("updateActivity"),
    deleteActivity: reject("deleteActivity"),
    stream,
  };
}

function createTraceRuntimeStub(recorder: WireRecorder): PluginRuntime {
  return {
    channel: {
      text: {
        resolveChunkMode,
        chunkMarkdownTextWithMode,
        convertMarkdownTables,
        resolveMarkdownTableMode,
      },
    },
    system: {
      enqueueSystemEvent: (text: string, opts?: { contextKey?: string }) => {
        recorder.recordWireCall({
          method: "system.enqueueSystemEvent",
          payload: { text, contextKey: opts?.contextKey },
        });
      },
    },
  } as unknown as PluginRuntime;
}

type MSTeamsTraceCase = {
  golden: string;
  scenario: DeliveryTraceScenarioName;
  conversationType: "personal" | "channel";
  conversationId: string;
  streamWriteFault?: StreamWriteFault;
};

const MSTEAMS_TRACE_CASES: readonly MSTeamsTraceCase[] = [
  {
    golden: "streaming-happy-dm",
    scenario: "streaming-happy",
    conversationType: "personal",
    conversationId: "a:1dm-trace-conversation",
  },
  {
    golden: "block-fallback-channel",
    scenario: "streaming-happy",
    conversationType: "channel",
    conversationId: "19:channel-trace@thread.tacv2;messageid=1000",
  },
  {
    golden: "cancel-via-write-error",
    scenario: "cancel-mid-stream",
    conversationType: "personal",
    conversationId: "a:1dm-trace-conversation",
    streamWriteFault: { atWrite: 2 },
  },
];

function setupMSTeamsTrace(recorder: WireRecorder, traceCase: MSTeamsTraceCase) {
  setMSTeamsRuntime(createTraceRuntimeStub(recorder));
  const stream = createRecordingStream(recorder, traceCase.streamWriteFault);
  const context = createRecordingTurnContext(recorder, traceCase, stream);
  const created = createMSTeamsReplyDispatcher({
    cfg: { channels: { msteams: {} } } as OpenClawConfig,
    agentId: "agent",
    sessionKey: "agent:msteams:trace",
    log: { info: () => {}, error: () => {} },
    app: {} as never,
    conversationRef: {
      activityId: "inbound-activity",
      user: { id: "29:trace-user", name: "Trace User" },
      agent: { id: "28:trace-bot", name: "OpenClaw" },
      conversation: {
        id: traceCase.conversationId,
        conversationType: traceCase.conversationType,
        tenantId: "tenant-trace",
      },
      tenantId: "tenant-trace",
      channelId: "msteams",
      serviceUrl: "https://smba.trafficmanager.net/amer/",
    },
    context,
    replyStyle: "thread",
    textLimit: 4000,
  });
  const options = {
    ...created.dispatcherOptions,
    deliver: created.delivery.deliver,
  };

  return async (step: DeliveryTraceInStep) => {
    switch (step.kind) {
      case "reply-start":
        await options.onReplyStart?.();
        break;
      case "partial":
        created.replyOptions.onPartialReply?.({ text: step.text });
        break;
      case "block-final":
        await options.deliver({ text: step.text }, { kind: "block" });
        break;
      case "tool-progress":
        await created.replyOptions.onToolStart?.({ name: step.name, phase: step.phase });
        break;
      case "final":
        await options.deliver(
          {
            ...(step.text !== undefined ? { text: step.text } : {}),
            ...(step.mediaUrls ? { mediaUrls: step.mediaUrls } : {}),
            ...(step.isError ? { isError: true } : {}),
          },
          { kind: "final" },
        );
        break;
      case "cancel":
        // User Stop is observed asynchronously through the armed write fault.
        break;
      case "idle":
        await created.dispatcherOptions.onSettled?.();
        break;
      case "wire-fault":
        throw new Error("msteams trace scenarios arm stream write faults at setup instead");
    }
  };
}

describe("msteams delivery trace goldens", () => {
  for (const traceCase of MSTEAMS_TRACE_CASES) {
    it(`records ${traceCase.golden}`, async () => {
      const events = await runDeliveryTraceScenario({
        scenario: deliveryTraceScenarios[traceCase.scenario],
        setup: (recorder) => setupMSTeamsTrace(recorder, traceCase),
      });
      expectDeliveryTraceMatchesGolden({
        goldenUrl: new URL(`./__traces__/${traceCase.golden}.trace.jsonl`, import.meta.url),
        events,
      });
    });
  }
});
