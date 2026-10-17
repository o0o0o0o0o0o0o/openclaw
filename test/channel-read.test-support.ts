import { Command } from "commander";
import { expect, vi } from "vitest";
import type { MSTeamsConfig } from "../extensions/msteams/runtime-api.js";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import type { ChannelMessageActionName } from "../src/channels/plugins/types.js";
import type { ChannelThreadingToolContext } from "../src/channels/plugins/types.public.js";
import { createDefaultDeps } from "../src/cli/deps.js";
import { createMessageCliHelpers } from "../src/cli/program/message/helpers.js";
import type { registerMessageDiscordAdminCommands } from "../src/cli/program/message/register.discord-admin.js";
import { messageCommand } from "../src/commands/message.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { createAgentRuntimeApprovalAuthorityValidator } from "../src/gateway/agent-runtime-approval-authority.js";
import {
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapability,
  revokeMessageActionTurnCapability,
} from "../src/gateway/message-action-turn-capability.js";
import { sendHandlers } from "../src/gateway/server-methods/send.js";
import type { GatewayClient, GatewayRequestContext } from "../src/gateway/server-methods/types.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
  validateAgentRunDelegatedAuthority,
} from "../src/infra/agent-run-registry.js";
import { createPluginRegistry } from "../src/plugins/registry.js";
import { setActivePluginRegistry } from "../src/plugins/runtime.js";
import type { PluginRuntime } from "../src/plugins/runtime/types.js";
import { createPluginRecord } from "../src/plugins/status.test-fixtures.js";
import { commandSecretFixture } from "./helpers/gateway-integration-fixtures.js";

let sequence = 0;

export function createTeamsReadConfig(
  policy: Pick<MSTeamsConfig, "groupPolicy" | "teams">,
): OpenClawConfig {
  return {
    channels: {
      msteams: {
        enabled: true,
        authType: "secret",
        appId: "44444444-4444-4444-4444-444444444444",
        appPassword: "synthetic-app-password",
        tenantId: "55555555-5555-5555-5555-555555555555",
        dmPolicy: "open",
        allowFrom: ["*"],
        ...policy,
      },
    },
  };
}

export function createReadCallerContext(
  cfg: OpenClawConfig,
  toolContext: ChannelThreadingToolContext | undefined,
  requesterSenderId: string | undefined,
  sessionKey = "agent:main:msteams:channel:origin",
  runId = `teams-read-${++sequence}`,
) {
  const operationalRunInstance = createOperationalRunInstanceRef(runId);
  const delegatedAuthority = claimAgentRunDelegatedAuthority(operationalRunInstance);
  const capabilityParams = { agentId: "main", runId: operationalRunInstance.runId, sessionKey };
  const turnCapability = mintMessageActionTurnCapability({
    ...capabilityParams,
    requesterAccountId: "default",
    requesterSenderId,
    toolContext,
  });
  const messageActionContext = resolveMessageActionTurnCapability({
    ...capabilityParams,
    token: turnCapability,
  });
  if (!messageActionContext) {
    throw new Error("Expected an admitted message turn");
  }
  const client = {
    internal: {
      agentRuntimeIdentity: {
        kind: "agentRuntime",
        agentId: "main",
        sessionKey,
        operationalRunInstance,
        delegatedAuthority: { kind: "local", ...delegatedAuthority },
        messageActionContext: { ...messageActionContext, turnCapability },
      },
    },
  } as GatewayClient;
  const context = {
    dedupe: new Map(),
    getRuntimeConfig: () => cfg,
    validateAgentRuntimeApprovalAuthority: createAgentRuntimeApprovalAuthorityValidator(),
  } as GatewayRequestContext;
  return {
    client,
    context,
    capabilityParams,
    operationalRunInstance,
    delegatedAuthority,
    turnCapability,
  };
}

export function createTeamsReadCaller(
  cfg: OpenClawConfig,
  toolContext: ChannelThreadingToolContext | undefined,
  requesterSenderId: string | undefined,
  senderIsOwner?: boolean,
) {
  const {
    client,
    context,
    capabilityParams,
    operationalRunInstance,
    delegatedAuthority,
    turnCapability,
  } = createReadCallerContext(cfg, toolContext, requesterSenderId);
  const sessionKey = capabilityParams.sessionKey;
  const tool = wrapToolWithGatewayCallerIdentity(
    createMessageTool({
      ...capabilityParams,
      ...toolContext,
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      senderIsOwner,
      messageActionTurnCapability: turnCapability,
      config: cfg,
      ...commandSecretFixture,
    }),
    {
      ...capabilityParams,
      operationalRunInstance,
      receiptAuthority: () => validateAgentRunDelegatedAuthority(delegatedAuthority),
    },
  );
  const revokeTurn = () => revokeMessageActionTurnCapability(turnCapability);
  const revokeClaim = () => releaseAgentRunDelegatedAuthority(delegatedAuthority);
  return {
    revokeTurn,
    revokeClaim,
    dispose() {
      revokeTurn();
      revokeClaim();
    },
    async invoke(
      route: "tool" | "gateway",
      action: ChannelMessageActionName,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) {
      const id = `teams-call-${++sequence}`;
      if (route === "tool") {
        return (await tool.execute(id, { action, channel: "msteams", ...params }, signal)).details;
      }
      const respond =
        vi.fn<(ok: boolean, payload?: unknown, error?: { message?: string }) => void>();
      await sendHandlers["message.action"]!({
        params: {
          action,
          channel: "msteams",
          params,
          agentId: "main",
          sessionKey,
          idempotencyKey: id,
        },
        respond,
        context,
        client,
        req: { type: "req", id, method: "message.action" },
        isWebchatConnect: () => false,
        signal,
      });
      expect(respond).toHaveBeenCalledTimes(1);
      const [ok, payload, error] = respond.mock.calls[0]!;
      if (!ok) {
        expect(payload).toBeUndefined();
        throw new Error(error?.message ?? "Gateway Teams action failed");
      }
      return payload;
    },
  };
}

export function createReadPluginRegistration(
  config: OpenClawConfig,
  id: string,
  origin: "bundled" | "global",
  runtime: PluginRuntime = {} as PluginRuntime,
) {
  const owner = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime,
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id, origin, trustedOfficialInstall: origin === "global" });
  owner.registry.plugins.push(record);
  const api = owner.createApi(record, { config, registrationMode: "full" });
  return { record, api, activate: () => setActivePluginRegistry(owner.registry) };
}

export async function runReadCli(
  channel: "matrix" | "msteams",
  register: typeof registerMessageDiscordAdminCommands,
  args: string[],
  action: ChannelMessageActionName,
  json = true,
) {
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const command = new Command().name("message").exitOverride();
  register(command, {
    ...createMessageCliHelpers(channel),
    runMessageAction: async (name, opts) => {
      await messageCommand({ ...opts, action: name }, createDefaultDeps(), runtime);
    },
  });
  await command.parseAsync([...args, "--channel", channel, ...(json ? ["--json"] : [])], {
    from: "user",
  });
  expect(runtime.error).not.toHaveBeenCalled();
  if (!json) {
    expect(runtime.log).toHaveBeenCalled();
    return runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
  }
  expect(runtime.log).toHaveBeenCalledTimes(1);
  const result = JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
  expect(result).toMatchObject({ action, channel, dryRun: false, handledBy: "plugin" });
  return result.payload;
}
