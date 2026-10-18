import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import * as sessionDirs from "../../agents/session-dirs.js";
import type { OpenClawConfig } from "../config.js";
import { resolveSessionStorePathCore } from "./paths.js";
import { replaceSessionEntry } from "./session-accessor.js";
import { resolveExistingAgentSessionStoreTargetsSync } from "./targets-discovery.native.js";
import {
  resolveAgentSessionStoreTargetsSync,
  resolveAllAgentSessionStoreCandidateTargetsSync,
  resolveAllAgentSessionStoreTargetsSync,
} from "./targets.js";
import {
  countMatching,
  createAgentSessionStores,
  createCustomRootCfg,
  EXPLICIT_MAIN_CONFIG,
  expectTargetsToContainStores,
  resolveTargetsForCustomRoot,
  resolveRealStorePath,
} from "./targets.test-support.js";

async function writeLegacyStore(storePath: string, entries: Record<string, unknown>) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(entries), "utf8");
}

async function writeSession(storePath: string, sessionId: string, agentId?: string) {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await replaceSessionEntry(
    { agentId, storePath, sessionKey: "main" },
    { sessionId, updatedAt: Date.now() },
  );
}

describe("resolveAgentSessionStoreTargetsSync", () => {
  it.each([
    ["candidate", resolveAgentSessionStoreTargetsSync],
    ["existing", resolveExistingAgentSessionStoreTargetsSync],
  ] as const)("resolves a configured %s store without broad discovery", async (_kind, resolve) => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      const storePaths = await createAgentSessionStores(customRoot, ["main", "codex"]);
      const cfg: OpenClawConfig = {
        ...createCustomRootCfg(customRoot, "main"),
        agents: { entries: { main: {}, codex: {} } },
      };
      const enumerateAgentDirs = vi.spyOn(sessionDirs, "resolveAgentSessionDirsFromAgentsDirSync");
      try {
        expect(resolve(cfg, "codex", { env: process.env })).toEqual([
          { agentId: "codex", storePath: storePaths.codex },
        ]);
        expect(enumerateAgentDirs).not.toHaveBeenCalled();
      } finally {
        enumerateAgentDirs.mockRestore();
      }
    });
  });

  it("finds discovered directories whose names normalize to the requested agent", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      const storePaths = await createAgentSessionStores(customRoot, ["main", "Retired Agent"]);
      const cfg = createCustomRootCfg(customRoot, "main");

      expect(
        resolveAgentSessionStoreTargetsSync(cfg, "retired-agent", { env: process.env }),
      ).toEqual([{ agentId: "retired-agent", storePath: storePaths["Retired Agent"] }]);
    });
  });
});

describe("resolveExistingAgentSessionStoreTargetsSync", () => {
  it("requires agent-specific rows instead of fixed-store file existence", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "shared", "sessions.json");
      await writeLegacyStore(storePath, {
        "agent:ghost:existing": { sessionId: "legacy-ghost", updatedAt: 42 },
      });
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { store: storePath },
      };

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ghost")).toEqual([]);
      expect(await fs.readdir(path.dirname(storePath))).toEqual(["sessions.json"]);

      await replaceSessionEntry(
        { agentId: "ghost", sessionKey: "agent:ghost:existing", storePath },
        { sessionId: "session-ghost", updatedAt: 42 },
      );

      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ghost")).toEqual([
        { agentId: "ghost", storePath },
      ]);
    });
  });

  it("includes existing deterministic template targets outside discoverable agent roots", async () => {
    await withTempHome(async (home) => {
      const storeTemplate = path.join(home, "external-stores", "sessions-{agentId}.json");
      const cfg: OpenClawConfig = {
        agents: { entries: { main: {} } },
        session: { store: storeTemplate },
      };
      const legacyStorePath = resolveSessionStorePathCore(storeTemplate, {
        agentId: "retired-legacy",
      });
      const sqliteStorePath = resolveSessionStorePathCore(storeTemplate, {
        agentId: "retired-sqlite",
      });
      await writeLegacyStore(legacyStorePath, {
        "agent:retired-legacy:existing": { sessionId: "legacy-retired", updatedAt: 42 },
      });
      await replaceSessionEntry(
        {
          agentId: "retired-sqlite",
          sessionKey: "agent:retired-sqlite:existing",
          storePath: sqliteStorePath,
        },
        { sessionId: "sqlite-retired", updatedAt: 42 },
      );

      expect(resolveAllAgentSessionStoreTargetsSync(cfg)).not.toContainEqual({
        agentId: "retired-legacy",
        storePath: legacyStorePath,
      });
      expect(resolveAllAgentSessionStoreTargetsSync(cfg)).not.toContainEqual({
        agentId: "retired-sqlite",
        storePath: sqliteStorePath,
      });
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "retired-legacy")).toEqual([]);
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "retired-sqlite")).toEqual([
        { agentId: "retired-sqlite", storePath: sqliteStorePath },
      ]);
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "ghost")).toEqual([]);
    });
  });

  it("rejects a deterministic target whose store symlink escapes the agents root", async () => {
    await withTempHome(async (home) => {
      if (process.platform === "win32") {
        return;
      }
      const customRoot = path.join(home, "custom-state");
      const escapedSessionsDir = path.join(customRoot, "agents", "escaped", "sessions");
      const outsideStorePath = path.join(home, "outside-sessions.json");
      const escapedStorePath = path.join(escapedSessionsDir, "sessions.json");
      await fs.mkdir(escapedSessionsDir, { recursive: true });
      await writeLegacyStore(outsideStorePath, {
        "agent:escaped:secret": { sessionId: "outside-session", updatedAt: 42 },
      });
      await fs.symlink(outsideStorePath, escapedStorePath);

      const cfg = createCustomRootCfg(customRoot, "main");
      expect(resolveAllAgentSessionStoreTargetsSync(cfg)).not.toContainEqual({
        agentId: "escaped",
        storePath: escapedStorePath,
      });
      expect(resolveExistingAgentSessionStoreTargetsSync(cfg, "escaped")).toEqual([]);
    });
  });
});

describe("resolveAllAgentSessionStoreTargetsSync", () => {
  it("includes legacy JSON stores before an agent SQLite database exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const sessionsDir = path.join(stateDir, "agents", "legacy", "sessions");
      const storePath = path.join(sessionsDir, "sessions.json");
      await writeLegacyStore(storePath, {
        main: { sessionId: "legacy-session", updatedAt: Date.now() },
      });

      const targets = resolveAllAgentSessionStoreTargetsSync(
        { agents: { entries: { legacy: {} } } },
        { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } },
      );

      expect(targets).toContainEqual({ agentId: "legacy", storePath });
    });
  });

  it("keeps the actual on-disk store path for discovered retired agents", async () => {
    await withTempHome(async (home) => {
      const { storePaths, targets } = await resolveTargetsForCustomRoot(home, [
        "ops",
        "Retired Agent",
      ]);

      expect(targets).toContainEqual({
        agentId: "retired-agent",
        storePath: storePaths["Retired Agent"],
      });
      expectTargetsToContainStores(targets, { ops: storePaths.ops });
      expect(countMatching(targets, (target) => target.storePath === storePaths.ops)).toBe(1);
      const scoped = resolveAllAgentSessionStoreTargetsSync(
        createCustomRootCfg(path.join(home, "custom-state")),
        { env: process.env, agentIds: new Set(["retired-agent"]) },
      );
      expect(scoped).toEqual([
        { agentId: "retired-agent", storePath: storePaths["Retired Agent"] },
      ]);
    });
  });

  it("respects the caller env when resolving configured and discovered store roots", async () => {
    await withTempHome(async (home) => {
      const envStateDir = path.join(home, "env-state");
      const mainSessionsDir = path.join(envStateDir, "agents", "main", "sessions");
      const retiredSessionsDir = path.join(envStateDir, "agents", "retired", "sessions");
      await writeSession(path.join(mainSessionsDir, "sessions.json"), "sid-main");
      await writeSession(path.join(retiredSessionsDir, "sessions.json"), "sid-retired");

      const env = { ...process.env, OPENCLAW_STATE_DIR: envStateDir };
      const cfg: OpenClawConfig = EXPLICIT_MAIN_CONFIG;
      const mainStorePath = await resolveRealStorePath(mainSessionsDir);
      const retiredStorePath = await resolveRealStorePath(retiredSessionsDir);

      const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env });

      expect(targets).toEqual(
        expect.arrayContaining([
          { agentId: "main", storePath: mainStorePath },
          { agentId: "retired", storePath: retiredStorePath },
        ]),
      );
    });
  });

  it("skips unreadable or invalid discovery roots when other roots are still readable", async () => {
    await withTempHome(async (home) => {
      const customRoot = path.join(home, "custom-state");
      await fs.mkdir(customRoot, { recursive: true });
      await fs.writeFile(path.join(customRoot, "agents"), "not-a-directory", "utf8");

      const envStateDir = path.join(home, "env-state");
      const storePaths = await createAgentSessionStores(envStateDir, ["main", "retired"]);
      const cfg = createCustomRootCfg(customRoot, "main");
      const env = { ...process.env, OPENCLAW_STATE_DIR: envStateDir };

      const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env });
      expect(targets).toContainEqual({ agentId: "retired", storePath: storePaths.retired });
    });
  });

  it("skips symlinked discovered stores under templated agents roots", async () => {
    await withTempHome(async (home) => {
      if (process.platform === "win32") {
        return;
      }
      const customRoot = path.join(home, "custom-state");
      const opsSessionsDir = path.join(customRoot, "agents", "ops", "sessions");
      const opsAgentDbDir = path.join(customRoot, "agents", "ops", "agent");
      const leakedFile = path.join(home, "outside.sqlite");
      await fs.mkdir(opsSessionsDir, { recursive: true });
      await fs.mkdir(opsAgentDbDir, { recursive: true });
      await fs.writeFile(leakedFile, JSON.stringify({ leak: { secret: "x" } }), "utf8");
      await fs.symlink(leakedFile, path.join(opsAgentDbDir, "openclaw-agent.sqlite"));

      const targets = resolveAllAgentSessionStoreTargetsSync(createCustomRootCfg(customRoot), {
        env: process.env,
      });
      const symlinkStoreSuffix = path.join("ops", "sessions", "sessions.json");
      expect(
        targets.some(
          (target) => target.agentId === "ops" && target.storePath.includes(symlinkStoreSuffix),
        ),
      ).toBe(false);
    });
  });

  it("skips discovered directories that only normalize into the default main agent", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const mainSessionsDir = path.join(stateDir, "agents", "main", "sessions");
      const junkSessionsDir = path.join(stateDir, "agents", "###", "sessions");
      const collisionSessionsDir = path.join(stateDir, "agents", "main!", "sessions");
      const whitespaceSessionsDir = path.join(stateDir, "agents", "main ", "sessions");
      for (const [directory, id] of [
        [mainSessionsDir, "main"],
        [junkSessionsDir, "junk"],
        [collisionSessionsDir, "collision"],
        [whitespaceSessionsDir, "whitespace"],
      ]) {
        await writeSession(path.join(directory, "sessions.json"), `sid-${id}`, "main");
      }

      const cfg: OpenClawConfig = EXPLICIT_MAIN_CONFIG;
      const mainStorePath = await resolveRealStorePath(mainSessionsDir);
      const targets = resolveAllAgentSessionStoreTargetsSync(cfg, { env: process.env });

      expect(targets).toEqual([{ agentId: "main", storePath: mainStorePath }]);
    });
  });
});

describe("resolveAllAgentSessionStoreCandidateTargetsSync", () => {
  it("includes configured targets before either state file exists", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
      const storePath = resolveSessionStorePathCore(undefined, { agentId: "main", env });

      expect(
        resolveAllAgentSessionStoreCandidateTargetsSync(
          { agents: { entries: { main: {} } } },
          { env },
        ),
      ).toContainEqual({ agentId: "main", storePath });
    });
  });

  it("includes retired agent directories after both state files are removed", async () => {
    await withTempHome(async (home) => {
      const stateDir = path.join(home, ".openclaw");
      const retiredAgentDir = path.join(stateDir, "agents", "retired");
      await fs.mkdir(retiredAgentDir, { recursive: true });
      const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };

      expect(
        resolveAllAgentSessionStoreCandidateTargetsSync(EXPLICIT_MAIN_CONFIG, { env }),
      ).toContainEqual({
        agentId: "retired",
        storePath: path.join(retiredAgentDir, "sessions", "sessions.json"),
      });
    });
  });

  it.each([false, true])(
    "rejects escaping candidate session directories (configured: %s)",
    async (configured) => {
      await withTempHome(async (home) => {
        if (process.platform === "win32") {
          return;
        }
        const stateDir = path.join(home, configured ? "custom-state" : ".openclaw");
        const agentId = configured ? "ops" : "retired";
        const agentDir = path.join(stateDir, "agents", agentId);
        const outside = path.join(home, "outside-sessions");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.mkdir(outside, { recursive: true });
        await fs.symlink(outside, path.join(agentDir, "sessions"));
        const cfg = configured ? createCustomRootCfg(stateDir) : EXPLICIT_MAIN_CONFIG;
        const env = configured ? process.env : { ...process.env, OPENCLAW_STATE_DIR: stateDir };
        expect(resolveAllAgentSessionStoreCandidateTargetsSync(cfg, { env })).not.toContainEqual({
          agentId,
          storePath: path.join(agentDir, "sessions", "sessions.json"),
        });
      });
    },
  );
});
