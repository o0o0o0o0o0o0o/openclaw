import { getEventListeners } from "node:events";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createControlUiSessionPullRequestSubscriptions as createSubscriptions } from "./control-ui-session-pr-subscriptions.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  routedFetch,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";

const fixture = createSessionPullRequestsFixture();
const loadPrs = fixture.load;

vi.mock("../infra/git-worker.js", () => ({ runGitWorkerOperation: vi.fn() }));

let cacheEpochMs = Date.now();

function localGitReads() {
  return vi
    .mocked(runGitWorkerOperation)
    .mock.calls.filter(
      ([operation]) =>
        operation.type !== "checkout.revision" &&
        operation.type !== "pull-request.branch-comparison",
    );
}

function mockCheckout(
  revision: () => string | null,
  branch: (root: string) => string | null,
  additions?: () => number,
) {
  vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) => {
    switch (operation.type) {
      case "pull-request.branch-comparison":
        return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
      case "checkout.revision":
        return revision();
      case "checkout.context": {
        const selected = branch(operation.input.root);
        return selected
          ? {
              ...testGitContext,
              branch: selected,
              root: operation.input.root,
              defaultBranch: "main",
            }
          : null;
      }
      case "pull-request.branch-facts":
        return additions
          ? { creatable: true, stats: { additions: additions(), deletions: 0, changedFiles: 1 } }
          : undefined;
      default:
        throw new Error("Unexpected local Git operation");
    }
  });
}

function subscribe(
  options: Pick<Parameters<typeof createSubscriptions>[0], "load" | "broadcastToConnIds">,
) {
  return createSubscriptions({
    scheduler: createTestGatewayScheduler("fake-timers"),
    prepareRead: fixture.prepareRead,
    ...options,
  });
}

beforeEach(() => {
  vi.mocked(runGitWorkerOperation).mockReset();
  vi.useFakeTimers();
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
  cacheEpochMs += 10 * 60_000;
  vi.setSystemTime(cacheEpochMs);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("watched session PR retention", () => {
  it("shares checkout facts across subscribers and refreshes both only when refs change", async () => {
    let revision = "first-head";
    let additions = 1;
    const fetchImpl = routedFetch([
      { match: "/pulls?head=", response: () => githubJson([]) },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    vi.stubGlobal("fetch", fetchImpl);
    mockCheckout(
      () => revision,
      () => "shared-feature",
      () => additions,
    );
    const broadcastToConnIds = vi.fn();
    const subscriptions = subscribe({
      broadcastToConnIds,
      load: (params, cacheSignal) =>
        loadPrs(params, {
          cacheSignal,
          resolveGitRoot: async () => "/watched/shared-checkout",
        }),
    });
    const expectReads = (count: number) => {
      for (const type of ["checkout.context", "pull-request.branch-facts"]) {
        expect(localGitReads().filter(([operation]) => operation.type === type)).toHaveLength(
          count,
        );
      }
    };
    const expectDelivered = (connId: string, sessionKey: string, expectedAdditions: number) => {
      expect(broadcastToConnIds).toHaveBeenCalledWith(
        "controlUi.sessionPullRequests.changed",
        {
          sessions: {
            [sessionKey]: expect.objectContaining({
              status: "ready",
              branch: expect.objectContaining({ additions: expectedAdditions }),
            }),
          },
        },
        new Set([connId]),
        expect.anything(),
      );
    };
    try {
      await Promise.all([
        subscriptions.replace("first", ["shared-first"]),
        subscriptions.replace("second", ["shared-second"]),
      ]);
      expectReads(1);
      expectDelivered("first", "shared-first", 1);
      expectDelivered("second", "shared-second", 1);

      broadcastToConnIds.mockClear();
      await subscriptions.replace("first", ["shared-first"], new Set(["shared-first"]));
      await subscriptions.pollNow();
      expectReads(1);
      expectDelivered("first", "shared-first", 1);

      revision = "second-head";
      additions = 2;
      broadcastToConnIds.mockClear();
      await subscriptions.pollNow();
      expectReads(2);
      expectDelivered("first", "shared-first", 2);
      expectDelivered("second", "shared-second", 2);

      subscriptions.unsubscribe("first");
      broadcastToConnIds.mockClear();
      await subscriptions.replace("second", ["shared-second"], new Set(["shared-second"]));
      expectReads(2);
      expectDelivered("second", "shared-second", 2);
    } finally {
      await subscriptions.stop();
    }
  });

  it("keeps every watched branch's last-good chips through quota backoff", async () => {
    let limited = false;
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          limited
            ? githubJson({}, 429)
            : githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);
    vi.stubGlobal("fetch", fetchImpl);
    const snapshots = new Map<string, unknown>();
    const expectSnapshots = (rateLimited: boolean) => {
      for (const snapshot of snapshots.values()) {
        expect(snapshot).toEqual(
          expect.objectContaining({
            rateLimited,
            pullRequests: [expect.anything()],
            repository: { owner: "openclaw", repo: "openclaw" },
          }),
        );
      }
    };
    const subscriptions = subscribe({
      broadcastToConnIds: (_event, payload) => {
        if (!isRecord(payload) || !isRecord(payload.sessions)) {
          throw new Error("invalid subscription event");
        }
        for (const [key, snapshot] of Object.entries(payload.sessions)) {
          expect(snapshot).toEqual(
            expect.objectContaining({
              rateLimited: expect.any(Boolean),
              pullRequests: expect.any(Array),
            }),
          );
          snapshots.set(key, snapshot);
        }
      },
      load: (params, cacheSignal) =>
        loadPrs(params, {
          cacheSignal,
          resolveGitContext: async () => ({
            owner: "openclaw",
            repo: "openclaw",
            branch: params.sessionKey,
          }),
        }),
    });
    const keys = Array.from({ length: 101 }, (_, index) => `quota-${index}`);
    try {
      await subscriptions.replace("watcher", keys);
      expect(fetchImpl.mock.calls).toHaveLength(101);
      limited = true;
      vi.setSystemTime(Date.now() + 90_001);
      await subscriptions.pollNow();
      const callsAtBackoff = fetchImpl.mock.calls.length;
      expect(callsAtBackoff).toBeGreaterThan(101);
      expectSnapshots(true);
      vi.setSystemTime(Date.now() + 61_000);
      await subscriptions.replace("watcher", keys, new Set(keys));
      expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff);
      expectSnapshots(true);
      limited = false;
      vi.setSystemTime(Date.now() + 240_001);
      await subscriptions.pollNow();
      expect(fetchImpl.mock.calls).toHaveLength(callsAtBackoff + 101);
      expectSnapshots(false);
    } finally {
      await subscriptions.stop();
    }
  });

  it("retains GitHub snapshots for the watched union across a poll", async () => {
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () => githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
      },
    ]);
    vi.stubGlobal("fetch", fetchImpl);
    const signals = new Set<AbortSignal>();
    mockCheckout(
      () => "unchanged",
      (root) => root.slice("/watched/".length),
    );
    const subscriptions = subscribe({
      broadcastToConnIds: vi.fn(),
      load: (params, cacheSignal) => {
        if (cacheSignal) {
          signals.add(cacheSignal);
        }
        return loadPrs(params, {
          cacheSignal,
          resolveGitRoot: async () => `/watched/${params.sessionKey}`,
        });
      },
    });
    try {
      await subscriptions.replace(
        "first",
        Array.from({ length: 200 }, (_, index) => `watched-${index}`),
      );
      await subscriptions.replace(
        "second",
        Array.from({ length: 100 }, (_, index) => `watched-${index + 200}`),
      );
      expect(fetchImpl.mock.calls).toHaveLength(300);
      expect(localGitReads()).toHaveLength(600);

      for (const elapsed of [60_000, 15_001]) {
        vi.setSystemTime(Date.now() + elapsed);
        await subscriptions.pollNow();
        expect(fetchImpl.mock.calls).toHaveLength(300);
        expect(localGitReads()).toHaveLength(600);
      }
      vi.setSystemTime(Date.now() + 225_000);
      await subscriptions.pollNow();
      expect(localGitReads()).toHaveLength(900);
      expect(signals.size).toBe(300);
      expect([...signals].every((signal) => getEventListeners(signal, "abort").length === 1)).toBe(
        true,
      );
    } finally {
      await subscriptions.stop();
    }
    expect(
      [...signals].every(
        (signal) => signal.aborted && getEventListeners(signal, "abort").length === 0,
      ),
    ).toBe(true);
  });

  it("releases obsolete GitHub snapshots when a watched checkout changes or disappears", async () => {
    const cacheLifetime = new AbortController();
    let root: string | null = "/retained/first";
    let branch: string | null = "feature-a";
    let rootFailure = false;
    let fetchFailure = false;
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () => githubJson(fetchFailure ? {} : [], fetchFailure ? 503 : 200),
      },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ]);
    vi.stubGlobal("fetch", fetchImpl);
    mockCheckout(
      () => branch,
      () => branch,
    );
    const load = () =>
      loadPrs(
        { sessionKey: "retained", refresh: true },
        {
          cacheSignal: cacheLifetime.signal,
          resolveGitRoot: async () => {
            if (rootFailure) {
              throw new Error("session unavailable");
            }
            return root;
          },
        },
      );
    const pins = () => getEventListeners(cacheLifetime.signal, "abort").length;
    try {
      await load();
      expect(pins()).toBe(1);
      root = "/retained/second";
      branch = "feature-b";
      await load();
      expect(pins()).toBe(1);
      root = null;
      await load();
      expect(pins()).toBe(0);
      root = "/retained/third";
      branch = "feature-c";
      fetchFailure = true;
      await expect(load()).resolves.toEqual({
        pullRequests: [],
        repository: { owner: "openclaw", repo: "openclaw" },
        rateLimited: false,
        status: "unavailable",
      });
      // Keep the GitHub failure expiry pinned until this watch retires.
      expect(pins()).toBe(1);
      fetchFailure = false;
      vi.setSystemTime(Date.now() + 30_001);
      await load();
      expect(pins()).toBe(1);
      branch = null;
      await load();
      expect(pins()).toBe(0);
      rootFailure = true;
      await expect(load()).rejects.toThrow("session unavailable");
      expect(pins()).toBe(0);
    } finally {
      cacheLifetime.abort();
    }
    expect(pins()).toBe(0);
  });
});
