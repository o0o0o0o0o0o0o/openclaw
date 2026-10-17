import { deepStrictEqual } from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentDatabaseAdmissionRefusalSchema } from "../../packages/gateway-protocol/src/schema/agent-database-admission.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import { revokeSqliteDatabaseAdmissionsForPath } from "../infra/sqlite-database-admission.js";
import {
  findStartupMaintenanceRequiredError,
  StartupMaintenanceRequiredError,
} from "../infra/startup-maintenance-required.js";
import { cleanupSessionStateForTest } from "../test-utils/session-state-cleanup.js";
import {
  AgentDatabaseAdmissionError,
  captureAgentDatabaseAdmission,
  createAgentDatabaseInspectionRefusal,
  evaluateAgentDatabaseAdmissions,
  preparePendingAgentDatabase,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "./agent-database-admission.js";
import { withAgentDatabaseStartupAdmission } from "./agent-database-startup.js";
import { readAgentDeletionJournalStatusInDatabase } from "./agent-deletion-journal.read.js";
import { OPENCLAW_AGENT_SCHEMA_VERSION } from "./openclaw-agent-db-contract.js";
import { invalidateOpenClawAgentDatabaseIntegrityBeforeMutation } from "./openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import {
  assertOpenClawDatabasesReady,
  preflightOpenClawDatabaseSchemas,
} from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  withExistingOpenClawStateDatabaseReadOnly,
  withOpenClawStateDatabaseReadSnapshot,
} from "./openclaw-state-db-readonly.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const tempDirs = createTempDirTracker();
const makeEnv = () => ({ OPENCLAW_STATE_DIR: tempDirs.make("agent-admission-") });
function closeDatabases() {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
}
function agentConfig(first: string, second: string, systemAgent = first): OpenClawConfig {
  return {
    agents: {
      entries: { [first]: {}, [second]: {} },
      defaults: { systemAgent: { agentId: systemAgent } },
    },
  };
}
afterEach(async () => {
  try {
    for (const stateDir of tempDirs.dirs) {
      await cleanupSessionStateForTest({ stateDir });
    }
    closeDatabases();
    tempDirs.cleanup();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("agent database admission", () => {
  it.each([
    [21, "per-agent"],
    [OPENCLAW_AGENT_SCHEMA_VERSION + 1, "per-agent"],
    [21, "fixed"],
    [OPENCLAW_AGENT_SCHEMA_VERSION + 1, "fixed"],
  ] as const)(
    "isolates secondary schema %s with %s stores across restart and startup without touching retained data",
    async (version, layout) => {
      const env = makeEnv();
      const storePath = path.join(env.OPENCLAW_STATE_DIR, "shared", "sessions.json");
      const config: OpenClawConfig = {
        ...(layout === "fixed" ? { session: { store: storePath } } : {}),
        ...agentConfig("main", "worker"),
      };
      const mainPath = openOpenClawAgentDatabase({ agentId: "main", env }).path;
      const workerPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
      const retainedPath = openOpenClawAgentDatabase({
        agentId: "retained",
        env,
        ...(layout === "fixed"
          ? { path: path.join(path.dirname(storePath), "openclaw-agent.retained.sqlite") }
          : {}),
      }).path;
      await closeOpenClawAgentDatabasesAsync();
      closeOpenClawStateDatabaseForTest();
      for (const pathname of [workerPath, retainedPath]) {
        revokeSqliteDatabaseAdmissionsForPath(pathname);
        using database = new (requireNodeSqlite().DatabaseSync)(pathname);
        database.exec(`PRAGMA journal_mode=DELETE; PRAGMA user_version=${version};`);
      }
      const workerBytes = fs.readFileSync(workerPath);
      const retainedBytes = fs.readFileSync(retainedPath);
      await expect(
        assertOpenClawDatabasesReady({ env, config, operation: "gateway-restart" }),
      ).resolves.toBeUndefined();
      await withAgentDatabaseStartupAdmission(
        async () => {
          await expect(
            assertOpenClawDatabasesReady({ env, config, operation: "gateway-startup" }),
          ).resolves.toBeUndefined();
          expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
          expect(readAgentDatabaseAdmissionRefusal("retained", { env })).toBeUndefined();
          expect(readAgentDatabaseAdmissionRefusal("worker", { env })).toMatchObject({
            code: "agent-database-inspection-failed",
            paths: [workerPath],
            repairHint: expect.stringContaining("openclaw doctor --fix"),
          });
          expect(() => openOpenClawAgentDatabase({ agentId: "worker", env })).toThrow(
            "openclaw doctor --fix",
          );
          expect(openOpenClawAgentDatabase({ agentId: "main", env }).path).toBe(mainPath);
        },
        { deferInspections: false },
      );
      await expect(
        assertOpenClawDatabasesReady({
          env,
          config,
          operation: "doctor",
          configuredAgentDatabaseTargets: [],
        }),
      ).rejects.toThrow();
      expect(fs.readFileSync(workerPath)).toEqual(workerBytes);
      expect(fs.readFileSync(retainedPath)).toEqual(retainedBytes);
    },
  );

  it("does not let an unavailable required agent hide a newer required database", async () => {
    const env = makeEnv();
    const config = agentConfig("openclaw", "worker", "worker");
    const unavailablePath = openOpenClawAgentDatabase({ agentId: "openclaw", env }).path;
    const newerPath = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
    closeDatabases();
    // The registered path exists but cannot be opened as a database; no schema fact is available.
    fs.unlinkSync(unavailablePath);
    fs.mkdirSync(unavailablePath);
    const database = new (requireNodeSqlite().DatabaseSync)(newerPath);
    database.exec(`PRAGMA user_version = ${OPENCLAW_AGENT_SCHEMA_VERSION + 1}`);
    database.close();
    await withAgentDatabaseStartupAdmission(
      async () => {
        const failure = await assertOpenClawDatabasesReady({
          env,
          operation: "gateway-startup",
          config,
        }).catch((error: unknown) => error);
        expect(findStartupMaintenanceRequiredError(failure), String(failure)).toMatchObject({
          kind: "newer-schema",
        });
        expect(failure).toBeInstanceOf(AggregateError);
        expect(String(failure)).toContain(unavailablePath);
        expect(String(failure)).toContain(newerPath);
      },
      { deferInspections: false },
    );
  });

  it("keeps a secondary with malformed ownership isolated while required agents start", async () => {
    const env = makeEnv();
    const config = agentConfig("main", "worker");
    openOpenClawAgentDatabase({ agentId: "main", env });
    const pathname = openOpenClawAgentDatabase({ agentId: "worker", env }).path;
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawStateDatabaseForTest();
    invalidateOpenClawAgentDatabaseIntegrityBeforeMutation(pathname);
    const database = new (requireNodeSqlite().DatabaseSync)(pathname);
    database.exec("UPDATE schema_meta SET agent_id = NULL WHERE meta_key = 'primary'");
    database.close();
    const before = fs.readFileSync(pathname);
    await withAgentDatabaseStartupAdmission(async (admission) => {
      await expect(
        assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config }),
      ).resolves.toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
      const owner = admission.adopt();
      const prepareAgent = vi.fn(async () => {});
      try {
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: prepareAgent,
          migrateAgent: prepareAgent,
          publishAgent: prepareAgent,
        });
        await admission.pendingPreparation;
        expect(readAgentDatabaseAdmissionRefusal("worker", { env })).toMatchObject({
          code: "agent-database-inspection-failed",
          reason: expect.stringContaining("no agent owner"),
        });
        expect(prepareAgent).not.toHaveBeenCalled();
        deepStrictEqual(fs.readFileSync(pathname), before);
      } finally {
        await owner.stop();
      }
    });
  });

  it("retains merged inspection causes without changing public refusals", () => {
    const env = makeEnv();
    const maintenance = new StartupMaintenanceRequiredError("state-migrations", "repair required");
    const failures = [maintenance, new Error("storage unavailable")];
    recordAgentDatabaseAdmissions(
      failures.map((cause, index) =>
        createAgentDatabaseInspectionRefusal({
          agentId: "main",
          paths: [`/synthetic/${index}.sqlite`],
          reason: cause.message,
          cause,
        }),
      ),
      { env },
    );
    const refusal = expectDefined(
      readAgentDatabaseAdmissionRefusal("main", { env }),
      "Expected the merged refusal",
    );
    const failure = new AgentDatabaseAdmissionError(refusal);
    expect(findStartupMaintenanceRequiredError(failure)).toBe(maintenance);
    expect(Value.Check(AgentDatabaseAdmissionRefusalSchema, refusal)).toBe(true);
    expect(() => captureAgentDatabaseAdmission("main", { env })()).toThrow(
      expect.objectContaining({ cause: failure.cause }),
    );
  });

  it("retains its selected agent and state while observing current refusal publications", () => {
    const env = makeEnv();
    const stateDir = env.OPENCLAW_STATE_DIR;
    const assertAdmitted = captureAgentDatabaseAdmission("  MAIN  ", { env });
    expect(assertAdmitted).not.toThrow();
    env.OPENCLAW_STATE_DIR = tempDirs.make("openclaw-other-admission-");
    const options = { env: { OPENCLAW_STATE_DIR: stateDir } };
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: [],
      reason: "Original admission refused",
    });
    recordAgentDatabaseAdmissions([refusal], options);
    expect(assertAdmitted).toThrow(expect.objectContaining({ refusal }));
    expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
    const replacement = { ...refusal, reason: "Replacement admission refused" };
    recordAgentDatabaseAdmissions([replacement], options);
    expect(assertAdmitted).toThrow(expect.objectContaining({ refusal: replacement }));
    recordAgentDatabaseAdmissions([], options);
    expect(assertAdmitted).not.toThrow();
  });

  it("uses the current preparation scope and refuses an escaped scope after preparation ends", async () => {
    const env = makeEnv();
    const assertAdmitted = captureAgentDatabaseAdmission("main", { env });
    const refusal = createAgentDatabaseInspectionRefusal({
      agentId: "main",
      paths: [],
      reason: "Preparation owns pending admission",
      pending: true,
    });
    recordAgentDatabaseAdmissions([refusal], { env });
    expect(assertAdmitted).toThrow(expect.objectContaining({ refusal }));
    let inPreparation = () => {};
    await preparePendingAgentDatabase(refusal, { env, assertCurrent() {} }, async () => {
      expect(assertAdmitted).not.toThrow();
      const runInScope = AsyncLocalStorage.snapshot();
      inPreparation = () => runInScope(assertAdmitted);
    });
    expect(assertAdmitted).not.toThrow();
    expect(inPreparation).toThrow("Agent database preparation has ended: main");
  });

  it("settles deferred startup admission after its discovery snapshot closes", async () => {
    const env = makeEnv();
    const agentId = "main";
    const pathname = openOpenClawAgentDatabase({ agentId, env }).path;
    closeDatabases();
    await withAgentDatabaseStartupAdmission(async (admission) => {
      const tracked = vi.spyOn(admission, "track");
      const owner = admission.adopt();
      try {
        await withOpenClawStateDatabaseReadSnapshot(
          async () => {
            const refusals = admission.defer({
              env,
              inspections: [
                {
                  target: { agentId, path: pathname },
                  result: Promise.resolve({ incompatible: [], indeterminate: [] }),
                },
              ],
              reason: "Awaiting Gateway activation",
            });
            recordAgentDatabaseAdmissions(refusals, { env, source: "startup" });
          },
          { env },
        );
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })?.code).toBe(
          "agent-database-inspection-pending",
        );
        const phases: string[] = [];
        admission.activate({
          isCurrent: () => true,
          preparationReady: Promise.resolve(),
          openAgent: async ({ assertCurrent }) => {
            assertCurrent();
            phases.push("open");
          },
          migrateAgent: async ({ assertCurrent }) => {
            assertCurrent();
            expect(
              withExistingOpenClawStateDatabaseReadOnly(
                ({ db }) => readAgentDeletionJournalStatusInDatabase(db, agentId),
                { env },
              ),
            ).toBe("absent");
            phases.push("migration");
          },
          publishAgent: async ({ assertCurrent }) => {
            assertCurrent();
            phases.push("publication");
          },
        });
        // Join the owner's work on success or refusal, never a success-only callback.
        await Promise.all(tracked.mock.calls.map(([work]) => work));
        const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env });
        expect(refusal, refusal?.reason).toBeUndefined();
        expect(phases).toEqual(["open", "migration", "publication"]);
      } finally {
        await owner.stop();
        tracked.mockRestore();
      }
    });
  });

  it.each([
    { role: "secondary", agentId: "cleaner", isolate: true },
    { role: "sole", agentId: "cleaner", isolate: false },
    { role: "configured system", agentId: "cleaner", isolate: false },
    { role: "reserved system", agentId: "openclaw", isolate: false },
  ] as const)(
    "$role agent ($agentId): divergent database permits startup=$isolate",
    async ({ role, agentId, isolate }) => {
      const env = makeEnv();
      const stateDir = env.OPENCLAW_STATE_DIR;
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      const config: OpenClawConfig = {
        agents: {
          entries: {
            ...(role === "sole" ? {} : { main: {} }),
            [agentId]: {
              sandbox: { mode: "all", workspaceAccess: "none", scope: "session" },
            },
          },
          ...(role === "configured system" ? { defaults: { systemAgent: { agentId } } } : {}),
        },
      };
      const source = openOpenClawAgentDatabase({ agentId: "main", env }).path;
      closeDatabases();
      const target = path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      const { DatabaseSync } = requireNodeSqlite();
      {
        using database = new DatabaseSync(target);
        database.prepare("UPDATE schema_meta SET app_version = ?").run("divergent-fixture");
      }
      const copyBytes = fs.readFileSync(target);
      const admission = await preflightOpenClawDatabaseSchemas({
        env,
        supportedVersions: {
          state: OPENCLAW_STATE_SCHEMA_VERSION,
          agent: OPENCLAW_AGENT_SCHEMA_VERSION,
        },
        configuredAgentDatabaseTargets: [{ agentId, path: target }],
        agentAdmissionConfig: config,
      });
      const mismatch = {
        agentId,
        embeddedOwnerId: "main",
        code: "agent-database-ownership-mismatch",
      };
      expect(admission.agentRefusals).toContainEqual(expect.objectContaining(mismatch));
      deepStrictEqual(fs.readFileSync(target), copyBytes);
      const startup = () =>
        assertOpenClawDatabasesReady({ env, operation: "gateway-startup", config });
      if (!isolate) {
        await expect(startup()).rejects.toMatchObject({
          name: "AgentDatabaseAdmissionError",
          message: expect.stringContaining(`belongs to agent main; requested agent ${agentId}`),
          refusal: { ...mismatch, paths: [target] },
        });
        expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
        deepStrictEqual(fs.readFileSync(target), copyBytes);
        return;
      }
      await expect(startup()).resolves.toBeUndefined();
      const refusal = readAgentDatabaseAdmissionRefusal(agentId, { env });
      expect(refusal).toMatchObject({
        ...mismatch,
        paths: [target],
        repairHint: expect.stringContaining("quarantine move"),
      });
      expect(readAgentDatabaseAdmissionRefusal("main", { env })).toBeUndefined();
      const { prepareSecretsRuntimeSnapshot } = await import("../secrets/runtime.js");
      await expect(
        prepareSecretsRuntimeSnapshot({
          config,
          env,
          includeConfigRefs: false,
          loadablePluginOrigins: new Map(),
        }),
      ).resolves.toBeDefined();
      const { resolveRequestedSessionAgentId } =
        await import("../gateway/session-request-agent.js");
      const { listGatewayAgentsBasic } = await import("../gateway/agent-list.js");
      expect(resolveRequestedSessionAgentId(config, "agent:main:main")).toEqual({
        ok: true,
        agentId: "main",
      });
      expect(resolveRequestedSessionAgentId(config, `agent:${agentId}:main`)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", details: refusal },
      });
      expect(
        (await listGatewayAgentsBasic(config)).agents.find((agent) => agent.id === agentId),
      ).toMatchObject({
        status: "degraded",
        admissionRefusal: refusal,
      });
      const { runStartupSessionMaintenanceForTest } =
        await import("../gateway/server-startup-session-migration.test-support.js");
      const { assertConfiguredWorkspaceStateReady } =
        await import("../agents/workspace-state-dirs.js");
      await assertConfiguredWorkspaceStateReady({ cfg: config, env });
      await runStartupSessionMaintenanceForTest({
        cfg: config,
        env,
        log: { info: vi.fn(), warn: vi.fn() },
      });
      deepStrictEqual(fs.readFileSync(target), copyBytes);
      expect(() => openOpenClawAgentDatabase({ agentId, env })).toThrow(refusal?.reason);
      await cleanupSessionStateForTest({ stateDir });
      closeDatabases();
      fs.renameSync(target, `${target}.operator-backup`);
      const freshDiagnosis = await evaluateAgentDatabaseAdmissions(config, { env });
      expect(freshDiagnosis).toEqual([]);
      recordAgentDatabaseAdmissions(freshDiagnosis, { env });
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBe(refusal);
      await expect(startup()).resolves.toBeUndefined();
      expect(readAgentDatabaseAdmissionRefusal(agentId, { env })).toBeUndefined();
      expect(resolveRequestedSessionAgentId(config, `agent:${agentId}:main`)).toEqual({
        ok: true,
        agentId,
      });
      expect(openOpenClawAgentDatabase({ agentId, env }).agentId).toBe(agentId);
      deepStrictEqual(fs.readFileSync(`${target}.operator-backup`), copyBytes);
    },
  );
});
