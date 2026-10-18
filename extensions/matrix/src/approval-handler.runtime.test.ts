import { beforeEach, describe, expect, it, vi } from "vitest";
import { matrixApprovalNativeRuntime } from "./approval-handler.runtime.js";
import {
  resolveMatrixApprovalReactionTargetWithPersistence as resolveMatrixApprovalReactionTargetWithPersistenceRaw,
  unregisterMatrixApprovalReactionTargetsForApproval,
} from "./approval-reactions.js";

function resolveReaction(eventId: string) {
  return resolveMatrixApprovalReactionTargetWithPersistenceRaw({
    accountId: "default",
    roomId: "!room:example.org",
    eventId,
    reactionKey: "✅",
  });
}

type MatrixDeliverPendingParams = Parameters<
  typeof matrixApprovalNativeRuntime.transport.deliverPending
>[0];
type MatrixPendingApprovalView = MatrixDeliverPendingParams["view"];
type MatrixPendingExecApprovalView = Extract<MatrixPendingApprovalView, { approvalKind: "exec" }>;
type MatrixPendingPluginApprovalView = Extract<
  MatrixPendingApprovalView,
  { approvalKind: "plugin" }
>;

const MATRIX_APPROVAL_METADATA_KEY = "com.openclaw.approval";
const baseContext = { cfg: {} as never, accountId: "default", context: { client: {} as never } };

function mockCall<T extends readonly unknown[]>(mock: { mock: { calls: T[] } }, index = 0) {
  return mock.mock.calls.at(index);
}

function buildMatrixReceipt(messageIds: readonly string[], roomId = "!room:example.org") {
  return {
    primaryPlatformMessageId: messageIds[0],
    platformMessageIds: [...messageIds],
    parts: messageIds.map((messageId, index) => ({
      platformMessageId: messageId,
      kind: "text" as const,
      index,
      raw: { channel: "matrix", messageId, roomId },
    })),
    sentAt: 100,
    raw: messageIds.map((messageId) => ({ channel: "matrix", messageId, roomId })),
  };
}

function singleMessageResult(messageId: string) {
  return {
    messageId,
    primaryMessageId: messageId,
    receipt: buildMatrixReceipt([messageId]),
    roomId: "!room:example.org",
  };
}

// Keep pending reaction anchors alive for the assertions.
const TEST_APPROVAL_EXPIRES_AT_MS = Date.now() + 5 * 60_000;

const allowOnceAction = (id: string) => ({
  decision: "allow-once" as const,
  label: "Allow Once",
  style: "success" as const,
  command: `/approve ${id} allow-once`,
});

function buildExecApprovalView(
  overrides: Partial<MatrixPendingExecApprovalView> = {},
): MatrixPendingExecApprovalView {
  return {
    approvalKind: "exec",
    approvalId: "req-1",
    phase: "pending",
    title: "Exec Approval Required",
    description: "A command needs your approval.",
    metadata: [],
    ask: "on-request",
    agentId: "agent-1",
    commandText: "echo hi",
    commandPreview: "echo hi",
    cwd: "/repo",
    host: "gateway",
    actions: [
      allowOnceAction("req-1"),
      { decision: "deny", label: "Deny", style: "danger", command: "/approve req-1 deny" },
    ],
    expiresAtMs: TEST_APPROVAL_EXPIRES_AT_MS,
    ...overrides,
  };
}

function buildPluginApprovalView(): MatrixPendingPluginApprovalView {
  return {
    approvalKind: "plugin",
    approvalId: "plugin:req-1",
    phase: "pending",
    title: "Plugin Approval Required",
    description: "Approve the tool call.",
    metadata: [],
    agentId: "agent-1",
    pluginId: "ops",
    toolName: "deploy",
    severity: "critical",
    actions: [allowOnceAction("plugin:req-1")],
    expiresAtMs: TEST_APPROVAL_EXPIRES_AT_MS,
  };
}

async function buildPendingPayload(view: MatrixPendingApprovalView) {
  const request = {
    id: view.approvalId,
    createdAtMs: 0,
    expiresAtMs: view.expiresAtMs,
    request:
      view.approvalKind === "plugin"
        ? { title: view.title, description: view.description ?? "" }
        : { command: view.commandText },
  };
  return await matrixApprovalNativeRuntime.presentation.buildPendingPayload({
    ...baseContext,
    request,
    approvalKind: view.approvalKind,
    nowMs: 100,
    view,
  });
}

async function deliverPending(
  view: MatrixPendingApprovalView,
  pendingPayload: MatrixDeliverPendingParams["pendingPayload"],
  deps: {
    sendSingleTextMessage: ReturnType<typeof vi.fn>;
    reactMessage: ReturnType<typeof vi.fn>;
    sendMessage?: ReturnType<typeof vi.fn>;
  },
) {
  return await matrixApprovalNativeRuntime.transport.deliverPending({
    cfg: {} as never,
    accountId: "default",
    context: { client: {} as never, deps },
    request: {} as never,
    approvalKind: view.approvalKind,
    plannedTarget: {
      surface: "approver-dm",
      target: { to: "room:!room:example.org" },
      reason: "preferred",
    },
    preparedTarget: { to: "room:!room:example.org", roomId: "!room:example.org" },
    view,
    pendingPayload,
  });
}

describe("matrixApprovalNativeRuntime", () => {
  beforeEach(async () => {
    await unregisterMatrixApprovalReactionTargetsForApproval({
      accountId: "default",
      approvalId: "req-1",
      approvalKind: "exec",
    });
    await unregisterMatrixApprovalReactionTargetsForApproval({
      accountId: "default",
      approvalId: "plugin:req-1",
      approvalKind: "plugin",
    });
  });

  it("delivers Matrix approval content with plugin approval fields", async () => {
    const sendSingleTextMessage = vi
      .fn()
      .mockResolvedValue(singleMessageResult("$plugin-approval"));
    const reactMessage = vi.fn().mockResolvedValue(undefined);
    const view = buildPluginApprovalView();
    const pendingPayload = await buildPendingPayload(view);

    await deliverPending(view, pendingPayload, { sendSingleTextMessage, reactMessage });

    const [target, text, options] = mockCall(sendSingleTextMessage) ?? [];
    expect(target).toBe("room:!room:example.org");
    expect(String(text)).toContain("deploy");
    const extraContent = (options as { extraContent?: Record<string, unknown> } | undefined)
      ?.extraContent;
    expect(extraContent?.[MATRIX_APPROVAL_METADATA_KEY]).toEqual({
      version: 1,
      type: "approval.request",
      state: "pending",
      phase: "pending",
      id: "plugin:req-1",
      kind: "plugin",
      title: "Plugin Approval Required",
      description: "Approve the tool call.",
      expiresAtMs: TEST_APPROVAL_EXPIRES_AT_MS,
      metadata: [],
      allowedDecisions: ["allow-once"],
      actions: [allowOnceAction("plugin:req-1")],
      pluginId: "ops",
      toolName: "deploy",
      agentId: "agent-1",
      severity: "critical",
    });
    expect(mockCall(reactMessage)).toEqual([
      "!room:example.org",
      "$plugin-approval",
      "✅",
      expect.objectContaining({ accountId: "default" }),
    ]);
  });

  it("binds Matrix approval reactions before publishing option reactions", async () => {
    const sendSingleTextMessage = vi.fn().mockResolvedValue(singleMessageResult("$approval"));
    const reactMessage = vi.fn().mockImplementation(async () => {
      expect(await resolveReaction("$approval")).toEqual({
        approvalId: "req-1",
        approvalKind: "exec",
        decision: "allow-once",
      });
    });
    const view = buildExecApprovalView();
    const pendingPayload = await buildPendingPayload(view);

    await deliverPending(view, pendingPayload, { sendSingleTextMessage, reactMessage });

    expect(reactMessage).toHaveBeenCalled();
  });

  it("retries transient Matrix direct-room repair failures before preparing approval DMs", async () => {
    const repairDirectRooms = vi
      .fn()
      .mockRejectedValueOnce(new Error("direct account data not ready"))
      .mockResolvedValue({ activeRoomId: "!dm:example.org" });

    const prepared = await matrixApprovalNativeRuntime.transport.prepareTarget({
      cfg: {
        channels: {
          matrix: { encryption: false },
        },
      } as never,
      accountId: "default",
      context: {
        client: {} as never,
        deps: { repairDirectRooms },
      },
      request: {} as never,
      approvalKind: "exec",
      view: buildExecApprovalView(),
      pendingPayload: {} as never,
      plannedTarget: {
        surface: "approver-dm",
        target: { to: "user:@owner:example.org" },
        reason: "preferred",
      },
    });

    expect(repairDirectRooms).toHaveBeenCalledTimes(2);
    expect(prepared).toHaveProperty("target", {
      to: "room:!dm:example.org",
      roomId: "!dm:example.org",
      threadId: undefined,
    });
  });

  it("falls back to chunked Matrix delivery when approval content exceeds one event", async () => {
    const sendSingleTextMessage = vi
      .fn()
      .mockRejectedValue(new Error("Matrix single-message text exceeds limit (5000 > 4000)"));
    const sendMessage = vi.fn().mockResolvedValue({
      messageId: "$last",
      primaryMessageId: "$legacy-primary",
      receipt: buildMatrixReceipt(["$primary", "$last"]),
      roomId: "!room:example.org",
    });
    const reactMessage = vi.fn().mockResolvedValue(undefined);
    const view = buildExecApprovalView({ actions: [allowOnceAction("req-1")] });
    const pendingPayload = await buildPendingPayload(view);

    const entry = await deliverPending(view, pendingPayload, {
      sendSingleTextMessage,
      sendMessage,
      reactMessage,
    });

    expect(mockCall(sendMessage)?.[0]).toBe("room:!room:example.org");
    expect(mockCall(sendMessage)?.[1]).toBe(pendingPayload.text);
    expect(mockCall(sendMessage)?.[2]).toEqual(
      expect.objectContaining({ accountId: "default", extraContent: pendingPayload.extraContent }),
    );
    expect(mockCall(reactMessage)).toEqual([
      "!room:example.org",
      "$primary",
      expect.any(String),
      expect.objectContaining({ accountId: "default" }),
    ]);
    expect(typeof mockCall(reactMessage)?.[2]).toBe("string");
    expect(entry).toEqual(
      expect.objectContaining({
        roomId: "!room:example.org",
        platformMessageIds: ["$primary", "$last"],
        reactionEventId: "$primary",
      }),
    );
    const bindPending = matrixApprovalNativeRuntime.interactions?.bindPending;
    if (!bindPending) {
      throw new Error("Matrix approval runtime must expose bindPending");
    }
    const binding = await bindPending({
      ...baseContext,
      request: {} as never,
      approvalKind: "exec",
      view,
      pendingPayload,
      entry: entry!,
    });

    expect(binding).toEqual({
      accountId: "default",
      roomId: "!room:example.org",
      eventId: "$primary",
    });
    expect(await resolveReaction("$primary")).toEqual({
      approvalId: "req-1",
      approvalKind: "exec",
      decision: "allow-once",
    });
    expect(await resolveReaction("$last")).toBeNull();
  });

  it("preserves the Denied system-agent heading after denial", async () => {
    const result = await matrixApprovalNativeRuntime.presentation.buildResolvedResult({
      cfg: {},
      accountId: "default",
      request: {
        approvalKind: "system-agent",
        id: "system-agent:change-1",
        request: {
          title: "OpenClaw change",
          description: "restart the Gateway",
          command: "restart the Gateway",
          proposalHash: "a".repeat(64),
          allowedDecisions: ["allow-once", "deny"],
          sessionId: "delegation-1",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      resolved: {
        id: "system-agent:change-1",
        decision: "deny",
        applicationStatus: "not-applied",
        terminalStatus: undefined,
        ts: 1,
      },
      view: {
        approvalKind: "system-agent",
        approvalId: "system-agent:change-1",
        phase: "resolved",
        title: "OpenClaw change",
        metadata: [],
        commandText: "restart the Gateway",
        operationSummary: "restart the Gateway",
        decision: "deny",
        applicationStatus: "not-applied",
        terminalStatus: undefined,
      },
      entry: null,
    });

    expect(result).toEqual({
      kind: "update",
      payload: `OpenClaw change: Denied\n\nChange\n\`\`\`\nrestart the Gateway\n\`\`\``,
    });
  });

  it("uses a longer code fence when resolved commands contain triple backticks", async () => {
    const result = await matrixApprovalNativeRuntime.presentation.buildResolvedResult({
      ...baseContext,
      request: {
        id: "req-1",
        request: { command: "echo hi" },
        createdAtMs: 0,
        expiresAtMs: 1_000,
      },
      resolved: { id: "req-1", decision: "allow-once", ts: 0 },
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        decision: "allow-once",
        commandText: "echo ```danger```",
      } as never,
      entry: {} as never,
    });

    expect(result).toEqual({
      kind: "update",
      payload: "Exec approval: Allowed once\n\nCommand\n````\necho ```danger```\n````",
    });
  });
});
