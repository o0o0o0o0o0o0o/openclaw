import { expect, vi } from "vitest";
import { createOperationalRunInstanceRef } from "../src/agents/admitted-run-context.js";
import { wrapToolWithGatewayCallerIdentity } from "../src/agents/tools/gateway-caller-context.js";
import { createMessageTool } from "../src/agents/tools/message-tool-execution.js";
import type { ChannelMessageActionName } from "../src/channels/plugins/types.js";
import type { ChannelThreadingToolContext } from "../src/channels/plugins/types.public.js";
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

let sequence = 0;

export function createTeamsReadCaller(
  cfg: OpenClawConfig,
  toolContext: ChannelThreadingToolContext | undefined,
  requesterSenderId: string | undefined,
  senderIsOwner?: boolean,
) {
  const sessionKey = "agent:main:msteams:channel:origin";
  const operationalRunInstance = createOperationalRunInstanceRef(`teams-read-${++sequence}`);
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
    throw new Error("Expected an admitted Teams turn");
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
  const tool = wrapToolWithGatewayCallerIdentity(
    createMessageTool({
      ...capabilityParams,
      ...toolContext,
      agentSessionKey: sessionKey,
      agentAccountId: "default",
      senderIsOwner,
      messageActionTurnCapability: turnCapability,
      config: cfg,
      getScopedChannelsCommandSecretTargets: () => ({ targetIds: new Set<string>() }),
      resolveCommandSecretRefsViaGateway: async ({ config }) => ({
        resolvedConfig: config,
        diagnostics: [],
        targetStatesByPath: {},
        hadUnresolvedTargets: false,
      }),
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
