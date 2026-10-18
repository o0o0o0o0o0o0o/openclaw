import { describe, expect, it } from "vitest";
import {
  evaluateChannelHealth,
  resolveChannelHealthState,
  resolveChannelRestartReason,
} from "./channel-health-policy.js";

const policy = {
  channelId: "discord",
  now: 100_000,
  channelConnectGraceMs: 10_000,
  staleEventThresholdMs: 30_000,
};

function evaluateHealth(
  account: Record<string, unknown>,
  opts: { now?: number; channelId?: string } = {},
) {
  return evaluateChannelHealth(account, { ...policy, ...opts });
}

function runningAccount(overrides: Record<string, unknown> = {}) {
  return {
    running: true,
    enabled: true,
    configured: true,
    ...overrides,
  };
}

function connectedAccount(overrides: Record<string, unknown> = {}) {
  return runningAccount({ connected: true, ...overrides });
}

function activeRunAccount(lastRunActivityAt: number, overrides: Record<string, unknown> = {}) {
  return runningAccount({
    connected: false,
    activeRuns: 1,
    lastRunActivityAt,
    ...overrides,
  });
}

function inheritedTransportAccount() {
  return connectedAccount({
    lastStartAt: 50_000,
    lastTransportActivityAt: 10_000,
  });
}

describe("evaluateChannelHealth", () => {
  it("treats explicitly unlinked accounts as healthy unmanaged", () => {
    const evaluation = evaluateHealth(runningAccount({ running: false, linked: false }));
    expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
  });

  it("trusts a fresh recorded starting lifecycle inside connect grace", () => {
    expect(
      evaluateHealth(
        runningAccount({ connected: false, lifecycle: "starting", lastStartAt: 95_000 }),
      ),
    ).toEqual({ healthy: true, reason: "startup-connect-grace" });
  });

  it.each([
    ["uses reconnect grace for a fresh typed disconnect", 0, { at: 95_000 }, true],
    ["expires reconnect grace after 120 seconds", 0, { at: -20_001 }, false],
    ["ignores a legacy string disconnect", 0, "socket closed", false],
    ["ignores a malformed typed disconnect", 0, { at: Number.NaN }, false],
    ["ignores a disconnect from the previous lifecycle", 80_000, { at: 79_000 }, false],
    ["ignores a disconnect dated after the current clock", 0, { at: 101_000 }, false],
  ] as const)("%s", (_name, lastStartAt, lastDisconnect, healthy) => {
    expect(
      evaluateHealth(
        runningAccount({
          connected: false,
          lifecycle: "recovering",
          lastStartAt,
          lastDisconnect,
        }),
      ),
    ).toEqual({ healthy, reason: healthy ? "reconnect-grace" : "disconnected" });
  });

  it("maps recorded stopped lifecycle to the existing restartable verdict", () => {
    expect(evaluateHealth(runningAccount({ lifecycle: "stopped" }))).toEqual({
      healthy: false,
      reason: "not-running",
    });
  });

  it("flags a hung run masking a disconnected transport as stuck despite a fresh heartbeat", () => {
    const now = 30 * 60_000;
    const evaluation = evaluateHealth(
      activeRunAccount(now - 1_000, {
        connected: false,
        activeRunStartedAt: now - 26 * 60_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "stuck" });
  });

  it("keeps a connected run healthy past the threshold while its heartbeat stays fresh", () => {
    const now = 30 * 60_000;
    const evaluation = evaluateHealth(
      activeRunAccount(now - 1_000, {
        connected: true,
        activeRunStartedAt: now - 26 * 60_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: true, reason: "busy" });
  });

  it("ignores inherited busy flags until current lifecycle reports run activity", () => {
    const now = 100_000;
    const evaluation = evaluateHealth(
      runningAccount({
        connected: false,
        lastStartAt: now - 30_000,
        busy: true,
        activeRuns: 1,
        lastRunActivityAt: now - 31_000,
      }),
      { now },
    );
    expect(evaluation).toEqual({ healthy: false, reason: "disconnected" });
  });

  it("ignores inherited transport timestamps from a previous lifecycle", () => {
    const evaluation = evaluateHealth(inheritedTransportAccount(), {
      now: 75_000,
      channelId: "slack",
    });
    expect(evaluation).toEqual({ healthy: true, reason: "healthy" });
  });

  it("flags inherited transport timestamps after the lifecycle exceeds the stale threshold", () => {
    const evaluation = evaluateHealth(inheritedTransportAccount(), {
      now: 140_000,
      channelId: "slack",
    });
    expect(evaluation).toEqual({ healthy: false, reason: "stale-socket" });
  });

  it.each([
    [{ running: false, terminalDisconnect: true, linked: false }, "terminal-disconnect"],
    [{ running: false, terminalDisconnect: false }, "not-running"],
    [{ running: true, connected: true, terminalDisconnect: true }, "healthy"],
  ] as const)("evaluates terminal state %j as %s", (snapshot, reason) => {
    expect(
      evaluateHealth({ enabled: true, configured: true, ...snapshot }, { channelId: "whatsapp" }),
    ).toEqual({ healthy: reason === "healthy", reason });
  });

  describe("inbound ingress dimension", () => {
    it("keeps the ingress reason for the stopped state a failed start lands in", () => {
      // Failed ingress starts publish their cause after the start task stops.
      const evaluation = evaluateHealth(
        runningAccount({
          running: false,
          linked: false,
          restartPending: true,
          ingressUnavailable: true,
        }),
      );
      expect(evaluation).toEqual({ healthy: false, reason: "ingress-unavailable" });
    });

    it.each([{ enabled: false }, { configured: false }])(
      "keeps disabled or unconfigured accounts unmanaged (%j)",
      (unmanaged) => {
        const evaluation = evaluateHealth(
          runningAccount({
            running: false,
            linked: false,
            terminalDisconnect: true,
            lifecycle: "blocked",
            ingressUnavailable: true,
            ...unmanaged,
          }),
        );
        expect(evaluation).toEqual({ healthy: true, reason: "unmanaged" });
      },
    );
  });
});

describe("resolveChannelHealthState", () => {
  it("preserves authored terminal detail above the shared blocked projection", () => {
    const snapshot = runningAccount({
      running: false,
      connected: false,
      terminalDisconnect: true,
      lifecycle: "blocked",
      healthState: "conflict",
    });
    const evaluation = evaluateHealth(snapshot);

    expect(evaluation).toEqual({ healthy: false, reason: "terminal-disconnect" });
    expect(resolveChannelHealthState(snapshot, policy)).toBe("conflict");
  });
});

describe("resolveChannelRestartReason", () => {
  it("maps not-running + high reconnect attempts to gave-up", () => {
    const reason = resolveChannelRestartReason(
      { running: false, reconnectAttempts: 10 },
      { healthy: false, reason: "not-running" },
    );
    expect(reason).toBe("gave-up");
  });
});
