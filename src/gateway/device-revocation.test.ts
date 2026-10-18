import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  acceptGatewayDeviceSourceAuthority as acceptSource,
  bindGatewayDeviceRevocation as bindGuard,
  captureGatewayDeviceRevocation as capture,
  closeGatewayDeviceRevocation as closeGateway,
  hasPreparedGatewayDeviceAuthority as hasAuthority,
  invalidateGatewayDeviceRevocation as invalidate,
  onGatewayDeviceSourceRevoked as onRevoked,
  retainGatewayDeviceRevocation as retain,
  readGatewayDeviceSourceAuthority as readSource,
  readAcceptedGatewayDeviceSourceAuthority as readAccepted,
} from "./device-revocation.js";

const device = { deviceId: "device", role: "operator" };
const live = () => true;
const makeSource = (isCurrent = live, release = () => {}) => ({
  isCurrent,
  subscribe: () => release,
});
const hold = (guard: Parameters<typeof retain>[0]) => expectDefined(retain(guard), "hold");

describe("Gateway device revocation", () => {
  it("keeps accepted source custody through fencing, but only while a holder retains it", () => {
    const connection = new AbortController();
    let transportCurrent = true;
    let sourceCurrent = true;
    const releaseSource = vi.fn();
    const request = capture(
      {},
      {},
      () => transportCurrent,
      connection.signal,
      makeSource(() => sourceCurrent, releaseSource),
    );
    transportCurrent = false;
    expect(request.isCurrent()).toBe(false);
    const client = { invalidated: true };
    expect(hasAuthority(client, request.isCurrent)).toBe(false);
    expect(acceptSource(request.isCurrent)).toBe(true);
    expect(hasAuthority(client, request.isCurrent)).toBe(true);
    const accepted = expectDefined(readAccepted(request.isCurrent), "accepted source");
    const releaseInput = hold(request.isCurrent);
    request.release();
    expect(request.isCurrent()).toBe(true);
    expect(accepted()).toBe(true);
    sourceCurrent = false;
    expect(request.isCurrent()).toBe(false);
    expect(hasAuthority(client, request.isCurrent)).toBe(false);
    expect(accepted()).toBe(false);
    sourceCurrent = true;
    releaseInput();
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(connection.signal.aborted).toBe(false);
    expect(request.isCurrent()).toBe(false);
    expect(accepted()).toBe(false);
    expect(acceptSource(request.isCurrent)).toBe(false);
    expect(hasAuthority(client, request.isCurrent)).toBe(false);
    expect(() => retain(request.isCurrent)).toThrow("no longer active");
  });

  it("requires an active source owner to accept custody", () => {
    const context = {};
    let current = true;
    const request = capture(context, {}, () => current);
    expect(acceptSource(request.isCurrent)).toBe(false);
    expect(readAccepted(request.isCurrent)).toBeUndefined();
    expect(request.isCurrent()).toBe(true);
    current = false;
    expect(request.isCurrent()).toBe(false);
    expect(() => retain(request.isCurrent)).toThrow("no longer active");
    expect(retain(undefined)).toBeUndefined();
    expect(retain(() => true)).toBeUndefined();
    const revoked = capture(context, { deviceId: "device" }, () => true, undefined, makeSource());
    invalidate(context, "device");
    expect(acceptSource(revoked.isCurrent)).toBe(false);
    expect(acceptSource(() => true)).toBe(false);
    request.release();
    revoked.release();
  });

  it("retains one source until its last independent holder releases it", () => {
    const context = {};
    const releaseSource = vi.fn();
    const request = capture(context, device, live, undefined, makeSource(live, releaseSource));
    const revoked = vi.fn();
    const unsubscribe = onRevoked(request.isCurrent, revoked);
    const releaseRun = hold(request.isCurrent);
    const releaseQueuedTurn = hold(request.isCurrent);
    request.release();
    expect(request.isCurrent()).toBe(true);
    releaseRun();
    expect(releaseSource).not.toHaveBeenCalled();
    expect(revoked).not.toHaveBeenCalled();
    invalidate(context, "device", "operator");
    expect(revoked).toHaveBeenCalledOnce();
    expect(request.isCurrent()).toBe(false);
    expect(() => retain(request.isCurrent)).toThrow("no longer active");
    const replacement = capture(context, device, live);
    expect(replacement.isCurrent()).toBe(true);
    releaseQueuedTurn();
    releaseQueuedTurn();
    expect(releaseSource).toHaveBeenCalledOnce();
    expect(request.isCurrent()).toBe(false);
    expect(replacement.isCurrent()).toBe(true);
    replacement.release();
    unsubscribe?.();
  });

  it("preserves exact device and optional role matching", () => {
    const context = {};
    const operator = capture(context, device, () => true);
    const node = capture(context, { deviceId: "device", role: "node" }, () => true);
    const otherDevice = capture(context, { deviceId: "other", role: "operator" }, () => true);
    invalidate(context, "device", "operator");
    expect([operator, node, otherDevice].map((request) => request.isCurrent())).toEqual([
      false,
      true,
      true,
    ]);
    invalidate(context, "device");
    expect([node.isCurrent(), otherDevice.isCurrent()]).toEqual([false, true]);
    operator.release();
    node.release();
    otherDevice.release();
  });

  it.each([false, true])("requires a live owner after release (connection: %s)", (connected) => {
    const connection = new AbortController();
    let clientInvalidated = false;
    const request = capture(
      {},
      device,
      () => !clientInvalidated,
      connected ? connection.signal : undefined,
    );
    const revoked = vi.fn();
    const unsubscribe = onRevoked(request.isCurrent, revoked);
    request.release();
    request.release();
    expect(request.isCurrent()).toBe(connected);
    expect(() => retain(request.isCurrent)).toThrow("no longer active");
    clientInvalidated = true;
    expect(request.isCurrent()).toBe(false);
    clientInvalidated = false;
    connection.abort();
    expect(request.isCurrent()).toBe(false);
    expect(revoked).not.toHaveBeenCalled();
    unsubscribe?.();
  });

  it("transfers the same caller through a queued commit guard", () => {
    const context = {};
    let requestCurrent = true;
    let authenticated = true;
    const request = capture(context, device, () => authenticated);
    const guard = bindGuard(() => {
      if (!requestCurrent || !request.isCurrent()) {
        throw new Error("revoked");
      }
    }, request.isCurrent);
    const releaseQueue = hold(guard);
    const source = expectDefined(readSource(guard), "original auth guard");
    request.release();
    expect(guard).not.toThrow();
    requestCurrent = false;
    expect(guard).toThrow("revoked");
    expect(source()).toBe(true);
    authenticated = false;
    expect(source()).toBe(false);
    authenticated = true;
    invalidate(context, "device", "operator");
    expect(guard).toThrow("revoked");
    expect(source()).toBe(false);
    releaseQueue();
    expect(() => retain(guard)).toThrow("no longer active");
  });

  it("closes only its own Gateway and cannot create a live capture after shutdown", () => {
    const context = {};
    const otherContext = {};
    const request = capture(context, device, live);
    const other = capture(otherContext, device, live);
    const revoked = vi.fn();
    const unsubscribe = onRevoked(request.isCurrent, revoked);
    closeGateway(context);
    closeGateway(context);
    expect(request.isCurrent()).toBe(false);
    expect(other.isCurrent()).toBe(true);
    expect(revoked).not.toHaveBeenCalled();
    const late = capture(context, device, live);
    expect(late.isCurrent()).toBe(false);
    expect(() => retain(late.isCurrent)).toThrow("no longer active");
    request.release();
    late.release();
    other.release();
    unsubscribe?.();
  });
});
