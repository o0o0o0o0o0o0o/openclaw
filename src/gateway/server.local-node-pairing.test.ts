import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { writeConfigFile } from "../config/config.js";
import { getRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import { withDevicePairingLock } from "../infra/device-pairing-lock.js";
import * as nodePairing from "../infra/device-pairing-node.js";
import { listNodePairing, rejectNodePairing } from "../infra/device-pairing-node.js";
import { revokeDeviceToken } from "../infra/device-pairing-tokens.js";
import {
  getPairedDevice,
  listDevicePairing,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { loadDeviceIdentity, openTrackedWs } from "./device-authz.test-helpers.js";
import { connectReq, installGatewayTestHooks, startServer } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const MAC_CLIENT = {
  id: GATEWAY_CLIENT_IDS.MACOS_APP,
  version: "1.0.0",
  platform: "macOS 26.0",
  deviceFamily: "Mac",
  mode: GATEWAY_CLIENT_MODES.UI,
};

// Native macOS advertisement with Computer Control enabled; recording stays policy-blocked.
const MAC_SURFACE = {
  caps: ["canvas", "screen", "computer"],
  commands: [
    "canvas.present",
    "canvas.hide",
    "canvas.navigate",
    "screen.snapshot",
    "screen.record",
    "system.notify",
    "computer.act",
  ],
};
type Identity = ReturnType<typeof loadDeviceIdentity>;
const pairedDevice = (loaded: Identity) => getPairedDevice(loaded.identity.deviceId);
const pendingNodes = async (loaded: Identity) =>
  (await listNodePairing()).pending.filter((entry) => entry.nodeId === loaded.identity.deviceId);
const pendingDevices = async (loaded: Identity) =>
  (await listDevicePairing()).pending.filter(
    (entry) => entry.deviceId === loaded.identity.deviceId,
  );
const setLocalApproval = (autoApproveLocal: boolean) =>
  writeConfigFile({ gateway: { nodes: { pairing: { autoApproveLocal } } } });

describe("same-machine native node device pairing", () => {
  let started: Awaited<ReturnType<typeof startServer>>;

  beforeAll(async () => {
    started = await startServer("secret", { bind: "loopback" });
  });
  afterAll(async () => {
    await started.server.close();
    started.envSnapshot.restore();
  });

  async function connect(
    identityPath: string,
    role: "operator" | "node",
    headers?: Record<string, string>,
    client: ConnectParams["client"] = MAC_CLIENT,
    surface?: Pick<ConnectParams, "caps" | "commands" | "permissions">,
  ) {
    const ws = await openTrackedWs(started.port, headers);
    try {
      return await connectReq(ws, {
        token: "secret",
        role,
        scopes: role === "operator" ? ["operator.read"] : [],
        client: {
          ...client,
          mode: role === "node" ? GATEWAY_CLIENT_MODES.NODE : client.mode,
        },
        deviceIdentityPath: identityPath,
        prePairDevice: false,
        ...surface,
      });
    } finally {
      ws.close();
    }
  }

  async function connectSurface(
    loaded: Identity,
    headers?: Record<string, string>,
    client: ConnectParams["client"] = MAC_CLIENT,
    surface = MAC_SURFACE,
  ) {
    expect(await connect(loaded.identityPath, "node", headers, client, surface)).toMatchObject({
      ok: true,
    });
  }

  test.each([
    { name: "direct loopback", headers: undefined },
    { name: "shared-secret loopback with a LAN Host", headers: { host: "192.168.1.10" } },
  ])(
    "silently approves the native node capability surface over $name",
    async ({ name, headers }) => {
      await writeConfigFile({
        gateway: { nodes: { pairing: { autoApproveCidrs: ["127.0.0.1/32"] } } },
      });
      const loaded = loadDeviceIdentity(`local-native-capability-surface-${name}`);
      expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
      const before = await pairedDevice(loaded);
      expect(before?.roles).toEqual(["operator"]);
      await connectSurface(loaded, headers);
      expect(await pendingNodes(loaded)).toEqual([]);
      const paired = await pairedDevice(loaded);
      expect(paired?.roles).toEqual(expect.arrayContaining(["operator", "node"]));
      expect(paired?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
      expect(paired?.approvedScopes).toEqual(before?.approvedScopes);
      expect(paired?.nodeSurface?.commands).toEqual(
        expect.arrayContaining(["screen.snapshot", "computer.act"]),
      );
      expect(paired?.nodeSurface?.commands).not.toContain("screen.record");
    },
  );

  async function seedSilentNode(name: string) {
    const loaded = loadDeviceIdentity(name);
    const pairing = await requestDevicePairing({
      deviceId: loaded.identity.deviceId,
      publicKey: loaded.publicKey,
      role: "node",
      scopes: [],
    });
    await approveDevicePairing(pairing.request.requestId, {
      callerScopes: [],
      approvedVia: "silent",
    });
    return loaded;
  }

  test("keeps the initial surface pending when local approval is disabled while queued", async () => {
    const loaded = loadDeviceIdentity("local-native-queued-opt-out");
    const locked = createDeferred();
    const release = createDeferred();
    const queued = createDeferred();
    const approve = nodePairing.approveNodePairing;
    let lockWork: Promise<void> | undefined;
    let approvalWork: ReturnType<typeof approve> | undefined;
    const approval = vi
      .spyOn(nodePairing, "approveNodePairing")
      .mockImplementation(async (...args) => {
        lockWork = withDevicePairingLock(async () => {
          locked.resolve();
          await release.promise;
        });
        await locked.promise;
        approvalWork = approve(...args);
        queued.resolve();
        return await approvalWork;
      });
    const connecting = connect(loaded.identityPath, "node", undefined, MAC_CLIENT, MAC_SURFACE);
    try {
      await awaitGateBeforeSettlement(
        queued.promise,
        connecting,
        "expected queued surface approval",
      );
      const current = getRuntimeConfigSnapshot();
      if (!current) {
        throw new Error("expected active Gateway config");
      }
      setRuntimeConfigSnapshot({
        ...current,
        gateway: {
          ...current.gateway,
          nodes: { ...current.gateway?.nodes, pairing: { autoApproveLocal: false } },
        },
      });
      release.resolve();
      expect(await connecting).toMatchObject({ ok: true });
      expect(approval).toHaveBeenCalledOnce();
      const paired = await getPairedDevice(loaded.identity.deviceId);
      expect(paired?.nodeSurface).toBeUndefined();
      expect(paired?.pendingNodeSurface?.commands).toContain("computer.act");
    } finally {
      release.resolve();
      await Promise.allSettled([connecting, lockWork, approvalWork]);
      approval.mockRestore();
    }
  });

  test("honors the local opt-out and approves a rejected initial surface when re-enabled", async () => {
    const loaded = await seedSilentNode("local-native-rejected-surface");
    await setLocalApproval(false);
    await connectSurface(loaded);
    const [request] = await pendingNodes(loaded);
    expect(request).toBeDefined();
    expect((await pairedDevice(loaded))?.nodeSurface).toBeUndefined();
    expect(await rejectNodePairing(request!.requestId)).toMatchObject({
      nodeId: loaded.identity.deviceId,
    });
    await setLocalApproval(true);
    await connectSurface(loaded);
    expect((await pairedDevice(loaded))?.nodeSurface?.commands).toContain("computer.act");
    expect(await pendingNodes(loaded)).toHaveLength(0);
  });

  test("keeps later native capability surface upgrades pending", async () => {
    const loaded = loadDeviceIdentity("local-native-surface-upgrade");
    await connectSurface(loaded);
    expect((await pairedDevice(loaded))?.pendingNodeSurface).toBeUndefined();
    await connectSurface(loaded, undefined, MAC_CLIENT, {
      ...MAC_SURFACE,
      commands: [...MAC_SURFACE.commands, "system.which"],
    });
    const paired = await pairedDevice(loaded);
    expect(paired?.nodeSurface?.commands).not.toContain("system.which");
    expect(paired?.pendingNodeSurface).toMatchObject({
      commands: expect.arrayContaining(["system.which"]),
    });
  });

  test("keeps a concurrent initial approval from silently widening the surface", async () => {
    const loaded = loadDeviceIdentity("local-native-concurrent-initial-surface");
    const begin = nodePairing.beginNodePairingConnect;
    const snapshot = vi
      .spyOn(nodePairing, "beginNodePairingConnect")
      .mockImplementationOnce(async (...args) => {
        const initial = await begin(...args);
        const request = await nodePairing.requestNodePairing({
          nodeId: loaded.identity.deviceId,
          caps: ["screen"],
          commands: ["screen.snapshot"],
        });
        await nodePairing.approveNodePairing(request.request.requestId, {
          callerScopes: ["operator.pairing", "operator.write"],
        });
        return initial;
      });
    try {
      await connectSurface(loaded);
      const paired = await pairedDevice(loaded);
      expect(paired?.nodeSurface?.commands).toEqual(["screen.snapshot"]);
      expect(paired?.pendingNodeSurface?.commands).toContain("computer.act");
      expect(paired?.pendingNodeSurface?.silent).toBe(false);
    } finally {
      snapshot.mockRestore();
    }
  });

  test("preserves command denies and their capability filtering during local approval", async () => {
    await writeConfigFile({
      gateway: { nodes: { commands: { deny: ["computer.act", "screen.snapshot"] } } },
    });
    const loaded = loadDeviceIdentity("local-native-policy-denies");
    await connectSurface(loaded);
    const paired = await pairedDevice(loaded);
    expect(paired?.pendingNodeSurface).toBeUndefined();
    expect(paired?.nodeSurface?.commands).toContain("system.notify");
    expect(paired?.nodeSurface?.commands).not.toContain("computer.act");
    expect(paired?.nodeSurface?.commands).not.toContain("screen.snapshot");
    expect(paired?.nodeSurface?.caps).not.toContain("computer");
    expect(paired?.nodeSurface?.caps).not.toContain("screen");
  });

  test.each<{ name: string; headers?: Record<string, string>; client?: ConnectParams["client"] }>([
    { name: "browser origin", headers: { origin: "https://localhost" } },
    { name: "proxy", headers: { "x-forwarded-for": "192.0.2.5" } },
  ])(
    "does not reuse silent provenance for a $name capability request",
    async ({ name, headers, client }) => {
      const loaded = await seedSilentNode(`local-native-surface-boundary-${name}`);
      await writeConfigFile({
        gateway: {
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://localhost"] },
        },
      });
      await connectSurface(loaded, headers, client);
      const paired = await pairedDevice(loaded);
      expect(paired?.nodeSurface).toBeUndefined();
      expect(paired?.pendingNodeSurface).toBeDefined();
    },
  );

  test("keeps an explicitly revoked native node token pending", async () => {
    const loaded = loadDeviceIdentity("local-native-node-repair");
    expect(await connect(loaded.identityPath, "node")).toMatchObject({ ok: true });
    expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
    const before = await pairedDevice(loaded);
    expect(
      await revokeDeviceToken({ deviceId: loaded.identity.deviceId, role: "node" }),
    ).toMatchObject({ ok: true });

    const response = await connect(loaded.identityPath, "node");
    const pending = await pendingDevices(loaded);
    expect(response).toMatchObject({ ok: false, error: { details: { reason: "role-upgrade" } } });
    expect(pending).toMatchObject([{ isRepair: true, silent: false }]);
    const after = await pairedDevice(loaded);
    expect(after?.tokens?.node?.revokedAtMs).toBeTypeOf("number");
    expect(after?.tokens?.node?.token === before?.tokens?.node?.token).toBe(true);
    expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
  });

  test("silently resolves an existing role-upgrade repair when local approval is enabled", async () => {
    const loaded = loadDeviceIdentity("local-native-pending-repair");
    expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
    const before = await pairedDevice(loaded);
    await setLocalApproval(false);
    expect(await connect(loaded.identityPath, "node")).toMatchObject({ ok: false });
    const pending = await pendingDevices(loaded);
    expect(pending).toMatchObject([{ role: "node", isRepair: true, silent: false }]);

    await setLocalApproval(true);
    const response = await connect(loaded.identityPath, "node");
    expect(response.ok).toBe(true);
    expect(await pendingDevices(loaded)).toEqual([]);
    const after = await pairedDevice(loaded);
    expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
  });

  test.each<{ name: string; headers?: Record<string, string>; client?: ConnectParams["client"] }>([
    { name: "browser origin", headers: { origin: "https://localhost" } },
    {
      name: "trusted proxy",
      headers: { "x-forwarded-for": "192.0.2.5", "x-forwarded-proto": "https" },
    },
    { name: "Control UI", client: { ...MAC_CLIENT, id: GATEWAY_CLIENT_IDS.CONTROL_UI } },
    { name: "WebChat", client: { ...MAC_CLIENT, id: GATEWAY_CLIENT_IDS.WEBCHAT_UI } },
  ])("keeps $name node role upgrades pending", async ({ name, headers, client }) => {
    const loaded = loadDeviceIdentity(`local-native-boundary-${name}`);
    expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
    await writeConfigFile({
      gateway: {
        trustedProxies: ["127.0.0.1"],
        controlUi: { allowedOrigins: ["https://localhost"] },
        nodes: { pairing: { autoApproveCidrs: ["192.0.2.0/24"] } },
      },
    });
    const response = await connect(loaded.identityPath, "node", headers, client);
    expect(response.ok).toBe(false);
    expect((await pairedDevice(loaded))?.tokens?.node).toBeUndefined();
  });

  test("does not approve a merged operator request during node repair", async () => {
    const loaded = loadDeviceIdentity("local-native-merged-repair");
    expect(await connect(loaded.identityPath, "operator")).toMatchObject({ ok: true });
    const before = await pairedDevice(loaded);
    await requestDevicePairing({
      deviceId: loaded.identity.deviceId,
      publicKey: loaded.publicKey,
      role: "operator",
      scopes: [],
      silent: false,
    });
    const response = await connect(loaded.identityPath, "node");
    expect(response.ok).toBe(false);
    const after = await pairedDevice(loaded);
    expect(after?.tokens?.node).toBeUndefined();
    expect(after?.tokens?.operator?.token === before?.tokens?.operator?.token).toBe(true);
    expect(after?.approvedScopes).toEqual(before?.approvedScopes);
  });
});
