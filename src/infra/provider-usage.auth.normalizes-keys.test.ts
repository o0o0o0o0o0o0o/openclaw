import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { OpenClawConfig } from "../config/config.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { resolveProviderAuths } from "./provider-usage.auth.js";

const authProfileMocks = vi.hoisted(() => {
  const store: AuthProfileStore = { version: 1, profiles: {} };
  const orders: Record<string, string[]> = {};
  return {
    store,
    orders,
    resolvedProfiles: new Map<string, { apiKey: string; provider: string } | null>(),
    unexpectedStoreRead: () => {
      throw new Error("Usage auth tests must use their prepared store");
    },
  };
});

// mock-isolation: Normalization fixtures require their prepared credential map and reject real auth-store reads.
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore: authProfileMocks.unexpectedStoreRead,
  ensureAuthProfileStoreAsync: authProfileMocks.unexpectedStoreRead,
  ensureAuthProfileStoreWithoutExternalProfilesAsync: authProfileMocks.unexpectedStoreRead,
  hasAnyAuthProfileStoreSourceAsync: authProfileMocks.unexpectedStoreRead,
  dedupeProfileIds: (profileIds: string[]) => [...new Set(profileIds)],
  listProfilesForProvider: (_store: unknown, provider: string) =>
    authProfileMocks.orders[provider] ?? [],
  resolveAuthProfileOrder: ({ provider }: { provider: string }) =>
    authProfileMocks.orders[provider] ?? [],
  resolveApiKeyForProfile: async ({ profileId }: { profileId: string }) =>
    authProfileMocks.resolvedProfiles.get(profileId) ?? null,
}));

const { resolvePlugin } = vi.hoisted(() => ({
  resolvePlugin:
    vi.fn<typeof import("../plugins/provider-runtime.js").resolveProviderUsageAuthWithPlugin>(),
}));

async function mockRuntime(modulePath: string) {
  return {
    ...(await vi.importActual<typeof import("../plugins/provider-runtime.js")>(modulePath)),
    resolveProviderUsageAuthWithPlugin: resolvePlugin,
  };
}
vi.mock("../plugins/provider-runtime.js", () => mockRuntime("../plugins/provider-runtime.js"));
vi.mock("../plugins/provider-runtime.ts", () => mockRuntime("../plugins/provider-runtime.ts"));

vi.mock("../agents/cli-credentials.js", () => ({
  readCodexCliCredentialsCached: () => null,
  readMiniMaxCliCredentialsCached: () => null,
}));

vi.mock("../agents/auth-profiles/external-cli-sync.js", () => ({
  listExternalCliSyncProviderIds: () => [],
  syncExternalCliCredentials: () => false,
}));

let clearConfigCache: typeof import("../config/config.js").clearConfigCache;
let clearRuntimeConfigSnapshot: typeof import("../config/config.js").clearRuntimeConfigSnapshot;
const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-provider-auth-suite-" });

describe("resolveProviderAuths key normalization", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
    ({ clearConfigCache, clearRuntimeConfigSnapshot } = await import("../config/config.js"));
  });

  afterAll(() => suiteRootTracker.cleanup());

  beforeEach(() => {
    authProfileMocks.store.profiles = {};
    authProfileMocks.orders = {};
    authProfileMocks.resolvedProfiles.clear();
    resolvePlugin.mockReset().mockImplementation(async ({ context }) => {
      const token = context.resolveApiKeyFromConfigAndStore();
      return token ? { token } : undefined;
    });
    clearRuntimeConfigSnapshot();
    clearConfigCache();
  });

  function profiles(entries: AuthProfileStore["profiles"]) {
    authProfileMocks.store.profiles = entries;
    for (const [id, profile] of Object.entries(entries)) {
      (authProfileMocks.orders[profile.provider] ??= []).push(id);
    }
  }

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    vi.restoreAllMocks();
  });

  async function resolve(
    providers: string[],
    config: OpenClawConfig = {},
    env: NodeJS.ProcessEnv = {},
  ) {
    const home = await suiteRootTracker.make("case");
    const drive = home.match(/^([A-Za-z]:)(.*)$/);
    return resolveProviderAuths({
      providers,
      config,
      env: {
        HOME: home,
        USERPROFILE: home,
        OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
        ...env,
        ...(drive ? { HOMEDRIVE: drive[1], HOMEPATH: drive[2] || "\\" } : {}),
      },
      store: authProfileMocks.store,
      agentDir: path.join(home, ".openclaw", "agents", "main", "agent"),
    });
  }

  it("strips embedded CR/LF from env credentials", async () => {
    expect(
      await resolve(
        ["zai", "minimax"],
        {},
        { ZAI_API_KEY: "zai-\r\nkey", MINIMAX_API_KEY: "mini-\r\nmax" },
      ),
    ).toEqual([
      { provider: "zai", token: "zai-key" },
      { provider: "minimax", token: "mini-max" },
    ]);
  });

  it("normalizes both token and API-key profile candidates", async () => {
    profiles({
      "minimax:default": { type: "token", provider: "minimax", token: "mini-\r\nmax" },
      "xiaomi:default": { type: "api_key", provider: "xiaomi", key: "xiao-\r\nmi" },
    });
    expect(await resolve(["minimax", "xiaomi"])).toEqual([
      { provider: "minimax", token: "mini-max" },
      { provider: "xiaomi", token: "xiao-mi" },
    ]);
  });

  it.each([
    ["plaintext", "ALLCAPS_SAMPLE", [{ provider: "minimax", token: "ALLCAPS_SAMPLE" }]],
    ["unresolved SecretRef", NON_ENV_SECRETREF_MARKER, []],
  ] as const)("resolves configured %s credentials", async (_name, apiKey, expected) => {
    expect(
      await resolve(["minimax"], {
        models: {
          providers: {
            minimax: { baseUrl: "https://api.minimaxi.com", models: [], apiKey },
          },
        },
      }),
    ).toEqual(expected);
  });

  it("returns no auth without a credential source", async () => {
    expect(await resolve(["zai", "anthropic"])).toEqual([]);
  });

  it("resolves the first usable OAuth-compatible profile, skipping API keys and unresolved tokens", async () => {
    profiles({
      "anthropic:api": { type: "api_key", provider: "anthropic", key: "api-key" },
      "anthropic:empty": { type: "token", provider: "anthropic", token: "unresolved" },
      "anthropic:valid": { type: "token", provider: "anthropic", token: "token-1" },
    });
    for (const [id, apiKey] of [
      ["api", "api-key"],
      ["valid", "token-1"],
    ]) {
      authProfileMocks.resolvedProfiles.set(`anthropic:${id}`, { apiKey, provider: "anthropic" });
    }
    resolvePlugin.mockImplementationOnce(
      async ({ context }) => (await context.resolveOAuthToken()) ?? { handled: true },
    );
    expect(await resolve(["anthropic"])).toEqual([{ provider: "anthropic", token: "token-1" }]);
  });
});
