import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ScopeUpgradeResult } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayOperatorRoleDefinition } from "../../config/types.gateway.js";

const { getPairedDeviceMock, requestDevicePairingMock, resolveOperatorRolePolicyMock } = vi.hoisted(
  () => ({
    getPairedDeviceMock: vi.fn(),
    requestDevicePairingMock: vi.fn(),
    resolveOperatorRolePolicyMock: vi.fn(),
  }),
);

vi.mock("../../infra/device-pairing.js", () => ({
  getPairedDevice: getPairedDeviceMock,
  requestDevicePairing: requestDevicePairingMock,
}));

vi.mock("../operator-role-policy.js", () => ({
  resolveOperatorRolePolicy: resolveOperatorRolePolicyMock,
}));

import { scopeUpgradeHandlers } from "./device-scope-upgrade.js";

const FULL_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.questions",
  "operator.pairing",
];

const ROLE_SCOPE_CASES: [string, string[] | undefined, string[], boolean][] = [
  ["admin implies full Control UI scopes", ["operator.admin"], FULL_SCOPES, true],
  ["write implies read and talk", ["operator.write"], ["operator.read", "operator.talk"], true],
  ["no operator role policy", undefined, FULL_SCOPES, true],
  ["guest cannot request admin", ["operator.read", "operator.write"], FULL_SCOPES, false],
  ["empty ceiling denies read", [], ["operator.read"], false],
];

const createUpgradeContext = () => ({
  getRuntimeConfig: () => ({}),
  logGateway: { warn: vi.fn() },
  scopeUpgradeCoordinator: { register: vi.fn(() => true), notify: vi.fn(), wait: vi.fn() },
});

const owner = { deviceId: "device-1", publicKey: "public-key-1" };
const upgradeRequest = { requestId: "request-1" };
const rolePolicy = (scopes: string[] | undefined) =>
  scopes
    ? ({
        sessions: { others: "view" },
        agents: "*",
        scopes,
      } satisfies GatewayOperatorRoleDefinition)
    : undefined;
const denial = (message: string) =>
  expect.objectContaining({ code: "INVALID_REQUEST", message: expect.stringContaining(message) });

async function runUpgradeHandler(
  method: "requestUpgrade" | "waitUpgrade",
  params: Record<string, unknown>,
  context = createUpgradeContext(),
) {
  const respond = vi.fn();
  await expectDefined(
    scopeUpgradeHandlers[`device.scopes.${method}`],
    `${method} handler`,
  )({
    params,
    respond,
    context,
    client: {
      connId: "connection-1",
      connect: {
        role: "operator",
        scopes: ["operator.read"],
        device: { id: owner.deviceId, publicKey: owner.publicKey },
        client: { id: "control-ui", platform: "test", mode: "webchat" },
      },
    },
  } as never);
  return { respond, context };
}

describe("device scope upgrade role ceiling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPairedDeviceMock.mockResolvedValue({
      ...owner,
      approvedAtMs: 1,
      tokens: { operator: { token: "old-token", scopes: ["operator.read"] } },
    });
    requestDevicePairingMock.mockResolvedValue({
      request: upgradeRequest,
      expiresAtMs: Date.now() + 60_000,
      created: false,
    });
    resolveOperatorRolePolicyMock.mockReturnValue(undefined);
  });

  describe.each(ROLE_SCOPE_CASES)("%s", (_name, allowedScopes, scopes, allowed) => {
    const policy = rolePolicy(allowedScopes);
    const roleDenial = denial("assigned operator role");

    it("enforces the ceiling when requesting approval", async () => {
      resolveOperatorRolePolicyMock.mockReturnValue(policy);
      const { respond, context } = await runUpgradeHandler("requestUpgrade", { scopes });

      expect(respond).toHaveBeenCalledOnce();
      if (!allowed) {
        expect(respond).toHaveBeenCalledWith(false, undefined, roleDenial);
        expect(requestDevicePairingMock).not.toHaveBeenCalled();
        expect(context.scopeUpgradeCoordinator.register).not.toHaveBeenCalled();
        return;
      }
      expect(respond).toHaveBeenCalledWith(true, upgradeRequest, undefined);
      expect(requestDevicePairingMock).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: scopes.toSorted(), silent: false }),
      );
      expect(context.scopeUpgradeCoordinator.register).toHaveBeenCalledWith(
        expect.objectContaining({
          ...upgradeRequest,
          owner,
          requestedScopes: scopes.toSorted(),
          initialToken: "old-token",
          initialApprovedAtMs: 1,
        }),
      );
    });

    it("uses the current role after waiting before disclosing the approved token", async () => {
      const context = createUpgradeContext();
      const approval = createDeferred<ScopeUpgradeResult>();
      context.scopeUpgradeCoordinator.wait.mockReturnValue(approval.promise);
      resolveOperatorRolePolicyMock.mockReturnValue(rolePolicy(allowed ? [] : ["operator.admin"]));
      const pending = runUpgradeHandler("waitUpgrade", upgradeRequest, context);
      expect(context.scopeUpgradeCoordinator.wait).toHaveBeenCalledWith("request-1", owner);
      resolveOperatorRolePolicyMock.mockReturnValue(policy);
      const result: ScopeUpgradeResult = {
        status: "approved",
        ...upgradeRequest,
        deviceToken: "upgraded-token",
        scopes,
      };
      approval.resolve(result);
      const { respond } = await pending;

      expect(respond).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledWith(
        allowed,
        allowed ? result : undefined,
        allowed ? undefined : roleDenial,
      );
    });
  });

  it("returns an unchanged rejected result", async () => {
    resolveOperatorRolePolicyMock.mockReturnValue(rolePolicy([]));
    const context = createUpgradeContext();
    const result: ScopeUpgradeResult = { status: "rejected", ...upgradeRequest };
    context.scopeUpgradeCoordinator.wait.mockResolvedValue(result);

    const { respond } = await runUpgradeHandler("waitUpgrade", upgradeRequest, context);

    expect(respond).toHaveBeenCalledWith(true, result, undefined);
  });

  it.each([
    { scopes: ["operator.read", "operator.unknown"], message: "unknown operator scope" },
    { scopes: ["operator.approvals"], message: "current scopes" },
  ])("rejects $message even with an admin ceiling", async ({ scopes, message }) => {
    resolveOperatorRolePolicyMock.mockReturnValue(rolePolicy(FULL_SCOPES));
    const { respond } = await runUpgradeHandler("requestUpgrade", { scopes });
    expect(respond).toHaveBeenCalledWith(false, undefined, denial(message));
    expect(requestDevicePairingMock).not.toHaveBeenCalled();
  });
});
