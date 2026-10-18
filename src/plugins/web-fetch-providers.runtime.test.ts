import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createWebFetchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { createPluginManifestRecordFixture } from "./plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "./test-helpers/cold-plugin-fixtures.js";

type ManifestRegistryModule = typeof import("./manifest-registry.js");
let loaderModule: typeof import("./loader.js");
let manifestRegistryModule: ManifestRegistryModule;
let webProviderResolutionModule: typeof import("./web-provider-resolution-shared.js");
let loadOpenClawPluginsMock: ReturnType<typeof vi.fn>;
let runtime: typeof import("./runtime.js");
let resolvePluginWebFetchProviders: typeof import("./web-fetch-providers.runtime.js").resolvePluginWebFetchProviders;

const DEFAULT_WORKSPACE = "/tmp/workspace";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const env = { OPENCLAW_HOME: "/tmp/openclaw-home" };
const allowConfig = { plugins: { allow: ["firecrawl"] } };
const fixtureProvider = createWebFetchTestProvider({
  pluginId: "firecrawl",
  id: "firecrawl",
  credentialPath: "apiKey",
});

function createManifestRegistryFixture(
  origin: "bundled" | "global" = "bundled",
  rootDir = "/tmp/firecrawl",
  source = path.join(rootDir, "index.js"),
): ReturnType<ManifestRegistryModule["loadPluginManifestRegistryCore"]> {
  return {
    plugins: [
      createPluginManifestRecordFixture({
        id: "firecrawl",
        origin,
        rootDir,
        source,
        contracts: { webFetchProviders: ["firecrawl"] },
        configUiHints: { "webFetch.apiKey": { label: "key" } },
      }),
      createPluginManifestRecordFixture({
        id: "noise",
        configUiHints: { unrelated: { label: "nope" } },
      }),
    ],
    diagnostics: [],
  };
}

describe("resolvePluginWebFetchProviders", () => {
  beforeAll(async () => {
    vi.doMock("./plugin-registry-snapshot.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("./plugin-registry-snapshot.js")>()),
      loadPluginRegistrySnapshotWithMetadata: () => ({
        snapshot: { plugins: [], diagnostics: [] },
        source: "derived",
        diagnostics: [],
      }),
    }));
    loaderModule = await import("./loader.js");
    manifestRegistryModule = await import("./manifest-registry.js");
    webProviderResolutionModule = await import("./web-provider-resolution-shared.js");
    runtime = await import("./runtime.js");
    ({ resolvePluginWebFetchProviders } = await import("./web-fetch-providers.runtime.js"));
  });

  beforeEach(() => {
    vi.spyOn(manifestRegistryModule, "loadPluginManifestRegistryCore").mockReturnValue(
      createManifestRegistryFixture(),
    );
    loadOpenClawPluginsMock = vi
      .spyOn(loaderModule, "loadOpenClawPlugins")
      .mockImplementation(() => ({
        ...createEmptyPluginRegistry(),
        webFetchProviders: [{ pluginId: "firecrawl", source: "test", provider: fixtureProvider }],
      }));
    runtime.resetPluginRuntimeStateForTest();
  });

  afterEach(() => {
    runtime.resetPluginRuntimeStateForTest();
    vi.restoreAllMocks();
  });

  it("loads bundled runtime artifacts when no compatible active registry exists", () => {
    const fixture = createColdPluginFixture({
      rootDir: tempDirs.make("openclaw-web-fetch-artifact-"),
      pluginId: "firecrawl",
      packageJson: { type: "commonjs" },
      manifest: { contracts: { webFetchProviders: ["firecrawl"] } },
    });
    fs.writeFileSync(
      path.join(fixture.rootDir, "web-fetch-provider.js"),
      `exports.createFixtureWebFetchProvider = () => ({
        id: "firecrawl", label: "Selected fixture", hint: "fixture", envVars: [],
        placeholder: "", signupUrl: "", credentialPath: "apiKey",
        getCredentialValue() {}, setCredentialValue() {}, createTool() { return null; },
      });`,
    );
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistryCore).mockReturnValue(
      createManifestRegistryFixture("bundled", fixture.rootDir, fixture.runtimeSource),
    );
    const providers = resolvePluginWebFetchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(providers[0]?.label).toBe("Selected fixture");
    expect(isColdPluginRuntimeLoaded(fixture)).toBe(false);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("falls back to the plugin loader for non-bundled provider owners", () => {
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistryCore).mockReturnValue(
      createManifestRegistryFixture("global"),
    );

    const providers = resolvePluginWebFetchProviders({});

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      label: "denylisted",
      config: { plugins: { deny: ["firecrawl"] } },
    },
    {
      label: "explicitly disabled",
      config: { plugins: { entries: { firecrawl: { enabled: false } } } },
    },
  ])("does not load $label bundled runtime artifacts", ({ config }) => {
    const providers = resolvePluginWebFetchProviders({ config });

    expect(providers).toStrictEqual([]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("loads manifest-declared web-fetch providers in setup mode without the plugin loader", () => {
    const providers = resolvePluginWebFetchProviders({
      config: createFirecrawlAllowConfig(),
      mode: "setup",
    });

    expect(providers.map((provider) => `${provider.pluginId}:${provider.id}`)).toEqual([
      "firecrawl:firecrawl",
    ]);
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("does not force a fresh snapshot load when the same web-provider load is already in flight", () => {
    const inFlightSpy = vi
      .spyOn(loaderModule, "isPluginRegistryLoadInFlight")
      .mockReturnValue(true);
    loadOpenClawPluginsMock.mockImplementation(() => {
      throw new Error("resolvePluginWebFetchProviders should not bypass the in-flight guard");
    });
    const rawConfig = allowConfig;
    const { config, activationSourceConfig, autoEnabledReasons } =
      webProviderResolutionModule.resolveBundledWebProviderResolutionConfig({
        contract: "webFetchProviders",
        config: rawConfig,
        workspaceDir: DEFAULT_WORKSPACE,
        env,
      });

    const providers = resolvePluginWebFetchProviders({
      config: rawConfig,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
    });

    expect(providers).toStrictEqual([]);
    const { logger: inFlightLogger, ...inFlightLoadOptions } = expectDefined(
      inFlightSpy.mock.calls[0]?.[0],
      "in-flight options",
    );
    expect(Object.keys(inFlightLogger ?? {}).toSorted()).toEqual([
      "debug",
      "error",
      "info",
      "warn",
    ]);
    expect(inFlightLoadOptions).toEqual({
      config,
      activationSourceConfig,
      autoEnabledReasons,
      workspaceDir: DEFAULT_WORKSPACE,
      env,
      cache: true,
      activate: false,
      onlyPluginIds: ["firecrawl"],
      installRecords: undefined,
      manifestRegistry: undefined,
    });
    expect(loadOpenClawPluginsMock).not.toHaveBeenCalled();
  });

  it("uses the active registry workspace for candidate discovery when workspaceDir is omitted", () => {
    const env = createWebFetchEnv();
    const rawConfig = createFirecrawlAllowConfig();

    setActivePluginRegistry(
      createEmptyPluginRegistry(),
      undefined,
      "default",
      "/tmp/runtime-workspace",
    );
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistryCore).mockReturnValue(
      createManifestRegistryFixture("global"),
    );

    resolvePluginWebFetchProviders({
      config: rawConfig,
      env,
    });

    expect(manifestRegistryModule.loadPluginManifestRegistryCore).toHaveBeenCalledWith({
      config: rawConfig,
      workspaceDir: "/tmp/runtime-workspace",
      env,
      candidates: [],
      diagnostics: [],
      installRecords: {},
      registryPath: "/tmp/openclaw-home/.openclaw/state/openclaw.sqlite",
    });
    const { logger, ...loadOptions } = firstPluginLoadOptions(loadOpenClawPluginsMock);
    expect(Object.keys(logger ?? {}).toSorted()).toEqual(["debug", "error", "info", "warn"]);
    expect(loadOptions).toEqual({
      config: createFirecrawlAllowConfig(),
      activationSourceConfig: createFirecrawlAllowConfig(),
      autoEnabledReasons: {},
      workspaceDir: "/tmp/runtime-workspace",
      env,
      cache: true,
      activate: false,
      onlyPluginIds: ["firecrawl"],
    });
  });

  it("resolves web-fetch providers for each active registry workspace", () => {
    const config = allowConfig;
    vi.mocked(manifestRegistryModule.loadPluginManifestRegistryCore).mockReturnValue(
      createManifestRegistryFixture("global"),
    );

    for (const workspace of ["/tmp/workspace-a", "/tmp/workspace-b"]) {
      runtime.setActivePluginRegistry(createEmptyPluginRegistry(), undefined, "default", workspace);
      resolvePluginWebFetchProviders({ config, env });
    }

    expect(loadOpenClawPluginsMock).toHaveBeenCalledTimes(2);
  });
});
