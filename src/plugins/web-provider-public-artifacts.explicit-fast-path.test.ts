// Verifies explicit web-provider artifact fast paths avoid runtime loading.
import { beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../logging/subsystem.js")>()),
  createSubsystemLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { loadPluginManifestRegistryMock } = vi.hoisted(() => ({
  loadPluginManifestRegistryMock: vi.fn(() => {
    throw new Error("manifest registry should stay off the explicit bundled fast path");
  }),
}));

const { loadCandidates, loadArtifact } = vi.hoisted(() => {
  const providerBase = {
    label: "Fixture",
    hint: "fixture",
    envVars: ["FIXTURE_API_KEY"],
    placeholder: "fixture",
    signupUrl: "https://example.com",
    credentialPath: "plugins.entries.fixture.config.apiKey",
    getCredentialValue: () => undefined,
    setCredentialValue: () => ({}),
  };
  const failedFactory = () => {
    throw new Error("fuzzplugin web provider factory failed");
  };
  const provider = (id: string) => ({ ...providerBase, id, createTool: () => null });
  const searchFactories = { createFuzzpluginWebSearchProvider: failedFactory };
  const modules: Record<string, object> = {
    "mockplugin/web-search-contract-api.js": {
      ...searchFactories,
      createMockpluginWebSearchProvider: () => provider("mockplugin"),
    },
    "fuzzplugin/web-search-contract-api.js": searchFactories,
    "firecrawl/web-fetch-contract-api.js": {
      createFirecrawlWebFetchProvider: () => provider("firecrawl"),
    },
    "firecrawl/web-fetch-provider.js": {
      createFirecrawlWebFetchProvider: () => ({
        ...provider("firecrawl"),
        createTool: () => ({
          description: "runtime firecrawl",
          parameters: {},
          execute: async () => ({}),
        }),
      }),
    },
  };
  const lowLevelLoaderMock = vi.fn(
    ({ dirName, artifactBasename }: { dirName: string; artifactBasename: string }) => {
      const module = modules[`${dirName}/${artifactBasename}`];
      if (module) {
        return module;
      }
      throw new Error(
        `Unable to resolve bundled plugin public surface ${dirName}/${artifactBasename}`,
      );
    },
  );
  return {
    loadArtifact: lowLevelLoaderMock,
    loadCandidates: vi.fn(
      ({
        dirName,
        artifactCandidates,
      }: {
        dirName: string;
        artifactCandidates: readonly string[];
      }) => {
        for (const artifactBasename of artifactCandidates) {
          try {
            return lowLevelLoaderMock({ dirName, artifactBasename });
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.startsWith("Unable to resolve bundled plugin public surface ")
            ) {
              continue;
            }
            throw error;
          }
        }
        return null;
      },
    ),
  };
});

vi.mock("./manifest-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./manifest-registry.js")>()),
  loadPluginManifestRegistryCore: loadPluginManifestRegistryMock,
}));

vi.mock("./public-surface-loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./public-surface-loader.js")>()),
  loadBundledPluginPublicArtifactModuleFromCandidatesSync: loadCandidates,
  loadBundledPluginPublicArtifactModuleSync: loadArtifact,
}));

import { resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts } from "./web-provider-public-artifacts.explicit.js";
import {
  resolveBundledWebFetchProvidersFromPublicArtifacts,
  resolveBundledWebSearchProvidersFromPublicArtifacts,
} from "./web-provider-public-artifacts.js";

function expectSingleProvider<T extends { pluginId: string }>(
  resolve: (params: { onlyPluginIds: string[] }) => T[] | null,
  pluginId: string,
  artifactBasename: string,
): T {
  const providers = resolve({ onlyPluginIds: [pluginId] });
  expect(providers).toHaveLength(1);
  const provider = providers?.[0];
  if (provider === undefined) {
    throw new Error("Expected one web provider");
  }
  expect(provider.pluginId).toBe(pluginId);
  expectArtifact(pluginId, artifactBasename);
  return provider;
}

function expectArtifact(dirName: string, artifactBasename: string) {
  expect(loadArtifact).toHaveBeenCalledWith({
    dirName,
    artifactBasename,
  });
  expect(loadPluginManifestRegistryMock).not.toHaveBeenCalled();
}

describe("web provider public artifacts explicit fast path", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips throwing bundled web provider factories while preserving healthy siblings", () => {
    const provider = expectSingleProvider(
      resolveBundledWebSearchProvidersFromPublicArtifacts,
      "mockplugin",
      "web-search-contract-api.js",
    );

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/web providers.*mockplugin/),
      { error: expect.objectContaining({ message: "fuzzplugin web provider factory failed" }) },
    );
    expect(provider.id).toBe("mockplugin");
    expect(provider.createTool({ config: {} as never })).toBeNull();
  });

  it("throws when every matching bundled web provider factory fails", () => {
    expect(() =>
      resolveBundledWebSearchProvidersFromPublicArtifacts({
        onlyPluginIds: ["fuzzplugin"],
      }),
    ).toThrow("Unable to initialize web providers for plugin fuzzplugin");
    expect(warn).not.toHaveBeenCalled();

    expectArtifact("fuzzplugin", "web-search-contract-api.js");
  });

  it("resolves bundled web fetch providers by explicit plugin id without manifest scans", () => {
    const provider = expectSingleProvider(
      resolveBundledWebFetchProvidersFromPublicArtifacts,
      "firecrawl",
      "web-fetch-contract-api.js",
    );

    expect(provider.createTool({ config: {} as never })).toBeNull();
  });

  it("loads executable web fetch runtime artifacts instead of contract-only facades", () => {
    const provider = expectSingleProvider(
      resolveBundledExplicitRuntimeWebFetchProvidersFromPublicArtifacts,
      "firecrawl",
      "web-fetch-provider.js",
    );

    expect(provider.createTool({ config: {} as never })).not.toBeNull();
    expect(loadArtifact).not.toHaveBeenCalledWith({
      dirName: "firecrawl",
      artifactBasename: "web-fetch-contract-api.js",
    });
  });
});
