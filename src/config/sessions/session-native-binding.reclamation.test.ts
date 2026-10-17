import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as admission from "../../infra/sqlite-worker-operation-admission.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import {
  readSessionProgressCard,
  writeSessionProgressCard,
} from "../../session-cards/progress-card-store.js";
import { createSessionInitialization } from "../../sessions/session-initialization.js";
import {
  onSessionIdentityMutation,
  onSessionLifecycleEvent,
} from "../../sessions/session-lifecycle-events.js";
import * as execution from "../../state/openclaw-agent-execution.js";
import { readExactSessionEntryRow } from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { applySessionEntryLifecycleMutation } from "./session-accessor.sqlite-projection.js";
import { loadTranscriptEventsSync } from "./session-accessor.sqlite-read.js";
import { applySessionEntryCanonicalReplacements } from "./session-accessor.sqlite-replacement-projection.js";
import {
  bindingWrites,
  expectNoSql,
  observeNativeCommit,
  publication,
  wrapAgentExecution,
} from "./session-native-binding.execution.test-support.js";
import { withNativeBindingFixture } from "./session-native-binding.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.each([false, true])(
  "settles canonical replacement and native binding cleanup off thread (rollback: %s)",
  async (rollback) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const before = fixture.readEntry();
      assert(before);
      const binding = fixture.readBinding();
      const sessionKey = "agent:main:replacement-target";
      const failure = new Error("synthetic replacement commit refusal");
      const admitted = observeNativeCommit(admission, () => {
        if (rollback) {
          throw failure;
        }
      });
      const sql = observeHostDataSql();
      try {
        const replacement = withPluginRuntimeRegistryScope(fixture.registry, () =>
          applySessionEntryCanonicalReplacements({
            agentId: fixture.scope.agentId,
            env: fixture.scope.env,
            storePath: fixture.scope.storePath,
            skipMaintenance: true,
            sessionKeys: [fixture.scope.sessionKey, sessionKey],
            update: () => ({
              result: "replaced",
              replacements: [
                { sessionKey, entry: before, previousSessionKeys: [fixture.scope.sessionKey] },
              ],
            }),
          }),
        );
        if (rollback) {
          await expect(replacement).rejects.toBe(failure);
        } else {
          await expect(replacement).resolves.toBe("replaced");
        }
        expect(admitted).toHaveBeenCalled();
        expectNoSql(sql.queries, /\b(?:session_nodes|session_windows|transcript_events)\b/i);
        expect(bindingWrites(sql.queries)).toEqual([]);
      } finally {
        sql.restore();
      }
      expect([fixture.readEntry(), fixture.readBinding()]).toEqual(
        rollback ? [before, binding] : [undefined, undefined],
      );
      expect(readExactSessionEntryRow(fixture.database, sessionKey)?.entry).toEqual(
        rollback ? undefined : before,
      );
      const transcript = loadTranscriptEventsSync({
        ...fixture.scope,
        sessionKey: rollback ? fixture.scope.sessionKey : sessionKey,
      });
      expect(transcript).toEqual(fixture.events);
    });
  },
);

it.each([false, true])(
  "settles typed reset and native reclamation without replacing a successor (%s)",
  async (successor) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const reset = {
        ...fixture.scope,
        sessionKey: "agent:main:reset-companion",
        sessionId: "reset-companion",
      };
      const entry = { sessionId: reset.sessionId, lifecycleRevision: "before", updatedAt: 1 };
      replaceSessionEntrySync(reset, entry);
      writeSessionProgressCard(fixture.database.db, reset.sessionKey, {
        markdown: "Previous task",
      });
      const next = successor
        ? { sessionId: "successor", lifecycleRevision: "successor", updatedAt: 3 }
        : { ...entry, lifecycleRevision: "after", updatedAt: 2 };
      const inject = vi.fn(() => replaceSessionEntrySync(reset, next));
      if (successor) {
        const capture = execution.captureOpenClawAgentDatabaseExecution;
        const capturePreparation = execution.captureOpenClawAgentDatabasePreparationExecution;
        const withDelivery = (owner: ReturnType<typeof capture>) =>
          wrapAgentExecution(owner, (worker) => ({
            execute: async (command, options) => {
              const result = await worker.execute(command, options);
              if (command.type === "session.nativeBindings.delete") {
                inject();
              }
              return result;
            },
          }));
        vi.spyOn(execution, "captureOpenClawAgentDatabaseExecution").mockImplementation((...args) =>
          withDelivery(capture(...args)),
        );
        vi.spyOn(execution, "captureOpenClawAgentDatabasePreparationExecution").mockImplementation(
          (...args) => withDelivery(capturePreparation(...args)),
        );
      }
      let committed = false;
      const notifications: boolean[] = [];
      const resetIdentities: string[] = [];
      const stopIdentity = onSessionIdentityMutation((change) => {
        if (change.kind === "reset" && change.current.sessionKeys.includes(reset.sessionKey)) {
          resetIdentities.push(change.kind);
        }
      });
      const stop = onSessionLifecycleEvent((event) => {
        if (event.sessionKey === reset.sessionKey && event.reason === "progress-card-reset") {
          notifications.push(committed);
        }
      });
      const sql = successor ? undefined : observeHostDataSql();
      try {
        await expect(
          withPluginRuntimeRegistryScope(fixture.registry, () =>
            applySessionEntryLifecycleMutation({
              agentId: fixture.scope.agentId,
              env: fixture.scope.env,
              storePath: fixture.scope.storePath,
              skipMaintenance: true,
              removals: [{ sessionKey: fixture.scope.sessionKey }],
              upserts: [
                {
                  sessionKey: reset.sessionKey,
                  entry: { ...entry, lifecycleRevision: "after", updatedAt: 2 },
                  resetBoundary: { context: "clear", reason: "reset", cwd: "/synthetic/workspace" },
                },
              ],
              onLifecycleCommitted: () => {
                committed = true;
              },
            }),
          ),
        ).resolves.toMatchObject({ removedSessionKeys: [fixture.scope.sessionKey] });
        if (sql) {
          expectNoSql(
            sql.queries,
            /\b(?:session_nodes|session_windows|transcript_events|session_progress_cards)\b/i,
          );
        }
      } finally {
        sql?.restore();
        stop();
        stopIdentity();
      }
      expect([fixture.readEntry(), fixture.readBinding()]).toEqual([undefined, undefined]);
      expect(readExactSessionEntryRow(fixture.database, reset.sessionKey)?.entry).toMatchObject(
        next,
      );
      expect(inject).toHaveBeenCalledTimes(successor ? 1 : 0);
      expect(resetIdentities).toEqual(successor ? [] : ["reset"]);
      const reader = new DatabaseSync(fixture.database.path, { readOnly: true });
      try {
        expect(readSessionProgressCard(reader, reset.sessionKey)).toBeNull();
      } finally {
        reader.close();
      }
      expect(notifications).toEqual([true]);
    });
  },
);

it("reclaims lifecycle artifacts with the native veto off the caller thread", async () => {
  await withNativeBindingFixture("agentsapi", async (fixture) => {
    const published = vi.fn();
    const stop = onSessionIdentityMutation((change) => {
      if (change.previous.sessionKeys.includes(fixture.scope.sessionKey)) {
        published(change.kind);
      }
    });
    const granted = observeNativeCommit(admission);
    const sql = observeHostDataSql();
    try {
      await expect(fixture.cleanup()).resolves.toMatchObject({ removedEntries: 1 });
      expect(granted).toHaveBeenCalled();
      // Other-owner live authority reads remain outside the moved A transaction.
      expectNoSql(sql.queries, /\b(?:session_nodes|session_windows|transcript_events)\b/i);
      expect(bindingWrites(sql.queries)).toEqual([]);
    } finally {
      sql.restore();
      stop();
    }
    expect([fixture.readEntry(), fixture.readBinding()]).toEqual([undefined, undefined]);
    expect(loadTranscriptEventsSync(fixture.scope)).toEqual([]);
    expect(published.mock.calls).toEqual([["delete"]]);
  });
});

it.each([false, true])(
  "settles maintenance participants only for rows actually reclaimed (changed: %s)",
  async (changed) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      const before = fixture.readEntry();
      assert(before);
      const binding = fixture.readBinding();
      const successor = { ...before, label: "updated after maintenance planning" };
      if (changed) {
        replaceSessionEntrySync(fixture.scope, successor);
      }
      const sql = observeHostDataSql();
      try {
        await expect(fixture.maintain(before)).resolves.toMatchObject({ pruned: changed ? 0 : 1 });
        expectNoSql(sql.queries, /\b(?:session_nodes|session_windows|transcript_events)\b/i);
      } finally {
        sql.restore();
      }
      expect([fixture.readEntry(), fixture.readBinding()]).toEqual(
        changed ? [successor, binding] : [undefined, undefined],
      );
    });
  },
);

it.each([false, true])(
  "retains rollback authority until acknowledged worker deletion (binding: %s)",
  async (withBinding) => {
    await withNativeBindingFixture("agentsapi", async (fixture) => {
      if (!withBinding) {
        fixture.registry.agentHarnesses.length = 0;
      }
      const entry = fixture.readEntry();
      assert(entry);
      let refuse = true;
      let grantDatabasePath: string | undefined;
      let agentGrants = 0;
      let authorityReads = 0;
      let fixtureRead = false;
      let revoked = true;
      const refusal = new Error("synthetic rollback authority revoked");
      const create = admission.createSqliteWorkerOperationAdmission;
      vi.spyOn(admission, "createSqliteWorkerOperationAdmission").mockImplementation(
        (callback, attachment) => {
          let databasePath: string | undefined;
          const owned = create((request, grant) => {
            const previous = grantDatabasePath;
            const identity = isRecord(request.facts) ? request.facts.identity : undefined;
            grantDatabasePath =
              isRecord(identity) && typeof identity.nativeLocation === "string"
                ? identity.nativeLocation
                : databasePath;
            if (grantDatabasePath === fixture.database.path) {
              agentGrants++;
            }
            try {
              const facts = publication(request);
              if (
                refuse &&
                request.stage === "commit" &&
                facts?.kind === "session-native-binding"
              ) {
                throw new Error("injected initializer delete failure");
              }
              callback(request, grant);
            } finally {
              grantDatabasePath = previous;
            }
          }, attachment);
          const bind = owned.bindDatabaseAuthority.bind(owned);
          owned.bindDatabaseAuthority = (authority) => {
            databasePath = authority.databasePath;
            bind(authority);
          };
          return owned;
        },
      );
      const initializer = createSessionInitialization(
        { ...fixture.scope, lifecycleRevision: entry.lifecycleRevision },
        () => {
          expect(grantDatabasePath).not.toBe(fixture.database.path);
          fixtureRead = true;
          try {
            fixture.readEntry();
          } finally {
            fixtureRead = false;
          }
          authorityReads++;
          if (revoked) {
            throw refusal;
          }
        },
        { config: {}, agentId: fixture.scope.agentId, entry },
      );
      try {
        await expect(initializer.rollback(() => fixture.remove())).rejects.toBe(refusal);
        expect(fixture.readEntry()).toEqual(entry);
        expect(fixture.readBinding()).toBeDefined();
        revoked = false;
        await expect(initializer.rollback(() => fixture.remove())).rejects.toThrow(
          "injected initializer delete failure",
        );
        expect(() => initializer.handle.assertCurrent()).not.toThrow();
        expect(fixture.readEntry()).toEqual(entry);
        expect(fixture.readBinding()).toBeDefined();
        refuse = false;
        const measured: string[] = [];
        // Exclude only the test's explicit authority read, not any owner work.
        const sql = observeHostDataSql((query) => {
          if (!fixtureRead) {
            measured.push(query);
          }
        });
        try {
          await expect(initializer.rollback(() => fixture.remove())).resolves.toMatchObject({
            deleted: true,
          });
          expectNoSql(
            measured,
            /\b(?:session_nodes|session_windows|transcript_events|session_transcript_archives)\b/i,
          );
        } finally {
          sql.restore();
        }
        expect(authorityReads).toBeGreaterThan(0);
        expect(agentGrants).toBeGreaterThan(0);
        expect(fixture.readEntry()).toBeUndefined();
        expect(loadTranscriptEventsSync(fixture.scope)).toEqual([]);
        expect(() => initializer.handle.assertCurrent()).toThrow(
          "Session initialization is rolling back",
        );
        if (withBinding) {
          expect(fixture.readBinding()).toBeUndefined();
        } else {
          expect(fixture.readBinding()).toBeDefined();
        }
      } finally {
        initializer.close();
      }
    });
  },
);
