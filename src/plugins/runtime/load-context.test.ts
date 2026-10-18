// Load context tests cover agent and workspace context resolution for plugin runtimes.
import { inspect } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { createPluginCache, withPluginCache } from "../plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../plugin-metadata-lifecycle.js";
import { createPluginMetadataSnapshotFixture } from "../plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../registry-empty.js";
import {
  buildPluginRuntimeLoadOptions,
  setPluginRuntimeLoadContext,
  getPluginRuntimeLoadContext,
  getReusablePluginRuntimeActivation,
} from "./load-context.js";
import { resolvePluginRuntimeLoadContext } from "./load-context.resolve.js";

const loadConfigMock = vi.hoisted(() =>
  vi.fn<typeof import("../../config/config.js").loadConfig>(),
);
const applyPluginAutoEnableMock = vi.hoisted(() =>
  vi.fn<typeof import("../../config/plugin-auto-enable.js").applyPluginAutoEnable>(),
);
const metadataSnapshot = {
  ...createPluginMetadataSnapshotFixture(),
  workspaceDir: "/resolved-workspace",
};
const { manifestRegistry } = metadataSnapshot;
const resolvePluginMetadataSnapshotMock = vi.hoisted(() => vi.fn(() => metadataSnapshot));
const resolveConfigWidePluginMetadataSnapshotMock = vi.hoisted(() => vi.fn(() => metadataSnapshot));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: loadConfigMock,
  loadConfig: loadConfigMock,
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: applyPluginAutoEnableMock,
}));

vi.mock("../control-plane-workspace.js", () => ({
  resolvePluginControlPlaneWorkspace: (params: { workspaceDir?: string }) => ({
    workspaceDir: params.workspaceDir ?? "/resolved-workspace",
    workspaceScope: "selected",
  }),
}));

vi.mock("../../config/io.plugin-metadata.js", () => ({
  resolveConfigWidePluginMetadataSnapshot: resolveConfigWidePluginMetadataSnapshotMock,
}));

vi.mock("../plugin-metadata-snapshot.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugin-metadata-snapshot.js")>()),
  resolvePluginMetadataSnapshot: resolvePluginMetadataSnapshotMock,
}));

describe("resolvePluginRuntimeLoadContext", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    applyPluginAutoEnableMock.mockReset();
    resolvePluginMetadataSnapshotMock.mockReset().mockReturnValue(metadataSnapshot);
    resolveConfigWidePluginMetadataSnapshotMock.mockReset().mockReturnValue(metadataSnapshot);

    loadConfigMock.mockReturnValue({ plugins: {} });
    applyPluginAutoEnableMock.mockImplementation((params) => ({
      config: params.config ?? {},
      changes: [],
      autoEnabledReasons: {},
    }));
    clearRuntimeConfigSnapshot();
    clearPluginMetadataLifecycleCaches();
  });

  it("uses the source runtime snapshot for plugin activation source config", () => {
    const env = { HOME: "/tmp/openclaw-home" };
    const runtimeConfig = { plugins: {} };
    const sourceConfig = { plugins: { allow: ["trusted-plugin"] } };

    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);
    loadConfigMock.mockReturnValue(runtimeConfig);

    const context = resolvePluginRuntimeLoadContext({ env });

    expect(context.rawConfig).toBe(runtimeConfig);
    expect(context.activationSourceConfig).toBe(sourceConfig);
    expect(applyPluginAutoEnableMock).toHaveBeenCalledWith({
      config: runtimeConfig,
      env,
      manifestRegistry,
    });
  });

  it("applies auto-enable against each operation's exact prepared metadata", () => {
    const env = { HOME: "/tmp/openclaw-home" };
    const config = { plugins: {} };
    const firstRegistry = { diagnostics: [], plugins: [] };
    const secondRegistry = { diagnostics: [], plugins: [] };
    const firstSnapshot = { ...metadataSnapshot, manifestRegistry: firstRegistry };
    const secondSnapshot = { ...metadataSnapshot, manifestRegistry: secondRegistry };
    const firstConfig = { plugins: { entries: { first: { enabled: true } } } };
    const secondConfig = { plugins: { entries: { second: { enabled: true } } } };
    applyPluginAutoEnableMock
      .mockReturnValueOnce({ config: firstConfig, changes: [], autoEnabledReasons: {} })
      .mockReturnValueOnce({ config: secondConfig, changes: [], autoEnabledReasons: {} });

    const first = withPluginCache(createPluginCache(), () =>
      resolvePluginRuntimeLoadContext({ config, env, metadataSnapshot: firstSnapshot }),
    );
    const second = withPluginCache(createPluginCache(), () =>
      resolvePluginRuntimeLoadContext({ config, env, metadataSnapshot: secondSnapshot }),
    );
    expect(first.config).toBe(firstConfig);
    expect(second.config).toBe(secondConfig);
    expect(second.manifestRegistry).toBe(secondRegistry);
    expect(applyPluginAutoEnableMock).toHaveBeenNthCalledWith(2, {
      config,
      env,
      manifestRegistry: secondRegistry,
      discovery: undefined,
    });
  });

  it.each([
    { scope: "explicit empty", pluginIds: [] },
    { scope: "explicit owner", pluginIds: ["demo"] },
  ])("projects $scope metadata from the prepared config-wide inventory", ({ pluginIds }) => {
    const config = { plugins: {} };
    const env = { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv;

    const context = resolvePluginRuntimeLoadContext({ config, env, onlyPluginIds: pluginIds });

    expect(context.metadataSnapshot?.pluginIds).toEqual(pluginIds);
    expect(context.metadataSnapshot?.index).toBe(metadataSnapshot.index);
    expect(resolveConfigWidePluginMetadataSnapshotMock).toHaveBeenCalledExactlyOnceWith({
      config,
      env,
    });
    expect(resolvePluginMetadataSnapshotMock).not.toHaveBeenCalled();
  });

  it("keeps private load facts out of diagnostics while preserving registry copies", () => {
    const configSentinel = "synthetic-private-config-sentinel";
    const envSentinel = "synthetic-private-env-sentinel";
    const config: OpenClawConfig = {
      plugins: { entries: { demo: { config: { sentinel: configSentinel } } } },
    };
    const env = { HOME: "/tmp/openclaw-home", PRIVATE_CONTEXT_TEST: envSentinel };
    const context = resolvePluginRuntimeLoadContext({ config, env });
    const registry = createEmptyPluginRegistry();
    setPluginRuntimeLoadContext(registry, context, "original-registration");
    const bound = getPluginRuntimeLoadContext(registry);
    expect(bound).toMatchObject(context);
    expect(bound?.config).toBe(config);
    expect(bound?.env).toBe(env);

    const copy = { ...registry };
    expect(getPluginRuntimeLoadContext(copy)).toBe(bound);
    const reboundContext = {
      ...context,
      workspaceDir: "/rebound-workspace",
      env: { ...env, PRIVATE_CONTEXT_TEST: `${envSentinel}-rebound` },
    };
    setPluginRuntimeLoadContext(copy, reboundContext, "replacement-registration");
    expect(getPluginRuntimeLoadContext(copy)).toMatchObject({
      ...reboundContext,
      registrationConfigKey: "original-registration",
    });
    expect(getPluginRuntimeLoadContext(copy)?.env).toBe(reboundContext.env);
    expect(getPluginRuntimeLoadContext(registry)).toBe(bound);

    for (const carrier of [registry, copy]) {
      for (const showHidden of [false, true]) {
        const diagnostic = inspect(carrier, { depth: null, showHidden });
        expect(diagnostic).not.toContain(configSentinel);
        expect(diagnostic).not.toContain(envSentinel);
      }
    }
  });

  it("hashes immutable fleet activation inputs once across registry rebindings", () => {
    const entries = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`agent-${i}`, { name: `${i}` }]),
    );
    const config = freezeJsonSnapshot({ agents: { entries } });
    const env = { HOME: "/tmp/openclaw-activation-fleet" };
    const context = resolvePluginRuntimeLoadContext({ config, env });
    const registry = createEmptyPluginRegistry();
    const keys = vi.spyOn(Object, "keys");
    try {
      setPluginRuntimeLoadContext(registry, context);
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const activation = getReusablePluginRuntimeActivation(registry, {
          config,
          env,
          workspaceDir: context.workspaceDir,
          metadataSnapshot,
        });
        expect(activation?.config).toBe(config);
        expect(activation?.activationSourceConfig).toBe(config);
        setPluginRuntimeLoadContext(registry, context);
      }
      expect(keys.mock.calls.filter(([value]) => value === config.agents.entries)).toHaveLength(1);
    } finally {
      keys.mockRestore();
    }
  });

  it("builds plugin load options from the shared runtime context", () => {
    const context = resolvePluginRuntimeLoadContext({
      config: { plugins: {} },
      env: { HOME: "/tmp/openclaw-home" } as NodeJS.ProcessEnv,
      preferBuiltPluginArtifacts: true,
      workspaceDir: "/explicit-workspace",
    });

    expect(resolvePluginMetadataSnapshotMock).toHaveBeenCalledExactlyOnceWith({
      allowWorkspaceScopedCurrent: true,
      config: context.rawConfig,
      env: context.env,
      workspaceDir: "/explicit-workspace",
    });
    expect(resolveConfigWidePluginMetadataSnapshotMock).not.toHaveBeenCalled();
    expect(
      buildPluginRuntimeLoadOptions(context, {
        cache: false,
        activate: false,
        onlyPluginIds: ["demo"],
      }),
    ).toEqual({
      config: context.config,
      activationSourceConfig: context.activationSourceConfig,
      autoEnabledReasons: context.autoEnabledReasons,
      workspaceDir: "/explicit-workspace",
      env: context.env,
      logger: context.logger,
      manifestRegistry,
      metadataSnapshot,
      installRecords: {},
      preferBuiltPluginArtifacts: true,
      cache: false,
      activate: false,
      onlyPluginIds: ["demo"],
    });
  });
});
