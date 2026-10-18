import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  createOperationalRunInstanceRef,
  getAdmittedRunDelegatedAuthority,
  prepareAgentRunAdmission,
} from "../../agents/admitted-run-context.js";
import { getActiveCronJobCount } from "../../cron/active-jobs.js";
import {
  createCronServiceWithStateForTest,
  setupCronServiceSuite,
} from "../../cron/service.test-harness.js";
import type { CronServiceDeps } from "../../cron/service/state.js";
import { onTimer } from "../../cron/service/timer.test-support.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../../test-utils/gateway-scheduler-clock.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../agent-runtime-approval-authority.js";
import {
  createCronCreatorAuthorityRunScope,
  mintCronCreatorAuthorityGrant,
  revokeCronCreatorAuthorityRunScope,
} from "../cron-creator-authority-grant.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { callCron } from "./cron-read.test-support.js";
import { agentTurnCronParams, createCronCallerClient } from "./cron.validation.test-support.js";

const { logger, makeStorePath } = setupCronServiceSuite({ prefix: "cron-self-removal-" });

it.each([
  ["agentTurn", "manual", 0, "exact"],
  ["agentTurn", "timer", 60, "exact"],
  ["script", "manual", 0, "exact"],
  ["script", "timer", 60, "exact"],
  ["agentTurn", "manual", 0, "unbound"],
  ["agentTurn", "manual", 0, "different instance"],
] as const)(
  "%s preserves %s completion (timeoutSeconds=%i, owner=%s)",
  async (payloadKind, path, timeoutSeconds, owner) => {
    const { storePath } = await makeStorePath();
    const clock = createGatewaySchedulerClock(Date.now());
    const scheduler = createTestGatewayScheduler(clock.clock);
    const finished = createDeferred<void>();
    const onEvent = vi.fn<NonNullable<CronServiceDeps["onEvent"]>>((event) => {
      if (event.action === "finished") {
        finished.resolve();
      }
    });
    const outcome = { status: "ok" as const, summary: "final reply after self-cleanup" };
    const runJob: NonNullable<CronServiceDeps["runScriptJob"]> = async (run) => {
      const { job, abortSignal, executionIdentity } = run;
      const runId = `run-${job.id}`;
      const admission = prepareAgentRunAdmission({
        cfg: {},
        operationalRunInstance: createOperationalRunInstanceRef(runId),
        facts: {
          runId,
          agentId: "main",
          ingress: { kind: "schedule", boundary: "cron.isolated-agent", state: "present" },
        },
      });
      const creatorScope = createCronCreatorAuthorityRunScope(runId, { kind: "local" });
      try {
        const admitted = await admission.admit("embedded");
        if (owner !== "unbound") {
          await executionIdentity?.onPostAdmission?.(admitted);
        }
        const delegatedAuthority = expectDefined(
          getAdmittedRunDelegatedAuthority(admitted),
          "live scheduled admission",
        );
        const sessionKey = `agent:main:cron:${job.id}`;
        const client = createCronCallerClient("main", undefined, sessionKey, job.id);
        client.internal!.agentRuntimeIdentity = {
          ...client.internal!.agentRuntimeIdentity!,
          operationalRunInstance:
            owner === "different instance"
              ? createOperationalRunInstanceRef(runId)
              : admitted.operationalRunInstance,
          delegatedAuthority: { kind: "local", ...delegatedAuthority },
          cronCreatorAuthorityGrant: mintCronCreatorAuthorityGrant(
            creatorScope,
            abortSignal,
            undefined,
            undefined,
            "requester",
          ),
        };
        const respond = await callCron(
          createDirectChatContext({
            cron,
            validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
          }),
          "cron.remove",
          { id: job.id },
          { client },
        );
        const refusal = expect.objectContaining({
          message: expect.stringContaining("job was not removed"),
        });
        expect(respond.mock.calls).toContainEqual(
          owner === "exact"
            ? [true, { ok: true, removed: true }, undefined]
            : [false, undefined, refusal],
        );
        expect([abortSignal?.aborted, getActiveCronJobCount() > 0]).toEqual([false, true]);
        return { ...outcome, notify: outcome.summary };
      } finally {
        revokeCronCreatorAuthorityRunScope(creatorScope);
        admission.close();
      }
    };
    const { cron, state } = createCronServiceWithStateForTest({
      scheduler,
      storePath,
      cronEnabled: true,
      log: logger,
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      onEvent,
      runIsolatedAgentJob: runJob,
      runScriptJob: runJob,
    });
    try {
      const job = await cron.add(
        agentTurnCronParams({
          schedule: { kind: "at", at: new Date(clock.clock.now() + 1_000).toISOString() },
          payload:
            payloadKind === "script"
              ? { kind: "script", script: "return {}", timeoutSeconds }
              : { kind: "agentTurn", message: "remove this job, then finish", timeoutSeconds },
          deleteAfterRun: false,
          delivery: { mode: "none" },
        }),
        { scheduledToolPolicy: { version: 1, mode: "trusted" } },
      );
      if (path === "manual") {
        await cron.run(job.id, "force");
      } else {
        await cron.start();
        clock.setTime(clock.clock.now() + 1_000);
        await onTimer(state);
      }
      await finished.promise;
      const events = onEvent.mock.calls.map(([event]) => event);
      expect(events.filter((event) => event.action === "finished")).toEqual([
        expect.objectContaining({ jobId: job.id, completionStatus: "succeeded", ...outcome }),
      ]);
      expect(getActiveCronJobCount()).toBe(0);
      expect(await cron.readJob(job.id)).toEqual(
        owner === "exact" ? undefined : expect.objectContaining({ id: job.id }),
      );
    } finally {
      cron.stop();
      await scheduler.stop();
    }
  },
);
