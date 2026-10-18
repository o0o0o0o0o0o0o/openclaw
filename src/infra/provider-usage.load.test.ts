import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderResolveUsageAuthContext } from "../plugins/types.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createProviderUsageFetch, makeResponse } from "../test-utils/provider-usage-fetch.js";
import {
  getProviderUsageAuthWithPluginMock,
  getProviderUsageSnapshotWithPluginMock,
  resetProviderUsageSnapshotWithPluginMock,
} from "./provider-usage-plugin-runtime.test-mocks.js";
import { loadProviderUsageSummary } from "./provider-usage.load.js";
import { ignoredErrors } from "./provider-usage.shared.js";
import { loadUsageWithAuth, usageNow } from "./provider-usage.test-support.js";
import type { ProviderUsageSnapshot, UsageSummary } from "./provider-usage.types.js";

const authHook = getProviderUsageAuthWithPluginMock();
const snapshotHook = getProviderUsageSnapshotWithPluginMock();
const loadSummary = (options: Parameters<typeof loadProviderUsageSummary>[0]) =>
  loadProviderUsageSummary({ config: {}, env: {}, now: usageNow, ...options });
const trackSummary = (scope: AsyncWorkScope, options: Parameters<typeof loadSummary>[0]) =>
  scope.track(() => loadSummary({ timeoutMs: 1, ...options }));
const auth = (...providers: string[]) =>
  providers.map((provider) => ({ provider, token: "token" }));
const failure = (error: string) => ({
  provider: "anthropic",
  displayName: "Claude",
  windows: [],
  error,
});
const snapshot = (provider: string, displayName: string, label: string, usedPercent: number) => ({
  provider,
  displayName,
  windows: [{ label, usedPercent }],
});

describe("provider-usage.load", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    resetProviderUsageSnapshotWithPluginMock();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not dispatch auth or fetch for an exhausted budget", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    authHook.mockResolvedValue({ token: "fixture-token" });
    const result = await loadSummary({
      providers: ["anthropic"],
      env: { ANTHROPIC_API_KEY: "fixture-token" },
      timeoutMs: 0,
      fetch,
    });
    expect(result).toEqual({ updatedAt: usageNow, providers: [failure("Timeout")] });
    expect(authHook).not.toHaveBeenCalled();
    expect(snapshotHook).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["init", false],
    ["request", true],
  ] as const)(
    "cancels the usage fetch (%s signal, caller abort: %s)",
    async (signalSource, callerAbort) => {
      vi.useFakeTimers();
      const scope = new AsyncWorkScope();
      const started = createDeferredCore();
      const response = createDeferredCore<Response>();
      const caller = new AbortController();
      const aborted = vi.fn();
      let fetchSignal: AbortSignal | null | undefined;
      const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
        fetchSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
        fetchSignal?.addEventListener(
          "abort",
          () => {
            aborted();
            response.reject(fetchSignal?.reason);
          },
          { once: true },
        );
        started.resolve();
        return response.promise;
      });
      snapshotHook.mockImplementation(async ({ context }) => {
        await (signalSource === "init"
          ? context.fetchFn("https://usage.example.test", { signal: caller.signal })
          : context.fetchFn(new Request("https://usage.example.test", { signal: caller.signal })));
        return { provider: "anthropic", displayName: "Claude", windows: [] };
      });
      const pending = trackSummary(scope, { auth: auth("anthropic"), fetch });
      try {
        await started.promise;
        if (callerAbort) {
          caller.abort(new Error("Caller cancelled"));
        }
        await vi.advanceTimersByTimeAsync(callerAbort ? 0 : 1);
        expect(fetchSignal?.aborted).toBe(true);
        expect(caller.signal.aborted).toBe(callerAbort);
        expect(aborted).toHaveBeenCalledOnce();
        expect((await pending).providers).toEqual([
          failure(callerAbort ? "Caller cancelled" : "Timeout"),
        ]);
        await scope.drain();
        expect(scope.hasPendingWork).toBe(false);
      } finally {
        response.resolve(new Response("{}"));
        await pending;
        await scope.drain();
      }
    },
  );

  it.each(["candidates", "oauth"])(
    "rejects a retained %s auth helper after the usage deadline",
    async (helper) => {
      vi.useFakeTimers();
      const scope = new AsyncWorkScope();
      const captured = createDeferredCore<ProviderResolveUsageAuthContext>();
      const release = createDeferredCore();
      authHook.mockImplementation(async ({ context }) => {
        captured.resolve(context);
        await release.promise;
        return { handled: true };
      });
      const pending = trackSummary(scope, {
        providers: ["anthropic"],
        env: { ANTHROPIC_API_KEY: "fixture-token" },
      });
      try {
        const context = await captured.promise;
        await vi.advanceTimersByTimeAsync(1);
        expect((await pending).providers[0]?.error).toBe("Timeout");
        expect(context.signal?.aborted).toBe(true);
        await expect(
          Promise.resolve().then(() =>
            helper === "candidates"
              ? context.resolveApiKeyCandidatesFromConfigAndStore?.()
              : context.resolveOAuthToken(),
          ),
        ).rejects.toBe(context.signal?.reason);
        expect(snapshotHook).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
        await scope.drain();
      }
    },
  );

  it("returns unsupported provider snapshots for unknown provider ids", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(404, "not found"));
    const summary = await loadSummary({ auth: auth("unsupported-provider"), fetch: mockFetch });
    expect(summary.providers).toMatchObject([{ error: "Unsupported provider" }]);
  });

  it("filters errors that are marked as ignored", async () => {
    snapshotHook.mockResolvedValueOnce({
      provider: "anthropic",
      displayName: "Claude",
      windows: [],
      error: "HTTP 500",
    });
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });
    ignoredErrors.add("HTTP 500");
    try {
      const summary = await loadUsageWithAuth(
        loadProviderUsageSummary,
        [{ provider: "anthropic", token: "token-a" }],
        mockFetch,
      );
      expect(summary.providers).toStrictEqual([]);
    } finally {
      ignoredErrors.delete("HTTP 500");
    }
  });

  it("keeps window and balance-only snapshots with injected auth", async () => {
    const snapshots: ProviderUsageSnapshot[] = [
      snapshot("anthropic", "Claude", "5h", 20),
      { provider: "deepseek", displayName: "DeepSeek", windows: [], summary: "Balance ¥42.50" },
    ];
    const expected = structuredClone(snapshots);
    snapshotHook.mockImplementation(
      async ({ provider }) => snapshots.find((entry) => entry.provider === provider) ?? null,
    );
    const mockFetch = createProviderUsageFetch(async () => {
      throw new Error("legacy fetch should not run");
    });

    const summary = await loadSummary({ auth: auth("anthropic", "deepseek"), fetch: mockFetch });

    expect(summary.providers).toEqual(expected);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns live siblings at the deadline while retaining the unfinished provider", async () => {
    vi.useFakeTimers();
    const scope = new AsyncWorkScope();
    const heldSnapshot = createDeferredCore<ProviderUsageSnapshot>();
    const lateSnapshot = snapshot("anthropic", "Claude", "5h", 20);
    let summaryPromise: Promise<UsageSummary> | undefined;
    let draining: Promise<void> | undefined;
    try {
      snapshotHook.mockImplementation(async ({ provider }) =>
        provider === "anthropic" ? heldSnapshot.promise : snapshot(provider, "Codex", "3h", 12),
      );
      summaryPromise = trackSummary(scope, { auth: auth("anthropic", "openai"), timeoutMs: 5_000 });
      const settled = vi.fn();
      void summaryPromise.then(settled);

      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toHaveBeenCalledOnce();
      const summary = await summaryPromise;

      expect(summary.providers).toEqual([
        failure("Timeout"),
        snapshot("openai", "Codex", "3h", 12),
      ]);
      const drained = vi.fn();
      draining = scope.drain().then(drained);
      await vi.advanceTimersByTimeAsync(0);
      expect(drained).not.toHaveBeenCalled();
      heldSnapshot.resolve(lateSnapshot);
      await draining;
      expect(drained).toHaveBeenCalledOnce();
      expect(summary.providers[0]?.error).toBe("Timeout");
    } finally {
      heldSnapshot.resolve(lateSnapshot);
      await Promise.allSettled([
        summaryPromise,
        ...snapshotHook.mock.results.map((result) => result.value),
      ]);
      await (draining ?? scope.drain());
    }
  });

  it("keeps successful provider usage when a sibling auth hook rejects", async () => {
    authHook.mockImplementation(async ({ provider }) => {
      if (provider === "anthropic") {
        throw new Error("auth failed");
      }
      return { token: `${provider}-token` };
    });
    snapshotHook.mockImplementation(async ({ provider }) => snapshot(provider, provider, "5h", 12));

    const summary = await loadSummary({
      providers: ["anthropic", "openai"],
      // Both credential sources must pass the plugin-auth gate.
      env: { ANTHROPIC_API_KEY: "sk-ant-test", OPENAI_API_KEY: "sk-openai-test" },
    });

    expect(summary.providers).toEqual([
      failure("auth failed"),
      snapshot("openai", "openai", "5h", 12),
    ]);
  });

  it("throws when fetch is unavailable", async () => {
    vi.stubGlobal("fetch", undefined);
    await expect(loadSummary({ auth: auth("xiaomi"), fetch: undefined })).rejects.toThrow(
      "fetch is not available",
    );
  });
});
