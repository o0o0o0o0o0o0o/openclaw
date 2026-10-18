// Covers gateway-side cleanup when silent pairing supersedes stale sibling records.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { approveDevicePairing } from "../infra/device-pairing-approval.js";
import {
  approveNodePairing,
  listNodePairing,
  requestNodePairing,
} from "../infra/device-pairing-node.js";
import {
  listDevicePairing,
  removePairedDeviceRole,
  requestDevicePairing,
} from "../infra/device-pairing.js";
import { loadApnsRegistration, registerApnsRegistration } from "../infra/push-apns.js";
import { createDeferredCore } from "../shared/deferred.js";
import { closeOpenClawStateDatabaseByPathAsync } from "../state/openclaw-state-db-cache.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { pruneSupersededSilentPairingsAfterApproval } from "./device-pairing-prune.js";
import {
  acceptGatewayDeviceSourceAuthority,
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
  retainGatewayDeviceRevocation,
} from "./device-revocation.js";
import { drainNodePendingWork, enqueueNodePendingWork } from "./node-pending-work.js";
import { enqueuePendingNodeAction, listPendingNodeActions } from "./node-runtime-state.js";
import {
  captureNodeWakeLifecycle,
  runNodeWakeAttempt,
  runNodeWakeNudgeAttempt,
} from "./node-wake-state.js";
import {
  getNodeWakeStateSnapshot,
  resetNodeWakeStateForTest,
} from "./node-wake-state.test-support.js";
import { bindDeviceWorkerReconciliation } from "./worker-environments/device-provider.js";

const pairingStateDirs: string[] = [];
const suiteRootTracker = createSuiteTempRootTracker({ prefix: "openclaw-gateway-pairing-prune-" });

type BroadcastCall = { event: string; payload: Record<string, unknown> };
type PruneContext = Parameters<typeof pruneSupersededSilentPairingsAfterApproval>[0]["context"];

function createPruneContext(params?: {
  connectedDeviceIds?: string[];
  workerEnvironmentIds?: Record<string, readonly string[]>;
}) {
  const broadcasts: BroadcastCall[] = [];
  const invalidated: string[] = [];
  const disconnected: string[] = [];
  const warnings: string[] = [];
  const clearedSurfaces: string[] = [];
  const order: string[] = [];
  const connected = new Set(params?.connectedDeviceIds ?? []);
  const workerEnvironmentService = {} as NonNullable<PruneContext["workerEnvironmentService"]>;
  bindDeviceWorkerReconciliation(workerEnvironmentService, async (deviceId) => {
    order.push(`worker:${deviceId}`);
    return params?.workerEnvironmentIds?.[deviceId] ?? [];
  });
  const workerPlacementDispatchService = {
    reconcileActive: async (environmentId: string) => {
      order.push(`placement:${environmentId}`);
    },
  } as NonNullable<PruneContext["workerPlacementDispatchService"]>;
  const context: PruneContext = {
    broadcast: (event, payload) => {
      broadcasts.push({ event, payload: payload as Record<string, unknown> });
    },
    logGateway: {
      info: vi.fn<(message: string) => void>(),
      warn: (message: string) => warnings.push(message),
    },
    hasConnectedClientsForDevice: (deviceId: string) => connected.has(deviceId),
    invalidateClientsForDevice: (deviceId: string) => {
      invalidated.push(deviceId);
      order.push(`invalidate:${deviceId}`);
    },
    disconnectClientsForDevice: (deviceId: string) => {
      disconnected.push(deviceId);
      order.push(`disconnect:${deviceId}`);
    },
    workerEnvironmentService,
    workerPlacementDispatchService,
    nodeRegistry: {
      updateSurface: (nodeId: string) => {
        clearedSurfaces.push(nodeId);
        return null;
      },
    },
  };
  return {
    broadcasts,
    invalidated,
    disconnected,
    warnings,
    clearedSurfaces,
    order,
    context,
    connectedDeviceIds: [...connected],
  };
}

async function pairSilentDevice(
  baseDir: string,
  deviceId: string,
  roles = ["operator"],
  clientId = "cli",
  clientMode = "cli",
  displayName?: string,
) {
  const request = await requestDevicePairing(
    {
      deviceId,
      publicKey: `pk-${deviceId}`,
      clientId,
      clientMode,
      displayName,
      role: roles[0],
      roles,
      scopes: [],
    },
    baseDir,
  );
  const approved = await approveDevicePairing(
    request.request.requestId,
    { callerScopes: [], approvedVia: "silent" },
    baseDir,
  );
  if (approved?.status !== "approved") {
    throw new Error(`expected approval for ${deviceId}`);
  }
  return approved.device;
}

async function makeStateDir() {
  const baseDir = await suiteRootTracker.make("case");
  pairingStateDirs.push(baseDir);
  return baseDir;
}
const pairNode = (baseDir: string, deviceId: string) =>
  pairSilentDevice(baseDir, deviceId, ["node"], "node-host", "node", "megaclaw");
const registerApns = (baseDir: string, nodeId: string) =>
  registerApnsRegistration({
    nodeId,
    baseDir,
    transport: "direct",
    token: "ABCD1234ABCD1234ABCD1234ABCD1234",
    topic: "ai.openclaw.ios",
    environment: "sandbox",
  });
const prune = (
  harness: ReturnType<typeof createPruneContext>,
  baseDir: string,
  deviceId = "cli-anchor",
) =>
  pruneSupersededSilentPairingsAfterApproval({
    deviceId,
    context: harness.context,
    connectedDeviceIds: harness.connectedDeviceIds,
    baseDir,
    nowMs: Date.now() + 120_000,
  });

describe("pruneSupersededSilentPairingsAfterApproval", () => {
  beforeAll(async () => {
    await suiteRootTracker.setup();
  });

  afterAll(async () => {
    for (const stateDir of pairingStateDirs) {
      await closeOpenClawStateDatabaseByPathAsync(
        resolveOpenClawStateSqlitePath({ ...process.env, OPENCLAW_STATE_DIR: stateDir }),
      );
    }
    await suiteRootTracker.cleanup();
  });

  afterEach(() => {
    resetNodeWakeStateForTest();
  });

  test("revokes the full batch before worker cleanup can wait or fail", async () => {
    const baseDir = await makeStateDir();
    for (const deviceId of ["cli-first", "cli-second", "cli-anchor"]) {
      await pairSilentDevice(baseDir, deviceId);
    }
    const harness = createPruneContext();
    const invalidate = harness.context.invalidateClientsForDevice;
    harness.context.invalidateClientsForDevice = (deviceId, options) => {
      invalidate?.(deviceId, options);
      invalidateGatewayDeviceRevocation(harness.context, deviceId);
    };
    let connected = true;
    const request = captureGatewayDeviceRevocation(
      harness.context,
      { deviceId: "cli-second", role: "operator" },
      () => connected,
      undefined,
      { isCurrent: () => true, subscribe: () => () => {} },
    );
    expect(acceptGatewayDeviceSourceAuthority(request.isCurrent)).toBe(true);
    const releaseRun = retainGatewayDeviceRevocation(request.isCurrent);
    request.release();
    connected = false;
    expect(request.isCurrent()).toBe(true);

    const entered = createDeferredCore();
    const cleanup = createDeferredCore();
    bindDeviceWorkerReconciliation(
      expectDefined(harness.context.workerEnvironmentService, "worker environment service"),
      async () => {
        entered.resolve();
        await cleanup.promise;
        return [];
      },
    );
    const pruning = prune(harness, baseDir, "cli-anchor").catch((error: unknown) => error);
    try {
      try {
        await entered.promise;
        expect(harness.invalidated).toEqual(["cli-first", "cli-second"]);
        expect(request.isCurrent()).toBe(false);
      } finally {
        cleanup.reject(new Error("worker cleanup failed"));
        await pruning;
      }
      await expect(pruning).resolves.toMatchObject({ message: "worker cleanup failed" });
      expect(request.isCurrent()).toBe(false);
    } finally {
      releaseRun?.();
    }
  });

  test("retires stale node siblings across both pairing stores", async () => {
    const baseDir = await makeStateDir();
    await pairNode(baseDir, "node-stale");
    const nodeRequest = await requestNodePairing(
      { nodeId: "node-stale", displayName: "megaclaw" },
      baseDir,
    );
    await approveNodePairing(nodeRequest.request.requestId, { callerScopes: [] }, baseDir);
    const anchor = await pairNode(baseDir, "node-anchor");
    await registerApns(baseDir, "node-stale");
    await runNodeWakeAttempt({
      nodeId: "node-stale",
      force: true,
      throttleMs: 60_000,
      attempt: async (markAttempted) => {
        markAttempted();
        return { available: true, throttled: false, path: "sent", durationMs: 1 };
      },
    });
    await runNodeWakeNudgeAttempt({
      nodeId: "node-stale",
      throttleMs: 60_000,
      throttled: () => ({ sent: false, throttled: true, reason: "throttled", durationMs: 0 }),
      attempt: async () => ({ sent: true, throttled: false, reason: "sent", durationMs: 1 }),
    });
    enqueueNodePendingWork({ nodeId: "node-stale", type: "location.request" });
    enqueuePendingNodeAction({
      nodeId: "node-stale",
      pairingGeneration: "generation-1",
      command: "camera.capture",
      idempotencyKey: "idem-1",
      ttlMs: 60_000,
      maxPerNode: 10,
    });
    const wakeLifecycle = captureNodeWakeLifecycle("node-stale");

    const harness = createPruneContext({
      workerEnvironmentIds: { "node-stale": ["environment-node-stale"] },
    });
    const pruned = await prune(harness, baseDir, anchor.deviceId);

    expect(pruned.map((entry) => entry.deviceId)).toEqual(["node-stale"]);
    const devices = await listDevicePairing(baseDir);
    expect(devices.paired.map((device) => device.deviceId)).toEqual(["node-anchor"]);
    const nodes = await listNodePairing(baseDir);
    expect(nodes.paired).toHaveLength(0);
    expect(getNodeWakeStateSnapshot("node-stale")).toBeUndefined();
    expect(wakeLifecycle.aborted).toBe(true);
    expect(drainNodePendingWork("node-stale", { includeDefaultStatus: false }).items).toEqual([]);
    expect(listPendingNodeActions({ nodeId: "node-stale", ttlMs: 60_000 })).toEqual([]);
    await expect(loadApnsRegistration("node-stale", baseDir)).resolves.toBeNull();
    expect(harness.invalidated).toEqual(["node-stale"]);
    expect(harness.disconnected).toEqual(["node-stale"]);
    expect(harness.order).toEqual([
      "invalidate:node-stale",
      "worker:node-stale",
      "placement:environment-node-stale",
      "disconnect:node-stale",
    ]);
    expect(harness.clearedSurfaces).toEqual(["node-stale"]);
    expect(harness.warnings).toEqual([]);
    expect(harness.broadcasts).toEqual([
      {
        event: "node.pair.resolved",
        payload: expect.objectContaining({ nodeId: "node-stale", decision: "removed" }),
      },
    ]);
  });

  test("keeps connected siblings and clears APNs for operator-only full prunes", async () => {
    const baseDir = await makeStateDir();
    await pairSilentDevice(baseDir, "cli-stale", ["operator", "node"]);
    await registerApns(baseDir, "cli-stale");
    await expect(
      removePairedDeviceRole({ deviceId: "cli-stale", role: "node", baseDir }),
    ).resolves.toEqual({ deviceId: "cli-stale", role: "node", removedDevice: false });
    await expect(loadApnsRegistration("cli-stale", baseDir)).resolves.toMatchObject({
      nodeId: "cli-stale",
    });
    await pairSilentDevice(baseDir, "cli-live");
    const anchor = await pairSilentDevice(baseDir, "cli-anchor");

    const harness = createPruneContext({ connectedDeviceIds: ["cli-live"] });
    const pruned = await prune(harness, baseDir, anchor.deviceId);

    expect(pruned.map((entry) => entry.deviceId)).toEqual(["cli-stale"]);
    const devices = await listDevicePairing(baseDir);
    expect(devices.paired.map((device) => device.deviceId).toSorted()).toEqual([
      "cli-anchor",
      "cli-live",
    ]);
    await expect(loadApnsRegistration("cli-stale", baseDir)).resolves.toBeNull();
    expect(harness.broadcasts).toEqual([]);
    expect(harness.disconnected).toEqual(["cli-stale"]);
  });
});
