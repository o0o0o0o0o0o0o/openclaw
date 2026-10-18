import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../cron/agent-id.js";
import type { CronJob } from "../cron/types.js";
import type {
  ManagedRun,
  ProcessSupervisor,
  RunExit,
  SpawnInput,
} from "../process/supervisor/types.js";
import { AsyncWorkScope, trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock as schedulerClock,
  createTestGatewayScheduler as createScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveStreamStopReason } from "./cron-stream-watchers.js";
import {
  createCronStreamWatcherFixture as createFixture,
  exitResult,
  fakeSupervisor,
  job,
  settle,
} from "./cron-stream-watchers.test-helpers.js";

function sourceRun(runId: string, cancel: (finish: () => void) => void, settled = false) {
  const wait = createDeferred<RunExit>();
  const activity = { resultSettled: settled, lastOutputAtMs: Date.now() };
  const finish = () => {
    activity.resultSettled = true;
    wait.resolve(exitResult({ reason: "manual-cancel" }));
  };
  return {
    activity,
    runId,
    startedAtMs: Date.now(),
    detachOutput: vi.fn(),
    cancel: vi.fn(() => cancel(finish)),
    wait: () => (settled ? Promise.resolve(exitResult()) : wait.promise),
  } satisfies ManagedRun;
}

const replacementJob = (id = "stream-job") =>
  job({ id, schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } });
const stoppedState = { state: "stopped", processAlive: false, restartTimerPending: false };
function sourceFixture(spawn: ProcessSupervisor["spawn"], minIntervalMs?: number) {
  const supervisor = { ...fakeSupervisor().supervisor, spawn } satisfies ProcessSupervisor;
  return createFixture({ getProcessSupervisor: () => supervisor, minIntervalMs });
}

function stubbornSourceFixture(replacing = false) {
  const cancels: Record<string, ReturnType<typeof vi.fn>> = {};
  const spawn = vi.fn(async (input: SpawnInput) => {
    if (!input.scopeKey || (replacing && input.mode !== "child")) {
      throw new Error("Expected a scoped stream source");
    }
    const jobId = input.scopeKey.replace("cron-stream:", "");
    const command = input.mode === "child" ? input.argv[0] : undefined;
    const stubborn = jobId === "stubborn-job" && (!replacing || command === "stream-source");
    const run = sourceRun(`run-${jobId}${replacing ? `-${command}` : ""}`, (finish) => {
      if (!stubborn) {
        finish();
      }
    });
    cancels[jobId] = run.cancel;
    return run;
  });
  return { cancels, spawn, ...sourceFixture(spawn, 1) };
}

async function flush() {
  await settle();
  await vi.advanceTimersByTimeAsync(50);
  await settle();
}
function blockStateWrite(
  matches: (patch: Partial<CronJob["state"]>, jobId: string) => boolean,
  result?: boolean,
) {
  const entered = createDeferred();
  const release = createDeferred();
  const updateState = vi.fn(async (jobId: string, patch: Partial<CronJob["state"]>) => {
    if (matches(patch, jobId)) {
      entered.resolve();
      await release.promise;
      return result;
    }
  });
  return { entered: entered.promise, release: release.resolve, updateState };
}

describe("cron stream watchers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it.each(["delivery", "owner"])(
    "withholds a stream needing %s repair without blocking its healthy sibling",
    async (repair) => {
      const warn = vi.fn();
      const { fake, watchers } = createFixture({
        logger: { info: vi.fn(), warn },
      });
      const invalid = job({ id: "invalid-delivery", delivery: { mode: "none" } });
      if (repair === "delivery") {
        Reflect.deleteProperty(invalid.delivery!, "mode");
      } else {
        delete invalid.agentId;
      }
      const error =
        repair === "owner" ? CRON_AGENT_SELECTION_REQUIRED_MESSAGE : "openclaw doctor --fix";
      try {
        await expect(watchers.start(invalid)).rejects.toThrow(error);
        await watchers.start({ ...invalid, agentId: "ops", delivery: { mode: "none" } });
        await settle();
        expect(watchers.inspect(invalid.id)?.processAlive).toBe(true);
        await watchers.reconcile([invalid, job({ id: "healthy-stream", agentId: "ops" })], true);
        await settle();
        expect(fake.spawn).toHaveBeenCalledTimes(2);
        expect(watchers.inspect("healthy-stream")?.state).toBe("running");
        expect(watchers.inspect("invalid-delivery")?.processAlive).toBe(false);
        expect(warn).toHaveBeenCalledWith(
          expect.objectContaining({
            jobId: "invalid-delivery",
            err: expect.stringContaining(error),
          }),
          "cron-stream: reconcile start failed",
        );
      } finally {
        await watchers.stopAll("shutdown");
      }
    },
  );

  it("rechecks ownership after persisting stream admission and before spawning", async () => {
    let defaultAgentId: string | undefined = "main";
    const { fake, updateState, watchers } = createFixture({
      getDefaultAgentId: () => defaultAgentId,
    });
    updateState.mockImplementationOnce(async () => {
      defaultAgentId = undefined;
    });
    const ownerless = job();
    delete ownerless.agentId;
    try {
      await expect(watchers.start(ownerless)).rejects.toThrow(
        CRON_AGENT_SELECTION_REQUIRED_MESSAGE,
      );
      expect(fake.spawn).not.toHaveBeenCalled();
      expect(watchers.inspect(ownerless.id)?.state).toBe("stopped");
      defaultAgentId = "main";
      await watchers.start(ownerless);
      expect(fake.spawn).toHaveBeenCalledOnce();
    } finally {
      await watchers.stopAll("shutdown");
    }
  });

  it.each([false, true])("coalesces late source wakes (restarting: %s)", async (restarting) => {
    const clock = schedulerClock();
    const scheduler = createScheduler(clock.clock);
    const { fake, updateState, watchers } = createFixture({ scheduler, retryBackoffMs: [1_000] });
    try {
      await watchers.start(restarting ? job() : job({ state: { streamConsecutiveFailures: 4 } }));
      if (restarting) {
        fake.exits[0]?.(exitResult());
        await settle();
        await settle();
        expect(watchers.inspect("stream-job")?.state).toBe("backoff");
      }
      clock.setTime(restarting ? 300_000 : 180_000);
      await clock.wake();
      await clock.advanceBy(restarting ? 0 : 60_000);
      if (restarting) {
        expect(watchers.inspect("stream-job")?.state).toBe("running");
        expect(fake.spawn).toHaveBeenCalledTimes(2);
        await watchers.stopAll("shutdown");
        await clock.advanceBy(60_000);
      } else {
        expect(watchers.inspect("stream-job")?.consecutiveFailures).toBe(0);
        expect(
          updateState.mock.calls.filter(([, p]) => p.streamConsecutiveFailures === 0),
        ).toHaveLength(1);
      }
      expect(fake.spawn).toHaveBeenCalledTimes(restarting ? 2 : 1);
      expect(scheduler.nextWakeAtMs).toBeNull();
    } finally {
      await watchers.stopAll("shutdown");
      await scheduler.stop();
    }
  });

  it.each([undefined, false] as const)(
    "joins scheduled stability teardown (write result: %s)",
    async (result, { signal }) => {
      const clock = schedulerClock();
      const scheduler = createScheduler(clock.clock);
      const write = blockStateWrite(
        (patch) => patch.streamStatus === "running" && patch.streamConsecutiveFailures === 0,
        result,
      );
      const { fake, watchers } = createFixture({ scheduler, updateState: write.updateState });
      let wake: ReturnType<typeof clock.advanceBy> = undefined;
      let stoppingSource: Promise<void> | undefined;
      let stoppingScheduler: Promise<void> | undefined;
      try {
        await watchers.start(job({ state: { streamConsecutiveFailures: 4 } }));
        wake = clock.advanceBy(60_000);
        await withinTest(
          awaitGateBeforeSettlement(
            write.entered,
            Promise.resolve(wake),
            "Scheduled callback settled before its state write",
          ),
          signal,
        );
        let stopped = false;
        stoppingScheduler = result === false ? undefined : scheduler.stop();
        stoppingSource =
          result === false ? watchers.stop("stream-job", "disabled") : watchers.stopAll("shutdown");
        void (stoppingScheduler ?? stoppingSource).then(() => {
          stopped = true;
        });
        await settle();
        expect(stopped).toBe(false);
      } finally {
        write.release();
        scheduler.beginClose();
        await withinTest(
          Promise.all([
            wake,
            stoppingSource ?? watchers.stop("stream-job", "disabled"),
            stoppingScheduler ?? scheduler.stop(),
          ]),
          signal,
        );
      }
      expect(watchers.inspect("stream-job")?.state).toBe("stopped");
      expect(fake.runs[0]?.cancel).toHaveBeenCalledOnce();
      expect(scheduler.nextWakeAtMs).toBeNull();
    },
  );
  it.each(["throws", "rejects ownership"] as const)(
    "treats state persistence that %s according to its authority",
    async (result) => {
      const failed = result === "throws";
      const { fake, watchers } = createFixture({
        updateState: vi.fn(async () => {
          if (failed) {
            throw new Error("state write failed");
          }
          return false;
        }),
      });
      await (failed ? watchers.reconcile([job()], true) : watchers.start(job()));
      await settle();
      expect(fake.spawn).toHaveBeenCalledTimes(failed ? 1 : 0);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: failed ? "running" : "stopped",
      });
      if (failed) {
        await watchers.stopAll("shutdown");
      }
    },
  );
  it("preserves historical stream ownership and settlement after the creating request closes", async () => {
    const creatorContext = new AsyncLocalStorage<string>();
    const creatorWork = new AsyncWorkScope();
    const inCreator = creatorContext.run("creator", () =>
      creatorWork.run(() => AsyncLocalStorage.snapshot()),
    );
    const observedContexts: Array<string | undefined> = [];
    const persistedStatuses: Array<CronJob["state"]["streamStatus"]> = [];
    const delivered: Array<{ agentId: string | undefined; batch: string }> = [];
    const fake = fakeSupervisor();
    function observe<T>(work: () => T) {
      observedContexts.push(creatorContext.getStore());
      return work();
    }
    const { watchers } = createFixture({
      getDefaultAgentId: () => "research",
      getProcessSupervisor: () => ({
        ...fake.supervisor,
        spawn: async (input: SpawnInput) => await observe(() => fake.spawn(input)),
      }),
      minIntervalMs: 1,
      updateState: async (_jobId, patch) => {
        await trackAsyncWork(() => observe(() => persistedStatuses.push(patch.streamStatus)));
      },
      fireBatch: async (current, batch) =>
        await trackAsyncWork(() =>
          observe(() => {
            delivered.push({ agentId: current.agentId, batch });
            return "fired" as const;
          }),
        ),
    });
    try {
      await inCreator(() => watchers.start(job({ agentId: "ops" })));
      await creatorWork.drain();
      inCreator(() => fake.inputs[0]?.onStdout?.("owned output\n"));
      await settle();
      await inCreator(() => vi.advanceTimersByTimeAsync(50));
      await settle();
      await inCreator(() => watchers.stopAll("shutdown"));
      expect(delivered).toEqual([{ agentId: "ops", batch: "owned output" }]);
      expect(persistedStatuses).toEqual(expect.arrayContaining(["starting", "running", "stopped"]));
      expect(observedContexts.every((context) => context === undefined)).toBe(true);
      expect(watchers.activeJobIds()).toEqual([]);
      expect(fake.runs[0]?.cancel).toHaveBeenCalled();
      await expect(inCreator(() => trackAsyncWork(() => undefined))).rejects.toThrow(
        "Async work scope is closed",
      );
    } finally {
      await creatorWork.drain();
      await watchers.stopAll("shutdown");
    }
  });

  it.each([
    [
      undefined,
      "stream sources are disabled because the operator set cron.triggers.enabled: false; remove it or set it to true",
    ],
    [true, "cron is disabled"],
  ] as const)(
    "withholds disabled sources and reports remediation (triggers: %s)",
    async (triggers, streamError) => {
      const { fake, updateState, watchers } = createFixture();
      await watchers.reconcile([job()], false, triggers);
      expect(fake.spawn).not.toHaveBeenCalled();
      expect(updateState).toHaveBeenCalledWith(
        "stream-job",
        expect.objectContaining({ streamStatus: "disabled", streamError }),
        expect.any(String),
        expect.any(String),
      );
    },
  );

  it.each([false, true])("continues a failed owner sweep (replacement: %s)", async (replacing) => {
    const { cancels, spawn, watchers } = stubbornSourceFixture(replacing);
    const stubborn = job({ id: "stubborn-job" });
    const healthy = job({ id: "healthy-job" });
    await watchers.reconcile(replacing ? [stubborn] : [stubborn, healthy], true);
    await settle();
    expect(spawn).toHaveBeenCalledTimes(replacing ? 1 : 2);
    const sweep = replacing
      ? watchers.reconcile([replacementJob(stubborn.id), healthy], true)
      : watchers.reconcile([stubborn, healthy], false, false);
    await vi.advanceTimersByTimeAsync(replacing ? 120_000 : 60_000);
    await sweep;
    expect(watchers.inspect(healthy.id)?.state).toBe(replacing ? "running" : "stopped");
    if (replacing) {
      expect(spawn.mock.calls.length).toBeGreaterThanOrEqual(2);
      const shutdown = watchers.stopAll("shutdown").catch(() => undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      await shutdown;
    } else {
      expect(cancels[healthy.id]).toHaveBeenCalled();
    }
  });

  it("leaves an exit queued ahead of a requested stop to the stop operation", async () => {
    const { fake, updateState, recordFailure, watchers } = createFixture({
      minIntervalMs: 1,
    });
    await watchers.start(job());
    fake.exits[0]?.(exitResult({ reason: "exit", exitCode: 1 }));
    const stopping = watchers.stop("stream-job", "disabled");
    await stopping;
    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "stopped",
      consecutiveFailures: 0,
      restartTimerPending: false,
    });
    expect(recordFailure).not.toHaveBeenCalled();
    expect(updateState.mock.calls.some(([, patch]) => patch.streamStatus === "restarting")).toBe(
      false,
    );
  });

  it("restarts fast exits and records terminal failure after five attempts", async () => {
    const spawn = vi.fn(async () => sourceRun(`run-${spawn.mock.calls.length}`, () => {}, true));
    const supervisor = {
      ...fakeSupervisor().supervisor,
      spawn,
    } satisfies ProcessSupervisor;
    const recordFailure = vi.fn(async () => {});
    const { watchers } = createFixture({
      getProcessSupervisor: () => supervisor,
      minIntervalMs: 1,
      retryBackoffMs: [1],
      recordFailure,
    });
    await watchers.reconcile([job()], true);
    await vi.advanceTimersByTimeAsync(10);
    expect(spawn).toHaveBeenCalledTimes(5);
    expect(recordFailure).toHaveBeenCalledWith(
      "stream-job",
      expect.stringContaining("stream source exited"),
      expect.objectContaining({ streamRestartExhausted: true, streamConsecutiveFailures: 5 }),
      expect.any(String),
      expect.any(String),
    );
    await watchers.start(job({ state: { streamRestartExhausted: false } }));
    await vi.advanceTimersByTimeAsync(1);
    expect(spawn.mock.calls.length).toBeGreaterThan(5);
    await watchers.stopAll("shutdown");
  });

  it("starts unrelated jobs without cross-job mutation fencing", async () => {
    const { fake, watchers } = createFixture();
    await Promise.all([
      watchers.start(job({ id: "stream-a" })),
      watchers.start(job({ id: "stream-b" })),
    ]);
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(watchers.activeJobIds()).toEqual(expect.arrayContaining(["stream-a", "stream-b"]));
    await watchers.stopAll("shutdown");
  });

  it.each(["starting", "replacement", "reconcile"] as const)(
    "fences a gated %s operation when shutdown wins",
    async (operation) => {
      const write = blockStateWrite(
        (patch) => patch.streamStatus === (operation === "starting" ? "starting" : "stopped"),
      );
      const { fake, watchers, updateState } = createFixture({
        updateState: write.updateState,
      });
      if (operation !== "starting") {
        await watchers.start(job({ id: operation === "reconcile" ? "old-job" : "stream-job" }));
      }
      const pending =
        operation === "reconcile"
          ? watchers.reconcile([job({ id: "new-job" })], true)
          : watchers.start(operation === "starting" ? job() : replacementJob());
      await write.entered;
      const shutdown = watchers.stopAll("shutdown");
      write.release();
      await Promise.all([pending, shutdown]);
      expect(fake.spawn).toHaveBeenCalledTimes(operation === "starting" ? 0 : 1);
      expect(watchers.activeJobIds()).toEqual([]);
      if (operation === "starting") {
        expect(updateState.mock.calls.at(-1)?.[1]).toMatchObject({ streamStatus: "stopped" });
        expect(watchers.inspect("stream-job")).toMatchObject(stoppedState);
      }
      if (operation === "reconcile") {
        expect(watchers.inspect("new-job")).toBeUndefined();
      }
    },
  );
  it("bounds shutdown outside a stalled owner operation and pre-cancels its scope", async () => {
    const write = blockStateWrite((p) => p.streamStatus === "starting");
    const { fake, watchers } = createFixture({ updateState: write.updateState });
    void watchers.start(job());
    await write.entered;
    const shutdown = watchers.stopAll("shutdown");
    const shutdownFailure = expect(shutdown).rejects.toThrow("stream owner stop did not settle");
    expect(fake.supervisor.cancelScope).toHaveBeenCalledWith(
      "cron-stream:stream-job",
      "manual-cancel",
    );
    await vi.advanceTimersByTimeAsync(20_000);
    await shutdownFailure;
    expect(fake.spawn).not.toHaveBeenCalled();
  });

  it("holds shutdown open until every owner stop settles before surfacing a failure", async () => {
    const write = blockStateWrite((p, id) => id === "slow-job" && p.streamStatus === "stopped");
    const { watchers } = createFixture({
      updateState: write.updateState,
      retireSource: vi.fn(async (jobId: string) => {
        if (jobId === "fail-job") {
          throw new Error("retirement write lost");
        }
        return undefined;
      }),
    });
    await watchers.start(job({ id: "slow-job" }));
    await watchers.start(job({ id: "fail-job" }));
    const shutdown = watchers.stopAll("shutdown");
    let settled = false;
    shutdown.catch(() => {
      settled = true;
    });
    const shutdownFailure = expect(shutdown).rejects.toThrow("retirement write lost");
    await settle();
    expect(settled).toBe(false);
    write.release();
    await shutdownFailure;
    expect(settled).toBe(true);
  });

  it("retains a late spawn handle until a later stop confirms its exit", async () => {
    const { promise: spawned, resolve: resolveSpawn } = createDeferred<ManagedRun>();
    let cancelAttempts = 0;
    const run = sourceRun("late-run", (finish) => {
      if (++cancelAttempts === 2) {
        finish();
      }
    });
    const { watchers } = sourceFixture(vi.fn(async () => await spawned));
    const starting = watchers.start(job());
    await settle();
    const stopping = watchers.stop("stream-job", "shutdown");
    resolveSpawn(run);
    const startFailure = expect(starting).rejects.toThrow("stream source did not exit");
    await vi.advanceTimersByTimeAsync(10_000);
    await startFailure;
    await stopping;
    expect(run.cancel).toHaveBeenCalledTimes(2);
    expect(watchers.inspect("stream-job")).toMatchObject(stoppedState);
  });

  it("cancels old backoff before starting an updated schedule", async () => {
    const { fake, watchers } = createFixture({
      minIntervalMs: 1,
      retryBackoffMs: [100],
    });
    await watchers.start(job());
    fake.exits[0]?.(exitResult());
    await settle();
    await settle();
    expect(watchers.inspect("stream-job")?.state).toBe("backoff");
    await watchers.start(replacementJob());
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(fake.inputs[1]).toMatchObject({ argv: ["replacement"] });
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    await watchers.stopAll("shutdown");
  });

  it("replaces same-schedule owners when logical source identity changes", async () => {
    vi.setSystemTime(1_000);
    const { fake, fireBatch, watchers } = createFixture({
      minIntervalMs: 100,
    });
    await watchers.start(job({ state: { lastRunAtMs: 1_000, streamSourceIdentity: "source-a" } }));
    fake.inputs[0]?.onStdout?.("old pending\n");
    await flush();
    await watchers.start(job({ state: { streamSourceIdentity: "source-b" } }));
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(watchers.inspect("stream-job")).toMatchObject({
      sourceIdentity: "source-b",
      droppedBatches: 1,
    });
    expect(fireBatch).not.toHaveBeenCalled();
    fake.inputs[1]?.onStdout?.("fresh\n");
    await flush();
    expect(fireBatch).toHaveBeenLastCalledWith(
      expect.any(Object),
      "fresh",
      expect.any(String),
      "source-b",
    );
    await watchers.stopAll("shutdown");
  });

  it("lets a newer explicit start replace an owner being removed", async () => {
    const retireSource = vi.fn(async (_jobId: string, _scheduleKey: string, identity: string) => {
      return `${identity}:retired`;
    });
    const { fake, watchers } = createFixture({
      retireSource,
    });
    await watchers.start(job());
    const removal = watchers.stop("stream-job", "removed");
    const replacement = watchers.start(job());
    await Promise.all([removal, replacement]);
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "running",
      processAlive: true,
      // Only the durable removal retires; disposing the obsolete owner for
      // the replacement start must not rotate the incoming identity.
      sourceIdentity: "source:stream-job",
    });
    expect(retireSource).toHaveBeenCalledTimes(1);
    await watchers.stopAll("shutdown");
  });

  it("retires logical source identity before waiting on an in-flight batch", async () => {
    const { promise: payload, resolve: releasePayload } = createDeferred();
    const retireSource = vi.fn(async () => "source-retired");
    const { fake, watchers } = createFixture({
      minIntervalMs: 1,
      retireSource,
      fireBatch: vi.fn(async () => {
        await payload;
        return "fired" as const;
      }),
    });
    await watchers.start(job());
    fake.inputs[0]?.onStdout?.("in flight\n");
    await flush();
    const stopping = watchers.stop("stream-job", "removed");
    await settle();
    expect(retireSource).toHaveBeenCalledWith(
      "stream-job",
      expect.any(String),
      "source:stream-job",
    );
    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "stopping",
      sourceIdentity: "source-retired",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await stopping;
    releasePayload();
    await settle();
  });
});

describe("resolveStreamStopReason", () => {
  const base = {
    triggersEnabled: true,
    cronEnabled: true,
    restartExhausted: false,
    isStream: true,
  };

  it("selects trust-disabled when triggers are off, even if cron is also off", () => {
    expect(resolveStreamStopReason({ ...base, triggersEnabled: false, cronEnabled: false })).toBe(
      "trust-disabled",
    );
  });

  it("selects the remediable cron-disabled when only global cron is off", () => {
    // Direct-mutation regression: cron off + triggers on must not fall through to
    // the generic stopped reason, matching reconcile's cron-disabled remediation.
    expect(resolveStreamStopReason({ ...base, cronEnabled: false })).toBe("cron-disabled");
  });

  it("prefers restart-exhausted over the generic disabled reason", () => {
    expect(resolveStreamStopReason({ ...base, restartExhausted: true })).toBe("restart-exhausted");
  });

  it("uses disabled for a live stream job and schedule-update otherwise", () => {
    expect(resolveStreamStopReason(base)).toBe("disabled");
    expect(resolveStreamStopReason({ ...base, isStream: false })).toBe("schedule-update");
  });
});
