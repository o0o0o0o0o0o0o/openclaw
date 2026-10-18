import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readBoardHtml } from "../boards/board-store.test-support.js";
import { buildWidgetDocument } from "../canvas/wrap.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/io.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.entry.js";
import * as historyReaders from "../config/sessions/session-transcript-worker-readers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { invalidateRegisteredAgentDatabasesMemo } from "../state/openclaw-agent-db-registry-listing.js";
import { registerOpenClawAgentDatabase } from "../state/openclaw-agent-db-registry.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../test-utils/main-thread-sql-spies.test-support.js";
import { boardStore } from "./board-store.js";
import { progressCardStore } from "./progress-card-store.js";
import { createBoardHarness } from "./server-methods/board.test-support.js";
import { createProgressCardHandlers } from "./server-methods/progress-card.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let stateDir: string;
beforeEach(() => {
  stateDir = tempDirs.make("openclaw-gateway-boards-");
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
});

async function closeDatabases() {
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  await closeOpenClawStateDatabaseAsync();
  closeOpenClawStateDatabaseForTest();
}

function progressHarness(cfg: OpenClawConfig) {
  const harness = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  Object.assign(harness.handlers, createProgressCardHandlers());
  return harness;
}

function configure(
  agents: string[],
  session?: OpenClawConfig["session"],
  defaults?: NonNullable<OpenClawConfig["agents"]>["defaults"],
) {
  const cfg: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: Object.fromEntries(agents.map((id) => [id, {}])),
      defaults,
    },
    session,
  };
  setRuntimeConfigSnapshot(cfg, cfg);
  return cfg;
}

function expectCard(response: unknown, card: Record<string, unknown> | null) {
  expect(response).toHaveBeenCalledWith(
    true,
    { card: card === null ? null : expect.objectContaining(card) },
    undefined,
  );
}

function seedSession(
  scope: Parameters<typeof replaceSessionEntrySync>[0],
  sessionId: string,
  updatedAt = 1,
) {
  replaceSessionEntrySync(scope, { sessionId, updatedAt });
}

function expectBoard(response: unknown, fields: Record<string, unknown>) {
  expect(response).toHaveBeenCalledWith(true, expect.objectContaining(fields));
}

afterEach(async () => {
  await closeDatabases();
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it("keeps global boards and progress under each owner's canonical row across reopen", async () => {
  const cfg = configure(["main", "work"], { scope: "global" });
  const { invoke, broadcast } = progressHarness(cfg);

  for (const agentId of ["main", "work"]) {
    const database = openOpenClawAgentDatabase({ agentId });
    const target = { agentId, sessionKey: "global" };
    seedSession({ ...target, storePath: database.path }, `session-${agentId}`);
    const written = await invoke("board.widget.put", {
      ...target,
      name: "status",
      content: { kind: "html", html: `<p>${agentId}</p>` },
    });
    expectBoard(written, { sessionKey: `agent:${agentId}:global`, revision: 1 });
    expect(database.db.prepare("SELECT session_key FROM board_tabs").all()).toEqual([
      expect.objectContaining({ session_key: "global" }),
    ]);
    const progress = await invoke("progressCard.put", {
      ...target,
      plan: [{ step: `${agentId} done`, status: "completed" }],
    });
    expectCard(progress, { sessionKey: `agent:${agentId}:global`, revision: 1 });
    for (const table of ["session_progress_cards", "session_nodes"]) {
      expect(database.db.prepare(`SELECT session_key FROM ${table}`).all()).toEqual([
        expect.objectContaining({ session_key: "global" }),
      ]);
    }
  }
  await closeDatabases();

  for (const agentId of ["main", "work"]) {
    const target = { sessionKey: "global", agentId };
    for (const params of [target, { sessionKey: `agent:${agentId}:main` }]) {
      expect(await boardStore.getSnapshot(params)).toMatchObject({
        sessionKey: "global",
        widgets: [{ name: "status", revision: 1 }],
      });
      expect((await readBoardHtml(boardStore, params, "status"))?.html).toBe(
        buildWidgetDocument("status", `<p>${agentId}</p>`),
      );
      const snapshot = await invoke("board.get", params);
      expectBoard(snapshot, {
        sessionKey: `agent:${agentId}:global`,
        widgets: [expect.objectContaining({ name: "status", revision: 1 })],
      });
    }
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    const parentSql = observeMainThreadSql();
    try {
      const progress = await invoke("progressCard.get", { sessionKey: "global", agentId });
      expectCard(progress, {
        sessionKey: `agent:${agentId}:global`,
        revision: 1,
        steps: [{ step: `${agentId} done`, status: "completed" }],
      });
      await closeOpenClawAgentDatabasesAsync();
      await closeOpenClawStateDatabaseAsync();
      parentSql.expectIdle();
    } finally {
      parentSql.restore();
    }
  }
  await invoke("progressCard.put", { sessionKey: "agent:work:main", expectedRevision: 2 });
  expect((await progressCardStore.get("global", "work"))?.revision).toBe(1);
  const cleared = await invoke("progressCard.put", {
    sessionKey: "global",
    agentId: "work",
    expectedRevision: 1,
  });
  expectCard(cleared, null);
  expect(broadcast).toHaveBeenLastCalledWith(
    "progressCard.changed",
    { sessionKey: "agent:work:global", revision: null },
    { sessionKeys: ["global"], agentId: "work" },
  );
  expect((await progressCardStore.get("global", "main"))?.revision).toBe(1);
});

it("keeps retained global progress separate from an ordinary qualified global row in per-sender mode", async () => {
  const cfg = configure(
    ["main", "work"],
    { scope: "per-sender" },
    { systemAgent: { agentId: "main" } },
  );
  const { invoke } = progressHarness(cfg);
  const targets = [
    { sessionKey: "global", agentId: "main" },
    { sessionKey: "global", agentId: "work" },
    { sessionKey: "agent:work:global", agentId: "work" },
  ];
  for (const target of targets) {
    const database = openOpenClawAgentDatabase({ agentId: target.agentId });
    seedSession({ ...target, storePath: database.path }, `${target.agentId}-${target.sessionKey}`);
    const written = await invoke("progressCard.put", {
      ...target,
      markdown: `${target.agentId}/${target.sessionKey}`,
      plan: [{ step: "Done", status: "completed" }],
    });
    expectCard(written, { revision: 1 });
  }
  await closeDatabases();

  for (const target of targets) {
    const read = await invoke("progressCard.get", target);
    expectCard(read, {
      sessionKey: `agent:${target.agentId}:global`,
      markdown: `${target.agentId}/${target.sessionKey}`,
      revision: 1,
    });
  }
  const unqualified = await invoke("progressCard.get", { sessionKey: "global" });
  expectCard(unqualified, { markdown: "main/global" });
  const stale = await invoke("progressCard.put", {
    sessionKey: "global",
    agentId: "work",
    expectedRevision: 2,
  });
  expectCard(stale, { markdown: "work/global", revision: 1 });
  const cleared = await invoke("progressCard.put", {
    sessionKey: "global",
    agentId: "work",
    expectedRevision: 1,
  });
  expectCard(cleared, null);
  expect(await progressCardStore.get("global", "work")).toBeNull();
  expect((await progressCardStore.get("global", "main"))?.markdown).toBe("main/global");
  expect((await progressCardStore.get("agent:work:global", "work"))?.markdown).toBe(
    "work/agent:work:global",
  );
});

it("prepares custom board targets off-thread and observes a newly registered store owner", async () => {
  const storePath = path.join(stateDir, "custom", "sessions.json");
  const databasePath = path.join(stateDir, "custom", "openclaw-agent.sqlite");
  configure(["main", "ops"], { store: storePath });
  const target = { sessionKey: "agent:ops:board" };
  expect(await boardStore.getSnapshot(target)).toMatchObject({ revision: 0, widgets: [] });
  expect(fs.existsSync(databasePath)).toBe(false);

  const database = openOpenClawAgentDatabase({ agentId: "ops", path: databasePath });
  seedSession({ agentId: "ops", ...target, storePath: database.path }, "registered-board");
  registerOpenClawAgentDatabase({ agentId: "ops", path: database.path });
  const host = observeHostDataSql();
  try {
    await boardStore.putWidget({
      ...target,
      name: "status",
      content: { kind: "html", html: "registered owner" },
    });
    expect(await boardStore.getSnapshot(target)).toMatchObject({
      revision: 1,
      widgets: [{ name: "status" }],
    });
    expect((await readBoardHtml(boardStore, target, "status"))?.html).toBe("registered owner");
    expect(host.queries).toEqual([]);
  } finally {
    host.restore();
  }
});

it("reopens separate boards and progress cards in a shared database owned by another agent", async () => {
  const storePath = path.join(stateDir, "shared.sqlite");
  const cfg = configure(
    ["alpha", "beta"],
    { store: storePath },
    { sessionStore: { agentId: "alpha" } },
  );
  openOpenClawAgentDatabase({ agentId: "alpha", path: storePath });
  // An older canonical registration must not replace the configured store's physical owner.
  openOpenClawAgentDatabase({ agentId: "beta" });

  for (const agentId of ["alpha", "beta"]) {
    const sessionKey = `agent:${agentId}:main`;
    seedSession({ agentId, sessionKey, storePath }, `session-${agentId}`, Date.now());
    await boardStore.putWidget({
      sessionKey,
      name: agentId,
      content: { kind: "html", html: `<p>${agentId}</p>` },
    });
    await progressCardStore.put(sessionKey, { markdown: `${agentId} progress` });
  }
  await closeDatabases();

  const { invoke } = createBoardHarness(undefined, {}, boardStore, { getRuntimeConfig: () => cfg });
  const create = historyReaders.createSessionHistoryWorkerReaders;
  const interceptSnapshot = (before: () => void, after: () => void) =>
    vi.spyOn(historyReaders, "createSessionHistoryWorkerReaders").mockImplementation((run) => {
      const readers = create(run);
      return {
        ...readers,
        async readBoardSnapshot(input) {
          before();
          const snapshot = await readers.readBoardSnapshot(input);
          after();
          return snapshot;
        },
      };
    });
  const resolverSql: string[] = [];
  const observations: ReturnType<typeof observeHostDataSql>[] = [];
  let reads = 0;
  const finishObservation = () => {
    for (const host of observations.splice(0)) {
      resolverSql.push(
        ...host.queries.filter((sql) =>
          /\bfrom\s+"?(?:agent_databases|schema_meta)"?\b/iu.test(sql),
        ),
      );
      host.restore();
    }
  };
  const interception = interceptSnapshot(
    () => {
      reads++;
      invalidateRegisteredAgentDatabasesMemo({});
      observations.push(observeHostDataSql());
    },
    () => {
      invalidateRegisteredAgentDatabasesMemo({});
    },
  );
  try {
    for (const agentId of ["alpha", "beta"]) {
      try {
        const response = await invoke("board.get", { sessionKey: `agent:${agentId}:main` });
        expectBoard(response, {
          widgets: [expect.objectContaining({ name: agentId, revision: 1 })],
        });
      } finally {
        finishObservation();
      }
    }
    expect(reads).toBe(2);
    expect(resolverSql).toEqual([]);
  } finally {
    interception.mockRestore();
  }

  for (const agentId of ["alpha", "beta"]) {
    const sessionKey = `agent:${agentId}:main`;
    expect((await boardStore.getSnapshot({ sessionKey })).widgets).toEqual([
      expect.objectContaining({ name: agentId, revision: 1 }),
    ]);
    expect(await progressCardStore.get(sessionKey)).toMatchObject({
      sessionKey,
      markdown: `${agentId} progress`,
      revision: 1,
    });
  }

  for (const stage of ["before-read", "after-read"] as const) {
    const replacement = { ...cfg, session: { store: path.join(stateDir, "replacement.sqlite") } };
    const revokeAt = (at: typeof stage) => {
      if (stage === at) {
        setRuntimeConfigSnapshot(replacement, replacement);
      }
    };
    const revoked = interceptSnapshot(
      () => revokeAt("before-read"),
      () => revokeAt("after-read"),
    );
    try {
      const response = await invoke("board.get", { sessionKey: "agent:beta:main" });
      expect(response).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ message: expect.stringContaining("board session changed") }),
      );
      expect(fs.existsSync(replacement.session.store)).toBe(false);
    } finally {
      revoked.mockRestore();
      setRuntimeConfigSnapshot(cfg, cfg);
    }
  }
});

it("keeps missing progress-card storage absent and reports unreadable stored cards", async () => {
  configure(["main"]);
  const key = "agent:main:main";
  expect(await progressCardStore.get(key)).toBeNull();
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }))).toBe(false);
  expect(fs.existsSync(path.join(stateDir, "state", "openclaw.sqlite"))).toBe(false);
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  seedSession({ agentId: "main", sessionKey: key, storePath: database.path }, "reader-card");
  expect(await progressCardStore.get(key)).toBeNull();
  await progressCardStore.put(key, { markdown: "card" });
  database.db
    .prepare("UPDATE session_progress_cards SET steps_json = ? WHERE session_key = ?")
    .run("invalid JSON", key);
  await expect(progressCardStore.get(key)).rejects.toThrow(/JSON/);
});
