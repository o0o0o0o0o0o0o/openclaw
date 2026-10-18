import { beforeEach, describe, expect, it, vi } from "vitest";
import { getRuntimeConfig } from "../config/io.js";
import {
  emitAgentEvent,
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
  withAgentRunLifecycleGeneration,
} from "../infra/agent-events.js";
import { clearAgentRunContext, registerAgentRunContext } from "../infra/agent-run-registry.js";
import {
  createChatEventFixture,
  registerChatRun,
  subscribeAgentEvents,
} from "./server-chat.agent-events.test-helpers.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";

const sessionFixture = vi.hoisted(() => ({ updatedAt: 50 }));
const sessionKey = "agent:delivery:late";

function registerRun(
  runId: string,
  overrides: Partial<Parameters<typeof registerAgentRunContext>[1]> = {},
) {
  registerAgentRunContext(runId, {
    agentId: "delivery",
    sessionKey,
    sessionId: "session",
    ...overrides,
  });
}

function publish(runId: string, stream: "assistant" | "lifecycle", data: Record<string, unknown>) {
  emitAgentEvent({ runId, stream, data });
}

// mock-isolation: Session owners are synthetic; the fixture must not load operator configuration.
vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({ agents: { entries: { main: {}, delivery: {} } } }),
}));
vi.mock("../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: () => ({ showOk: false, showAlerts: true, useIndicator: true }),
}));

describe("retired execution event projection", () => {
  beforeEach(() => {
    resetAgentEventsForTest();
    sessionFixture.updatedAt = 50;
  });

  async function withReceiver(
    emit: (chatRunState: ReturnType<typeof createChatEventFixture>["chatRunState"]) => void,
  ) {
    const fixture = createChatEventFixture();
    const { broadcast, broadcastToConnIds, nodeSendToSession, chatRunState } = fixture;
    fixture.sessionMessageSubscribers.subscribe("selected", sessionKey);
    const entry = {
      sessionId: "session",
      verboseLevel: "off" as const,
      updatedAt: sessionFixture.updatedAt,
    };
    const projection = createSessionRowProjectionFixture({
      cfg: getRuntimeConfig(),
      agentId: "delivery",
      store: { global: entry, [sessionKey]: entry },
    });
    const handler = createAgentEventHandler({
      ...fixture,
      clearAgentRunContext,
      resolveSessionKeyForRun: () => {
        throw new Error("Event lost its producer route");
      },
      loadGatewaySessionLifecycleSnapshotForEvent: () => ({ row: null }),
      persistGatewaySessionLifecycleEventForEvent: async () => {},
      getSessionRowProjection: () => projection,
    });
    const unsubscribe = subscribeAgentEvents(handler);
    try {
      withAgentRunLifecycleGeneration(getAgentEventLifecycleGeneration(), () => emit(chatRunState));
    } finally {
      try {
        await unsubscribe();
      } finally {
        await handler.dispose();
        projection.dispose();
      }
    }
    return { broadcast, broadcastToConnIds, nodeSendToSession };
  }

  function emitToolResult(runId: string, toolCallId = "finished") {
    emitAgentEvent({
      runId,
      stream: "tool",
      data: { phase: "result", name: "read", toolCallId, result: { value: "retained" } },
    });
  }

  it.each([false, true])("suppresses hidden heartbeat tools (%s)", async (isHeartbeat) => {
    const receiver = await withReceiver(() => {
      registerRun("late", {
        isControlUiVisible: false,
        projectSessionMessages: true,
        isHeartbeat,
        verboseLevel: "full",
        registeredAt: 100,
      });
      clearAgentRunContext("late");
      emitToolResult("late");
    });
    const delivered = receiver.broadcastToConnIds.mock.calls.filter(([name]) => name === "agent");
    expect(delivered).toHaveLength(isHeartbeat ? 0 : 1);
    expect(receiver.broadcast).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses newer session verbosity, including global aliases (%s)",
    async (newer) => {
      sessionFixture.updatedAt = newer ? 200 : 50;
      const receiver = await withReceiver(() => {
        registerRun("verbose", {
          sessionKey: newer ? "global" : sessionKey,
          sessionId: newer ? undefined : "session",
          verboseLevel: "full",
          registeredAt: 100,
        });
        clearAgentRunContext("verbose");
        emitToolResult("verbose", newer ? "late" : "finished");
      });
      const delivered = receiver.nodeSendToSession.mock.calls.filter(
        ([, name]) => name === "agent",
      );
      expect(delivered).toHaveLength(newer ? 0 : 1);
      if (!newer) {
        expect(delivered[0]?.[2]).toMatchObject({ data: { result: { value: "retained" } } });
      }
    },
  );

  const alert = `Service outage requires action. ${"Repair is still required. ".repeat(20)}`;
  it.each([
    { text: "HEARTBEAT_OK", expected: undefined },
    { text: `HEARTBEAT_OK ${alert}`, expected: alert.trim() },
  ])(
    "preserves heartbeat final ACK/alert policy after cleanup ($text)",
    async ({ text, expected }) => {
      const receiver = await withReceiver(() => {
        registerRun("heartbeat", { isHeartbeat: true });
        clearAgentRunContext("heartbeat");
        publish("heartbeat", "assistant", { text, delta: text });
        publish("heartbeat", "lifecycle", { phase: "end" });
      });
      const chat = receiver.broadcast.mock.calls.filter(([name]) => name === "chat");
      expect(chat.filter(([, payload]) => payload.state === "delta")).toEqual([]);
      const final = chat.filter(([, payload]) => payload.state === "final");
      expect(final).toHaveLength(1);
      if (expected) {
        expect(final[0]?.[1]).toMatchObject({ message: { content: [{ text: expected }] } });
      } else {
        expect(final[0]?.[1].message).toBeUndefined();
      }
    },
  );

  it("keeps heartbeat alias suppression separate from explicit source flags", async () => {
    const receiver = await withReceiver((chatRunState) => {
      registerRun("client", { isHeartbeat: true, sessionId: undefined });
      registerRun("source", { isHeartbeat: false, verboseLevel: "full", sessionId: undefined });
      registerChatRun(chatRunState, "source", sessionKey, "client", { agentId: "delivery" });
      publish("source", "assistant", { text: "A source event", delta: "A source event" });
      emitToolResult("source", "late");
    });
    const source = receiver.broadcast.mock.calls.find(
      ([name, payload]) => name === "agent" && payload.stream === "assistant",
    )?.[1];
    expect(source).toMatchObject({ isHeartbeat: false });
    expect(
      receiver.nodeSendToSession.mock.calls.filter(
        ([, name, payload]) => name === "agent" && payload.stream === "tool",
      ),
    ).toEqual([]);
  });
});
