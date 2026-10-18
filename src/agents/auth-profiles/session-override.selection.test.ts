import { expectDefined } from "@openclaw/normalization-core/expect";
import { describe, expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createApiKeyCredential,
  createOAuthRefreshCredential,
} from "./credential-fixtures.test-support.js";
import {
  authStoreMocks,
  createAuthStoreWithProfiles,
  createAutomaticSessionEntry,
  resolveSession,
  resolveSessionAuthSelection,
  TEST_PRIMARY_PROFILE_ID as PRIMARY,
  TEST_SECONDARY_PROFILE_ID as SECONDARY,
  withAuthState,
} from "./session-override.test-support.js";

const OAUTH_PROFILE_ID = "openai:subscription";
const MISMATCHED_PROFILE_ID = "anthropic:other";
const SESSION_KEY = "agent:main:main";

function configureProfiles(): void {
  authStoreMocks.state.hasSource = true;
  authStoreMocks.state.store = createAuthStoreWithProfiles({
    profiles: {
      [PRIMARY]: createApiKeyCredential("openai", "sk-primary"),
      [SECONDARY]: createApiKeyCredential("openai", "sk-secondary"),
      [OAUTH_PROFILE_ID]: createOAuthRefreshCredential(),
      [MISMATCHED_PROFILE_ID]: createApiKeyCredential("anthropic", "sk-mismatched"),
    },
    order: { openai: [PRIMARY, SECONDARY, OAUTH_PROFILE_ID] },
  });
}

async function select(params: {
  agentDir: string;
  sessionEntry: SessionEntry;
  configuredProfileId?: string;
  modelId?: string;
  cfg?: OpenClawConfig;
  agentId?: string;
}) {
  return await resolveSessionAuthSelection({
    ...params,
    cfg: params.cfg ?? {},
    agentId: params.agentId ?? "main",
    provider: "openai",
    modelId: params.modelId ?? "gpt-5.6-sol",
    sessionStore: { [SESSION_KEY]: params.sessionEntry },
    sessionKey: SESSION_KEY,
    isNewSession: false,
  });
}

describe("session auth selection prepared facts", () => {
  it("selects the configured profile after model activation", () =>
    withAuthState(async (state) => {
      configureProfiles();
      const sessionEntry = createAutomaticSessionEntry({
        compactionCount: 0,
        authProfileOverrideCompactionCount: 0,
      });
      await expect(
        select({
          agentDir: state.agentDir(),
          agentId: "main",
          cfg: {
            agents: {
              entries: { main: { model: `openai/gpt-4.1@${SECONDARY}` } },
            },
          },
          modelId: "gpt-4.1",
          sessionEntry,
        }),
      ).resolves.toMatchObject({
        profileId: SECONDARY,
        source: "user",
      });
    }));

  it("retains a removed explicit pin that also names the configured default", () =>
    withAuthState(async (state) => {
      configureProfiles();
      const sessionEntry = createAutomaticSessionEntry({ authProfileOverrideSource: "user" });
      const params = {
        agentDir: state.agentDir(),
        sessionEntry,
        configuredProfileId: PRIMARY,
      };
      await expect(select(params)).resolves.toMatchObject({
        profileId: PRIMARY,
        source: "user",
      });
      delete authStoreMocks.state.store.profiles[PRIMARY];

      await expect(select(params)).resolves.toMatchObject({
        profileId: PRIMARY,
        source: "user",
      });
      expect(sessionEntry.authProfileOverride).toBe(PRIMARY);
    }));

  it("uses only explicit configured-profile precedence", () =>
    withAuthState(async (state) => {
      configureProfiles();
      const sessionEntry = createAutomaticSessionEntry({
        compactionCount: 0,
        authProfileOverrideCompactionCount: 0,
      });

      await expect(
        select({
          agentDir: state.agentDir(),
          sessionEntry,
          modelId: `gpt-5.6-sol@${OAUTH_PROFILE_ID}`,
        }),
      ).resolves.toMatchObject({ profileId: PRIMARY, source: "auto" });
      await expect(
        select({
          agentDir: state.agentDir(),
          sessionEntry,
          configuredProfileId: OAUTH_PROFILE_ID,
        }),
      ).resolves.toEqual({
        profileId: OAUTH_PROFILE_ID,
        source: "user",
        routeRequirement: "subscription",
      });
    }));

  it("retains typed recovery for an explicitly selected profile removed from the store", () =>
    withAuthState(async (state) => {
      configureProfiles();
      await expect(
        select({
          agentDir: state.agentDir(),
          sessionEntry: { sessionId: "s1", updatedAt: 1 },
          configuredProfileId: "openai:removed",
        }),
      ).rejects.toMatchObject({
        code: "selected_auth_profile_unavailable",
        profileId: "openai:removed",
      });
    }));

  it("keeps provider incompatibility for a config-only aws-sdk profile", () =>
    withAuthState(async (state) => {
      configureProfiles();
      await expect(
        select({
          agentDir: state.agentDir(),
          sessionEntry: { sessionId: "s1", updatedAt: 1 },
          configuredProfileId: "amazon-bedrock:default",
          cfg: {
            auth: {
              profiles: {
                "amazon-bedrock:default": { provider: "amazon-bedrock", mode: "aws-sdk" },
              },
            },
          },
        }),
      ).rejects.toMatchObject({
        name: "Error",
        message: 'Auth profile "amazon-bedrock:default" is not configured for openai.',
      });
    }));
  it("still rotates a legacy source-less automatic pin on a new session", () =>
    withAuthState(async (state) => {
      configureProfiles();
      const sessionEntry = createAutomaticSessionEntry({
        compactionCount: 0,
        authProfileOverrideSource: undefined,
        authProfileOverrideCompactionCount: 0,
      });

      const resolved = await resolveSession({
        agentDir: state.agentDir(),
        sessionEntry,
        sessionStore: { [SESSION_KEY]: sessionEntry },
        isNewSession: true,
      });

      expect(resolved).toBe(SECONDARY);
      expect(sessionEntry).toMatchObject({
        authProfileOverride: SECONDARY,
        authProfileOverrideSource: "auto",
      });
    }));
});

it("clears an incompatible global pin only in the selected agent store", async () => {
  const sessionKey = "global";
  await withAuthState(async (state) => {
    const storePath = state.statePath("sessions.json");
    const mainScope = { agentId: "main", sessionKey, storePath };
    const opsScope = { agentId: "ops", sessionKey, storePath };
    await replaceSessionEntry(mainScope, {
      sessionId: "main-session",
      updatedAt: 1,
      authProfileOverride: "anthropic:main",
      authProfileOverrideSource: "user",
    });
    await replaceSessionEntry(opsScope, {
      sessionId: "ops-session",
      updatedAt: 1,
      authProfileOverride: "anthropic:ops",
      authProfileOverrideSource: "user",
      label: "before",
      pinnedAt: 1,
    });
    const sessionEntry = expectDefined(loadSessionEntryReadOnly(opsScope), "ops session");
    const sessionStore = { [sessionKey]: sessionEntry };
    await patchSessionEntryCore(opsScope, () => ({ label: "renamed", pinnedAt: undefined }));
    const mainBefore = loadSessionEntryReadOnly(mainScope);
    authStoreMocks.state.store = createAuthStoreWithProfiles({
      profiles: {
        "anthropic:ops": { type: "api_key", provider: "anthropic", key: "sk-test" },
      },
    });

    await resolveSessionAuthSelection({
      cfg: {},
      agentId: "ops",
      agentDir: state.agentDir("ops"),
      provider: "openrouter",
      modelId: "model-x",
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      isNewSession: false,
    });

    expect(loadSessionEntryReadOnly({ ...mainScope, readConsistency: "latest" })).toEqual(
      mainBefore,
    );
    const persisted = loadSessionEntryReadOnly({ ...opsScope, readConsistency: "latest" });
    expect(persisted).toMatchObject({ sessionId: "ops-session", label: "renamed" });
    expect(persisted?.authProfileOverride).toBeUndefined();
    expect(persisted?.authProfileOverrideSource).toBeUndefined();
    expect(persisted?.pinnedAt).toBeUndefined();
    expect(sessionStore[sessionKey]).toEqual(persisted);
  });
});
