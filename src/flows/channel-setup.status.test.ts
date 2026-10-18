import { expectDefined } from "@openclaw/normalization-core/expect";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withEnv, withEnvAsync } from "../test-utils/env.js";
import {
  makeCatalogEntry,
  makeChannelSetupEntries,
  makeMeta,
} from "./channel-setup.test-helpers.js";

type ListChatChannels = typeof import("../channels/chat-meta.js").listChatChannels;
type ResolveChannelSetupEntries =
  typeof import("../commands/channel-setup/discovery.js").resolveChannelSetupEntries;
type FormatChannelPrimerLine = typeof import("../channels/registry.js").formatChannelPrimerLine;
type FormatChannelSelectionLine =
  typeof import("../channels/registry.js").formatChannelSelectionLine;
type IsChannelConfigured = typeof import("../config/channel-configured.js").isChannelConfigured;
type ChannelSetupPlugin = import("../channels/plugins/setup-wizard-types.js").ChannelSetupPlugin;
type NoteChannelPrimerChannels = Parameters<
  typeof import("./channel-setup.status.js").noteChannelPrimer
>[1];

const listChatChannels = vi.hoisted(() => vi.fn<ListChatChannels>(() => []));
const resolveChannelSetupEntries = vi.hoisted(() =>
  vi.fn<ResolveChannelSetupEntries>(() => ({
    entries: [],
    installedCatalogEntries: [],
    installableCatalogEntries: [],
    installedCatalogById: new Map(),
    installableCatalogById: new Map(),
  })),
);
const formatChannelPrimerLine = vi.hoisted(() =>
  vi.fn<FormatChannelPrimerLine>((meta) => `${meta.label}: ${meta.blurb}`),
);
const formatChannelSelectionLine = vi.hoisted(() =>
  vi.fn<FormatChannelSelectionLine>((meta) => `${meta.label} — ${meta.blurb}`),
);
const isChannelConfigured = vi.hoisted(() => vi.fn<IsChannelConfigured>(() => false));

vi.mock("../channels/chat-meta.js", () => ({
  listChatChannels,
}));

vi.mock("../channels/registry.js", () => ({
  formatChannelPrimerLine,
  formatChannelSelectionLine,
  normalizeAnyChannelId: (channelId?: string) => channelId?.trim().toLowerCase() ?? null,
}));

vi.mock("../commands/channel-setup/discovery.js", () => ({
  resolveChannelSetupEntries,
  shouldShowChannelInSetup: (meta: { exposure?: { setup?: boolean } }) =>
    meta.exposure?.setup !== false,
}));

vi.mock("../config/channel-configured.js", () => ({
  isChannelConfigured,
}));

// Keep installable-catalog fixtures independent of the bundled extensions tree.
vi.mock("../plugins/bundled-sources.js", () => ({
  resolveBundledPluginSources: () => new Map(),
  findBundledPluginSourceInMap: () => undefined,
}));

import {
  collectChannelStatus,
  noteChannelPrimer,
  resolveChannelSelectionNoteLines,
  resolveChannelSetupSelectionOptions,
} from "./channel-setup.status.js";

function statusPlugin(id: string, label: string): ChannelSetupPlugin {
  return {
    id,
    meta: makeMeta(id, label),
    capabilities: { chatTypes: [] },
    config: {} as ChannelSetupPlugin["config"],
  };
}

function statusSummary(overrides: Partial<Parameters<typeof collectChannelStatus>[0]> = {}) {
  return collectChannelStatus({
    cfg: {},
    accountOverrides: {},
    installedPlugins: [],
    ...overrides,
  });
}

function selectionNotes(
  overrides: Pick<Parameters<typeof resolveChannelSelectionNoteLines>[0], "selection"> &
    Partial<Parameters<typeof resolveChannelSelectionNoteLines>[0]>,
) {
  return resolveChannelSelectionNoteLines({ cfg: {}, installedPlugins: [], ...overrides });
}

describe("resolveChannelSetupSelectionOptions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listChatChannels.mockReturnValue([
      makeMeta("discord", "Discord"),
      makeMeta("imessage", "iMessage"),
    ]);
    resolveChannelSetupEntries.mockReturnValue(makeChannelSetupEntries());
    formatChannelPrimerLine.mockImplementation(
      (meta: { label: string; blurb: string }) => `${meta.label}: ${meta.blurb}`,
    );
    formatChannelSelectionLine.mockImplementation((meta) => `${meta.label} — ${meta.blurb}`);
    isChannelConfigured.mockReturnValue(false);
  });

  it("uses the caller-selected workspace for explicit-fleet status and selection notes", async () => {
    const params = {
      cfg: { agents: { ownership: "explicit" as const, entries: { alpha: {}, beta: {} } } },
      workspaceDir: "/tmp/beta-workspace",
      accountOverrides: {},
      installedPlugins: [],
      selection: [],
    };

    await collectChannelStatus(params);
    resolveChannelSelectionNoteLines(params);

    expect(resolveChannelSetupEntries).toHaveBeenCalledTimes(2);
    for (const [request] of resolveChannelSetupEntries.mock.calls) {
      expect(request.workspaceDir).toBe(params.workspaceDir);
    }
  });

  it("uses the configured system agent workspace for explicit multi-agent setup", async () => {
    const cfg = {
      agents: {
        ownership: "explicit",
        defaults: { systemAgent: { agentId: "main" } },
        entries: {
          main: { workspace: "/tmp/openclaw-main-workspace" },
          helper: { workspace: "/tmp/openclaw-helper-workspace" },
          third: { workspace: "/tmp/openclaw-third-workspace" },
        },
      },
    } as const;

    await statusSummary({ cfg });
    selectionNotes({ cfg, selection: [] });

    expect(resolveChannelSetupEntries).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-main-workspace" }),
    );
    expect(resolveChannelSetupEntries).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ workspaceDir: "/tmp/openclaw-main-workspace" }),
    );
  });

  it("sorts channels alphabetically by picker label", () => {
    const options = resolveChannelSetupSelectionOptions({
      entries: (
        [
          ["zalo", "Zalo", "Zalo (Bot API)"],
          ["discord", "Discord", "Discord (Bot API)"],
          ["imessage", "iMessage", "iMessage (macOS app)"],
        ] as const
      ).map(([id, label, selectionLabel]) => ({
        id,
        meta: makeMeta(id, label, { selectionLabel }),
      })),
      statusByChannel: new Map(),
      resolveDisabledHint: () => undefined,
    });

    expect(options.map((option) => option.label)).toEqual([
      "Discord (Bot API)",
      "iMessage (macOS app)",
      "Zalo (Bot API)",
    ]);
  });

  it("sanitizes picker labels and hints before terminal rendering", () => {
    const options = resolveChannelSetupSelectionOptions({
      entries: [
        {
          id: "zalo",
          meta: {
            id: "zalo",
            label: "Zalo\u001B[31m\nBot\u0007",
          },
        },
      ],
      statusByChannel: new Map([["zalo", { selectionHint: "configured\u001B[2K\nnow" }]]),
      resolveDisabledHint: () => "disabled\u0007",
    });

    expect(options[0]).toEqual({
      value: "zalo",
      label: "Zalo\\nBot",
      hint: "configured\\nnow · disabled",
    });
  });

  it("sanitizes channel labels in status note lines", async () => {
    listChatChannels.mockReturnValue([makeMeta("discord", "Discord\u001B[31m\nCore\u0007")]);
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        installedCatalogEntries: [makeCatalogEntry("matrix", "Matrix\u001B[2K\nPlugin\u0007")],
        installableCatalogEntries: [makeCatalogEntry("zalo", "Zalo\u001B[2K\nPlugin\u0007")],
      }),
    );

    const summary = await statusSummary();

    expect(summary.statusLines).toEqual([
      "Discord\\nCore: not configured",
      "Matrix\\nPlugin: installed",
      "Zalo\\nPlugin: install plugin to enable",
    ]);
  });

  it.each(["rejected status check", "adapter resolution"] as const)(
    "keeps healthy channels selectable after a %s failure",
    async (failurePoint) => {
      const installedPlugins = [
        statusPlugin("matrix", "Matrix"),
        statusPlugin("telegram", "Telegram"),
      ] satisfies ChannelSetupPlugin[];
      listChatChannels.mockReturnValue([
        makeMeta("matrix", "Matrix"),
        makeMeta("telegram", "Telegram"),
      ]);
      isChannelConfigured.mockImplementation((_, channelId) => channelId === "matrix");

      const failure = new Error("lazy Matrix setup module unavailable");
      const summary = await statusSummary({
        installedPlugins,
        resolveAdapter: (channel) => {
          if (channel === "matrix" && failurePoint === "adapter resolution") {
            throw failure;
          }
          return {
            channel,
            getStatus:
              channel === "matrix"
                ? async () => {
                    throw failure;
                  }
                : async () => ({
                    channel: "telegram",
                    configured: true,
                    statusLines: ["Telegram: configured"],
                    selectionHint: "configured",
                    quickstartScore: 5,
                  }),
          } as never;
        },
      });

      expect(summary.statusByChannel.get("matrix")).toEqual({
        channel: "matrix",
        configured: true,
        statusLines: ["Matrix: status unavailable (lazy Matrix setup module unavailable)"],
        selectionHint: "status unavailable",
      });
      expect(summary.statusByChannel.get("telegram")).toEqual({
        channel: "telegram",
        configured: true,
        statusLines: ["Telegram: configured"],
        selectionHint: "configured",
        quickstartScore: 5,
      });
      expect(summary.statusLines).toEqual([
        "Matrix: status unavailable (lazy Matrix setup module unavailable)",
        "Telegram: configured",
      ]);
    },
  );

  it("redacts credentials and terminal controls in failed channel status checks", async () => {
    const token = "sk-abcdefghijklmnopqrstuv";
    const summary = await statusSummary({
      installedPlugins: [statusPlugin("matrix", "Matrix")],
      resolveAdapter: (channel) =>
        ({
          channel,
          getStatus: async () => {
            throw new Error(`\u001B[31mloader failed\nAuthorization: Bearer ${token}`);
          },
        }) as never,
    });

    const statusLine = summary.statusLines[0];
    expect(statusLine).toContain(
      "Matrix: status unavailable (loader failed\\nAuthorization: Bearer",
    );
    expect(statusLine).not.toContain(token);
    expect(statusLine).not.toContain("\u001B");
    expect(statusLine).not.toContain("\n");
  });

  it("localizes channel status note labels", async () => {
    listChatChannels.mockReturnValue([
      makeMeta("discord", "Discord"),
      makeMeta("telegram", "Telegram"),
    ]);
    isChannelConfigured.mockImplementation((_, channelId) => channelId === "discord");
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        installedCatalogEntries: [makeCatalogEntry("matrix", "Matrix")],
        installableCatalogEntries: [makeCatalogEntry("zalo", "Zalo")],
      }),
    );

    await withEnvAsync({ OPENCLAW_LOCALE: "zh-CN" }, async () => {
      const summary = await statusSummary();

      expect(summary.statusLines).toEqual([
        "Discord: 已配置（插件已禁用）",
        "Telegram: 未配置",
        "Matrix: 已安装",
        "Zalo: 安装插件后启用",
      ]);
    });
  });

  it("sanitizes channel metadata before primer notes", async () => {
    const note = vi.fn(async () => undefined);

    await noteChannelPrimer(
      { note } as never,
      [
        {
          id: "bad\u001B[31m\nid",
          label: "\u001B[31m\u0007",
          blurb: "Blurb\u001B[2K\nline\u0007",
        } satisfies NoteChannelPrimerChannels[number],
      ] as NoteChannelPrimerChannels,
    );

    expect(formatChannelPrimerLine).toHaveBeenCalledOnce();
    const [primerMeta] = expectDefined(
      formatChannelPrimerLine.mock.calls.at(0),
      "primer line call",
    );
    expect(primerMeta?.id).toBe("bad\\nid");
    expect(primerMeta?.label).toBe("bad\\nid");
    expect(primerMeta?.selectionLabel).toBe("bad\\nid");
    expect(primerMeta?.blurb).toBe("Blurb\\nline");
    expect(note).toHaveBeenCalledWith(
      [
        "Inbound DM safety defaults to pairing: unknown senders get a pairing code first.",
        "Approve with: openclaw pairing approve <channel> <code>",
        'Open/public DMs require dmPolicy="open" plus allowFrom=["*"].',
        'For multi-user DMs, isolate sessions with: openclaw config set session.dmScope "per-channel-peer" (or "per-account-channel-peer" for multi-account channels).',
        "Docs: https://docs.openclaw.ai/channels/pairing",
        "",
        "bad\\nid: Blurb\\nline",
      ].join("\n"),
      "How channels work",
    );
  });

  it("sanitizes channel metadata before selection notes", () => {
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "zalo",
            meta: {
              id: "zalo",
              label: "Zalo\u001B[31m\nBot\u0007",
              selectionLabel: "Zalo",
              docsPath: "/channels/zalo",
              docsLabel: "Docs\u001B[2K\nLabel",
              blurb: "Setup\u001B[2K\nhelp\u0007",
              selectionDocsPrefix: "Docs\u001B[2K\nPrefix",
              selectionExtras: ["Extra\u001B[2K\nOne", "\u001B[31m\u0007"],
            },
          },
        ],
      }),
    );

    const lines = selectionNotes({ selection: ["zalo"] });

    expect(formatChannelSelectionLine).toHaveBeenCalledOnce();
    const [selectionMeta, docsLink] = expectDefined(
      formatChannelSelectionLine.mock.calls.at(0),
      "selection line call",
    );
    expect(selectionMeta).toMatchObject({
      label: "Zalo\\nBot",
      blurb: "Setup\\nhelp",
      docsLabel: "Docs\\nLabel",
      selectionDocsPrefix: "Docs\\nPrefix",
      selectionExtras: ["Extra\\nOne"],
    });
    if (typeof docsLink !== "function") {
      throw new Error("Expected docs link formatter");
    }
    expect(docsLink("/channels/zalo", "Docs")).toBe("https://docs.openclaw.ai/channels/zalo");
    expect(lines).toEqual(["Zalo\\nBot — Setup\\nhelp"]);
  });

  it("preserves an explicitly empty selection docs prefix", () => {
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "custom-chat",
            meta: makeMeta("custom-chat", "Custom Chat", {
              blurb: "External channel.",
              selectionDocsPrefix: "",
            }),
          },
        ],
      }),
    );

    selectionNotes({ selection: ["custom-chat"] });

    const [selectionMeta] = expectDefined(
      formatChannelSelectionLine.mock.calls.at(0),
      "selection line call",
    );
    expect(selectionMeta?.selectionDocsPrefix).toBe("");
  });

  it("localizes built-in channel blurbs before selection notes", () => {
    resolveChannelSetupEntries.mockReturnValue(
      makeChannelSetupEntries({
        entries: [
          {
            id: "feishu",
            meta: makeMeta("feishu", "Feishu", {
              docsLabel: "feishu",
              blurb: "飞书/Lark enterprise messaging.",
            }),
          },
        ],
      }),
    );

    withEnv({ OPENCLAW_LOCALE: "zh-CN" }, () => {
      const lines = selectionNotes({ selection: ["feishu"] });

      expect(formatChannelSelectionLine).toHaveBeenCalledWith(
        expect.objectContaining({
          label: "Feishu",
          blurb: "飞书/Lark 企业消息。",
          selectionDocsPrefix: "文档：",
        }),
        expect.any(Function),
      );
      expect(lines).toEqual(["Feishu — 飞书/Lark 企业消息。"]);
    });
  });
});
