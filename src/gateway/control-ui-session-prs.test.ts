import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runGitWorkerOperation } from "../infra/git-worker.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  createSessionPullRequestsFixture,
  githubJson,
  pullListItem,
  requestUrl,
  routedFetch,
  testGitContext as context,
} from "./control-ui-session-prs.test-support.js";
import { parseGitHubRemoteUrl } from "./github-remote.js";

const { load: loadControlUiSessionPullRequests } = createSessionPullRequestsFixture();

vi.mock("../infra/git-worker.js", () => ({ runGitWorkerOperation: vi.fn() }));

const resolveGitContext = async () => context;
const load = (refresh = false, deps: Parameters<typeof loadControlUiSessionPullRequests>[1] = {}) =>
  loadControlUiSessionPullRequests(
    { sessionKey: "agent:main:main", refresh },
    { resolveGitContext, ...deps },
  );
let cacheEpochMs = Date.now();

function stubGithub(routes: Record<string, () => Response | Promise<Response>>) {
  const fetchImpl = routedFetch(
    Object.entries(routes).map(([match, response]) => ({ match, response })),
  );
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

function rateLimitedResponse() {
  const response = githubJson({ message: "rate limited" }, 403);
  response.headers.set("x-ratelimit-remaining", "0");
  return response;
}

const expectedChip = {
  number: 103469,
  owner: "openclaw",
  repo: "openclaw",
  branch: context.branch,
  headSha: "a".repeat(40),
  title: "fix(macos): tighten the link-browser tab header",
  url: "https://github.com/openclaw/openclaw/pull/103469",
  state: "open",
};

function localGitReads() {
  return vi
    .mocked(runGitWorkerOperation)
    .mock.calls.filter(
      ([operation]) =>
        operation.type !== "checkout.revision" &&
        operation.type !== "pull-request.branch-comparison",
    );
}

function makeCheckRuns(count: number, verbose = false) {
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    status: "completed",
    conclusion: verbose && index === count - 1 ? "failure" : "success",
    ...(verbose ? { output: { title: "Synthetic check", summary: "x".repeat(3_000) } } : {}),
  }));
}

function mockChecks(
  runs: Record<string, unknown>[],
  details: Record<string, number> = { additions: 4, deletions: 3, changed_files: 2 },
  laterStatus?: number,
) {
  const fetchImpl = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(requestUrl(input));
    if (url.pathname.endsWith("/pulls")) {
      return githubJson([pullListItem()]);
    }
    if (url.pathname.endsWith("/pulls/103469")) {
      return githubJson(details);
    }
    if (!url.pathname.endsWith("/check-runs")) {
      throw new Error(`unexpected GitHub request: ${url.href}`);
    }
    const page = Number(url.searchParams.get("page") ?? 1);
    const pageSize = Number(url.searchParams.get("per_page") ?? 30);
    if (page > 1 && laterStatus) {
      return githubJson({ message: "Later page unavailable" }, laterStatus);
    }
    const response = githubJson({
      total_count: runs.length,
      check_runs: runs.slice((page - 1) * pageSize, page * pageSize),
    });
    if (page * pageSize < runs.length) {
      url.searchParams.set("page", String(page + 1));
      response.headers.set("Link", `<${url.href}>; rel="next"`);
    }
    return response;
  });
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
}

describe("parseGitHubRemoteUrl", () => {
  it("parses the configured GitHub Enterprise host without admitting another host", () => {
    const expected = { owner: "acme", repo: "private-repo" };
    expect(
      parseGitHubRemoteUrl("https://ghe.example.test/acme/private-repo.git", "ghe.example.test"),
    ).toEqual(expected);
    expect(
      parseGitHubRemoteUrl("git@ghe.example.test:acme/private-repo.git", "ghe.example.test"),
    ).toEqual(expected);
    expect(
      parseGitHubRemoteUrl("https://github.com/acme/private-repo.git", "ghe.example.test"),
    ).toBeNull();
  });

  it("rejects non-GitHub and malformed remotes", () => {
    expect(parseGitHubRemoteUrl("https://gitlab.com/openclaw/openclaw.git")).toBeNull();
    expect(parseGitHubRemoteUrl("git@github.com:openclaw")).toBeNull();
    expect(parseGitHubRemoteUrl("https://github.com/openclaw/openclaw/extra")).toBeNull();
    expect(parseGitHubRemoteUrl("/local/path/repo.git")).toBeNull();
  });
});

describe("loadControlUiSessionPullRequests", () => {
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

  it("returns chips with diff counts and check rollup for open PRs", async () => {
    mockChecks([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "skipped" },
    ]);
    const result = await load();

    expect(result).toEqual({
      repository: { owner: "openclaw", repo: "openclaw" },
      pullRequests: [
        {
          ...expectedChip,
          additions: 4,
          deletions: 3,
          changedFiles: 2,
          checks: { state: "passing", passed: 1, failed: 0, skipped: 1, running: 0 },
          checksUrl: "https://github.com/openclaw/openclaw/pull/103469/checks",
        },
      ],
      rateLimited: false,
    });
  });

  it("does not reuse cached private PRs after the GitHub token is removed", async () => {
    const cacheLifetime = new AbortController();
    vi.stubEnv("GH_TOKEN", "github-token-a");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const authorization = new Headers(init?.headers).get("Authorization");
      return authorization === "Bearer github-token-a"
        ? githubJson([
            pullListItem({
              title: "private PR from token A",
              merged_at: "2026-08-12T00:00:00Z",
            }),
          ])
        : githubJson({ message: "Not Found" }, 404);
    });
    vi.stubGlobal("fetch", fetchImpl);

    try {
      const first = await load(false, { cacheSignal: cacheLifetime.signal });

      vi.stubEnv("GH_TOKEN", "");
      await expect(load(false, { cacheSignal: cacheLifetime.signal })).resolves.toEqual({
        pullRequests: [],
        repository: { owner: "openclaw", repo: "openclaw" },
        rateLimited: false,
        status: "unavailable",
      });

      expect(first.pullRequests[0]?.title).toBe("private PR from token A");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(fetchImpl.mock.calls[0]?.[1]?.headers).toHaveProperty(
        "Authorization",
        "Bearer github-token-a",
      );
      expect(fetchImpl.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Authorization");
      // The current credential's PR cache is the only retained lookup here.
      expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(1);
    } finally {
      cacheLifetime.abort();
    }
    expect(getEventListeners(cacheLifetime.signal, "abort")).toHaveLength(0);
  });

  it("marks in-flight checks pending and failed conclusions failing", async () => {
    const checkRuns = [
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "success" },
    ];
    mockChecks(checkRuns, { additions: 1, deletions: 1 });

    for (const conclusion of [null, "timed_out", "stale"]) {
      if (conclusion) {
        vi.advanceTimersByTime(10 * 60_000);
        checkRuns[0] = { status: "completed", conclusion };
      }
      const failed = conclusion === "timed_out";
      expect((await load()).pullRequests[0]?.checks).toEqual({
        state: failed ? "failing" : "pending",
        passed: 1,
        failed: failed ? 1 : 0,
        skipped: 0,
        running: failed ? 0 : 1,
      });
    }
  });

  it("returns the complete rollup for verbose check output", async () => {
    const count = 100;
    mockChecks(makeCheckRuns(count, true), { additions: 4, deletions: 3 });

    const result = await load();

    expect(result.pullRequests[0]?.checks).toEqual({
      state: "failing",
      passed: count - 1,
      failed: 1,
      skipped: 0,
      running: 0,
    });
  });

  it("discards an incomplete rollup when a later page returns 403", async () => {
    mockChecks(makeCheckRuns(101), { additions: 4, deletions: 3 }, 403);

    const result = await load();

    expect(result.pullRequests[0]?.number).toBe(103469);
    expect(result.pullRequests[0]?.checks).toBeUndefined();
    expect(result.rateLimited).toBe(false);
  });

  it.each([
    { count: 0, passed: undefined },
    { count: 1_000, passed: 1_000 },
    { count: 1_001, passed: undefined },
  ])("bounds check collection for $count runs", async ({ count, passed }) => {
    const fetchImpl = mockChecks(makeCheckRuns(count), { additions: 4, deletions: 3 });

    const result = await load();

    expect(result.pullRequests[0]?.checks?.passed).toBe(passed);
    expect(
      fetchImpl.mock.calls.filter(([url]) => requestUrl(url).includes("/check-runs")).length,
    ).toBeLessThanOrEqual(10);
  });

  it("falls back to the fork parent repo when the origin repo has no PRs", async () => {
    const fetchImpl = stubGithub({
      "/repos/fork-owner/openclaw/pulls?head=": () => githubJson([]),
      "/repos/fork-owner/openclaw": () =>
        githubJson({
          fork: true,
          parent: { name: "openclaw", owner: { login: "openclaw" } },
        }),
      "/repos/openclaw/openclaw/pulls?head=": () =>
        githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
    });
    const result = await load(false, {
      resolveGitContext: async () => ({ ...context, owner: "fork-owner" }),
    });

    expect(result.pullRequests[0]?.number).toBe(103469);
    expect(
      fetchImpl.mock.calls.some((call) =>
        requestUrl(call[0] as RequestInfo | URL).includes(
          "head=fork-owner%3Aclaude%2Fbrowser-tabs-tighter-header",
        ),
      ),
    ).toBe(true);
  });

  it("serves stale chips flagged rateLimited when GitHub quota runs out", async () => {
    let limited = false;
    const fetchImpl = stubGithub({
      "/pulls?head=": () =>
        limited
          ? rateLimitedResponse()
          : githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]),
    });

    const fresh = await load();
    expect(fresh.rateLimited).toBe(false);
    expect(fresh.repository).toEqual({ owner: "openclaw", repo: "openclaw" });

    limited = true;
    vi.advanceTimersByTime(91_000);
    const stale = await load();
    expect(stale.rateLimited).toBe(true);
    expect(stale.pullRequests).toEqual(fresh.pullRequests);
    expect(stale.repository).toEqual(fresh.repository);

    const callsDuringBackoff = fetchImpl.mock.calls.length;
    const explicitRefresh = await load(true);
    expect(explicitRefresh).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsDuringBackoff);

    vi.advanceTimersByTime(61_000);
    const stillBackedOff = await load();
    expect(stillBackedOff).toEqual(stale);
    expect(fetchImpl.mock.calls).toHaveLength(callsDuringBackoff);
  });

  it("returns no chips without a git context and spends no quota", async () => {
    const fetchImpl = stubGithub({});
    const result = await load(false, { resolveGitContext: async () => null });
    expect(result).toEqual({ pullRequests: [], rateLimited: false });
    expect(fetchImpl.mock.calls).toHaveLength(0);
  });

  it("revalidates local facts on refresh and observes changed merged heads or the slow fallback", async () => {
    let pulls: Record<string, unknown>[] = [];
    const fetchImpl = stubGithub({
      "/pulls?head=": () => githubJson(pulls),
      "/repos/openclaw/openclaw": () => githubJson({ fork: false }),
    });
    let additions = 1;
    vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) => {
      if (operation.type === "pull-request.branch-comparison") {
        return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
      }
      if (operation.type === "checkout.revision") {
        return "unchanged";
      }
      if (operation.type !== "pull-request.branch-facts") {
        throw new Error("Unexpected local Git operation");
      }
      return {
        creatable: true,
        stats: {
          additions: operation.input.root === "/repo/b" ? 3 : additions,
          deletions: 0,
          changedFiles: 1,
        },
      };
    });
    const loadSession = (sessionKey: string, refresh = false) =>
      loadControlUiSessionPullRequests(
        { sessionKey, ...(refresh ? { refresh: true } : {}) },
        {
          resolveGitContext: async () => ({
            ...context,
            branch: "cache/test",
            root: sessionKey.endsWith(":b") ? "/repo/b" : "/repo/a",
            defaultBranch: "main",
          }),
        },
      );

    expect((await loadSession("agent:main:a")).branch?.additions).toBe(1);
    additions = 2;
    expect((await loadSession("agent:main:a")).branch?.additions).toBe(1);
    expect(localGitReads()).toHaveLength(1);
    expect((await loadSession("agent:main:a", true)).branch?.additions).toBe(1);
    expect(localGitReads()).toHaveLength(1);
    expect(
      fetchImpl.mock.calls.filter((call) =>
        requestUrl(call[0] as RequestInfo | URL).includes("/pulls?head="),
      ),
    ).toHaveLength(2);

    pulls = [pullListItem({ merged_at: "2026-07-09T10:00:00Z" })];
    additions = 4;
    expect((await loadSession("agent:main:a", true)).branch?.additions).toBe(4);
    expect(localGitReads()).toHaveLength(2);

    const githubRequests = fetchImpl.mock.calls.length;
    vi.advanceTimersByTime(60_000);
    additions = 5;
    expect((await loadSession("agent:main:a")).branch?.additions).toBe(4);
    expect(localGitReads()).toHaveLength(2);
    expect(fetchImpl.mock.calls).toHaveLength(githubRequests);

    vi.advanceTimersByTime(240_001);
    additions = 5;
    expect((await loadSession("agent:main:a")).branch?.additions).toBe(5);
    expect(localGitReads()).toHaveLength(3);

    expect((await loadSession("agent:main:b")).branch?.additions).toBe(3);
    expect(localGitReads()).toHaveLength(4);
  });

  it("refreshes branch context on metadata changes without repeating it for working-tree activity", async () => {
    let branch = "feature-a";
    let revision: string | null = "initial";
    stubGithub({
      "/pulls?head=": () => githubJson([]),
      "/repos/openclaw/openclaw": () => githubJson({ fork: false }),
    });
    vi.mocked(runGitWorkerOperation).mockImplementation(async (operation) => {
      if (operation.type === "pull-request.branch-comparison") {
        return { statsBase: null, creatable: false, equalPushedTips: false, complete: true };
      }
      if (operation.type === "checkout.revision") {
        return revision;
      }
      if (operation.type === "checkout.context") {
        return { ...context, branch, root: operation.input.root, defaultBranch: "main" };
      }
      if (operation.type === "pull-request.branch-facts") {
        return { creatable: true, stats: null };
      }
      throw new Error("Unexpected local Git operation");
    });
    const loadContext = (refresh = false) =>
      loadControlUiSessionPullRequests(
        { sessionKey: "agent:main:context-refresh", ...(refresh ? { refresh: true } : {}) },
        {
          resolveGitRoot: async () => "/repo/forced-context",
        },
      );

    expect((await loadContext()).branch?.branch).toBe("feature-a");
    branch = "feature-b";
    expect((await loadContext()).branch?.branch).toBe("feature-a");
    expect((await loadContext(true)).branch?.branch).toBe("feature-a");
    revision = "changed-head";
    expect((await loadContext()).branch?.branch).toBe("feature-b");
    expect(
      localGitReads().filter(([operation]) => operation.type === "checkout.context"),
    ).toHaveLength(2);
    // Unsupported layouts retain immediate explicit branch discovery.
    revision = null;
    expect((await loadContext()).branch?.branch).toBe("feature-b");
    branch = "feature-c";
    expect((await loadContext(true)).branch?.branch).toBe("feature-c");
  });

  it("queues one forced refresh behind an ordinary in-flight lookup", async () => {
    const initialPulls = createDeferredCore<Response>();
    const initialPullStarted = createDeferredCore();
    let pullListCalls = 0;
    stubGithub({
      "/pulls?head=": () => {
        pullListCalls += 1;
        if (pullListCalls === 1) {
          initialPullStarted.resolve();
          return initialPulls.promise;
        }
        return githubJson([pullListItem({ merged_at: "2026-07-09T10:00:00Z" })]);
      },
      "/repos/openclaw/openclaw": () => githubJson({ fork: false }),
    });

    const initial = load();
    await initialPullStarted.promise;
    const forcedRefresh = load(true);
    await Promise.resolve();
    const ordinaryFollower = load();
    const duplicateForcedRefresh = load(true);

    initialPulls.resolve(githubJson([]));
    expect((await initial).pullRequests).toEqual([]);
    expect(
      (await Promise.all([forcedRefresh, ordinaryFollower, duplicateForcedRefresh])).map((result) =>
        result.pullRequests.map((item) => item.number),
      ),
    ).toEqual([[103469], [103469], [103469]]);
    expect(pullListCalls).toBe(2);
  });

  it("keeps the proven PR list as state-only chips when detail fetches are rate limited", async () => {
    // A cached empty branch discovers a new PR before quota dies on detail fetches.
    let hasPull = false;
    const routes = [
      {
        match: "/pulls?head=",
        response: () => githubJson(hasPull ? [pullListItem({ user: { login: "octocat" } })] : []),
      },
      { match: "/pulls/103469", response: rateLimitedResponse },
      { match: "/check-runs", response: rateLimitedResponse },
      { match: "/repos/openclaw/openclaw", response: () => githubJson({ fork: false }) },
    ];
    const fetchImpl = routedFetch(routes);
    vi.stubGlobal("fetch", fetchImpl);

    const beforePublication = await load();
    expect(beforePublication.pullRequests).toEqual([]);
    expect(beforePublication.branch).toBeDefined();
    hasPull = true;

    const result = await load(true);

    expect(result.rateLimited).toBe(true);
    expect(result.branch).toBeUndefined();
    expect(result.pullRequests).toEqual([
      {
        ...expectedChip,
        // The list fetch succeeded, so its author survives the degraded chip.
        author: { login: "octocat" },
      },
    ]);

    // Outage outlives the rate-limit cache window and now even the list
    // fetch 429s: the proven chips must survive as the last-known fallback.
    routes.length = 0;
    routes.push({ match: "/pulls?head=", response: rateLimitedResponse });
    vi.advanceTimersByTime(5 * 60_000 + 1_000);
    const stillLimited = await load();
    expect(stillLimited.rateLimited).toBe(true);
    expect(stillLimited.pullRequests.map((item) => item.number)).toEqual([103469]);
  });
});
import { getEventListeners } from "node:events";
