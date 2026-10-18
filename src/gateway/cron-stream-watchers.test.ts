import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { resolveStreamStopReason } from "./cron-stream-watchers.js";
import {
  createCronStreamWatcherFixture as createFixture,
  createWatchers,
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
  const supervisor = { ...fakeSupervisor().supervisor, spawn } satisfies ProcessSupervisor;
  return {
    cancels,
    spawn,
    ...createFixture({
      getProcessSupervisor: () => supervisor,
      minIntervalMs: 1,
    }),
  };
}

function blockStateWrite(matches: (patch: Partial<CronJob["state"]>) => boolean, result?: boolean) {
  const entered = createDeferred();
  const release = createDeferred();
  const updateState = vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
    if (matches(patch)) {
      entered.resolve();
      await release.promise;
      return result;
    }
  });
  return { entered: entered.promise, release: release.resolve, updateState };
}

describe("cron stream watchers", () => {
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

  it("marks a source stable once after a late scheduler wake", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const { fake, updateState, watchers } = createFixture({ scheduler });
    try {
      await watchers.start(job({ state: { streamConsecutiveFailures: 4 } }));
      clock.setTime(180_000);
      await clock.wake();
      await clock.advanceBy(60_000);
      expect(watchers.inspect("stream-job")?.consecutiveFailures).toBe(0);
      expect(
        updateState.mock.calls.filter(([, patch]) => patch.streamConsecutiveFailures === 0),
      ).toHaveLength(1);
      expect(fake.spawn).toHaveBeenCalledOnce();
      expect(scheduler.nextWakeAtMs).toBeNull();
    } finally {
      await watchers.stopAll("shutdown");
      await scheduler.stop();
    }
  });

  it("restarts once after sleeping past source backoff and cancels the next deadline on stop", async () => {
    const clock = createGatewaySchedulerClock();
    const scheduler = createTestGatewayScheduler(clock.clock);
    const { fake, watchers } = createFixture({
      scheduler,
      retryBackoffMs: [1_000],
    });
    try {
      await watchers.start(job());
      fake.exits[0]?.(exitResult());
      await settle();
      await settle();
      expect(watchers.inspect("stream-job")?.state).toBe("backoff");
      clock.setTime(300_000);
      await clock.wake();
      await clock.advanceBy(0);
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")?.state).toBe("running");
      await watchers.stopAll("shutdown");
      await clock.advanceBy(60_000);
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(scheduler.nextWakeAtMs).toBeNull();
    } finally {
      await watchers.stopAll("shutdown");
      await scheduler.stop();
    }
  });

  it.each([undefined, false] as const)(
    "joins scheduled stability teardown (write result: %s)",
    async (result, { signal }) => {
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
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
        if (result === false) {
          stoppingSource = watchers.stop("stream-job", "disabled").then(() => {
            stopped = true;
          });
        } else {
          stoppingScheduler = scheduler.stop().then(() => {
            stopped = true;
          });
          stoppingSource = watchers.stopAll("shutdown");
        }
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
    vi.useFakeTimers();
    const creatorContext = new AsyncLocalStorage<string>();
    const creatorWork = new AsyncWorkScope();
    const inCreator = creatorContext.run("creator", () =>
      creatorWork.run(() => AsyncLocalStorage.snapshot()),
    );
    const observedContexts: Array<string | undefined> = [];
    const persistedStatuses: Array<CronJob["state"]["streamStatus"]> = [];
    const delivered: Array<{ agentId: string | undefined; batch: string }> = [];
    const fake = fakeSupervisor();
    const watchers = createWatchers({
      getDefaultAgentId: () => "research",
      getProcessSupervisor: () => ({
        ...fake.supervisor,
        spawn: async (input: SpawnInput) => {
          observedContexts.push(creatorContext.getStore());
          return await fake.spawn(input);
        },
      }),
      minIntervalMs: 1,
      updateState: async (_jobId, patch) => {
        await trackAsyncWork(() => {
          observedContexts.push(creatorContext.getStore());
          persistedStatuses.push(patch.streamStatus);
        });
      },
      recordFailure: vi.fn(async () => {}),
      fireBatch: async (current, batch) =>
        await trackAsyncWork(() => {
          observedContexts.push(creatorContext.getStore());
          delivered.push({ agentId: current.agentId, batch });
          return "fired" as const;
        }),
      logger: { info: vi.fn(), warn: vi.fn() },
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

  it("fences every source during a disable sweep even when one stop fails", async () => {
    vi.useFakeTimers();
    const { cancels, spawn, watchers } = stubbornSourceFixture();
    const jobs = [job({ id: "stubborn-job" }), job({ id: "healthy-job" })];
    await watchers.reconcile(jobs, true);
    await settle();
    expect(spawn).toHaveBeenCalledTimes(2);

    // A bounded stop failure must not abort the sibling sweep.
    const sweep = watchers.reconcile(jobs, false, false);
    await vi.advanceTimersByTimeAsync(60_000);
    await sweep;
    expect(cancels["healthy-job"]).toHaveBeenCalled();
    expect(watchers.inspect("healthy-job")?.state).toBe("stopped");
  });

  it("continues reconciling after a stubborn schedule replacement fails", async () => {
    vi.useFakeTimers();
    const { spawn, watchers } = stubbornSourceFixture(true);
    await watchers.reconcile([job({ id: "stubborn-job" })], true);
    await settle();
    expect(spawn).toHaveBeenCalledTimes(1);

    // The stubborn child refuses to exit, so its schedule replacement rejects
    // after the bounded stop. The sweep must still start the sibling job.
    const replaced = job({
      id: "stubborn-job",
      schedule: { kind: "stream", command: ["replacement"], batchMs: 50 },
    });
    const sweep = watchers.reconcile([replaced, job({ id: "healthy-job" })], true);
    await vi.advanceTimersByTimeAsync(120_000);
    await sweep;
    expect(spawn.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(watchers.inspect("healthy-job")?.state).toBe("running");
    // The stubborn child also fails shutdown; advance its bounded stop.
    const shutdown = watchers.stopAll("shutdown").catch(() => undefined);
    await vi.advanceTimersByTimeAsync(60_000);
    await shutdown;
  });

  it("leaves an exit queued ahead of a requested stop to the stop operation", async () => {
    const { fake, updateState, recordFailure, watchers } = createFixture({
      minIntervalMs: 1,
    });
    await watchers.start(job());

    // The child exits and the operator stop lands before the exit callback is
    // processed: the exit belongs to the stop, not the failure counters.
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
    vi.useFakeTimers();
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
          : watchers.start(
              operation === "starting"
                ? job()
                : job({ schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } }),
            );
      await write.entered;
      const shutdown = watchers.stopAll("shutdown");
      write.release();
      await Promise.all([pending, shutdown]);
      expect(fake.spawn).toHaveBeenCalledTimes(operation === "starting" ? 0 : 1);
      expect(watchers.activeJobIds()).toEqual([]);
      if (operation === "starting") {
        expect(updateState.mock.calls.at(-1)?.[1]).toMatchObject({ streamStatus: "stopped" });
        expect(watchers.inspect("stream-job")).toMatchObject({
          state: "stopped",
          processAlive: false,
          restartTimerPending: false,
        });
      }
      if (operation === "reconcile") {
        expect(watchers.inspect("new-job")).toBeUndefined();
      }
    },
  );
  it("bounds shutdown outside a stalled owner operation and pre-cancels its scope", async () => {
    vi.useFakeTimers();
    const { promise: starting, resolve: markStarting } = createDeferred();
    const { fake, watchers } = createFixture({
      updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
        if (patch.streamStatus === "starting") {
          markStarting();
          await new Promise<never>(() => {});
        }
      }),
    });

    void watchers.start(job());
    await starting;
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
    const { promise: slowStopWrite, resolve: releaseSlowStop } = createDeferred();
    const { watchers } = createFixture({
      updateState: vi.fn(async (jobId: string, patch: Partial<CronJob["state"]>) => {
        if (jobId === "slow-job" && patch.streamStatus === "stopped") {
          await slowStopWrite;
        }
      }),
      retireSource: vi.fn(async (jobId: string) => {
        if (jobId === "fail-job") {
          throw new Error("retirement write lost");
        }
        return undefined;
      }),
    });
    await watchers.start(job({ id: "slow-job" }));
    await watchers.start(job({ id: "fail-job" }));

    // Failure must wait for the other owner's gated final persist.
    const shutdown = watchers.stopAll("shutdown");
    let settled = false;
    shutdown.catch(() => {
      settled = true;
    });
    const shutdownFailure = expect(shutdown).rejects.toThrow("retirement write lost");
    await settle();
    expect(settled).toBe(false);
    releaseSlowStop();
    await shutdownFailure;
    expect(settled).toBe(true);
  });

  it("retains a late spawn handle until a later stop confirms its exit", async () => {
    vi.useFakeTimers();
    const { promise: spawned, resolve: resolveSpawn } = createDeferred<ManagedRun>();
    let cancelAttempts = 0;
    const run = sourceRun("late-run", (finish) => {
      if (++cancelAttempts === 2) {
        finish();
      }
    });
    const supervisor = {
      ...fakeSupervisor().supervisor,
      spawn: vi.fn(async () => await spawned),
    } satisfies ProcessSupervisor;
    const { watchers } = createFixture({
      getProcessSupervisor: () => supervisor,
    });

    const starting = watchers.start(job());
    await settle();
    const stopping = watchers.stop("stream-job", "shutdown");
    resolveSpawn(run);
    const startFailure = expect(starting).rejects.toThrow("stream source did not exit");
    await vi.advanceTimersByTimeAsync(10_000);

    await startFailure;
    await stopping;
    expect(run.cancel).toHaveBeenCalledTimes(2);
    expect(watchers.inspect("stream-job")).toMatchObject({
      state: "stopped",
      processAlive: false,
      restartTimerPending: false,
    });
  });

  it("cancels old backoff before starting an updated schedule", async () => {
    vi.useFakeTimers();
    const { fake, watchers } = createFixture({
      minIntervalMs: 1,
      retryBackoffMs: [100],
    });
    await watchers.start(job());
    fake.exits[0]?.(exitResult());
    await settle();
    await settle();
    expect(watchers.inspect("stream-job")?.state).toBe("backoff");

    await watchers.start(
      job({ schedule: { kind: "stream", command: ["replacement"], batchMs: 50 } }),
    );
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(fake.inputs[1]).toMatchObject({ argv: ["replacement"] });
    await vi.advanceTimersByTimeAsync(200);
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    await watchers.stopAll("shutdown");
  });

  it("replaces same-schedule owners when logical source identity changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const { fake, fireBatch, watchers } = createFixture({
      minIntervalMs: 100,
    });
    await watchers.start(job({ state: { lastRunAtMs: 1_000, streamSourceIdentity: "source-a" } }));
    fake.inputs[0]?.onStdout?.("old pending\n");
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    await settle();

    await watchers.start(job({ state: { streamSourceIdentity: "source-b" } }));
    expect(fake.spawn).toHaveBeenCalledTimes(2);
    expect(watchers.inspect("stream-job")).toMatchObject({
      sourceIdentity: "source-b",
      droppedBatches: 1,
    });
    expect(fireBatch).not.toHaveBeenCalled();

    fake.inputs[1]?.onStdout?.("fresh\n");
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    await settle();
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
    vi.useFakeTimers();
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
    await settle();
    await vi.advanceTimersByTimeAsync(50);
    await settle();

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
