import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { createBedrockAwsSdkConfig } from "./config-fixtures.test-support.js";
import { authProfilesLog } from "./constants.js";
import { createApiKeyCredential } from "./credential-fixtures.test-support.js";
import {
  authStoreMocks,
  configureProviderRoutes,
  createAuthStoreWithProfiles,
  createAutomaticSessionEntry,
  prepareCooldownAuthState,
  resolveSession,
  TEST_PRIMARY_PROFILE_ID as PRIMARY,
  TEST_SECONDARY_PROFILE_ID as SECONDARY,
  withAuthState,
} from "./session-override.test-support.js";
import { isProfileInCooldown } from "./usage-state.js";

describe("resolveSessionAuthProfileOverride", () => {
  it("returns early when no auth sources exist", () =>
    withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });

      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };

      const resolved = await resolveSession({
        provider: "openrouter",
        agentDir,
        sessionEntry,
      });

      expect(resolved).toBeUndefined();
      expect(authStoreMocks.ensureAuthProfileStoreAsync).not.toHaveBeenCalled();
      await expect(fs.access(`${agentDir}/auth-profiles.json`)).rejects.toMatchObject({
        code: "ENOENT",
      });
    }));

  it("keeps config-only aws-sdk user overrides", () =>
    withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      const sessionEntry = createAutomaticSessionEntry({
        authProfileOverride: "amazon-bedrock:default",
        authProfileOverrideSource: "user",
      });

      const resolved = await resolveSession({
        cfg: createBedrockAwsSdkConfig(),
        provider: "amazon-bedrock",
        agentDir,
        sessionEntry,
      });

      expect(resolved).toBe("amazon-bedrock:default");
      expect(sessionEntry.authProfileOverride).toBe("amazon-bedrock:default");
    }));

  it("clears aws-sdk config override when stored profile drifted to another provider", () =>
    withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          "amazon-bedrock:default": createApiKeyCredential("openrouter", "sk-drifted"),
        },
      });

      const sessionEntry = createAutomaticSessionEntry({
        authProfileOverride: "amazon-bedrock:default",
        authProfileOverrideSource: "user",
      });

      const resolved = await resolveSession({
        cfg: createBedrockAwsSdkConfig(),
        provider: "amazon-bedrock",
        agentDir,
        sessionEntry,
      });

      expect(resolved).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    }));

  it("rotates unavailable auth state without restoring concurrent session management fields", () =>
    withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      authStoreMocks.state.hasSource = true;
      authStoreMocks.state.store = createAuthStoreWithProfiles({
        profiles: {
          [PRIMARY]: createApiKeyCredential("openai", "sk-primary"),
          [SECONDARY]: createApiKeyCredential("openai", "sk-secondary"),
        },
        order: {
          openai: [PRIMARY, SECONDARY],
        },
      });
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (_store, profileId) => profileId === PRIMARY,
      );

      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(
        scope,
        createAutomaticSessionEntry({
          label: "before",
          pinnedAt: 1,
          compactionCount: 1,
          authProfileOverrideCompactionCount: 0,
        }),
      );
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(sessionEntry).toBeDefined();
      const sessionStore = { [sessionKey]: sessionEntry! };

      await patchSessionEntryCore(scope, () => ({ label: "renamed", pinnedAt: undefined }));
      const resolved = await resolveSession({
        agentDir,
        sessionEntry: sessionEntry!,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBe(SECONDARY);
      const persisted = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(persisted).toMatchObject({
        label: "renamed",
        authProfileOverride: SECONDARY,
        authProfileOverrideCompactionCount: 1,
      });
      expect(persisted?.pinnedAt).toBeUndefined();
      expect(sessionStore[sessionKey]?.label).toBe("renamed");
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    }));

  it("clears a persisted automatic override when every auth profile is in cooldown", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        profileIds: [PRIMARY, SECONDARY],
      });

      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(
        scope,
        createAutomaticSessionEntry({
          label: "before",
          pinnedAt: 1,
          authProfileOverrideCompactionCount: 3,
        }),
      );
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" });
      expect(sessionEntry).toBeDefined();
      const sessionStore = { [sessionKey]: sessionEntry! };
      await patchSessionEntryCore(scope, () => ({ label: "renamed", pinnedAt: undefined }));

      const resolved = await resolveSession({
        agentDir,
        sessionEntry: sessionEntry!,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBeUndefined();
      for (const entry of [
        sessionEntry,
        sessionStore[sessionKey],
        loadSessionEntry({ ...scope, readConsistency: "latest" }),
      ]) {
        expect(entry?.authProfileOverride).toBeUndefined();
        expect(entry?.authProfileOverrideSource).toBeUndefined();
        expect(entry?.authProfileOverrideCompactionCount).toBeUndefined();
      }
      expect(sessionStore[sessionKey]?.label).toBe("renamed");
      expect(sessionStore[sessionKey]?.pinnedAt).toBeUndefined();
    }));

  it.each([
    ["persisted", true, false, "user"],
    ["in-memory", false, false, "user"],
    ["persisted cross-provider", true, true, "user"],
    ["persisted automatic", true, false, "auto"],
  ] as const)(
    "preserves a newer %s override against an obsolete automatic clear",
    async (_label, persisted, crossProvider, source) => {
      await withAuthState(async (state) => {
        const agentDir = await prepareCooldownAuthState(state, {
          profileIds: [PRIMARY, SECONDARY],
        });
        const latestProfileId = crossProvider ? "anthropic:manual" : SECONDARY;
        if (crossProvider) {
          authStoreMocks.state.store.profiles[latestProfileId] = createApiKeyCredential(
            "anthropic",
            "sk-anthropic",
          );
        }
        const sessionKey = "agent:main:main";
        const scope = { storePath: path.join(state.sessionsDir(), "sessions.json"), sessionKey };
        let sessionEntry = createAutomaticSessionEntry({
          label: "before",
          pinnedAt: 1,
          authProfileOverrideCompactionCount: 3,
        });
        const latestEntry: SessionEntry = {
          sessionId: "s1",
          updatedAt: 2,
          label: "manually selected",
          authProfileOverride: latestProfileId,
          ...(source ? { authProfileOverrideSource: source } : {}),
        };
        if (persisted) {
          await replaceSessionEntry(scope, sessionEntry);
          sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" })!;
          await patchSessionEntryCore(scope, () => ({
            ...latestEntry,
            authProfileOverrideSource: source,
            pinnedAt: undefined,
            authProfileOverrideCompactionCount: undefined,
          }));
        }
        const sessionStore = { [sessionKey]: persisted ? sessionEntry : latestEntry };
        const resolved = await resolveSession({
          agentDir,
          sessionEntry,
          sessionStore,
          sessionKey,
          storePath: persisted ? scope.storePath : undefined,
        });

        expect(resolved).toBe(crossProvider || source === "auto" ? undefined : SECONDARY);
        const entries = [sessionEntry, sessionStore[sessionKey]];
        if (persisted) {
          entries.push(loadSessionEntry({ ...scope, readConsistency: "latest" })!);
        }
        latestEntry.updatedAt = sessionStore[sessionKey].updatedAt;
        for (const entry of entries) {
          expect(entry).toMatchObject(latestEntry);
          expect(entry.authProfileOverrideCompactionCount).toBeUndefined();
          expect(entry.pinnedAt).toBeUndefined();
        }
      });
    },
  );

  it("preserves newer in-memory session metadata when an automatic override snapshot still matches", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionEntry = createAutomaticSessionEntry({ label: "stale", pinnedAt: 1 });
      const latestEntry = createAutomaticSessionEntry({ label: "latest", pinnedAt: 2 });
      const sessionStore = { "agent:main:main": latestEntry };

      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionStore["agent:main:main"]).toBe(latestEntry);
      for (const entry of [sessionEntry, latestEntry]) {
        expect(entry).toMatchObject({ label: "latest", pinnedAt: 2 });
        expect(entry.authProfileOverride).toBeUndefined();
        expect(entry.authProfileOverrideSource).toBeUndefined();
      }
    }));

  it("does not recreate a concurrently deleted in-memory session", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionEntry = createAutomaticSessionEntry();
      const sessionStore: Record<string, SessionEntry> = {};

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore })).toBeUndefined();
      expect(Object.hasOwn(sessionStore, "agent:main:main")).toBe(false);
      expect(sessionEntry.authProfileOverride).toBe(PRIMARY);
    }));

  it("does not recreate a concurrently deleted session while clearing its automatic override", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);
      const sessionKey = "agent:main:main";
      const storePath = path.join(state.sessionsDir(), "sessions.json");
      const scope = { storePath, sessionKey };
      await replaceSessionEntry(
        scope,
        createAutomaticSessionEntry({ sessionId: "deleted-session" }),
      );
      const sessionEntry = loadSessionEntry({ ...scope, readConsistency: "latest" })!;
      const sessionStore = { [sessionKey]: sessionEntry };
      await deleteSessionEntryLifecycle({
        archiveTranscript: false,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      });

      const resolved = await resolveSession({
        agentDir,
        sessionEntry,
        sessionStore,
        sessionKey,
        storePath,
      });

      expect(resolved).toBeUndefined();
      expect(loadSessionEntry({ ...scope, readConsistency: "latest" })).toBeUndefined();
    }));

  it("clears an automatic override when a model-scoped cooldown also has a profile-wide disable", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state, {
        usageStats: {
          [PRIMARY]: {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
            cooldownModel: "model-x",
            disabledUntil: Date.now() + 60_000,
            disabledReason: "billing",
          },
        },
      });

      const sessionEntry = createAutomaticSessionEntry({
        model: "model-y",
        authProfileOverrideCompactionCount: 0,
      });

      const resolved = await resolveSession({ agentDir, sessionEntry });

      expect(resolved).toBeUndefined();
      expect(sessionEntry.authProfileOverride).toBeUndefined();
      expect(sessionEntry.authProfileOverrideSource).toBeUndefined();
    }));

  it("keeps an automatic pin for a sibling of a managed provider's blocked model", () =>
    withAuthState(async (state) => {
      const profileId = "openrouter:manual";
      const agentDir = await prepareCooldownAuthState(state, { profileIds: [profileId] });
      authStoreMocks.state.store = {
        version: 1,
        profiles: { [profileId]: createApiKeyCredential("openrouter", "sk-test") },
        order: { openrouter: [profileId] },
        usageStats: {
          [profileId]: {
            cooldownUntil: Date.now() + 60_000,
            cooldownReason: "rate_limit",
            blockedUntil: Date.now() + 60_000,
            blockedScope: "model",
            blockedModel: "model-x",
            blockedReason: "subscription_limit",
          },
        },
      };
      authStoreMocks.isProfileInCooldown.mockImplementation(isProfileInCooldown);
      const sessionEntry = createAutomaticSessionEntry({
        authProfileOverride: profileId,
        model: "model-y",
      });
      const snapshot = createPluginMetadataSnapshotFixture({
        plugins: [{ id: "openrouter", providers: ["openrouter"], managesOwnAvailability: true }],
      });
      const resolved = await withPluginMetadataSnapshotScope(
        snapshot,
        () =>
          resolveSession({
            agentDir,
            provider: "openrouter",
            sessionEntry,
            sessionStore: { "agent:main:main": sessionEntry },
          }),
        { trustConfigIdentity: true },
      );
      expect(resolved).toBe(profileId);
      expect(sessionEntry.authProfileOverride).toBe(profileId);
    }));

  it("does not persist an automatic override when every auth profile is in cooldown", () =>
    withAuthState(async (state) => {
      const agentDir = await prepareCooldownAuthState(state);

      const sessionEntry: SessionEntry = { sessionId: "s1", updatedAt: 1 };
      const sessionStore = { "agent:main:main": sessionEntry };
      const resolved = await resolveSession({ agentDir, sessionEntry, sessionStore });

      expect(resolved).toBeUndefined();
      expect(sessionEntry).toEqual({ sessionId: "s1", updatedAt: 1 });
      expect(sessionStore["agent:main:main"]).toBe(sessionEntry);
    }));

  it("does not replace a missing user override with an auth profile in cooldown", () =>
    withAuthState(async (state) => {
      const warn = vi.spyOn(authProfilesLog, "warn").mockImplementation(() => {});
      const agentDir = await prepareCooldownAuthState(state);

      const sessionEntry = createAutomaticSessionEntry({
        authProfileOverride: "openai:missing",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      });
      const resolved = await resolveSession({ agentDir, sessionEntry });

      expect(resolved).toBe("openai:missing");
      expect(sessionEntry).toMatchObject({
        authProfileOverride: "openai:missing",
        authProfileOverrideSource: "user",
        authProfileOverrideCompactionCount: 2,
      });
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          event: "session_auth_profile_unavailable",
          profileId: "openai:missing",
        }),
      );
    }));
});

const OPENAI_MODEL_ID = "gpt-5.6-sol";
const API_PRIMARY_PROFILE_ID = "openai:api-primary";
const API_BACKUP_PROFILE_ID = "openai:api-backup";
const OAUTH_PROFILE_ID = "openai:subscription";

function configureMixedOpenAiAuthStore(): void {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = {
    version: 1,
    profiles: {
      [API_PRIMARY_PROFILE_ID]: createApiKeyCredential("openai", "sk-primary"),
      [API_BACKUP_PROFILE_ID]: createApiKeyCredential("openai", "sk-backup"),
      [OAUTH_PROFILE_ID]: {
        type: "oauth",
        provider: "openai",
        access: "test-access",
        refresh: "test-refresh",
        expires: Date.now() + 60_000,
      },
    },
    order: {
      openai: [API_PRIMARY_PROFILE_ID, OAUTH_PROFILE_ID, API_BACKUP_PROFILE_ID],
    },
  };
}

describe("session auth-profile rotation", () => {
  it("retries preferred OAuth after cooldown when compaction also advanced", () =>
    withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      authStoreMocks.state.store.order = undefined;
      const cfg = {
        auth: { order: { openai: [OAUTH_PROFILE_ID, API_PRIMARY_PROFILE_ID] } },
      };
      configureProviderRoutes({
        provider: "openai",
        modelId: OPENAI_MODEL_ID,
        requirements: ["subscription", "api-key"],
      });
      authStoreMocks.state.store.usageStats = {
        [OAUTH_PROFILE_ID]: {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
          failureCounts: { rate_limit: 1 },
        },
      };
      const sessionEntry: SessionEntry = {
        sessionId: "s1",
        updatedAt: 1,
        model: OPENAI_MODEL_ID,
      };
      const sessionStore = { "agent:main:main": sessionEntry };

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore, cfg })).toBe(
        API_PRIMARY_PROFILE_ID,
      );
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");

      authStoreMocks.state.store.usageStats[OAUTH_PROFILE_ID] = {
        cooldownUntil: Date.now() - 1,
        cooldownReason: "rate_limit",
        failureCounts: { rate_limit: 1 },
      };
      sessionEntry.compactionCount = 1;

      expect(await resolveSession({ agentDir, sessionEntry, sessionStore, cfg })).toBe(
        OAUTH_PROFILE_ID,
      );
      expect(sessionEntry.authProfileOverride).toBe(OAUTH_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(1);
    }));

  it("keeps a healthy automatic profile across compaction when auth order is implicit", () =>
    withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      authStoreMocks.state.store.order = undefined;
      const sessionEntry = createAutomaticSessionEntry({
        model: OPENAI_MODEL_ID,
        authProfileOverride: API_PRIMARY_PROFILE_ID,
        compactionCount: 1,
        authProfileOverrideCompactionCount: 0,
      });

      expect(await resolveSession({ agentDir, sessionEntry })).toBe(API_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(API_PRIMARY_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
      expect(sessionEntry.updatedAt).toBe(1);
    }));

  it("rotates a cooled multi-route OpenAI session within its physical route", () =>
    withAuthState(async (state) => {
      const agentDir = state.agentDir();
      await fs.mkdir(agentDir, { recursive: true });
      configureMixedOpenAiAuthStore();
      authStoreMocks.state.store.order = {
        openai: [OAUTH_PROFILE_ID, API_PRIMARY_PROFILE_ID, API_BACKUP_PROFILE_ID],
      };
      configureProviderRoutes({
        provider: "openai",
        modelId: OPENAI_MODEL_ID,
        requirements: ["api-key", "subscription"],
      });
      authStoreMocks.state.store.usageStats = {
        [API_PRIMARY_PROFILE_ID]: {
          cooldownUntil: Date.now() + 60_000,
          cooldownReason: "rate_limit",
        },
      };
      authStoreMocks.isProfileInCooldown.mockImplementation(
        (_store, profileId) => profileId === API_PRIMARY_PROFILE_ID,
      );
      const sessionEntry = createAutomaticSessionEntry({
        authProfileOverride: API_PRIMARY_PROFILE_ID,
        model: OPENAI_MODEL_ID,
        compactionCount: 0,
        authProfileOverrideCompactionCount: 0,
      });

      const resolved = await resolveSession({ agentDir, sessionEntry });

      expect(resolved).toBe(API_BACKUP_PROFILE_ID);
      expect(sessionEntry.authProfileOverride).toBe(API_BACKUP_PROFILE_ID);
      expect(sessionEntry.authProfileOverrideSource).toBe("auto");
      expect(sessionEntry.authProfileOverrideCompactionCount).toBe(0);
    }));
});
