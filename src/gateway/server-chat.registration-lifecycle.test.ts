import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resetAgentEventsForTest } from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  chatBroadcastCalls,
  createAgentEventTestHarness,
  type AgentEventTestHarnessOptions,
} from "./server-chat.agent-events.test-harness.js";
import { createChatAbortMarker } from "./server-chat.js";
import { broadcastChatError } from "./server-methods/chat-broadcast.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: vi.fn(() => ({
    showOk: false,
    showAlerts: true,
    useIndicator: true,
  })),
}));

const persistGatewaySessionLifecycleEventMock = vi.fn();
const sessionKey = "session";

beforeEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  persistGatewaySessionLifecycleEventMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest({ preserveListeners: true });
});

function createHarness(params?: AgentEventTestHarnessOptions) {
  const harness = createAgentEventTestHarness({
    ...params,
    persistGatewaySessionLifecycleEventForEvent: persistGatewaySessionLifecycleEventMock,
  });
  onTestFinished(() => harness.handler.dispose());
  return harness;
}

function createRetryHarness() {
  vi.useFakeTimers();
  return createHarness({
    resolveSessionKeyForRun: () => sessionKey,
    lifecycleErrorRetryGraceMs: 100,
  });
}

describe("chat run registration lifecycle", () => {
  it("releases finalized hidden run registrations without message subscribers", async () => {
    const h = createHarness();
    for (let index = 0; index < 300; index += 1) {
      const runId = `hidden-run-${index}`;
      h.register(runId, "agent:main:hidden", runId);
      registerAgentRunContext(runId, {
        sessionKey: "agent:main:hidden",
        isControlUiVisible: false,
        projectSessionMessages: true,
        projectSessionLifecycle: false,
      });
      await h.emit(runId, "lifecycle", { phase: "end" });
    }
    expect(h.chat()).toHaveLength(0);
    expect(h.chatRunState.runs.size).toBe(0);
  });

  it("cancels deferred lifecycle errors when the handler is disposed", async () => {
    const h = createRetryHarness();

    await h.emit(
      "run-dispose",
      "lifecycle",
      { phase: "error", error: "retryable provider failure" },
      { sessionKey, ts: 2_000 },
    );
    expect(vi.getTimerCount()).toBe(1);

    await h.handler.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);

    expect(h.clearAgentRunContext).not.toHaveBeenCalled();
    expect(persistGatewaySessionLifecycleEventMock).not.toHaveBeenCalled();
    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
  });

  it.each([false, true])("honors only current same-ms abort markers (%s)", async (current) => {
    const h = createHarness({ now: 2_000 });
    if (!current) {
      const staleMarker = { abortedAtMs: 2_000, sequence: -1 };
      h.chatRunState.getOrCreate("client-abort").abortMarker = staleMarker;
    }
    h.registerNamed("abort");
    if (current) {
      h.chatRunState.getOrCreate("client-abort").abortMarker = createChatAbortMarker();
    }
    await h.emit("run-abort", "assistant", { text: "Output", delta: "Output" }, { ts: 2_100 });
    const end = current ? { phase: "end", aborted: true, stopReason: "rpc" } : { phase: "end" };
    await h.emit("run-abort", "lifecycle", end, { seq: 2, ts: 2_200 });
    const states = h.chat().map(([, payload]) => payload.state);
    expect(states).toEqual(current ? [] : ["delta", "final"]);
    expect(h.nodeChat()).toHaveLength(current ? 0 : 2);
    expect(h.chatRunState.runs.get("client-abort")?.abortMarker).toBeDefined();
    expect(h.chatRunState.registry.peek("run-abort")).toBeUndefined();
  });

  it("keeps chat-linked run remapping alive across per-attempt lifecycle errors", async () => {
    const h = createRetryHarness();
    const runId = "retry",
      clientRunId = "client";
    h.register(runId, sessionKey, clientRunId);
    const expectRegistration = (seq: number) => {
      expect(h.chatRunState.registry.peek(runId)).toMatchObject({ sessionKey, clientRunId });
      expect(h.clearAgentRunContext).not.toHaveBeenCalled();
      expect(h.agentRunSeq.get(runId)).toBe(seq);
    };

    await h.emitMany(runId, [
      ["assistant", { text: "draft" }],
      ["lifecycle", { phase: "error", error: "provider failed" }],
    ]);

    expectRegistration(2);

    await h.emit(
      runId,
      "lifecycle",
      {
        phase: "fallback",
        selectedProvider: "fireworks",
        selectedModel: "fireworks/accounts/fireworks/routers/kimi-k2p5-turbo",
        activeProvider: "deepinfra",
        activeModel: "moonshotai/Kimi-K2.5",
      },
      { seq: 3, sessionKey },
    );
    const fallback = {
      runId: clientRunId,
      data: { phase: "fallback" },
    };
    expect(h.agent().at(-1)?.[1]).toMatchObject(fallback);
    expect(h.nodeAgent().at(-1)?.[2]).toMatchObject(fallback);

    vi.advanceTimersByTime(100);

    expectRegistration(3);
    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");

    await h.end(runId, 4);

    expect(h.chat().map(([, payload]) => payload.state)).not.toContain("error");
    expect(h.chat().at(-1)?.[1]).toMatchObject({ state: "final", runId: clientRunId });
    expect(h.clearAgentRunContext).toHaveBeenCalledWith(runId);
    expect(h.agentRunSeq.has(runId)).toBe(false);
  });

  it.each([false, true])("preserves reply-dispatch ownership (settled=%s)", async (settled) => {
    vi.useFakeTimers();
    const trackTrackedRunTerminalPersistence = vi.fn();
    const harness = createHarness({
      resolveSessionKeyForRun: () => sessionKey,
      trackTrackedRunTerminalPersistence,
    });
    const { broadcast, chatRunState, clearAgentRunContext, agentRunSeq } = harness;
    const runId = "run-reply-dispatch";
    harness.register(runId, sessionKey, runId);
    registerAgentRunContext(runId, { sessionKey });
    chatRunState.getOrCreate(runId).buffer = "pending delivered reply";

    await harness.emit(runId, "lifecycle", {
      phase: "error",
      error: "ACP turn failed",
      completionSource: "reply-dispatch",
      ...(settled ? { executionSettled: true } : {}),
    });
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledTimes(settled ? 1 : 0);
    expect.soft(chatRunState.runs.get(runId)?.buffer).toBe("pending delivered reply");
    expect(agentRunSeq.get(runId)).toBe(1);
    if (settled) {
      broadcastChatError({
        terminalEntry: undefined,
        context: harness,
        runId,
        sessionKey,
        errorMessage: "ACP turn failed",
      });
      chatRunState.clearRun(runId);
      chatRunState.registry.remove(runId, runId);
    }

    // Drain pending persistence or legacy grace after the dispatch owner's action.
    await vi.runAllTimersAsync();

    const terminals = chatBroadcastCalls(broadcast);
    expect(terminals).toHaveLength(settled ? 1 : 0);
    if (settled) {
      expect(terminals[0]?.[1]).toMatchObject({ state: "error", seq: 2 });
      expect(agentRunSeq.has(runId)).toBe(false);
    } else {
      expect(chatRunState.runs.get(runId)?.buffer).toBe("pending delivered reply");
      expect(chatRunState.registry.peek(runId)?.clientRunId).toBe(runId);
      expect(agentRunSeq.get(runId)).toBe(1);
    }
    expect(clearAgentRunContext).not.toHaveBeenCalled();
    expect(persistGatewaySessionLifecycleEventMock).toHaveBeenCalledOnce();
    expect(trackTrackedRunTerminalPersistence).toHaveBeenCalledWith({
      runId,
      clientRunId: runId,
      sessionKey,
      sessionId: undefined,
      persistence: expect.any(Promise),
    });
  });
});
