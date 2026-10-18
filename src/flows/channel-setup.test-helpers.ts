import { vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";

type ChannelMeta = import("../channels/plugins/types.core.js").ChannelMeta;
type ChannelPluginCatalogEntry = import("../channels/plugins/catalog.js").ChannelPluginCatalogEntry;
type ChannelSetupPlugin = import("../channels/plugins/setup-wizard-types.js").ChannelSetupPlugin;
type ChannelSetupWizardAdapter =
  import("../channels/plugins/setup-wizard-types.js").ChannelSetupWizardAdapter;
type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
type LoadChannelSetupPluginRegistrySnapshotForChannel =
  typeof import("../commands/channel-setup/plugin-install.js").loadChannelSetupPluginRegistrySnapshotForChannel;
type PluginRegistry = Awaited<ReturnType<LoadChannelSetupPluginRegistrySnapshotForChannel>>;

type ChannelSetupEntries = ReturnType<ResolveChannelSetupEntries>;

export function makeMeta(
  id: string,
  label: string,
  overrides: Partial<ChannelMeta> = {},
): ChannelMeta {
  return {
    id: id as ChannelMeta["id"],
    label,
    selectionLabel: label,
    docsPath: `/channels/${id}`,
    blurb: "",
    ...overrides,
  };
}

export function makeCatalogEntry(
  id: string,
  label: string,
  overrides: Partial<ChannelPluginCatalogEntry> = {},
): ChannelPluginCatalogEntry {
  return {
    id,
    pluginId: id,
    meta: makeMeta(id, label, overrides.meta),
    install: { npmSpec: `@openclaw/${id}` },
    ...overrides,
  };
}

export function makeChannelSetupEntries(
  overrides: Partial<ChannelSetupEntries> = {},
): ChannelSetupEntries {
  return {
    entries: [],
    installedCatalogEntries: [],
    installableCatalogEntries: [],
    installedCatalogById: new Map(),
    installableCatalogById: new Map(),
    ...overrides,
  };
}

export function makeSetupPlugin(params: {
  id: string;
  label: string;
  setupWizard?: ChannelSetupPlugin["setupWizard"];
}): ChannelSetupPlugin {
  return {
    id: params.id as ChannelSetupPlugin["id"],
    meta: makeMeta(params.id, params.label),
    capabilities: { chatTypes: [] },
    config: {
      listAccountIds: vi.fn(() => ["default"]),
      resolveAccount: vi.fn(() => ({})),
    } as unknown as ChannelSetupPlugin["config"],
    ...(params.setupWizard ? { setupWizard: params.setupWizard } : {}),
  };
}

export function makeExternalChatSetupPlugin(
  setupWizard: Pick<ChannelSetupWizardAdapter, "configure"> & Partial<ChannelSetupWizardAdapter>,
): ChannelSetupPlugin {
  return makeSetupPlugin({
    id: "external-chat",
    label: "External Chat",
    setupWizard: {
      channel: "external-chat",
      getStatus: vi.fn(async () => ({
        channel: "external-chat",
        configured: false,
        statusLines: [],
      })),
      ...setupWizard,
    },
  });
}

export function externalChatSetupEntries(
  overrides: Partial<ReturnType<ResolveChannelSetupEntries>> = {},
) {
  return makeChannelSetupEntries({
    entries: [{ id: "external-chat", meta: makeMeta("external-chat", "External Chat") }],
    ...overrides,
  });
}

export function makePluginRegistry(overrides: Partial<PluginRegistry> = {}): PluginRegistry {
  const registry = createEmptyPluginRegistry();
  for (const key of Object.keys(overrides) as Array<keyof PluginRegistry>) {
    const value = overrides[key];
    if (value !== undefined) {
      Object.assign(registry, { [key]: value });
    }
  }
  return registry;
}

type CollectChannelStatus = typeof import("./channel-setup.status.js").collectChannelStatus;
type EnsureChannelSetupPluginInstalled =
  typeof import("../commands/channel-setup/plugin-install.js").ensureChannelSetupPluginInstalled;

export function createChannelSetupMocks() {
  const mocks = {
    resolveAgentWorkspaceDir: vi.fn(
      (_cfg?: unknown, _agentId?: unknown) => "/tmp/openclaw-workspace",
    ),
    resolveDefaultAgentId: vi.fn((_cfg?: unknown) => "default"),
    listTrustedChannelPluginCatalogEntries: vi.fn((_params?: unknown): unknown[] => [
      { id: "external-chat", pluginId: "@vendor/external-chat-plugin", origin: "bundled" },
    ]),
    getTrustedChannelPluginCatalogEntry: vi.fn(
      (_channelId: string, _params?: unknown): unknown => undefined,
    ),
    getChannelSetupPlugin: vi.fn((_channel?: unknown) => undefined),
    listChannelSetupPlugins: vi.fn((): unknown[] => []),
    listActiveChannelSetupPlugins: vi.fn((): unknown[] => []),
    loadChannelSetupPluginRegistrySnapshotForChannel: vi.fn(
      (_params: Parameters<LoadChannelSetupPluginRegistrySnapshotForChannel>[0]) =>
        makePluginRegistry(),
    ),
    ensureChannelSetupPluginInstalled: vi.fn(
      async ({ cfg, entry }: Parameters<EnsureChannelSetupPluginInstalled>[0]) => ({
        cfg,
        installed: true,
        pluginId: entry?.pluginId,
        status: "installed",
      }),
    ),
    resolveChannelSetupEntries: vi.fn(
      (
        _params: Parameters<ResolveChannelSetupEntries>[0],
      ): ReturnType<ResolveChannelSetupEntries> => makeChannelSetupEntries(),
    ),
    collectChannelStatus: vi.fn<CollectChannelStatus>(async (_params) => ({
      statusByChannel: new Map(),
      statusLines: [],
    })),
    resolveChannelSetupWorkspaceDir: vi.fn((_cfg?: unknown) => "/tmp/openclaw-workspace"),
    isChannelConfigured: vi.fn((_cfg?: unknown, _channel?: unknown) => true),
  };
  const factories = {
    agentScope: () => ({
      resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
      resolveDefaultAgentId: mocks.resolveDefaultAgentId,
    }),
    setupRegistry: () => ({
      getChannelSetupPlugin: mocks.getChannelSetupPlugin,
      listActiveChannelSetupPlugins: mocks.listActiveChannelSetupPlugins,
      listChannelSetupPlugins: mocks.listChannelSetupPlugins,
    }),
    channels: () => ({
      getChatChannelMeta: (channelId: string) => ({ id: channelId, label: channelId }),
      listChatChannels: () => [],
      normalizeAnyChannelId: (channelId?: unknown) =>
        typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
      normalizeChatChannelId: (channelId?: unknown) =>
        typeof channelId === "string" ? channelId.trim().toLowerCase() || null : null,
    }),
    discovery: () => ({
      resolveChannelSetupEntries: mocks.resolveChannelSetupEntries,
      shouldShowChannelInSetup: () => true,
    }),
    pluginInstall: () => ({
      ensureChannelSetupPluginInstalled: mocks.ensureChannelSetupPluginInstalled,
      loadChannelSetupPluginRegistrySnapshotForChannel:
        mocks.loadChannelSetupPluginRegistrySnapshotForChannel,
    }),
    registry: () => ({
      resolveChannelSetupWizardAdapterForPlugin: (plugin?: { setupWizard?: unknown }) =>
        plugin?.setupWizard,
    }),
    trustedCatalog: () => ({
      listTrustedChannelPluginCatalogEntries: mocks.listTrustedChannelPluginCatalogEntries,
      getTrustedChannelPluginCatalogEntry: mocks.getTrustedChannelPluginCatalogEntry,
    }),
    configured: () => ({
      isChannelConfigured: mocks.isChannelConfigured,
    }),
    prompts: () => ({
      maybeConfigureCommandOwner: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => cfg),
      maybeConfigureDmPolicies: vi.fn(async ({ cfg }: { cfg: OpenClawConfig }) => cfg),
      promptConfiguredAction: vi.fn(),
      promptRemovalAccountId: vi.fn(),
      formatAccountLabel: vi.fn(),
    }),
    status: () => ({
      collectChannelStatus: mocks.collectChannelStatus,
      findBundledSourceForCatalogChannel: vi.fn(() => undefined),
      noteChannelPrimer: vi.fn(),
      resolveCatalogChannelSelectionHint: vi.fn(() => "download from <npm>"),
      resolveChannelSelectionNoteLines: vi.fn(() => []),
      resolveChannelSetupSelectionOptions: vi.fn(() => []),
      resolveChannelSetupWorkspaceDir: mocks.resolveChannelSetupWorkspaceDir,
      resolveQuickstartDefault: vi.fn(() => undefined),
    }),
  };
  return {
    ...mocks,
    factories,
    reset() {
      vi.clearAllMocks();
      for (const mock of Object.values(mocks)) {
        mock.mockReset();
      }
      mocks.loadChannelSetupPluginRegistrySnapshotForChannel.mockReturnValue(makePluginRegistry());
      mocks.resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries());
    },
  };
}
