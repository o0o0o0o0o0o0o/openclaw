import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createAccountListHelpers } from "../channels/plugins/account-helpers.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronScheduledToolCallerOrigin } from "../cron/scheduled-tool-policy.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import { useSessionStoreTempDirs } from "../test-utils/session-state-cleanup.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import {
  prepareConversationCapabilityProfile,
  resolveConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import {
  isConversationToolAllowed,
  projectConversationToolNames,
} from "./conversation-tool-policy-pipeline.js";
import { preparePluginHarnessPolicyToolsAllow } from "./harness/execution-environment.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import { resolveWebSearchToolPolicy } from "./web-search-tool-policy.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-capability-profile-");

function project(
  capabilityProfile: ReturnType<typeof resolveConversationCapabilityProfile>,
  toolNames: string[],
) {
  return projectConversationToolNames({ capabilityProfile, toolNames, warn: () => undefined });
}

function groupConfig(
  toolsBySender: Record<string, { allow?: string[]; deny?: string[] }>,
  allow = ["read"],
): OpenClawConfig {
  return { channels: { whatsapp: { groups: { team: { tools: { allow }, toolsBySender } } } } };
}

describe("resolveConversationCapabilityProfile", () => {
  it.each(["fixture-reader", "group:plugins"])(
    "uses registered ownership for %s without granting name-only callers",
    (allow) => {
      const profile = resolveConversationCapabilityProfile({
        config: { tools: { allow: [allow, "read"] } },
      });
      expect(
        isConversationToolAllowed(profile, "read_public_item", { pluginId: "fixture-reader" }),
      ).toBe(true);
      expect(isConversationToolAllowed(profile, "read_public_item")).toBe(false);
      expect(isConversationToolAllowed(profile, "read")).toBe(true);
    },
  );

  it.each(["read_public_item", "fixture-reader", "group:plugins"])(
    "keeps %s denied when rechecking a registered plugin tool",
    (deny) => {
      const profile = resolveConversationCapabilityProfile({
        config: { tools: { allow: ["group:plugins"], deny: [deny] } },
      });
      expect(
        isConversationToolAllowed(profile, "read_public_item", { pluginId: "fixture-reader" }),
      ).toBe(false);
    },
  );

  it("does not let plugin ownership widen a narrower conversation policy", () => {
    const profile = resolveConversationCapabilityProfile({
      config: { tools: { allow: ["group:plugins", "read"] } },
      conversationToolPolicy: { allow: ["read"] },
    });
    expect(
      isConversationToolAllowed(profile, "read_public_item", { pluginId: "fixture-reader" }),
    ).toBe(false);
    expect(isConversationToolAllowed(profile, "read")).toBe(true);
  });

  it("intersects base and provider profile contributions from plugin manifests", () => {
    const profile = resolveConversationCapabilityProfile({
      config: {
        tools: {
          profile: "coding",
          byProvider: { openai: { profile: "messaging" } },
        },
      },
      modelProvider: "openai",
      pluginMetadataSnapshot: {
        plugins: [
          {
            contracts: { tools: ["coding_only", "messaging_only", "shared"] },
            toolMetadata: {
              coding_only: { profiles: ["coding"] },
              messaging_only: { profiles: ["messaging"] },
              shared: { profiles: ["coding", "messaging"] },
            },
          },
        ],
      } as never,
    });

    expect(project(profile, ["coding_only", "messaging_only", "shared"])).toEqual(["shared"]);
  });

  it("intersects a prepared direct policy with existing tool policy", () => {
    const profile = resolveConversationCapabilityProfile({
      config: { tools: { deny: ["write"] } },
      conversationToolPolicy: { allow: ["read", "write", "exec"], deny: ["exec"] },
    });

    expect(profile.policy.groupPolicy).toEqual({
      allow: ["read", "write", "exec"],
      deny: ["exec"],
    });
    expect(profile.policy.inheritancePolicies).toContain(profile.policy.groupPolicy);
    expect(project(profile, ["read", "write", "exec", "process"])).toEqual(["read"]);
  });

  it("does not add a requester restriction without a conversation policy", () => {
    const profile = resolveConversationCapabilityProfile({});

    expect(profile.policy.groupPolicy).toBeUndefined();
    expect(project(profile, ["read", "write", "exec"])).toEqual(["read", "write", "exec"]);
  });

  it.each([
    ["owner WebChat", { messageChannel: INTERNAL_MESSAGE_CHANNEL, senderIsOwner: true }, false],
    [
      "non-owner WebChat",
      { messageProvider: INTERNAL_MESSAGE_CHANNEL, senderIsOwner: false },
      true,
    ],
    ["external owner", { messageProvider: "discord", senderIsOwner: true }, true],
  ] as const)("applies sender restrictions for %s", (_name, params, restricted) => {
    const deny = ["exec", "process"];
    const profile = resolveConversationCapabilityProfile({
      config: { tools: { toolsBySender: { "*": { deny } } } },
      ...params,
    });

    expect(profile.policy.senderPolicy).toEqual(
      restricted ? { deny: ["exec", "process"] } : undefined,
    );
    expect(profile.policy.explicitToolDenylist).toEqual(restricted ? ["exec", "process"] : []);
  });

  it("prepares a shared conversation profile with group per-sender restrictions", () => {
    const profile = resolveConversationCapabilityProfile({
      config: groupConfig({ "id:alice": { allow: ["read", "exec"] } }),
      sessionKey: "agent:main:whatsapp:group:team",
      agentId: "main",
      messageProvider: "whatsapp",
      groupId: "team",
      senderId: "alice",
      modelProvider: "openai",
      modelId: "gpt-5.5",
      workspaceDir: "/tmp/openclaw-shared-profile",
    });

    expect(profile.policy.trustedGroup).toEqual({ groupId: "team", dropped: false });
    expect(profile.policy.groupPolicy).toEqual({ allow: ["read", "exec"] });
    expect(profile.policy.explicitToolAllowlist).toEqual(["read", "exec"]);
  });

  it("uses a scheduled owner group without reapplying sender wildcard policy", () => {
    const cfg: OpenClawConfig = {
      ...groupConfig({ "*": { deny: ["write"] } }, ["read", "write"]),
      tools: {
        deny: ["exec"],
        toolsBySender: { "*": { deny: ["write"] } },
      },
    };
    const baseParams = {
      config: cfg,
      sessionKey: "agent:main:cron:job:run:session",
      agentId: "main",
      messageProvider: "whatsapp",
      runtimeToolAllowlist: ["write"],
    };

    const legacy = resolveConversationCapabilityProfile(baseParams);
    const scheduled = resolveConversationCapabilityProfile({
      ...baseParams,
      scheduledToolPolicy: {
        version: 1,
        mode: "account",
        ownerSessionKey: "agent:main:whatsapp:group:team",
        ownerAccountId: "default",
      },
    });

    expect(legacy.policy.senderPolicy).toEqual({ deny: ["write"] });
    expect(legacy.policy.groupPolicy).toBeUndefined();
    expect(scheduled.policy.senderPolicy).toBeUndefined();
    expect(scheduled.policy.groupPolicy).toEqual({ allow: ["read", "write"] });
    expect(scheduled.policy.explicitToolDenylist).toEqual(["exec"]);
    expect(scheduled.policy.explicitToolAllowlist).toContain("write");
  });

  it("adds runtime tools without replacing the configured tool surface", () => {
    const profile = resolveConversationCapabilityProfile({
      config: {
        tools: {
          profile: "coding",
          deny: ["workboard_block"],
        },
      },
      runtimePluginToolGrant: {
        pluginId: "workboard",
        toolNames: ["workboard_heartbeat", " workboard_complete ", "workboard_heartbeat"],
      },
    });

    expect(profile.policy.profileAlsoAllow).toEqual(["workboard_heartbeat", "workboard_complete"]);
    expect(profile.policy.providerProfileAlsoAllow).toEqual([
      "workboard_heartbeat",
      "workboard_complete",
    ]);
    expect(profile.policy.explicitToolAllowlist).toEqual(expect.arrayContaining(["read", "exec"]));
    expect(profile.policy.explicitToolAllowlist).not.toContain("workboard_heartbeat");
    expect(profile.policy.explicitToolOverrideAllowlist).toEqual([]);
    expect(profile.policy.explicitToolDenylist).toEqual(["workboard_block"]);
    expect(profile.policy.runtimePluginToolGrant).toEqual({
      pluginId: "workboard",
      toolNames: ["workboard_heartbeat", " workboard_complete ", "workboard_heartbeat"],
    });
    expect(profile.policy.inheritancePolicies).not.toContainEqual({
      allow: ["workboard_heartbeat", "workboard_complete"],
    });
  });

  it("keeps inherited subagent grants out of explicit overrides", async () => {
    const tempDir = sessionDirs.make();
    const storePath = path.join(tempDir, "sessions.json");
    const sessionKey = "agent:main:subagent:limited";
    await replaceSessionEntry({ storePath, sessionKey }, {
      sessionId: "limited-session",
      updatedAt: Date.now(),
      spawnDepth: 1,
      subagentRole: "orchestrator",
      subagentControlScope: "children",
      spawnedBy: "agent:main:main",
      inheritedToolPolicyVersion: 1,
      inheritedToolAllow: ["image_generate"],
    } as SessionEntry);

    const profile = await prepareConversationCapabilityProfile({
      config: { session: { store: storePath } },
      sessionKey,
      agentId: "main",
      modelProvider: "ollama",
      modelId: "qwen3.5:9b",
    });

    expect(profile.policy.explicitToolAllowlist).toContain("image_generate");
    expect(profile.policy.explicitToolOverrideAllowlist).not.toContain("image_generate");
    expect(profile.policy.delegated).toBe(true);
    expect(profile.policy.requesterPolicySource).toBe("persisted-child");
  });

  it("keeps runtime allowlists local unless the caller opts into inheritance", () => {
    const localRuntimeProfile = resolveConversationCapabilityProfile({
      runtimeToolAllowlist: ["sessions_spawn", "memory_search"],
    });

    expect(localRuntimeProfile.policy.explicitToolAllowlist).toEqual([
      "sessions_spawn",
      "memory_search",
    ]);
    expect(localRuntimeProfile.policy.explicitToolOverrideAllowlist).toEqual([
      "sessions_spawn",
      "memory_search",
    ]);
    expect(localRuntimeProfile.policy.runtimeToolPolicyForInheritance).toBeUndefined();

    const inheritedRuntimeProfile = resolveConversationCapabilityProfile({
      runtimeToolAllowlist: ["sessions_spawn", "memory_search"],
      inheritRuntimeToolAllowlist: true,
    });

    expect(inheritedRuntimeProfile.policy.runtimeToolPolicyForInheritance).toEqual({
      allow: ["sessions_spawn", "memory_search"],
    });
    expect(inheritedRuntimeProfile.policy.inheritancePolicies).toContain(
      inheritedRuntimeProfile.policy.runtimeToolPolicyForInheritance,
    );
  });

  it("drops caller group facts that the session key cannot vouch for", () => {
    const profile = resolveConversationCapabilityProfile({
      sessionKey: "agent:main:discord:dm:guest",
      agentId: "main",
      messageProvider: "discord",
      groupId: "team",
      groupChannel: "#general",
      groupSpace: "guild-1",
      senderId: "guest",
    });

    expect(profile.policy.trustedGroup).toEqual({ groupId: null, dropped: true });
    expect(profile.conversation).toMatchObject({
      groupId: null,
      groupChannel: null,
      groupSpace: null,
    });
  });
});

describe("resolveConversationCapabilityProfile scheduled account authority", () => {
  beforeEach(() => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            id: "whatsapp",
            meta: {},
            config: createAccountListHelpers("whatsapp"),
          },
        },
      ]),
    );
  });

  it.each([
    ["external", true, "telegram"],
    ["unknown", true, "whatsapp"],
    ["local", false, "whatsapp"],
  ] satisfies Array<[CronScheduledToolCallerOrigin["kind"], boolean, string]>)(
    "preserves scheduled %s creator authority (configured=%s, delivery=%s)",
    async (origin, configured, delivery) => {
      const config: OpenClawConfig = {
        channels: { whatsapp: { accounts: configured ? { work: {} } : {} } },
      };
      const ownerOrigin: CronScheduledToolCallerOrigin =
        origin === "external" ? { kind: origin, channel: "whatsapp" } : { kind: origin };
      const params = {
        config,
        sessionKey: "agent:main:cron:job:run:turn",
        agentId: "main",
        agentAccountId: "default",
        messageProvider: delivery,
        scheduledToolPolicy: {
          version: 1,
          mode: "account",
          ownerSessionKey:
            origin === "local" ? "agent:main:main" : "agent:main:whatsapp:direct:sender",
          ownerAccountId: "work",
          ownerOrigin,
        } satisfies ScheduledToolPolicyContext,
      };
      const conversationTools = () =>
        project(
          resolveConversationCapabilityProfile({
            ...params,
            config: { ...params.config, tools: { allow: ["read"] } },
          }),
          ["read", "write"],
        );
      const webSearch = () =>
        resolveWebSearchToolPolicy({ ...params, runtimeToolAllowlist: ["web_search"] });
      const harnessTools = () =>
        preparePluginHarnessPolicyToolsAllow({
          ...params,
          provider: "fixture",
          modelId: "fixture-model",
          senderId: "sender",
          conversationToolPolicy: { deny: ["*"] },
        });

      if (origin === "unknown" || !configured) {
        for (const resolve of [conversationTools, webSearch]) {
          expect(resolve).toThrow('Scheduled account "work" is unavailable');
        }
        await expect(harnessTools()).rejects.toThrow('Scheduled account "work" is unavailable');
        return;
      }
      expect(conversationTools()).toEqual(["read"]);
      expect(webSearch()).toEqual({ allowed: true, persistentAllowed: true });
      expect(await harnessTools()).toEqual([]);
    },
  );
});
