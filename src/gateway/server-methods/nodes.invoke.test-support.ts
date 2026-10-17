import { expectDefined } from "@openclaw/normalization-core";
import { expect, it, vi, type Mock } from "vitest";
import type { NodeInvokeParams, NodeInvokeResult } from "../node-invoke.types.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export type RespondCall = Parameters<GatewayRequestHandlerOptions["respond"]>;

type MockCallSource = {
  mock: {
    calls: ArrayLike<ReadonlyArray<unknown>>;
  };
};

export type TestNodeSession = {
  nodeId: string;
  connId?: string;
  pairingGeneration?: string;
  commands: string[];
  declaredCommands?: string[];
  platform?: string;
  client?: { invalidated?: boolean };
};

function mockCall(source: MockCallSource, callIndex = 0): ReadonlyArray<unknown> {
  const call = source.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected mock call ${callIndex}`);
  }
  return call;
}

export function firstRespondCall(source: MockCallSource): RespondCall {
  return mockCall(source) as RespondCall;
}

export function mockArg(source: MockCallSource, callIndex: number, argIndex: number) {
  return mockCall(source, callIndex)[argIndex];
}

export function createNodeInvokeTestHarness({
  getRuntimeConfig,
  nodeHandlers,
}: {
  getRuntimeConfig: () => unknown;
  nodeHandlers: (typeof import("./nodes.js"))["nodeHandlers"];
}) {
  return async (params: {
    nodeRegistry: {
      get: (nodeId: string) => TestNodeSession | undefined;
      getForPairingGeneration?: (
        nodeId: string,
        pairingGeneration: string,
      ) => TestNodeSession | undefined;
      invoke: (payload: NodeInvokeParams) => Promise<NodeInvokeResult>;
    };
    client?: unknown;
    signal?: AbortSignal;
    requestParams?: Partial<Record<string, unknown>>;
    validateAgentRuntimeApprovalAuthority?: () => boolean;
    execApprovalManager?: {
      projectDecisionIfActive: (id: string, decision: string) => string | null;
      retainForHandoff?: (id: string) => (() => void) | null;
    };
  }) => {
    const respond = vi.fn();
    const nodeRegistry = {
      ...params.nodeRegistry,
      getForPairingGeneration:
        params.nodeRegistry.getForPairingGeneration ??
        ((nodeId: string, _pairingGeneration: string) => params.nodeRegistry.get(nodeId)),
    };
    const execApprovalManager = params.execApprovalManager
      ? {
          retainForHandoff: () => () => {},
          ...params.execApprovalManager,
        }
      : undefined;
    await expectDefined(
      nodeHandlers["node.invoke"],
      'nodeHandlers["node.invoke"] test invariant',
    )({
      params: {
        nodeId: "ios-node-1",
        command: "camera.capture",
        params: { quality: "high" },
        timeoutMs: 5000,
        idempotencyKey: "idem-node-invoke",
        ...params.requestParams,
      },
      respond: respond as never,
      context: {
        nodeRegistry,
        execApprovalManager,
        logGateway: { info: vi.fn(), warn: vi.fn() },
        getRuntimeConfig,
        validateAgentRuntimeApprovalAuthority: params.validateAgentRuntimeApprovalAuthority,
      } as never,
      client: (params.client ?? null) as never,
      signal: params.signal,
      req: { type: "req", id: "req-node-invoke", method: "node.invoke" },
      isWebchatConnect: () => false,
    });
    return respond;
  };
}

export function createOperatorClient(params?: {
  scopes?: string[];
  pluginRuntimeOwnerId?: string;
}) {
  return {
    connect: {
      role: "operator" as const,
      scopes: params?.scopes ?? ["operator.write"],
      client: {
        id: "operator-test",
        mode: "backend" as const,
        name: "operator-test",
        platform: "node",
        version: "test",
      },
    },
    internal: params?.pluginRuntimeOwnerId
      ? { pluginRuntimeOwnerId: params.pluginRuntimeOwnerId }
      : {},
  };
}

export function registerNodeInvokeUploadTests({
  mocks,
  invokeNode,
}: {
  mocks: {
    getRuntimeConfig: Pick<Mock<() => unknown>, "mockReturnValue">;
    resolveNodeCommandAllowlist: { mockReturnValue(value: Set<string>): unknown };
    sanitizeNodeInvokeParamsForForwarding: Pick<
      Mock<(params: { rawParams: unknown }) => { ok: boolean; params: unknown }>,
      "mockImplementationOnce"
    >;
  };
  invokeNode: ReturnType<typeof createNodeInvokeTestHarness>;
}): void {
  const setUploads = (enabled: boolean) =>
    mocks.getRuntimeConfig.mockReturnValue({ gateway: { uploads: { enabled } } });
  const upload = (
    nodeRegistry: Parameters<typeof invokeNode>[0]["nodeRegistry"],
    internal = {},
    params: Record<string, unknown> = { name: "proof", contentBase64: "cHJvb2Y=" },
  ) =>
    invokeNode({
      nodeRegistry,
      client: { ...createOperatorClient({ scopes: ["operator.admin"] }), internal },
      requestParams: { nodeId: "upload-node", command: "terminal.upload", params },
    });
  const uploadNode = () => ({
    get: vi.fn(() => ({ nodeId: "upload-node", commands: ["terminal.upload"] })),
    invoke: vi.fn(),
  });
  const expectDisabled = (respond: Mock, error = {}) =>
    expect(firstRespondCall(respond)).toMatchObject([
      false,
      undefined,
      { ...error, details: { code: "UPLOADS_DISABLED" } },
    ]);
  it.each(["before lookup", "during preparation", "internal service"])(
    "enforces terminal upload policy: %s",
    async (stage) => {
      const internal = stage === "internal service";
      setUploads(stage === "during preparation");
      const nodeRegistry =
        stage === "before lookup" ? { get: vi.fn(), invoke: vi.fn() } : uploadNode();
      if (stage !== "before lookup") {
        mocks.resolveNodeCommandAllowlist.mockReturnValue(new Set(["terminal.upload"]));
      }
      if (stage === "during preparation") {
        mocks.sanitizeNodeInvokeParamsForForwarding.mockImplementationOnce(({ rawParams }) => {
          setUploads(false);
          return { ok: true, params: rawParams };
        });
      }
      if (internal) {
        nodeRegistry.invoke.mockResolvedValue({
          ok: true,
          payloadJSON: '{"path":"/uploads/proof"}',
        });
      }
      const bytes =
        stage === "before lookup"
          ? { contentBase64: "", internal: { syntheticClient: true } }
          : undefined;
      const respond = await upload(nodeRegistry, internal ? { syntheticClient: true } : {}, bytes);
      if (internal) {
        expect(firstRespondCall(respond)[0]).toBe(true);
        expect(nodeRegistry.invoke).toHaveBeenCalledOnce();
      } else {
        expectDisabled(respond, stage === "before lookup" ? { code: "FORBIDDEN" } : {});
        expect(nodeRegistry.invoke).not.toHaveBeenCalled();
      }
      if (stage === "before lookup") {
        expect(nodeRegistry.get).not.toHaveBeenCalled();
      }
    },
  );
}
