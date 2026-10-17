import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExplicitLiveModelCandidates } from "../gateway/gateway-models.profiles.live.test-helpers.js";
import { loadPluginManifest } from "../plugins/manifest.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../plugins/runtime/generation-scope.js";
import * as authProfileStore from "./auth-profiles/store-runtime.js";
import { createEmptyAgentDiscoveryStores } from "./embedded-agent-runner/model.js";
import { appendLiveModelCandidates } from "./test-helpers/live-model-dynamic-candidates.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: ["deepseek", "xai"].map((id) => {
    const rootDir = fileURLToPath(new URL(`../../extensions/${id}`, import.meta.url));
    const loaded = loadPluginManifest(rootDir);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return Object.assign(loaded.manifest, { rootDir, source: path.join(rootDir, "index.ts") });
  }),
});
const config: OpenClawConfig = {
  plugins: {
    enabled: true,
    allow: ["deepseek", "xai"],
    entries: { deepseek: { enabled: true }, xai: { enabled: true } },
  },
};
const agentDir = "/fixture/live-explicit-models/agent";
const deepseek = {
  provider: "deepseek",
  id: "deepseek-v4-flash",
  api: "openai-completions",
  baseUrl: "https://api.deepseek.com",
};
const fetchMock = vi.fn(() => {
  throw new Error("Model selection must not make network requests");
});

beforeEach(() => {
  vi.spyOn(authProfileStore, "loadAuthProfileStoreForRuntimeAsync").mockResolvedValue({
    version: 1,
    profiles: {},
  });
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  expect(fetchMock).not.toHaveBeenCalled();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function selectionFixture() {
  const stores = createEmptyAgentDiscoveryStores();
  const getDiscoveryStores = vi.fn(async () => stores);
  const append = (overrides: Partial<Parameters<typeof appendLiveModelCandidates>[0]> = {}) =>
    appendLiveModelCandidates({
      models: [],
      config,
      agentDir,
      modelRegistry: stores.modelRegistry,
      resolution: { kind: "explicit", getDiscoveryStores },
      refs: [deepseek],
      ...overrides,
    });
  return { stores, getDiscoveryStores, append };
}

function withSelection(run: (fixture: ReturnType<typeof selectionFixture>) => Promise<void>) {
  return withPluginRuntimeGenerationScope({ metadataSnapshot }, () => run(selectionFixture()));
}

describe("explicit live model candidates", () => {
  it("recovers accepted DeepSeek selections omitted from discovery using one captured store", async () => {
    await withSelection(async ({ append, getDiscoveryStores }) => {
      const result = await append({
        refs: [deepseek, { provider: "deepseek", id: "deepseek-v4-flash-vision-exp" }],
      });

      expect(result.models).toMatchObject(
        [
          ["deepseek-v4-flash", ["text"]],
          ["deepseek-v4-flash-vision-exp", ["text", "image"]],
        ].map(([id, input]) => Object.assign({}, deepseek, { id, input })),
      );
      expect(result.added).toHaveLength(2);
      expect(getDiscoveryStores).toHaveBeenCalledOnce();
    });
  });

  it("keeps configured transport and model limits when recovering a bundled selection", async () => {
    await withSelection(async ({ append }) => {
      const model = makeProviderModelFixture({
        ...deepseek,
        name: "Configured Flash",
        baseUrl: "https://deepseek-proxy.example.invalid/v1",
        reasoning: true,
        contextWindow: 64_000,
        maxTokens: 8_000,
      });
      const headers = { "X-Tenant": "fixture" };
      const provider = { api: model.api, baseUrl: model.baseUrl, headers, models: [model] };
      const result = await append({
        config: { ...config, models: { providers: { deepseek: provider } } },
      });

      expect(result.models).toMatchObject([{ ...model, headers }]);
    });
  });

  it("does not acquire discovery stores when every explicit selection is already present", async () => {
    await withSelection(async ({ append, getDiscoveryStores }) => {
      const model = makeProviderModelFixture(deepseek);
      expect(await append({ models: [model] })).toEqual({ models: [model], added: [] });
      expect(getDiscoveryStores).not.toHaveBeenCalled();
    });
  });

  it("does not manufacture an unknown explicit selection", async () => {
    await withSelection(async ({ append }) => {
      const result = await append({
        refs: [{ provider: "deepseek", id: "not-a-deepseek-model" }],
      });

      expect(result).toEqual({ models: [], added: [] });
    });
  });

  it("does not revive a suppressed model present in the captured registry", async () => {
    await withSelection(async ({ stores, append }) => {
      const transport = { api: "openai-completions", baseUrl: "https://api.x.ai/v1" } as const;
      const ref = { provider: "xai", id: "grok-4.20-multi-agent-0309" };
      stores.modelRegistry.registerProvider("xai", {
        ...transport,
        models: [makeProviderModelFixture({ ...transport, ...ref })],
      });
      const result = await append({ refs: [ref] });

      expect(result).toEqual({ models: [], added: [] });
      const registered = stores.modelRegistry.getAll();
      expect(registered).toHaveLength(1);
      expect(() =>
        resolveExplicitLiveModelCandidates({
          modelRegistry: stores.modelRegistry,
          models: registered,
          modelFilter: new Set(["xai/grok-4.20-multi-agent-0309"]),
          providerFilter: new Set(["xai"]),
          config,
          env: {},
        }),
      ).toThrow(/xai\/grok-4.20-multi-agent-0309/);
    });
  });
});
