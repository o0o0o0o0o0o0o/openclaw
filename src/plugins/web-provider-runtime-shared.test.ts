import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { withPluginRuntimeGenerationRegistryScope } from "./runtime/generation-state.js";
import type {
  ResolvePluginWebProvidersParams,
  WebProviderRuntimeResolution,
} from "./web-provider-runtime-shared.js";

const mocks = vi.hoisted(() => ({
  isPluginRegistryLoadInFlight: vi.fn(() => false),
  loadOpenClawPlugins: vi.fn(),
  resolveCompatibleRuntimePluginRegistry: vi.fn(),
  getLoadedRuntimePluginRegistry: vi.fn(),
  resolvePluginRegistryLoadCacheKey: vi.fn((options: unknown) => JSON.stringify(options)),
  resolveRuntimePluginRegistry: vi.fn(),
  getActivePluginRegistry: vi.fn<() => Record<string, unknown> | null>(() => null),
  getActivePluginRegistryWorkspaceDir: vi.fn(() => undefined),
  buildPluginRuntimeLoadOptions: vi.fn((_values: unknown, overrides?: Record<string, unknown>) => ({
    ...overrides,
  })),
  pluginRuntimeLoaderLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("./loader.js", () => ({
  isPluginRegistryLoadInFlight: mocks.isPluginRegistryLoadInFlight,
  loadOpenClawPlugins: mocks.loadOpenClawPlugins,
  resolveCompatibleRuntimePluginRegistry: mocks.resolveCompatibleRuntimePluginRegistry,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
  resolveRuntimePluginRegistry: mocks.resolveRuntimePluginRegistry,
}));

vi.mock("./active-runtime-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./active-runtime-registry.js")>()),
  getLoadedRuntimePluginRegistry: mocks.getLoadedRuntimePluginRegistry,
}));

vi.mock("./runtime.js", () => ({
  getActivePluginRegistry: mocks.getActivePluginRegistry,
  getActivePluginRegistryWorkspaceDir: mocks.getActivePluginRegistryWorkspaceDir,
}));

vi.mock("./runtime/load-context.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime/load-context.js")>()),
  buildPluginRuntimeLoadOptions: mocks.buildPluginRuntimeLoadOptions,
  pluginRuntimeLoaderLogger: mocks.pluginRuntimeLoaderLogger,
}));

let resolvePluginWebProviders: typeof import("./web-provider-runtime-shared.js").resolvePluginWebProviders;

const requireRecord = createRequireRecord("record", "expected-non-array-record");

function mockArg(mock: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return requireRecord(mock.mock.calls[callIndex]?.[0]);
}

const mapRegistryProviders = vi.fn<WebProviderRuntimeResolution<string>["mapRegistryProviders"]>();
function resolve(
  params: ResolvePluginWebProvidersParams,
  overrides: Partial<WebProviderRuntimeResolution<string>> = {},
) {
  return resolvePluginWebProviders(params, {
    resolveBundledResolutionConfig: ({ manifestRecords }) => ({
      config: {},
      activationSourceConfig: {},
      autoEnabledReasons: {},
      manifestRecords,
    }),
    resolveCandidatePluginIds: () => ["brave"],
    mapRegistryProviders,
    ...overrides,
  });
}

function expectNoReload() {
  expect(mocks.getLoadedRuntimePluginRegistry).not.toHaveBeenCalled();
  expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
}

describe("web-provider-runtime-shared", () => {
  beforeAll(async () => {
    ({ resolvePluginWebProviders } = await import("./web-provider-runtime-shared.js"));
  });

  beforeEach(() => {
    vi.resetAllMocks();
    mapRegistryProviders.mockReturnValue([]);
    mocks.isPluginRegistryLoadInFlight.mockReturnValue(false);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(undefined);
    mocks.resolvePluginRegistryLoadCacheKey.mockImplementation((options: unknown) =>
      JSON.stringify(options),
    );
    mocks.getActivePluginRegistry.mockReturnValue(null);
    mocks.getActivePluginRegistryWorkspaceDir.mockReturnValue(undefined);
    mocks.buildPluginRuntimeLoadOptions.mockImplementation(
      (_values: unknown, overrides?: Record<string, unknown>) => ({
        ...overrides,
      }),
    );
  });

  it("preserves explicit empty scopes in runtime-compatible web provider loads", () => {
    const activeRegistry = { source: "active" };
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);

    const result = resolve(
      { config: {}, onlyPluginIds: [] },
      { resolveCandidatePluginIds: () => [] },
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual([]);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: [],
    });
    expect(result).toStrictEqual([]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("preserves explicit scopes when config is omitted in direct runtime resolution", () => {
    const mapRegistryProviders = vi.fn(() => []);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue({} as never);

    resolvePluginWebProviders(
      {
        onlyPluginIds: ["alpha"],
      },
      resolution({
        resolveCandidatePluginIds: () => ["alpha"],
        mapRegistryProviders,
      }),
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["alpha"]);
    expect(mockArg(mapRegistryProviders).onlyPluginIds).toEqual(["alpha"]);
  });

  it("resolves provider candidates from the original config and prepared manifests", () => {
    const activeRegistry = { source: "active" };
    const config = { plugins: { entries: {} } };
    const resolvedConfig = { plugins: { entries: { brave: { enabled: true } } } };
    const manifestRecords: PluginManifestRecord[] = [];
    const resolveCandidatePluginIds = vi.fn(() => ["brave"]);
    mapRegistryProviders.mockReturnValue(["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry);
    const candidateParams = {
      config,
      env: { BRAVE_API_KEY: "key" },
      onlyPluginIds: ["brave", "firecrawl"],
      origin: "bundled" as const,
      sandboxed: true,
      workspaceDir: "/workspace",
      manifestRecords,
    };

    const providers = resolve(candidateParams, {
      resolveBundledResolutionConfig: () => ({
        config: resolvedConfig,
        activationSourceConfig: config,
        autoEnabledReasons: { brave: ["env"] },
        manifestRecords,
      }),
      resolveCandidatePluginIds,
    });

    expect(providers).toEqual(["provider"]);
    expect(resolveCandidatePluginIds).toHaveBeenCalledWith(candidateParams);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: activeRegistry,
      onlyPluginIds: ["brave"],
    });
    expect(mockArg(mocks.buildPluginRuntimeLoadOptions).manifestRegistry).toEqual({
      plugins: manifestRecords,
      diagnostics: [],
    });
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("reuses the loaded registry for runtime web providers", () => {
    const loadedRegistry = { source: "loaded" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(loadedRegistry as never);

    resolvePluginWebProviders(
      {
        config: {},
        onlyPluginIds: ["brave"],
      },
      resolution({
        mapRegistryProviders,
      }),
    );

    expect(mockArg(mocks.getLoadedRuntimePluginRegistry).requiredPluginIds).toEqual(["brave"]);
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("caches setup web provider plugin loads by default", () => {
    const loadedRegistry = { source: "setup" };
    mapRegistryProviders.mockReturnValue(["provider"]);
    mocks.loadOpenClawPlugins.mockReturnValue(loadedRegistry as never);

    const providers = resolve(
      { config: {}, mode: "setup" },
      { resolveBundledPublicArtifactProviders: () => null },
    );

    expect(providers).toEqual(["provider"]);
    expect(mockArg(mocks.loadOpenClawPlugins)).toMatchObject({
      cache: true,
      onlyPluginIds: ["brave"],
    });
  });

  it("uses bundled runtime artifacts before loading a plugin registry", () => {
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => ["provider"]);

    const providers = resolvePluginWebProviders(
      {
        config: {},
        workspaceDir: "/workspace",
        env: { FIRECRAWL_API_KEY: "" },
      },
      resolution({
        resolveCandidatePluginIds: () => ["firecrawl"],
        mapRegistryProviders: vi.fn(() => []),
        resolveBundledRuntimeArtifactProviders,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).toHaveBeenCalledWith({
      config: {},
      workspaceDir: "/workspace",
      env: { FIRECRAWL_API_KEY: "" },
      onlyPluginIds: ["firecrawl"],
    });
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });

  it("falls back to plugin loading when bundled runtime artifacts do not cover the scope", () => {
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(() => ["provider"]);
    const resolveBundledRuntimeArtifactProviders = vi.fn(() => null);
    mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry as never);

    const providers = resolvePluginWebProviders(
      {
        config: {},
      },
      resolution({
        resolveCandidatePluginIds: () => ["external-provider"],
        mapRegistryProviders,
        resolveBundledRuntimeArtifactProviders,
      }),
    );

    expect(providers).toEqual(["provider"]);
    expect(resolveBundledRuntimeArtifactProviders).toHaveBeenCalledTimes(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mapRegistryProviders).toHaveBeenCalledWith({
      registry: fallbackRegistry,
      onlyPluginIds: ["external-provider"],
    });
  });

  it("falls back to a scoped provider load when the active runtime registry has no web providers", () => {
    const activeRegistry = { source: "active" };
    const fallbackRegistry = { source: "fallback" };
    const mapRegistryProviders = vi.fn(({ registry }) =>
      registry === fallbackRegistry ? ["brave"] : [],
    );
    mocks.getLoadedRuntimePluginRegistry.mockReturnValue(activeRegistry as never);
    mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry as never);

    const result = resolvePluginWebProviders(
      {
        config: {},
      },
      resolution({
        resolveCandidatePluginIds: () => undefined,
        mapRegistryProviders,
      }),
    );

    expect(result).toEqual(["brave"]);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    expect(mapRegistryProviders).toHaveBeenCalledTimes(2);
  });

  it("retains an empty request-owned web provider selection without registering plugins again", () => {
    const registry = createEmptyPluginRegistry();

    const result = withPluginRuntimeRegistryScope(registry, () =>
      resolve({ config: {}, manifestRecords: [] }, { resolveCandidatePluginIds: () => undefined }),
    );

    expect(result).toEqual([]);
    expect(mapRegistryProviders).toHaveBeenCalledExactlyOnceWith({
      registry,
      onlyPluginIds: undefined,
    });
    expectNoReload();
  });

  it.each([undefined, ["external-search"]])(
    "retains an exact generation's empty selection with candidates %j",
    (candidates) => {
      const registry = createEmptyPluginRegistry();
      const requestRegistry = createEmptyPluginRegistry();

      const result = withPluginRuntimeRegistryScope(requestRegistry, () =>
        withPluginRuntimeGenerationRegistryScope(registry, () =>
          resolve({ config: {} }, { resolveCandidatePluginIds: () => candidates }),
        ),
      );

      expect(result).toEqual([]);
      expect(mapRegistryProviders).toHaveBeenCalledExactlyOnceWith({
        registry,
        onlyPluginIds: candidates,
      });
      expectNoReload();
    },
  );

  it.each([
    { name: "unknown inventory", manifestRecords: undefined, scopedProviders: [] },
    {
      name: "an uninspected provider",
      manifestRecords: [createPluginManifestRecordFixture({ id: "external-search" })],
      scopedProviders: [],
    },
    {
      name: "an uninspected provider alongside another provider",
      manifestRecords: [createPluginManifestRecordFixture({ id: "external-search" })],
      scopedProviders: ["scoped-search"],
    },
  ])(
    "discovers undeclared providers from a request scope with $name",
    ({ manifestRecords, scopedProviders }) => {
      const registry = createEmptyPluginRegistry();
      const fallbackRegistry = createEmptyPluginRegistry();
      mapRegistryProviders.mockImplementation(({ registry: selected }) =>
        selected === fallbackRegistry ? ["external-search", "scoped-search"] : scopedProviders,
      );
      mocks.loadOpenClawPlugins.mockReturnValue(fallbackRegistry);

      const result = withPluginRuntimeRegistryScope(registry, () =>
        resolve({ config: {}, manifestRecords }, { resolveCandidatePluginIds: () => undefined }),
      );

      expect(result).toEqual(["external-search", "scoped-search"]);
      expect(mocks.getLoadedRuntimePluginRegistry).not.toHaveBeenCalled();
      expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat an active registry missing declared candidates as authoritative", () => {
    // A partially loaded active registry must not hide an installed env-enabled provider.
    const activeRegistry = createEmptyPluginRegistry();
    const scopedRegistry = createEmptyPluginRegistry();
    mapRegistryProviders.mockImplementation(({ registry }) =>
      registry === scopedRegistry ? ["brave", "grok"] : ["grok"],
    );
    mocks.getLoadedRuntimePluginRegistry.mockImplementation((args: unknown) => {
      const requiredPluginIds = (args as { requiredPluginIds?: readonly string[] })
        ?.requiredPluginIds;
      // Simulate active-registry coverage: brave never loaded at startup.
      if (requiredPluginIds?.includes("brave")) {
        return undefined;
      }
      return activeRegistry as never;
    });
    mocks.loadOpenClawPlugins.mockReturnValue(scopedRegistry as never);

    const result = resolve(
      {
        config: {},
        env: { BRAVE_API_KEY: "key" } as never,
      },
      { resolveCandidatePluginIds: () => ["brave", "xai"] },
    );

    expect(result).toEqual(["brave", "grok"]);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });
});
