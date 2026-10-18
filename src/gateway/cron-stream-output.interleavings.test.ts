import { afterEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { CronJob } from "../cron/types.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import * as matcher from "./cron-stream-matcher.js";
import {
  createCronStreamMatchingJob,
  createCronStreamWatcherFixture,
  exitResult,
  job,
  settle,
} from "./cron-stream-watchers.test-helpers.js";

const batchArgs = (text: string) => [
  expect.any(Object),
  text,
  expect.any(String),
  expect.any(String),
];
const coalescedArgs = [
  "stream-job",
  expect.objectContaining({ streamCoalescedBatches: 1 }),
  expect.any(String),
  expect.any(String),
];
const blockedFire = (gate: Promise<void>) =>
  vi.fn(async () => {
    await gate;
    return "fired" as const;
  });
function pausedOutput(coalesced: number, once = false) {
  const payload = createDeferred();
  const counter = createDeferred();
  const entered = createDeferred();
  const fireBatch = blockedFire(payload.promise);
  if (once) {
    fireBatch.mockResolvedValue("fired").mockImplementationOnce(async () => {
      await payload.promise;
      return "fired";
    });
  }
  const fixture = createCronStreamWatcherFixture({
    minIntervalMs: 1,
    retryBackoffMs: once ? [1] : undefined,
    fireBatch,
    updateState: vi.fn(async (_jobId: string, patch: Partial<CronJob["state"]>) => {
      if (patch.streamCoalescedBatches === coalesced) {
        entered.resolve();
        await counter.promise;
      }
    }),
  });
  return { ...fixture, payload, counter, entered: entered.promise };
}
async function advance(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}
async function queueTwoBatches(fake: ReturnType<typeof createCronStreamWatcherFixture>["fake"]) {
  fake.inputs[0]?.onStdout?.("first\n");
  await vi.advanceTimersByTimeAsync(50);
  fake.inputs[0]?.onStdout?.("second\n");
  await advance(50);
}

describe("cron stream output", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe("serialized output interleavings", () => {
    it("coalesces late quiet and busy-retry wakes and resumes after an owner stop", async () => {
      const clock = createGatewaySchedulerClock(1_000);
      const scheduler = createTestGatewayScheduler(clock.clock);
      const fireBatch = vi.fn().mockResolvedValueOnce("busy").mockResolvedValue("fired");
      const { fake, watchers } = createCronStreamWatcherFixture({
        scheduler,
        minIntervalMs: 100,
        fireBatch,
      });
      try {
        await watchers.start(job());
        fake.inputs[0]?.onStdout?.("first\n");
        await settle();
        clock.setTime(5_000);
        await clock.wake();
        await settle();
        expect(fireBatch).toHaveBeenCalledExactlyOnceWith(...batchArgs("first"));

        clock.setTime(10_000);
        await clock.wake();
        await settle();
        expect(fireBatch).toHaveBeenCalledTimes(2);
        expect(fireBatch).toHaveBeenLastCalledWith(...batchArgs("first"));
        await watchers.stop("stream-job", "disabled");
        expect(scheduler.nextWakeAtMs).toBeNull();

        await watchers.start(job());
        fake.inputs[1]?.onStdout?.("resumed\n");
        await settle();
        await clock.advanceBy(100);
        expect(fireBatch).toHaveBeenCalledTimes(3);
        expect(fireBatch).toHaveBeenLastCalledWith(...batchArgs("resumed"));
      } finally {
        await watchers.stopAll("shutdown");
        await scheduler.stop();
      }
    });

    it("settles a scheduled callback's internal teardown while public stop joins its scope", async ({
      signal,
    }) => {
      const clock = createGatewaySchedulerClock();
      const scheduler = createTestGatewayScheduler(clock.clock);
      const writing = createDeferred();
      const releaseWrite = createDeferred<boolean>();
      const { fake, watchers } = createCronStreamWatcherFixture({
        scheduler,
        updateState: vi.fn(async (_id: string, patch: Partial<CronJob["state"]>) => {
          if (patch.streamStatus === "running" && patch.streamConsecutiveFailures === 0) {
            writing.resolve();
            return await releaseWrite.promise;
          }
          return undefined;
        }),
      });
      let waking: ReturnType<typeof clock.advanceBy> = undefined;
      let stopping: Promise<void> | undefined;
      try {
        await watchers.start(job({ state: { streamConsecutiveFailures: 4 } }));
        waking = clock.advanceBy(60_000);
        await withinTest(
          awaitGateBeforeSettlement(
            writing.promise,
            Promise.resolve(waking),
            "The scheduled callback completed before its state write",
          ),
          signal,
        );
        let stopped = false;
        stopping = watchers.stop("stream-job", "disabled").then(() => {
          stopped = true;
        });
        await settle();
        expect(stopped).toBe(false);
      } finally {
        releaseWrite.resolve(false);
        const closing = stopping ?? watchers.stop("stream-job", "disabled");
        scheduler.beginClose();
        await withinTest(Promise.all([waking, closing, scheduler.stop()]), signal);
      }
      expect(watchers.inspect("stream-job")?.state).toBe("stopped");
      expect(fake.runs[0]?.cancel).toHaveBeenCalledOnce();
      expect(scheduler.nextWakeAtMs).toBeNull();
    });

    it("restarts the quiet window when a match overtakes a queued close", async () => {
      vi.useFakeTimers();
      const entered = createDeferred();
      const matching = createDeferred<boolean>();
      vi.spyOn(matcher, "matchCronStreamLines")
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(async () => {
          entered.resolve();
          return await matching.promise;
        });
      const { fake, fireBatch, watchers } = createCronStreamWatcherFixture({ minIntervalMs: 1 });
      try {
        await watchers.start(createCronStreamMatchingJob("^keep"));
        fake.inputs[0]?.onStdout?.("keep first\n");
        await settle();
        fake.inputs[0]?.onStdout?.("keep second\n");
        await entered.promise;

        await vi.advanceTimersByTimeAsync(50);
        matching.resolve(true);
        await settle();
        expect(fireBatch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(49);
        expect(fireBatch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(fireBatch).toHaveBeenCalledExactlyOnceWith(...batchArgs("keep first\nkeep second"));
        expect(watchers.inspect("stream-job")).toMatchObject({
          droppedBatches: 0,
          coalescedBatches: 0,
        });
      } finally {
        matching.resolve(false);
        await watchers.stopAll("shutdown");
      }
    });

    it("drops and counts an open batch when disable wins, then freezes after stop", async () => {
      vi.useFakeTimers();
      const { fake, updateState, fireBatch, watchers } = createCronStreamWatcherFixture({
        minIntervalMs: 1,
      });
      await watchers.start(job());

      const lateOutput = fake.inputs[0]?.onStdout;
      lateOutput?.("open batch\n");
      await settle();
      await watchers.stop("stream-job", "disabled");

      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        processAlive: false,
        restartTimerPending: false,
        droppedBatches: 1,
        coalescedBatches: 0,
      });
      expect(fireBatch).not.toHaveBeenCalled();
      const counterWrites = () =>
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined);
      expect(counterWrites()).toHaveLength(1);

      lateOutput?.("late batch\n");
      await vi.runAllTimersAsync();
      await settle();
      expect(counterWrites()).toHaveLength(1);
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(1);
    });

    it("ignores obsolete process output during backoff and after replacement", async () => {
      vi.useFakeTimers();
      const { fake, updateState, watchers } = createCronStreamWatcherFixture({
        minIntervalMs: 1,
        retryBackoffMs: [10],
      });
      await watchers.start(job());
      const obsoleteOutput = fake.inputs[0]?.onStdout;
      fake.exits[0]?.(exitResult());
      await settle();
      expect(watchers.inspect("stream-job")?.state).toBe("backoff");

      obsoleteOutput?.("late during backoff\n");
      await settle();
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);

      await advance(10);
      expect(fake.spawn).toHaveBeenCalledTimes(2);

      obsoleteOutput?.("late after replacement\n");
      await settle();

      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);
      expect(
        updateState.mock.calls.some(([, patch]) => patch.streamDroppedBatches !== undefined),
      ).toBe(false);
      await watchers.stopAll("shutdown");
    });

    it("retains a cadence-delayed batch across source restart backoff", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { fake, fireBatch, watchers } = createCronStreamWatcherFixture({
        minIntervalMs: 100,
        retryBackoffMs: [200],
      });
      await watchers.start(job());
      const initialOwner = watchers.inspect("stream-job");
      expect(initialOwner?.sourceIdentity).toBe("source:stream-job");
      fake.inputs[0]?.onStdout?.("first\n");
      await advance(50);
      fake.inputs[0]?.onStdout?.("pending\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.exits[0]?.(exitResult());
      await settle();

      await vi.advanceTimersByTimeAsync(50);
      expect(fireBatch).toHaveBeenCalledTimes(1);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "backoff",
        droppedBatches: 0,
      });

      await advance(150);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.spawn).toHaveBeenCalledTimes(2);
      expect(watchers.inspect("stream-job")).toMatchObject({
        sourceIdentity: initialOwner?.sourceIdentity,
      });
      expect(fireBatch).toHaveBeenLastCalledWith(
        expect.any(Object),
        "pending",
        expect.any(String),
        initialOwner?.sourceIdentity,
      );
      await watchers.stopAll("shutdown");
    });

    it("counts a pending batch before terminal restart exhaustion", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { fake, recordFailure, fireBatch, watchers } = createCronStreamWatcherFixture({
        minIntervalMs: 100,
      });
      await watchers.start(job({ state: { lastRunAtMs: 1_000, streamConsecutiveFailures: 4 } }));
      fake.inputs[0]?.onStdout?.("pending\n");
      await vi.advanceTimersByTimeAsync(50);
      fake.exits[0]?.(exitResult());
      await settle();

      expect(fireBatch).not.toHaveBeenCalled();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
        consecutiveFailures: 5,
      });
      expect(recordFailure).toHaveBeenCalledOnce();
    });

    it("honors a synchronous stop fence in a pending-fire operation already queued first", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(1_000);
      const { fake, fireBatch, watchers } = createCronStreamWatcherFixture({
        minIntervalMs: 100,
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("first\n");
      await advance(50);
      fake.inputs[0]?.onStdout?.("pending\n");
      await advance(50);

      vi.advanceTimersByTime(50);
      await watchers.stop("stream-job", "disabled");

      expect(fireBatch).toHaveBeenCalledTimes(1);
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
      });
    });

    it("drains output accepted behind a slow owner write before entering backoff", async () => {
      vi.useFakeTimers();
      const { fake, watchers, fireBatch, updateState, counter, payload } = pausedOutput(1, true);
      await watchers.start(job());
      await queueTwoBatches(fake);
      expect(updateState).toHaveBeenCalledWith(...coalescedArgs);

      fake.inputs[0]?.onStdout?.("accepted-before-exit\n");
      fake.exits[0]?.(exitResult());
      counter.resolve();
      await settle();
      expect(watchers.inspect("stream-job")?.droppedBatches).toBe(0);

      payload.resolve();
      await settle();
      await vi.advanceTimersByTimeAsync(2);
      expect(fireBatch).toHaveBeenLastCalledWith(...batchArgs("second\naccepted-before-exit"));
      await watchers.stopAll("shutdown");
    });

    it("lets a stop requested during exit draining own teardown without counting failure", async () => {
      vi.useFakeTimers();
      const { fake, recordFailure, watchers, payload, counter, entered } = pausedOutput(2);
      await watchers.start(job({ state: { streamConsecutiveFailures: 4 } }));
      await queueTwoBatches(fake);

      fake.inputs[0]?.onStdout?.("accepted-before-exit\n");
      fake.exits[0]?.(exitResult());
      await entered;
      const stopping = watchers.stop("stream-job", "disabled");
      payload.resolve();
      counter.resolve();
      await settle();
      await stopping;

      expect(recordFailure).not.toHaveBeenCalled();
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        consecutiveFailures: 4,
      });
    });

    it("bounds raw output while a serialized counter write is slow", async () => {
      vi.useFakeTimers();
      const { fake, watchers, updateState, counter, payload } = pausedOutput(1);
      await watchers.start(
        job({
          schedule: {
            kind: "stream",
            command: ["source"],
            batchMs: 50,
            maxBatchBytes: 1_024,
          },
        }),
      );
      fake.inputs[0]?.onStdout?.("first\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);
      fake.inputs[0]?.onStdout?.("second\n");
      await settle();
      await advance(50);
      expect(updateState).toHaveBeenCalledWith(...coalescedArgs);

      for (let index = 0; index < 1_000; index += 1) {
        fake.inputs[0]?.onStdout?.(`${"x".repeat(100)}\n`);
      }
      expect(watchers.inspect("stream-job")).toMatchObject({
        // Raw intake is bounded at 4x the batch cap between drains.
        bufferedOutputBytes: 4_096,
        bufferedOutputSegments: 1,
      });

      counter.resolve();
      payload.resolve();
      await advance(100);
      await watchers.stopAll("shutdown");
    });

    it("bounds stop while a payload remains in flight and freezes its counter", async () => {
      vi.useFakeTimers();
      const { promise: payload, resolve: releasePayload } = createDeferred();
      const { fake, updateState, watchers } = createCronStreamWatcherFixture({
        minIntervalMs: 1,
        fireBatch: blockedFire(payload),
      });
      await watchers.start(job());
      fake.inputs[0]?.onStdout?.("in flight\n");
      await settle();
      await vi.advanceTimersByTimeAsync(50);

      const stopping = watchers.stop("stream-job", "disabled");
      await settle();
      await vi.advanceTimersByTimeAsync(10_000);
      await stopping;
      expect(watchers.inspect("stream-job")).toMatchObject({
        state: "stopped",
        droppedBatches: 1,
      });
      const counterWrites = updateState.mock.calls.filter(
        ([, patch]) => patch.streamDroppedBatches !== undefined,
      ).length;

      releasePayload();
      await settle();
      expect(
        updateState.mock.calls.filter(([, patch]) => patch.streamDroppedBatches !== undefined),
      ).toHaveLength(counterWrites);
    });
  });
});
