import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { publishSubagentRunChanges } from "../agents/subagents/registry/subagent-registry-publication.js";
import * as registryRead from "../agents/subagents/registry/subagent-registry-read.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import {
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveIncognitoOpenClawAgentSqlitePath,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createChatEventFixture, emitAgentEvent } from "./server-chat.agent-events.test-helpers.js";
import { createAgentEventHandler } from "./server-chat.js";
import { createSessionRowProjection, type SessionRowProjection } from "./session-row-projection.js";

function createLineageHarness(projection: SessionRowProjection, key: string) {
  const fixture = createChatEventFixture();
  const { broadcast, chatRunState } = fixture;
  const runId = "lineage-run";
  const handler = createAgentEventHandler({
    ...fixture,
    nodeHasSessionSubscribers: () => false,
    resolveSessionKeyForRun: () => key,
    getSessionRowProjection: () => projection,
  });
  let seq = 0;
  return {
    async expectLineage(expected: string | undefined, refresh = false) {
      if (refresh) {
        await projection.ensureMaterialized();
      }
      broadcast.mockClear();
      const materialized = projection.materializedCount;
      const sql = observeHostDataSql();
      const builds = vi.spyOn(registryRead, "buildSubagentSessionListReadIndex");
      try {
        const stream = seq === 0 ? "assistant" : "thinking";
        await emitAgentEvent(handler, runId, stream, { text: "Child" }, { seq: ++seq });
        const payload = broadcast.mock.calls.find(
          ([event]) => event === (stream === "assistant" ? "chat" : "agent"),
        )?.[1];
        expect(payload).toMatchObject({ sessionKey: key });
        if (expected === undefined) {
          expect.soft(payload).not.toHaveProperty("spawnedBy");
        } else {
          expect.soft(payload).toHaveProperty("spawnedBy", expected);
        }
        expect.soft(sql.queries).toEqual([]);
        expect(projection.materializedCount).toBe(materialized);
        expect(builds).not.toHaveBeenCalled();
      } finally {
        builds.mockRestore();
        sql.restore();
      }
    },
    async dispose() {
      await handler.dispose();
      chatRunState.clear();
    },
  };
}

it("keeps prepared lineage current across publications and store lifetimes without SQL", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      session: { scope: "global", mainKey: "dashboard:alias" },
    };
    setRuntimeConfigSnapshot(cfg);
    replaceSessionEntrySync(
      { agentId: "main", sessionKey: "agent:main:dashboard:anchor" },
      { sessionId: "anchor", updatedAt: 1 },
    );
    const key = "agent:main:subagent:child";
    const target = { agentId: "main", sessionKey: key };
    const controller = "agent:main:controller";
    const replacement = "agent:main:replacement-controller";
    const runId = "lineage-run";
    const fallback = "agent:main:former-controller";
    const entry = { sessionId: "lineage", updatedAt: 1, spawnedBy: fallback };
    const run = createSubagentRunRecord({
      runId,
      childSessionKey: key,
      requesterSessionKey: controller,
      controllerSessionKey: controller,
    });
    subagentRuns.set(runId, run);
    publishSubagentRunChanges([key]);
    const projection = await createSessionRowProjection({ cfg, modelCatalog: [] });
    await projection.ensureMaterialized();
    const harnesses: ReturnType<typeof createLineageHarness>[] = [];
    const attach = (sessionKey: string) => {
      const harness = createLineageHarness(projection, sessionKey);
      harnesses.push(harness);
      return harness;
    };
    const child = attach(key);
    try {
      await child.expectLineage(undefined);
      replaceSessionEntrySync(target, entry);
      publishSubagentRunChanges([key]);
      await child.expectLineage(fallback);
      await child.expectLineage(controller, true);
      subagentRuns.set(runId, { ...run, controllerSessionKey: replacement });
      publishSubagentRunChanges([key]);
      await child.expectLineage(fallback);
      await child.expectLineage(replacement, true);
      await deleteSessionEntryLifecycle({
        ...target,
        storePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
        archiveTranscript: false,
        target: { canonicalKey: key, storeKeys: [key] },
      });
      await child.expectLineage(undefined, true);
      subagentRuns.delete(runId);
      publishSubagentRunChanges([key]);

      for (const kind of ["dashboard", "acp", "archived", "incognito"] as const) {
        const incognito = kind === "incognito";
        const sessionKey = `agent:main:${kind === "acp" ? "acp" : "dashboard"}:${incognito ? "incognito-" : ""}lineage-${kind}`;
        const scope = { agentId: "main", sessionKey };
        const parent = "agent:main:main";
        const stored = {
          sessionId: `stored-lineage-${kind}`,
          updatedAt: 1,
          spawnedBy: parent,
          ...(kind === "archived" ? { archivedAt: 1 } : {}),
          ...(incognito ? { incognito: true as const } : {}),
        };
        await replaceSessionEntry(scope, stored);
        await projection.ensureMaterialized();
        const eventKey = incognito
          ? sessionKey.replace("agent:main:", "AGENT:MAIN:")
          : kind === "acp"
            ? sessionKey.slice("agent:main:".length)
            : sessionKey;
        const harness = attach(eventKey);
        await harness.expectLineage(parent);
        await replaceSessionEntry(scope, {
          ...stored,
          sessionId: `replacement-${kind}`,
          updatedAt: 2,
          spawnedBy: "agent:main:new-parent",
        });
        await harness.expectLineage("agent:main:new-parent");
        if (incognito) {
          memorySessionActorOwners.closeDatabase({
            agentId: "main",
            path: resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main" }),
          });
          await harness.expectLineage(undefined);
        }
      }
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: "global" },
        { sessionId: "lineage-alias", updatedAt: 1, spawnedBy: fallback },
      );
      subagentRuns.set(runId, { ...run, childSessionKey: "global" });
      publishSubagentRunChanges(["global"]);
      await attach("agent:main:dashboard:alias").expectLineage(controller, true);
      projection.dispose();
      for (const harness of harnesses) {
        await harness.expectLineage(undefined);
      }
    } finally {
      for (const harness of harnesses) {
        await harness.dispose();
      }
      projection.dispose();
      subagentRuns.delete(runId);
      publishSubagentRunChanges([key, "global"]);
    }
  });
});
