// Plugin registry CLI tests cover canonical process-root load scopes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensurePluginRegistryLoaded } from "../plugins/runtime/runtime-registry-loader.js";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function expectConfiguredChannelPluginIdsParams(expected: {
  config: unknown;
  workspaceDir?: string;
}) {
  expect(mocks.resolveConfiguredChannelPluginIds).toHaveBeenCalledTimes(1);
  const params = mocks.resolveConfiguredChannelPluginIds.mock.calls[0]?.[0];
  expect(params?.config).toBe(expected.config);
  // Compare identity without exposing ambient credentials in failure output.
  expect(params?.env === process.env).toBe(true);
  expect(params?.workspaceDir).toBe(expected.workspaceDir);
}

function expectLoadOpenClawPluginsCall(
  callIndex: number,
  expected: Partial<Parameters<typeof mocks.loadAndActivateRootPluginRegistry>[0]>,
) {
  const params = mocks.loadAndActivateRootPluginRegistry.mock.calls[callIndex]?.[0];
  for (const key of Object.keys(expected)) {
    expect(params && Reflect.get(params, key)).toEqual(Reflect.get(expected, key));
  }
}

const mocks = vi.hoisted(() => ({
  loadAndActivateRootPluginRegistry:
    vi.fn<typeof import("../plugins/loader.js").loadAndActivateRootPluginRegistry>(),
  resolveConfiguredChannelPluginIds:
    vi.fn<typeof import("../plugins/channel-plugin-ids.js").resolveConfiguredChannelPluginIds>(),
  resolveChannelPluginIds:
    vi.fn<typeof import("../plugins/channel-plugin-ids.js").resolveChannelPluginIds>(),
  resolveEffectivePluginIds:
    vi.fn<typeof import("../plugins/effective-plugin-ids.js").resolveEffectivePluginIds>(),
  resolvePluginRuntimeLoadContext:
    vi.fn<
      typeof import("../plugins/runtime/load-context.resolve.js").resolvePluginRuntimeLoadContext
    >(),
}));

vi.mock("../plugins/loader.js", () => ({
  loadAndActivateRootPluginRegistry: mocks.loadAndActivateRootPluginRegistry,
}));

// mock-isolation: Registry selection uses fixture channel ids without persisted channel discovery.
vi.mock("../plugins/channel-plugin-ids.js", () => ({
  resolveConfiguredChannelPluginIdsAsync: async (
    ...args: Parameters<typeof mocks.resolveConfiguredChannelPluginIds>
  ) => mocks.resolveConfiguredChannelPluginIds(...args),
  resolveChannelPluginIds: mocks.resolveChannelPluginIds,
}));

// mock-isolation: Registry selection uses fixture plugin ids without installed-plugin discovery.
vi.mock("../plugins/effective-plugin-ids.js", () => ({
  resolveEffectivePluginIdsAsync: async (
    ...args: Parameters<typeof mocks.resolveEffectivePluginIds>
  ) => mocks.resolveEffectivePluginIds(...args),
}));

vi.mock("../plugins/runtime/load-context.resolve.js", () => ({
  resolvePluginRuntimeLoadContext: mocks.resolvePluginRuntimeLoadContext,
}));

describe("ensurePluginRegistryLoaded", () => {
  beforeEach(() => {
    mocks.loadAndActivateRootPluginRegistry.mockReset();
    mocks.resolveConfiguredChannelPluginIds.mockReset();
    mocks.resolveChannelPluginIds.mockReset();
    mocks.resolveEffectivePluginIds.mockReset();
    mocks.resolvePluginRuntimeLoadContext.mockReset();
    mocks.resolveEffectivePluginIds.mockReturnValue(["demo"]);
    mocks.resolvePluginRuntimeLoadContext.mockImplementation((options) => {
      const rawConfig = (options?.config ?? {}) as Record<string, unknown>;
      return {
        rawConfig,
        config: rawConfig,
        activationSourceConfig: (options?.activationSourceConfig ?? rawConfig) as Record<
          string,
          unknown
        >,
        autoEnabledReasons: {},
        workspaceDir: "/tmp/workspace",
        env: options?.env ?? process.env,
        logger,
      } as never;
    });
  });

  it("uses the resolved runtime load context for configured channel scope", async () => {
    const baseConfig = {
      channels: {
        "demo-chat": {
          botToken: "demo-bot-token",
          appToken: "demo-app-token",
        },
      },
    };
    const autoEnabledConfig = {
      ...baseConfig,
      plugins: { allow: ["demo-chat"], entries: { "demo-chat": { enabled: true } } },
    };

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      rawConfig: baseConfig,
      config: autoEnabledConfig,
      activationSourceConfig: baseConfig,
      autoEnabledReasons: {
        "demo-chat": ["demo-chat configured"],
      },
      workspaceDir: "/tmp/workspace",
      env: process.env,
      logger,
    } as never);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-chat"]);

    await ensurePluginRegistryLoaded({ scope: "configured-channels" });

    expectConfiguredChannelPluginIdsParams({
      config: autoEnabledConfig,
      workspaceDir: "/tmp/workspace",
    });
    expect(mocks.loadAndActivateRootPluginRegistry).toHaveBeenCalledTimes(1);
    expectLoadOpenClawPluginsCall(0, {
      config: autoEnabledConfig,
      activationSourceConfig: autoEnabledConfig,
      autoEnabledReasons: {
        "demo-chat": ["demo-chat configured"],
      },
      onlyPluginIds: ["demo-chat"],
      throwOnLoadError: true,
      workspaceDir: "/tmp/workspace",
    });
  });

  it("reloads when escalating from configured-channels to channels", async () => {
    const config = {
      plugins: { enabled: true },
      channels: { "demo-channel-a": { enabled: false } },
    };

    mocks.resolvePluginRuntimeLoadContext.mockReturnValue({
      rawConfig: config,
      config,
      activationSourceConfig: config,
      autoEnabledReasons: {},
      workspaceDir: "/tmp/workspace",
      env: process.env,
      logger,
    } as never);
    mocks.resolveConfiguredChannelPluginIds.mockReturnValue(["demo-channel-a"]);
    mocks.resolveChannelPluginIds.mockReturnValue(["demo-channel-a", "demo-channel-b"]);

    await ensurePluginRegistryLoaded({ scope: "configured-channels" });
    await ensurePluginRegistryLoaded({ scope: "channels" });

    expect(mocks.loadAndActivateRootPluginRegistry).toHaveBeenCalledTimes(2);
    expectLoadOpenClawPluginsCall(0, {
      onlyPluginIds: ["demo-channel-a"],
      throwOnLoadError: true,
    });
    expectLoadOpenClawPluginsCall(1, {
      onlyPluginIds: ["demo-channel-a", "demo-channel-b"],
      throwOnLoadError: true,
    });
  });
});
