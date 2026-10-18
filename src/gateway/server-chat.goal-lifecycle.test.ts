import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  loadSessionEntry as loadStoredSessionEntry,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  getAgentEventLifecycleGeneration,
  resetAgentEventsForTest,
} from "../infra/agent-events.js";
import { registerAgentRunContext } from "../infra/agent-run-registry.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  createChatEventFixture,
  emitAgentEvents,
} from "./server-chat.agent-events.test-helpers.js";
import { createAgentEventHandler } from "./server-chat.js";
import { persistGatewaySessionLifecycleEvent } from "./session-lifecycle-state.js";

vi.mock("../config/io.js", () => ({ getRuntimeConfig: vi.fn(() => ({})) }));
// mock-isolation: The fixture supplies its persisted session entry to the lifecycle worker adapter.
const loadSessionEntryAsync = vi.hoisted(() =>
  vi.fn<typeof import("./session-entry-load.test-support.js").loadSessionEntryAsync>(),
);
vi.mock("./session-utils-store-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils-store-worker.js")>()),
  loadGatewaySessionEntryReadOnlyInWorker: () => loadSessionEntryAsync("session-terminal-error"),
}));

beforeEach(() => {
  resetAgentEventsForTest({ preserveListeners: true });
  vi.mocked(loadSessionEntryAsync).mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  resetAgentEventsForTest({ preserveListeners: true });
});

it.each([
  [
    "fallback-exhausted failure",
    { error: "LLM request failed: network connection error.", fallbackExhaustedFailure: true },
    "failed",
  ],
  [
    "provider timeout after a tool error",
    {
      error:
        "Request timed out before a response was generated. Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
      aborted: false,
      timeoutPhase: "provider",
      providerStarted: true,
    },
    "timeout",
  ],
] as const)("persists %s without waiting for retry grace", (_name, terminal, status) =>
  withOpenClawTestState({ label: "terminal-projection" }, async (state) => {
    const sessionKey = "agent:main:session-terminal-error";
    const storePath = state.statePath("agents", "main", "sessions", "sessions.json");
    const target = { storePath, sessionKey };
    const read = () => loadStoredSessionEntry({ ...target, readConsistency: "latest" });
    await replaceSessionEntry(target, {
      sessionId: "session-terminal",
      updatedAt: 1_000,
      startedAt: 1_000,
      goal: {
        schemaVersion: 1,
        id: "terminal-goal",
        objective: "Finish the requested work",
        status: "active",
        createdAt: 1_000,
        updatedAt: 1_000,
        tokenStart: 0,
        tokensUsed: 0,
        continuationTurns: 0,
      },
    });
    vi.mocked(loadSessionEntryAsync).mockImplementation(async () => ({
      cfg: {},
      agentId: "main",
      storePath,
      store: {},
      entry: read(),
      canonicalKey: sessionKey,
      storeKeys: [sessionKey],
      legacyKey: undefined,
    }));
    const persist = vi.fn(persistGatewaySessionLifecycleEvent);
    const gateway = createChatEventFixture();
    const handler = createAgentEventHandler({
      ...gateway,
      resolveSessionKeyForRun: () => sessionKey,
      loadGatewaySessionLifecycleSnapshotForEvent: () => ({
        row: { kind: "direct", ...read(), key: sessionKey },
      }),
      persistGatewaySessionLifecycleEventForEvent: persist,
    });
    const emitMany = emitAgentEvents.bind(undefined, handler);
    const drainPersistence = () => Promise.all(persist.mock.results.map((result) => result.value));
    try {
      vi.useFakeTimers();
      vi.setSystemTime(2_000);
      gateway.sessionEventSubscribers.subscribe("conn-session");
      registerAgentRunContext("run-terminal-final-failure", { sessionKey });

      await emitMany("run-terminal-final-failure", [
        ["lifecycle", { phase: "error", error: "Retryable provider failure." }],
        [
          "tool",
          { phase: "result", name: "read", isError: true, result: "An earlier tool failed." },
        ],
      ]);
      expect(read()?.goal?.status).toBe("active");
      expect(persist).not.toHaveBeenCalled();
      await emitMany("run-terminal-final-failure", [
        ["lifecycle", { phase: "error", startedAt: 1_000, endedAt: 2_000, ...terminal }],
      ]);
      await drainPersistence();

      const stoppedGoal = {
        id: "terminal-goal",
        status: "paused",
        pausedAt: 2_000,
        lastStatusNote: expect.stringContaining(terminal.error),
      };
      expect(read()).toMatchObject({
        status,
        lastRunError: terminal.error,
        endedAt: 2_000,
        goal: stoppedGoal,
      });
      expect(
        gateway.broadcastToConnIds.mock.calls.find(([event]) => event === "sessions.changed")?.[1],
      ).toMatchObject({
        status,
        lastRunError: terminal.error,
        session: { goal: stoppedGoal },
      });

      vi.setSystemTime(3_000);
      const lifecycleGeneration = getAgentEventLifecycleGeneration();
      await emitMany("run-recovered", [
        ["lifecycle", { phase: "start", startedAt: 3_000 }, { lifecycleGeneration }],
        ["lifecycle", { phase: "end", startedAt: 3_000, endedAt: 4_000 }, { lifecycleGeneration }],
      ]);
      await drainPersistence();
      await vi.advanceTimersByTimeAsync(15_000);
      expect(read()).toMatchObject({
        status: "done",
        startedAt: 3_000,
        endedAt: 4_000,
        goal: stoppedGoal,
      });
      expect(read()?.lastRunError).toBeUndefined();
      expect(
        gateway.broadcast.mock.calls
          .filter(([event]) => event === "chat")
          .map(([, payload]) => payload.state),
      ).toEqual(["error", "final"]);
    } finally {
      await handler.dispose();
      vi.useRealTimers();
    }
  }),
);
