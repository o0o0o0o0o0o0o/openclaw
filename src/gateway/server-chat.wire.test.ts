import { EventEmitter } from "node:events";
import path from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { buildPreparedCliRunContext } from "../agents/cli-runner.test-helpers.js";
import { persistCliAssistantTranscript } from "../agents/cli-runner/cli-run-transcript.js";
import { createCliEventHandlers } from "../agents/cli-runner/execute-events.js";
import { createCliToolTracking } from "../agents/cli-runner/execute-tool-tracking.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { type AgentEventRuntimePayload, resetAgentEventsForTest } from "../infra/agent-events.js";
import { captureSessionTarget } from "../sessions/session-controller.target.js";
import { onInternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { readAssistantDisplayContent } from "../shared/assistant-display-content.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { createAssistantTextStream } from "./agent-event-assistant-text.js";
import { abortChatRunById, registerChatAbortController } from "./chat-abort.js";
import { projectInFlightRunSnapshot } from "./chat-inflight-snapshot.js";
import { capLiveAssistantText } from "./live-chat-projector.js";
import { createGatewayBroadcaster } from "./server-broadcast.js";
import {
  emitAgentEvent,
  createChatEventFixture,
  registerChatRun,
  subscribeAgentEvents,
} from "./server-chat.agent-events.test-helpers.js";
import { createAgentEventHandler, createChatRunState } from "./server-chat.js";
import { broadcastChatFinal } from "./server-methods/chat-broadcast.js";
import { GatewayClientRegistry } from "./server/client-registry.js";
import type { GatewayWsClient } from "./server/ws-types.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-chat-wire-cli-");

function createHarness(
  audience: Omit<Parameters<typeof createGatewayBroadcaster>[0], "clients"> = {},
) {
  vi.useFakeTimers();
  const clients = new GatewayClientRegistry();
  const broadcaster = createGatewayBroadcaster({ clients, ...audience });
  const options = {
    ...createChatEventFixture(),
    broadcast: vi.fn(broadcaster.broadcast),
    broadcastToConnIds: vi.fn(broadcaster.broadcastToConnIds),
    persistGatewaySessionLifecycleEventForEvent: vi.fn(async () => undefined),
  };
  const { chatRunState } = options;
  const handler = createAgentEventHandler(options);
  return {
    ...options,
    handler,
    clients,
    broadcaster,
    registerRun(runId: string, sessionKey: string) {
      registerChatRun(chatRunState, runId, sessionKey, runId);
      const emit = (
        seq: number,
        stream: AgentEventRuntimePayload["stream"],
        data: Record<string, unknown>,
      ) => emitAgentEvent(handler, runId, stream, data, { seq });
      return Object.assign(emit, {
        snapshot: () => projectInFlightRunSnapshot({ chatRunState, runId }).text,
        end: (seq: number) => emit(seq, "lifecycle", { phase: "end" }),
        retire: (
          text: string,
          retirement: Omit<
            Parameters<typeof handler.retireTranscript>[0],
            "sessionKey" | "message"
          > & {
            message?: Record<string, unknown>;
          } = {},
        ) => {
          const { message, ...publication } = retirement;
          handler.retireTranscript({
            sessionKey,
            ...publication,
            message: { ...assistantMessage(text), __openclaw: { runId }, ...message },
          });
        },
      });
    },
    async [Symbol.asyncDispose]() {
      await handler.dispose();
      chatRunState.clear();
      options.agentRunSeq.clear();
    },
  };
}
function assistantMessage(text: string) {
  return { role: "assistant", content: [{ type: "text", text }] };
}
function answerCandidate(itemId: string, progressText: string, status = "candidate") {
  return {
    itemId,
    kind: "answer_candidate",
    title: "Answer candidate",
    phase: "update",
    status,
    progressText,
    source: "test",
    hideFromChannelProgress: true,
  };
}
function connect(
  clients: GatewayClientRegistry,
  connId: string,
  completeWrite: (callback?: () => void) => void = (callback) => callback?.(),
  caps: string[] = [],
) {
  const frames: Array<{
    event: string;
    seq: number;
    payload: {
      stream?: string;
      message?: unknown;
      data?: { text?: string; delta?: string };
      state?: string;
      deltaText?: string;
    };
  }> = [];
  const socket = Object.assign(new EventEmitter(), {
    readyState: 1,
    bufferedAmount: 0,
    send: (
      wire: string | Buffer,
      options?: { binary: false } | (() => void),
      callback?: () => void,
    ) => {
      frames.push(JSON.parse(wire.toString()));
      completeWrite(typeof options === "function" ? options : callback);
    },
    close: vi.fn(),
    terminate: vi.fn(),
  });
  const client = {
    connId,
    socket,
    usesSharedGatewayAuth: false,
    connect: {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: "test", version: "test", platform: "test", mode: "test" },
      role: "operator",
      scopes: ["operator.read"],
      caps,
    },
  } satisfies GatewayWsClient;
  clients.add(client);
  return { frames, client, socket };
}
type Frames = ReturnType<typeof connect>["frames"];
const connectChatOnly = (clients: GatewayClientRegistry, id: string) =>
  connect(clients, id, undefined, [GATEWAY_CLIENT_CAPS.CHAT_ONLY_ASSISTANT_TEXT]);
const payloads = (frames: Frames, event: string) =>
  frames.filter((frame) => frame.event === event).map((frame) => frame.payload);
const chatDeltaText = (frames: Frames) =>
  payloads(frames, "chat")
    .filter((payload) => payload.state === "delta")
    .map((payload) => payload.deltaText)
    .join("");

function expectCapturedTail(actual: string, tail: string, prefix: string) {
  if (capLiveAssistantText({ text: prefix }).length === prefix.length) {
    expect(actual).toBe(tail);
    return;
  }
  // Cumulative snapshots may correct evicted bytes, so capped multi-occurrence
  // text can retain a committed prefix; every unsaved character must survive.
  expect(actual.endsWith(tail)).toBe(true);
  expect(prefix.endsWith(actual.slice(0, -tail.length))).toBe(true);
  expect(actual.length).toBeLessThanOrEqual(capLiveAssistantText({ text: prefix + tail }).length);
}

afterEach(() => vi.useRealTimers());

it("uses display deltas independently of cumulative raw assistant snapshots", async () => {
  await using harness = createHarness();
  const { frames } = connect(harness.clients, "viewer");
  const runId = "display-deltas";
  harness.registerRun(runId, "agent:main:display-deltas");
  for (const [index, delta] of ["Hello", " world"].entries()) {
    const event: AgentEventRuntimePayload = {
      runId,
      seq: index + 1,
      ts: Date.now(),
      stream: "assistant",
      data: { itemId: "raw", text: "raw transcript text", delta },
      assistantProjection: { itemId: "display", delta, replace: false },
    };
    await harness.handler(event);
  }
  vi.advanceTimersByTime(75);
  expect(chatDeltaText(frames)).toBe("Hello world");
  expect(payloads(frames, "agent")[0]?.data?.text).toBe("raw transcript text");
});

it("retains display deltas while a hidden run has no session subscribers", async () => {
  await using harness = createHarness();
  const { frames } = connect(harness.clients, "viewer");
  const runId = "hidden-display-deltas";
  const sessionKey = "agent:main:hidden-display-deltas";
  harness.registerRun(runId, sessionKey);
  const emit = (seq: number, delta: string) => {
    const event: AgentEventRuntimePayload = {
      runId,
      sessionKey,
      seq,
      ts: Date.now(),
      stream: "assistant",
      controlUiVisible: false,
      projectSessionLifecycle: false,
      data: { itemId: "raw", text: "raw transcript text", delta },
      assistantProjection: { itemId: "display", delta, replace: false },
    };
    return harness.handler(event);
  };

  await emit(1, "Hello");
  expect(frames).toEqual([]);
  harness.sessionMessageSubscribers.subscribe("viewer", sessionKey);
  await emit(2, " world");
  harness.chatRunState.flushPendingText(runId);
  expect(chatDeltaText(frames)).toBe("Hello world");

  harness.sessionMessageSubscribers.unsubscribe("viewer", sessionKey);
  const delivered = frames.length;
  await emit(3, " hidden");
  expect(frames).toHaveLength(delivered);
  harness.sessionMessageSubscribers.subscribe("viewer", sessionKey);
  await emit(4, " again");
  harness.chatRunState.flushPendingText(runId);
  expect(chatDeltaText(frames)).toBe("Hello world hidden again");
  expect(harness.broadcast).not.toHaveBeenCalled();
  expect(harness.nodeSendToSession).not.toHaveBeenCalled();
});

it("replaces the wire baseline when a cumulative snapshot restores capped context", () => {
  const state = createChatRunState();
  const runId = "restored-context";
  state.updateBuffer(runId, { itemId: "a", text: "A".repeat(400_000) });
  state.updateBuffer(runId, { itemId: "b", text: "A".repeat(100_002) });
  state.updateBuffer(runId, { itemId: "b", text: "", replace: true });
  const baseline = state.resolveBuffer(runId).text;
  expect(baseline.length).toBe(399_996);
  state.takeBufferDelta(runId, baseline);
  state.updateBuffer(runId, { text: "A".repeat(400_001) });
  const restored = state.resolveBuffer(runId).text;
  const frame = state.takeBufferDelta(runId, restored);
  const wire = frame?.replace ? frame.deltaText : baseline + (frame?.deltaText ?? "");
  expect(wire.length).toBe(restored.length);
  expect(wire === restored).toBe(true);
});

it("restores the wire baseline when an anonymous snapshot invalidates retired ownership", async () => {
  await using harness = createHarness();
  const { frames } = connectChatOnly(harness.clients, "viewer");
  const runId = "anonymous-reset";
  const sessionKey = "agent:main:anonymous-reset";
  const emit = harness.registerRun(runId, sessionKey);
  await emit(1, "assistant", { itemId: "saved", text: "Saved." });
  emit.retire("Saved.", {
    messageSeq: 2,
    assistantItemIds: ["saved"],
  });
  expect(payloads(frames, "chat").at(-1)).toMatchObject({ deltaText: "", replace: true });
  await emit(2, "assistant", { text: "Saved. More." });
  vi.advanceTimersByTime(75);
  expect(payloads(frames, "chat").at(-1)).toMatchObject({
    deltaText: "Saved. More.",
  });
});

it("keeps literal control tails through the capped terminal wire flush", async () => {
  await using harness = createHarness();
  const { frames } = connectChatOnly(harness.clients, "viewer");
  const runId = "literal-control";
  const sessionKey = "agent:main:literal-control";
  const emit = harness.registerRun(runId, sessionKey);
  const prefix = "The token is " + " ".repeat(500_000);
  const tail = `${SILENT_REPLY_TOKEN}.`;
  await emit(1, "assistant", { itemId: "native", occurrenceId: "a", text: prefix });
  await emit(2, "assistant", { itemId: "native", occurrenceId: "b", text: prefix + tail });
  emit.retire(prefix, {
    messageSeq: 2,
    assistantItemIds: ["a"],
  });
  const display = harness.chatRunState.resolveBuffer(runId).text;
  expect(display.trim()).toBe(tail);
  await emit.end(3);
  const delta = payloads(frames, "chat").findLast((payload) => payload.state === "delta");
  expect
    .soft(
      readAssistantDisplayContent(delta?.message)[0]?.text === display,
      "pending flush preserves the display tail",
    )
    .toBe(true);
  const final = payloads(frames, "chat").at(-1);
  expect(final?.state).toBe("final");
  expect(
    readAssistantDisplayContent(final?.message)[0]?.text === display,
    "terminal frame retains display-only content",
  ).toBe(true);
});

it("preserves an unfinished native replacement when an earlier matching prefix persists", async () => {
  await using harness = createHarness();
  const sessionKey = "agent:main:native-steer";
  const emit = harness.registerRun("native-steer", sessionKey);
  await emit(1, "assistant", { itemId: "completed", text: "Same.", replaceable: true });
  await emit(2, "assistant", {
    itemId: "unfinished",
    text: "Same. tail",
    replace: true,
    replaceable: true,
  });
  emit.retire("Same.", {
    messageSeq: 2,
    assistantItemIds: ["completed"],
    message: { idempotencyKey: "codex-app-server:thread:turn:assistant:completed" },
  });
  expect(harness.chatRunState.resolveBuffer("native-steer").text).toBe("Same. tail");
});

it.each([
  { name: "short", prefix: "A", preceding: false },
  { name: "capped after another item", prefix: "A".repeat(600_000), preceding: true },
])(
  "retires a captured occurrence while the same native item continues ($name)",
  async ({ prefix, preceding }) => {
    await using harness = createHarness();
    const sessionKey = "agent:main:occurrence-tail";
    const runId = "occurrence-tail";
    const wireEmit = harness.registerRun(runId, sessionKey);
    const rawStream = createAssistantTextStream(false);
    const emit = async (seq: number, occurrenceId: string, text: string, delta: string) => {
      const data = { itemId: "answer", occurrenceId, text, delta };
      rawStream.update(data);
      await wireEmit(seq, "assistant", data);
    };
    if (preceding) {
      const data = { itemId: "earlier", text: "Earlier." };
      rawStream.update(data);
      await wireEmit(0, "assistant", data);
    }
    await emit(1, "captured", prefix, prefix);
    await emit(2, "tail", `${prefix}B`, "B");
    wireEmit.retire(prefix, {
      messageSeq: 2,
      assistantItemIds: [...(preceding ? ["earlier"] : []), "captured"],
    });
    const tail = wireEmit.snapshot();
    expectCapturedTail(tail, "B", prefix);
    expect(harness.chatRunState.resolveBuffer(runId, { final: true }).text).toBe(
      `${prefix}B`.slice(-500_000),
    );
    await emit(3, "tail", `${prefix}BC`, "C");
    expectCapturedTail(wireEmit.snapshot(), "BC", prefix);
    expect(rawStream.streamedText).toBe(`${preceding ? "Earlier.\n\n" : ""}${prefix}BC`);
    expect(harness.chatRunState.resolveBuffer(runId, { final: true }).text).toBe(
      `${prefix}BC`.slice(-500_000),
    );
  },
);

it.each([
  { name: "capped", saved: "A".repeat(600_000), preceding: false },
  { name: "earlier committed item", saved: "A", preceding: true },
])(
  "preserves the next answer after clearing a native item ($name)",
  async ({ saved, preceding }) => {
    await using harness = createHarness();
    const { frames } = connect(harness.clients, "control-ui");
    const runId = "cleared-native-item";
    const sessionKey = "agent:main:cleared-native-item";
    const emit = harness.registerRun(runId, sessionKey);
    const commit = (itemId: string, text: string) =>
      emit.retire(text, { assistantItemIds: [itemId] });
    if (preceding) {
      await emit(0, "assistant", { itemId: "earlier", text: "Earlier." });
      commit("earlier", "Earlier.");
    }
    await emit(1, "assistant", { itemId: "native", occurrenceId: "saved", text: saved });
    commit("saved", saved);
    await emit(2, "assistant", { itemId: "native", occurrenceId: "pending", text: `${saved}B` });
    expectCapturedTail(emit.snapshot(), "B", saved);
    await emit(3, "assistant", {
      itemId: "native",
      occurrenceId: "pending",
      text: "",
      replace: true,
    });
    expect(emit.snapshot()).toBe("");
    await emit(4, "assistant", { itemId: "answer", text: "Done" });
    commit("saved", saved);
    harness.chatRunState.flushPendingText(runId);
    expect(emit.snapshot()).toBe("Done");
    expect(payloads(frames, "chat").at(-1)).toMatchObject({ deltaText: "Done" });
    await emit.end(5);
    expect(payloads(frames, "chat").at(-1)).toMatchObject({
      state: "final",
      message: { content: [{ type: "text", text: `${preceding ? "Earlier.\n\n" : ""}Done` }] },
    });
  },
);

it("keeps nonempty native replacement and the next item outside retired positions", () => {
  const saved = "😀";
  const replacement = "😁";
  const state = createChatRunState();
  const runId = "nonempty-replacement";
  state.updateBuffer(runId, { itemId: "native", occurrenceId: "saved", text: saved });
  state.retireBuffer(runId, ["saved"]);
  state.updateBuffer(runId, { itemId: "native", occurrenceId: "pending", text: `${saved}B` });
  state.updateBuffer(runId, {
    itemId: "native",
    occurrenceId: "pending",
    text: replacement,
    replace: true,
  });
  expect.soft(state.resolveBuffer(runId).text).toBe(replacement);
  state.updateBuffer(runId, { itemId: "next", text: "Done" });
  expect(projectInFlightRunSnapshot({ chatRunState: state, runId }).text).toBe(
    `${replacement}\n\nDone`,
  );
  const final = state.resolveBuffer(runId, { final: true });
  expect(final.displayText ?? final.text).toBe(`${replacement}\n\nDone`);
});

it("preserves unsaved text after replacing a fully evicted occurrence", () => {
  const state = createChatRunState();
  const runId = "evicted-retirement";
  const itemId = "native";
  const saved = "a".repeat(100_000);
  const pending = "b".repeat(500_000);
  state.updateBuffer(runId, { itemId, occurrenceId: "saved", text: saved });
  state.updateBuffer(runId, { itemId, occurrenceId: "pending", text: saved + pending });
  state.retireBuffer(runId, ["saved"]);
  const unsaved = pending.slice(0, -50_000);
  const replacement = saved + unsaved;
  state.updateBuffer(runId, {
    itemId,
    occurrenceId: "pending",
    text: replacement,
    replace: true,
  });
  const available = capLiveAssistantText({ text: replacement });
  const availableSaved = available.slice(0, -unsaved.length);
  const final = state.resolveBuffer(runId, { final: true });
  const views: Array<[string, string]> = [
    ["live", state.resolveBuffer(runId).text],
    ["snapshot", projectInFlightRunSnapshot({ chatRunState: state, runId }).text],
    ["display-final", final.displayText ?? final.text],
  ];
  for (const [view, actual] of views) {
    expect(actual.endsWith(unsaved), `${view} retains every unsaved character`).toBe(true);
    expect(actual.length, `${view} respects the display cap`).toBeLessThanOrEqual(available.length);
    const prefix = actual.slice(0, -unsaved.length);
    expect(
      availableSaved.endsWith(prefix),
      `${view} only duplicates available committed text`,
    ).toBe(true);
  }
});

it("keeps unidentified third-party text live through unrelated commits", async () => {
  await using harness = createHarness();
  const { frames } = connectChatOnly(harness.clients, "existing");
  const sessionKey = "agent:main:unkeyed-replacement";
  const runId = "unkeyed-replacement";
  const emit = harness.registerRun(runId, sessionKey);
  const persist = (messageSeq: number) => emit.retire("Saved.", { messageSeq });
  await emit(1, "assistant", { text: "Draft" });
  persist(2);
  const replacement = "Saved.\n\nNew answer";
  await emit(2, "assistant", { text: replacement, replace: true });
  expect(emit.snapshot()).toBe(replacement);
  expect(payloads(frames, "chat").at(-1)).toMatchObject({
    replace: true,
    deltaText: replacement,
  });
  await emit(3, "assistant", { delta: " More." });
  vi.advanceTimersByTime(75);
  expect(payloads(frames, "chat").at(-1)).toMatchObject({ deltaText: " More." });
  persist(3);
  expect(emit.snapshot()).toBe("Saved.\n\nNew answer More.");
});

it("replaces committed live text and preserves an indented tail for existing and returning clients", async () => {
  const tail = "    const value = 1;";
  await using harness = createHarness({ canReceiveSessionEvent: () => true });
  const { frames } = connectChatOnly(harness.clients, "existing");
  const sessionKey = "agent:main:tail";
  const emit = harness.registerRun("tail-run", sessionKey);
  await emit(1, "assistant", { itemId: "saved", text: "Saved.", delta: "Saved." });
  await emit(2, "assistant", { itemId: "tail", text: tail, delta: tail });
  emit.retire("Saved.", {
    messageSeq: 2,
    message: { idempotencyKey: "saved" },
  });
  expect(payloads(frames, "chat").at(-1)).toMatchObject({
    replace: true,
    deltaText: tail,
    message: { content: [{ type: "text", text: tail }] },
  });
  const { frames: returning } = connectChatOnly(harness.clients, "returning");
  expect(harness.chatRunState.resolveBuffer("tail-run").text).toBe(tail);
  await emit(3, "assistant", { itemId: "tail", text: `${tail} More.`, delta: " More." });
  vi.advanceTimersByTime(75);
  expect(payloads(frames, "chat").at(-1)).toMatchObject({ deltaText: " More." });
  expect(payloads(returning, "chat").at(-1)).toMatchObject({
    message: { content: [{ type: "text", text: `${tail} More.` }] },
  });
  await emit.end(4);
  expect(payloads(frames, "chat").at(-1)).toMatchObject({
    state: "final",
    message: { content: [{ type: "text", text: `Saved.\n\n${tail} More.` }] },
  });
  expect(payloads(frames, "chat").findLast((payload) => payload.state === "delta")).toMatchObject({
    deltaText: " More.",
  });
});

it("keeps non-text agent events for chat-only clients", async () => {
  const onBroadcast = vi.fn();
  await using harness = createHarness({ onBroadcast, canReceiveSessionEvent: () => true });
  const { clients } = harness;
  const { frames: legacy } = connect(clients, "legacy");
  const { frames: chatOnly } = connectChatOnly(clients, "chat-only");
  const runId = "progress-run";
  const emit = harness.registerRun(runId, "agent:main:progress");
  harness.toolEventRecipients.add(runId, "legacy");
  harness.toolEventRecipients.add(runId, "chat-only");
  const events: Array<Pick<AgentEventRuntimePayload, "stream" | "data">> = [
    { stream: "assistant", data: { text: "Hello", delta: "Hello" } },
    { stream: "tool", data: { phase: "start", name: "read", toolCallId: "tool-1" } },
    { stream: "item", data: answerCandidate("candidate", "Progress") },
    { stream: "usage", data: { outputTokens: 1 } },
    { stream: "run_status", data: { phase: "retrying", message: "Retrying" } },
    { stream: "plan", data: { phase: "update", steps: [] } },
    { stream: "approval", data: { phase: "requested", approvalId: "approval-1" } },
    { stream: "thinking", data: { text: "Thinking" } },
    { stream: "assistant", data: { mediaUrl: "https://example.com/image.png" } },
    { stream: "lifecycle", data: { phase: "finishing" } },
  ];
  for (const [index, { stream, data }] of events.entries()) {
    await emit(index + 1, stream, data);
  }
  harness.chatRunState.flushPendingText(runId);
  const progress = payloads(chatOnly, "agent");
  expect(progress.map((payload) => payload.stream)).toEqual(
    events.slice(1).map(({ stream }) => stream),
  );
  expect(progress).toEqual(payloads(legacy, "agent").slice(1));
  expect(onBroadcast).toHaveBeenCalledWith(
    "agent",
    expect.objectContaining({ stream: "assistant", data: { text: "Hello", delta: "Hello" } }),
    expect.any(Object),
  );
  expect(chatOnly.map(({ seq }) => seq)).toEqual(chatOnly.map((_, index) => index + 1));
});

it("sends append-only wire text while retaining snapshots for observers and late recipients", async () => {
  let visible = true;
  await using harness = createHarness({ canReceiveSessionEvent: () => visible });
  const { clients, chatRunState } = harness;
  const { frames } = connect(clients, "first");
  const { frames: chatOnly } = connectChatOnly(clients, "chat-only");
  const wireEmit = harness.registerRun("wire-run", "agent:main:wire");
  const emit = async (
    seq: number,
    text: string | undefined,
    delta: string | undefined,
    replace?: true,
    itemId = "answer",
  ) => {
    await wireEmit(seq, "assistant", { itemId, text, delta, replace });
    chatRunState.flushPendingText("wire-run");
  };
  await emit(1, undefined, "Hello");
  const { frames: late } = connect(clients, "late");
  await emit(2, undefined, " world");
  expect(payloads(frames, "chat")).toEqual([
    expect.objectContaining({
      message: expect.any(Object),
      deltaText: "Hello",
    }),
    expect.not.objectContaining({ message: expect.anything() }),
  ]);
  expect(payloads(frames, "agent").at(-1)?.data).toEqual({
    itemId: "answer",
    delta: " world",
  });
  expect(payloads(late, "chat")[0]?.message).toMatchObject({
    content: [{ type: "text", text: "Hello world" }],
  });
  expect(payloads(late, "agent")[0]?.data?.text).toBe("Hello world");
  expect(harness.broadcast.mock.calls.findLast(([event]) => event === "agent")?.[1]).toMatchObject({
    data: { text: "Hello world" },
  });
  await emit(3, "Rewritten", "", true);
  expect(payloads(frames, "chat").at(-1)).toMatchObject({
    replace: true,
    message: { content: [{ type: "text", text: "Rewritten" }] },
  });
  visible = false;
  await emit(4, "Reset", undefined);
  visible = true;
  await emit(5, "Reset!", "!");
  expect(payloads(frames, "agent").at(-1)?.data?.text).toBe("Reset!");
  await emit(6, "Other", "Other", undefined, "other");
  expect(payloads(frames, "chat").at(-1)).toMatchObject({
    deltaText: "\n\nOther",
  });
  expect(wireEmit.snapshot()).toBe("Reset!\n\nOther");
  await emit(7, "Reset! again", " again", undefined, "followup");
  expect(payloads(frames, "agent").at(-1)?.data?.text).toBe("Reset! again");
  wireEmit.retire("Other", {
    messageSeq: 1,
    assistantItemIds: ["other"],
  });
  expect(wireEmit.snapshot()).toBe("Reset!\n\nReset! again");
  await wireEmit.end(8);
  expect(frames.at(-1)?.payload).toMatchObject({
    state: "final",
    message: { content: [{ type: "text", text: "Reset!\n\nOther\n\nReset! again" }] },
  });
  expect(readAssistantDisplayContent(frames.at(-1)?.payload.message)).toEqual([
    { type: "text", text: "Reset!\n\nReset! again" },
  ]);
  expect(chatOnly.map(({ event, payload }) => ({ event, payload }))).toEqual(
    frames
      .filter(({ event, payload }) => event !== "agent" || payload.stream !== "assistant")
      .map(({ event, payload }) => ({ event, payload })),
  );
  expect(chatOnly.map(({ seq }) => seq)).toEqual(chatOnly.map((_, index) => index + 1));
});

it.each(["immediate", "paced", "slow"])(
  "preserves real CLI output transforms through %s wire delivery",
  async (mode) => {
    const replacement = "foobaz";
    const harness = createHarness();
    const { clients, broadcaster, handler, chatRunState } = harness;
    const callbacks: Array<() => void> = [];
    let hold = false;
    const { frames } = connect(clients, "cli-reader", (callback) => {
      if (callback && hold) {
        callbacks.push(callback);
      } else {
        callback?.();
      }
    });
    const runId = `cli-transform-${mode}`;
    harness.registerRun(runId, `agent:main:${runId}`);
    const context = buildPreparedCliRunContext({ runId });
    context.backendResolved.textTransforms = { output: [{ from: /foobar/g, to: replacement }] };
    const cli = createCliEventHandlers({
      context,
      toolTracking: createCliToolTracking(context),
      getRunState: () => ({ failed: false, error: undefined }),
    });
    const dispose = subscribeAgentEvents((event) => {
      if (event.runId === runId) {
        return handler(event);
      }
    });
    try {
      cli.emitCliAssistantDelta({ text: "foo", delta: "foo" });
      await dispose.drain();
      chatRunState.flushPendingText(runId);
      if (mode === "slow") {
        hold = true;
        broadcaster.broadcast("tick", {});
      }
      cli.emitCliAssistantDelta({ text: "foobar", delta: "bar" });
      await dispose.drain();
      if (mode !== "paced") {
        chatRunState.flushPendingText(runId);
      }
      cli.emitCliAssistantDelta({ text: "foobarbaz", delta: "baz" });
      await dispose.drain();
      chatRunState.flushPendingText(runId);
      hold = false;
      while (callbacks.length) {
        callbacks.shift()?.();
      }
      const itemId = `cli-assistant:${runId}`;
      expect(payloads(frames, "agent").map((payload) => payload.data)).toEqual([
        { itemId, text: "foo", delta: "foo" },
        ...(mode === "immediate"
          ? [
              { itemId, text: replacement, delta: "bar" },
              { itemId, delta: "baz" },
            ]
          : [{ itemId, text: `${replacement}baz`, delta: "barbaz" }]),
      ]);
    } finally {
      try {
        await dispose();
      } finally {
        await harness[Symbol.asyncDispose]();
        resetAgentEventsForTest({ preserveListeners: true });
      }
    }
  },
);

it("retires a real CLI reply before its corrected source snapshot arrives", async () => {
  await using harness = createHarness();
  vi.useRealTimers();
  const root = sessionDirs.make();
  const runId = "cli-committed-correction";
  const target = {
    agentId: "main",
    sessionId: "cli-session",
    sessionKey: `agent:main:${runId}`,
    storePath: path.join(root, "agents", "main", "agent", "openclaw-agent.sqlite"),
  };
  await upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: Date.now() });
  harness.registerRun(runId, target.sessionKey);
  const context = buildPreparedCliRunContext({
    runId,
    sessionTarget: target,
    workspaceDir: root,
    config: {},
  });
  context.params.storePath = target.storePath;
  context.params.persistAssistantTranscript = true;
  const cli = createCliEventHandlers({
    context,
    toolTracking: createCliToolTracking(context),
    getRunState: () => ({ failed: false, error: undefined }),
  });
  const stopEvents = subscribeAgentEvents((event) => {
    if (event.runId === runId) {
      return harness.handler(event);
    }
  });
  const stopTranscript = onInternalSessionTranscriptUpdate(harness.handler.retireTranscript);
  try {
    cli.emitCliAssistantDelta({ text: "Preview", delta: "Preview" });
    await stopEvents.drain();
    harness.chatRunState.flushPendingText(runId);
    expect(harness.chatRunState.resolveBuffer(runId).text).toBe("Preview");

    const persisted = await persistCliAssistantTranscript({
      runParams: context.params,
      text: "Selected",
      modelId: context.modelId,
      stopReason: "stop",
    });
    expect(persisted).toMatchObject({
      owned: true,
      terminalAnchor: { entryId: expect.any(String) },
    });
    expect(harness.chatRunState.resolveBuffer(runId).text).toBe("");

    cli.emitCliAssistantDelta({ text: "Selected", delta: "" });
    await stopEvents.drain();
    harness.chatRunState.flushPendingText(runId);
    expect(harness.chatRunState.resolveBuffer(runId).text).toBe("");
    expect(harness.chatRunState.resolveBuffer(runId, { final: true }).text).toBe("Selected");
  } finally {
    stopTranscript();
    await stopEvents();
    resetAgentEventsForTest({ preserveListeners: true });
  }
});

it.each([true, false])(
  "re-baselines after an upstream sequence gap (visible=%s)",
  async (visible) => {
    await using harness = createHarness();
    const { clients, handler, chatRunState } = harness;
    const { frames } = connect(clients, "gap-reader");
    const { frames: chatOnly } = connectChatOnly(clients, "chat-only");
    const runId = "gap-run";
    const sessionKey = "agent:main:gap-proof";
    harness.sessionMessageSubscribers.subscribe("gap-reader", sessionKey);
    harness.sessionMessageSubscribers.subscribe("chat-only", sessionKey);
    const emit = (seq: number, text: string, delta: string) => {
      const event: AgentEventRuntimePayload = {
        runId,
        sessionKey,
        seq,
        ts: seq,
        stream: "assistant",
        controlUiVisible: visible,
        projectSessionLifecycle: false,
        data: { itemId: "reply", phase: "commentary", text, delta },
      };
      return handler(event);
    };
    await emit(1, "A", "A");
    await emit(2, "AB", "B");
    // Keep B paced when the source skips C. The next known snapshot must repair both.
    await emit(4, "ABCD", "D");
    chatRunState.flushPendingText(runId);
    expect(payloads(frames, "agent").at(-1)?.data).toMatchObject({ text: "ABCD", delta: "D" });
    await emit(5, "ABCDE", "E");
    chatRunState.flushPendingText(runId);
    expect(payloads(frames, "agent").at(-1)?.data).toEqual({
      itemId: "reply",
      phase: "commentary",
      delta: "E",
    });
    expect(chatOnly.some(({ payload }) => payload.stream === "assistant")).toBe(false);
    expect(payloads(chatOnly, "chat")).toEqual(payloads(frames, "chat"));
    expect(chatOnly.map(({ seq }) => seq)).toEqual(chatOnly.map((_, index) => index + 1));
  },
);

it.each(["native", "dispatch", "abort", "retry", "clearRun", "clear"] as const)(
  "bounds connection snapshots until %s completion without losing the terminal reply",
  async (terminal) => {
    await using harness = createHarness();
    const { chatRunState, nodeSendToSession, clients, broadcaster } = harness;
    const callbacks: Array<() => void> = [];
    const { frames, client, socket } = connect(clients, "held-reader", (callback) => {
      if (callback) {
        callbacks.push(callback);
      }
    });
    const runId = "backpressured-run";
    const sessionKey = "agent:main:backpressured";
    const emit = harness.registerRun(runId, sessionKey);
    const chunks = Array.from({ length: 24 }, (_, i) => `[${i}]${"abc🚀".repeat(64)}`);
    let expected = chunks.join("");

    let text = "";
    for (const [index, delta] of chunks.entries()) {
      text += delta;
      await emit(index * 2 + 1, "item", answerCandidate("answer", text));
      await emit(index * 2 + 2, "assistant", { text, delta });
      vi.advanceTimersByTime(75);
    }
    // The existing producer pacing still delivers updates to nodes, but a
    // socket with an unfinished write must not retain every historical prefix.
    expect(nodeSendToSession.mock.calls.length).toBeGreaterThan(chunks.length);
    expect(frames.length).toBeLessThan(6);
    if (terminal === "retry" || terminal === "clearRun" || terminal === "clear") {
      expect(broadcaster.getBufferedAmount(client.connId)).toBeGreaterThan(socket.bufferedAmount);
      if (terminal === "retry") {
        await emit(49, "assistant", { text: `${expected} failed tail` });
        await emit(50, "lifecycle", { phase: "error", error: "retryable failure" });
        expect(chatDeltaText(frames)).toBe(`${expected} failed tail`);
      } else if (terminal === "clearRun") {
        chatRunState.clearRun(runId);
      } else {
        chatRunState.clear();
        harness.registerRun(runId, sessionKey);
      }
      expect(broadcaster.getBufferedAmount(client.connId)).toBe(socket.bufferedAmount);
      expected = "successor reply";
      await emit(51, "assistant", { text: expected, delta: expected });
      await emit(52, "lifecycle", { phase: "end" });
    } else if (terminal === "native") {
      await emit(chunks.length * 2 + 1, "item", answerCandidate("answer", expected, "selected"));
      await emit(chunks.length * 2 + 2, "lifecycle", { phase: "end" });
    } else if (terminal === "dispatch") {
      broadcastChatFinal({
        terminalEntry: undefined,
        context: { ...harness, ...broadcaster },
        runId,
        sessionKey,
        message: { role: "assistant", content: [{ type: "text", text: expected }] },
      });
      chatRunState.clearRun(runId);
    } else {
      const registration = registerChatAbortController({
        target: captureSessionTarget({
          storeScope: "/synthetic/chat-wire/" + runId,
          sessionKey,
          incarnation: runId,
        }),
        runId,
        sessionId: runId,
        sessionKey,
        timeoutMs: 60_000,
      });
      try {
        expect(registration.registered).toBe(true);
        expect(
          abortChatRunById(
            {
              ...harness,
              ...broadcaster,
              removeChatRun: (sourceRunId, clientRunId, key) =>
                chatRunState.registry.remove(sourceRunId, clientRunId, key),
            },
            { runId, sessionKey },
          ).aborted,
        ).toBe(true);
      } finally {
        registration.cleanup();
      }
    }
    const beforeDrain = frames.length;
    while (callbacks.length) {
      callbacks.shift()?.();
    }
    expect(frames).toHaveLength(beforeDrain);
    expect(frames.map(({ seq }) => seq)).toEqual(frames.map((_, index) => index + 1));
    expect(frames.at(-1)).toMatchObject({
      event: "chat",
      payload: {
        state: terminal === "abort" ? "aborted" : "final",
        message: { content: [{ type: "text", text: expected }] },
      },
    });
    if (terminal === "native" || terminal === "dispatch") {
      expect(
        payloads(frames, "agent")
          .filter((payload) => payload.stream === "assistant")
          .map((payload) => payload.data?.delta)
          .join(""),
      ).toBe(expected);
      expect(chatDeltaText(frames)).toBe(expected);
    }
    expect(socket.close).not.toHaveBeenCalled();
  },
);
