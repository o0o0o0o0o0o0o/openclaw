import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";
import {
  resolveAutomaticUtilityRuntimeOverride as resolveRuntime,
  resolveConfiguredSetupModelForAgent as resolveSetup,
  resolveUtilityModelRefForAgent as resolveUtility,
} from "./utility-model.js";

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type Entries = NonNullable<OpenClawConfig["agents"]>["entries"];
const config = (defaults: Defaults, entries?: Entries): OpenClawConfig => ({
  agents: { defaults, ...(entries ? { entries } : {}) },
});
const utilityResult = (modelRef: string) => ({ modelRef, modelTarget: "utility" as const });

function snapshotWithDefaults(defaults: Record<string, string>) {
  return createPluginMetadataSnapshotFixture({
    plugins: Object.entries(defaults).map(([provider, defaultUtilityModel], index) => ({
      id: `plugin-${index}`,
      modelCatalog: {
        providers: { [provider]: { defaultUtilityModel, models: [{ id: defaultUtilityModel }] } },
      },
    })),
  });
}

describe("resolveConfiguredSetupModelForAgent", () => {
  it.each([
    [undefined, "main", undefined],
    ["", "main", undefined],
    ["local-utility/shared", "ops", "local-utility/ops"],
    ["local-utility/shared", "disabled", undefined],
    [" local-utility/tiny@local-utility:setup ", "main", "local-utility/tiny@local-utility:setup"],
  ] as const)("uses utility %s for %s", (utilityModel, agentId, expectedRef) => {
    const cfg: OpenClawConfig = {
      meta: { migrations: { utilityModelSeparation: true } },
      agents: {
        ownership: "explicit",
        defaults: { utilityModel },
        entries: { ops: { utilityModel: "local-utility/ops" }, disabled: { utilityModel: "" } },
      },
    };
    const expected = expectedRef === undefined ? undefined : utilityResult(expectedRef);
    expect(resolveSetup({ cfg, agentId })).toEqual(expected);
    cfg.agents!.defaults!.model = "openai/gpt-5.5";
    expect(resolveSetup({ cfg, agentId, modelTarget: "utility" })).toEqual(expected);
  });

  it.each(["native", "acp", "legacy", "legacy-alias"] as const)(
    "%s setup separates primary and utility without mutating config",
    (mode) => {
      const legacy = mode.startsWith("legacy");
      const utilityModel = legacy
        ? `${mode === "legacy" ? "local-utility/tiny" : "helper"}@local:utility`
        : "local-utility/tiny";
      const provider = "local-utility";
      const route = { provider, api: "openai-completions", baseUrl: "http://127.0.0.1:9/v1" };
      const localProvider = {
        baseUrl: route.baseUrl,
        models: [makeProviderModelFixture({ id: "tiny", ...route })],
      };
      const cfg: OpenClawConfig = legacy
        ? {
            ...config({ utilityModel, models: { "local-utility/tiny": { alias: "helper" } } }),
            models: { providers: { [provider]: localProvider } },
          }
        : config(
            { model: "openai/gpt-5.5@openai:primary", utilityModel },
            { main: mode === "acp" ? { model: "harness-only", runtime: { type: "acp" } } : {} },
          );
      const original = structuredClone(cfg);
      expect(resolveSetup({ cfg, agentId: "main" })).toEqual(
        legacy
          ? { modelRef: "local-utility/tiny", implicitPrimary: true }
          : { modelRef: "openai/gpt-5.5@openai:primary" },
      );
      expect(resolveSetup({ cfg, agentId: "main", modelTarget: "utility" })).toEqual(
        utilityResult(utilityModel),
      );
      expect(cfg).toEqual(original);
    },
  );
});

describe("resolveUtilityModelRefForAgent", () => {
  const metadataSnapshot = snapshotWithDefaults({
    openai: "gpt-5.6-luna",
    anthropic: "claude-haiku-4-5",
  });
  type Scenario = [
    name: string,
    cfg: OpenClawConfig,
    expected?: string,
    overrides?: Partial<Parameters<typeof resolveUtility>[0]>,
  ];
  const primary = config({ model: "openai/gpt-5.5@work" }, { main: {} });
  const optOut = config({ utilityModel: "openai/gpt-5.4-mini" }, { ops: { utilityModel: "" } });
  it.each<Scenario>([
    [
      "trimmed explicit reference",
      config({ utilityModel: " openrouter/mistralai/mistral-small " }),
      "openrouter/mistralai/mistral-small",
    ],
    ["disabled", config({ utilityModel: "   " })],
    [
      "provider default",
      config({ model: "anthropic/claude-fable-5" }),
      "anthropic/claude-haiku-4-5",
    ],
    ["native auth profile", primary, "openai/gpt-5.6-luna@work"],
    [
      "ACP preserves native auth profile",
      config(primary.agents!.defaults!, {
        main: { model: "harness-only@harness-profile", runtime: { type: "acp" } },
      }),
      "openai/gpt-5.6-luna@work",
    ],
    [
      "session auth overrides primary",
      config({ model: "anthropic/claude-fable-5@personal" }),
      "openai/gpt-5.6-luna@work",
      { primaryProvider: "OpenAI", primaryModelRef: "openai/gpt-5.5@work" },
    ],
    ["no provider default", config({ model: "ollama/llama-4-70b" })],
    ["agent opt-out", optOut, undefined, { agentId: "ops" }],
    ["other agent retains shared model", optOut, "openai/gpt-5.4-mini"],
  ])("resolves %s", (_name, cfg, expected, overrides) => {
    expect(resolveUtility({ cfg, agentId: "main", metadataSnapshot, ...overrides })).toBe(expected);
  });
});

describe("resolveAutomaticUtilityRuntimeOverride", () => {
  const primary = "anthropic/claude-opus-5";
  const utility = "anthropic/claude-haiku-4-5";
  const cliEntry = { agentRuntime: { id: "claude-cli" } };
  const metadataSnapshot = snapshotWithDefaults({ anthropic: "claude-haiku-4-5" });
  const models = (entry: NonNullable<Defaults["models"]>[string]) => ({
    models: { [primary]: cliEntry, [utility]: entry },
  });
  type Options = Partial<Omit<Parameters<typeof resolveRuntime>[0], "cfg" | "agentId">> & {
    defaults?: Defaults;
    providers?: NonNullable<OpenClawConfig["models"]>["providers"];
  };
  type Scenario = [name: string, options: Options, expected?: string];
  it.each<Scenario>([
    ["model-level CLI pin", {}, "claude-cli"],
    ["explicit same-provider selection", { utilityModelId: "claude-sonnet-5" }],
    [
      "provider without default",
      { metadataSnapshot: snapshotWithDefaults({ openai: "gpt-5.4-mini" }) },
    ],
    ["explicit utility", { defaults: { utilityModel: "openai/gpt-5.6-luna" } }],
    ["disabled utility", { defaults: { utilityModel: "" } }],
    ["different provider", { utilityProvider: "openai", utilityModelId: "gpt-5.6-luna" }],
    ["default primary runtime", { defaults: { models: {} } }],
    [
      "provider-level runtime",
      {
        defaults: { models: {} },
        providers: { anthropic: { baseUrl: "https://api.anthropic.com", models: [], ...cliEntry } },
      },
    ],
    ["wildcard runtime", { defaults: { models: { "anthropic/*": cliEntry } } }],
    ["derived HTTP pin", { defaults: models({ agentRuntime: { id: "openclaw" } }) }],
    ["bare derived entry", { defaults: models({}) }, "claude-cli"],
    [
      "derived default alias",
      { defaults: models({ agentRuntime: { id: "default" } }) },
      "claude-cli",
    ],
  ])(
    "inherits only an automatic model's eligible runtime: %s",
    (_name, { defaults, providers, ...scenario }, expected) => {
      const cfg: OpenClawConfig = {
        agents: { defaults: { model: primary, models: { [primary]: cliEntry }, ...defaults } },
        ...(providers ? { models: { providers } } : {}),
      };
      expect(
        resolveRuntime({
          cfg,
          agentId: "main",
          utilityProvider: "anthropic",
          utilityModelId: "claude-haiku-4-5",
          metadataSnapshot,
          ...scenario,
        }),
      ).toBe(expected);
    },
  );
});
