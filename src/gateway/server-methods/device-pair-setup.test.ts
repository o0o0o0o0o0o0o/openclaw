import { expectDefined } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { registerDevicesCli } from "../../cli/devices-cli.js";
import * as gatewayRpc from "../../cli/gateway-rpc.js";
import * as devicePairingJoinCode from "../../infra/device-pairing-join-code.js";
import { defaultRuntime } from "../../runtime.js";
import { useMockHttp } from "../../test-utils/mock-http.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  resolvePairingSetupFromConfig: vi.fn(),
  encodePairingSetupCode: vi.fn(),
  renderQrPngDataUrl: vi.fn(),
  runCommandWithTimeout: vi.fn(),
  readDevicePairSetupCompletion: vi.fn(),
  readInstallStatus: vi.fn(),
  version: "2026.9.9",
}));

vi.mock("../../pairing/setup-code.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../pairing/setup-code.js")>()),
  resolvePairingSetupFromConfig: mocks.resolvePairingSetupFromConfig,
  encodePairingSetupCode: mocks.encodePairingSetupCode,
}));
vi.mock("../../media/qr-image.js", () => ({ renderQrPngDataUrl: mocks.renderQrPngDataUrl }));
vi.mock("../../process/exec.js", () => ({ runCommandWithTimeout: mocks.runCommandWithTimeout }));
vi.mock("../../infra/device-bootstrap.js", () => ({
  readDevicePairSetupCompletion: mocks.readDevicePairSetupCompletion,
}));
vi.mock("../../infra/update-check-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check-lifecycle.js")>()),
  currentUpdateCheckLifecycle: () => ({ installStatus: mocks.readInstallStatus() }),
}));
vi.mock("../../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../version.js")>()),
  get VERSION() {
    return mocks.version;
  },
}));

const mockHttp = useMockHttp();

import { devicePairSetupHandlers } from "./device-pair-setup.js";

function createOptions(params: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const respond = vi.fn();
  const options = {
    req: { type: "req", id: "req-1", method: "device.pair.setupCode", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond,
    context: {
      getRuntimeConfig: vi.fn(() => config),
      gatewayTlsFingerprint: "sha256:gateway-leaf",
    },
  } as unknown as GatewayRequestHandlerOptions;
  return { options, respond };
}

function setupHandler(method: "setupCode" | "setupStatus") {
  return expectDefined(devicePairSetupHandlers[`device.pair.${method}`], `${method} handler`);
}

async function runSetupCode(params: Record<string, unknown>, config: Record<string, unknown> = {}) {
  const { options, respond } = createOptions(params, config);
  await setupHandler("setupCode")(options);
  return respond;
}

function mockJoinCode() {
  return vi
    .spyOn(devicePairingJoinCode, "registerDevicePairingJoinCode")
    .mockResolvedValue("a".repeat(22));
}

function expectSetupResponse(respond: ReturnType<typeof vi.fn>, payload: unknown) {
  expect(respond).toHaveBeenCalledWith(true, payload, undefined);
}

function expectResolutionOptions(options: Record<string, unknown>) {
  expect(mocks.resolvePairingSetupFromConfig).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining(options),
  );
}

function expectSetupError(respond: ReturnType<typeof vi.fn>, message: string) {
  expect(respond).toHaveBeenCalledWith(
    false,
    undefined,
    expect.objectContaining({ message: expect.stringContaining(message) }),
  );
}

function joinCommands(joinUrl: string, spec = "openclaw") {
  return {
    command: `npx -y ${spec} connect ${joinUrl} --service --session-host`,
    serviceCommand: `npx -y ${spec} connect ${joinUrl} --service`,
    installedCommand: `openclaw connect ${joinUrl} --service --session-host`,
    versionNote: expect.stringContaining("matching Gateway build"),
  };
}

const okResolution = {
  ok: true as const,
  payload: {
    url: "wss://gw.example:8443",
    urls: ["wss://gw.example:8443", "ws://192.168.1.20:18789"],
    bootstrapToken: "boot-123",
  },
  authLabel: "token" as const,
  urlSource: "remote",
  access: "full" as const,
  accessDowngraded: false,
  setupId: "setup-123",
  expiresAtMs: 123_456,
};

describe("device.pair.setupCode", () => {
  beforeEach(() => {
    mocks.runCommandWithTimeout.mockReset();
    mocks.readDevicePairSetupCompletion.mockReset();
    mocks.resolvePairingSetupFromConfig.mockReset().mockResolvedValue(okResolution);
    mocks.encodePairingSetupCode.mockReset().mockReturnValue("SETUP-CODE-XYZ");
    mocks.renderQrPngDataUrl.mockReset().mockResolvedValue("data:image/png;base64,qr");
    mocks.version = "2026.9.9";
    mocks.readInstallStatus.mockReturnValue({
      status: { installKind: "package", packageManager: "npm" },
    });
  });

  afterEach(() => vi.restoreAllMocks());

  it("returns the setup code, QR data URL, and only an auth label", async () => {
    const respond = await runSetupCode({});

    expect(respond).toHaveBeenCalledTimes(1);
    expectSetupResponse(respond, {
      setupId: "setup-123",
      expiresAtMs: 123_456,
      setupCode: "SETUP-CODE-XYZ",
      qrDataUrl: "data:image/png;base64,qr",
      gatewayUrl: "wss://gw.example:8443",
      gatewayUrls: ["wss://gw.example:8443", "ws://192.168.1.20:18789"],
      auth: "token",
      urlSource: "remote",
      access: "full",
    });
    expect(JSON.stringify(respond.mock.calls[0]?.[1])).not.toContain("boot-123");
    expectResolutionOptions({ localTlsFingerprint: "sha256:gateway-leaf" });
  });

  it("reports when plaintext transport limits a requested full-access code", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue({
      ...okResolution,
      access: "limited",
      accessDowngraded: true,
    });
    const respond = await runSetupCode({ includeQr: false });

    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      access: "limited",
      accessDowngraded: true,
    });
  });

  it("labels an explicit request URL separately from configured fallback", async () => {
    const respond = await runSetupCode({ publicUrl: "wss://request.example.com" });

    expectResolutionOptions({ publicUrl: "wss://request.example.com" });
    expect(respond.mock.calls[0]?.[1]?.urlSource).toBe("request.publicUrl");
  });

  it.each([false, true])(
    "pairs the hosted Gateway unless a remote URL is explicitly requested (%s)",
    async (preferRemoteUrl) => {
      await runSetupCode(
        { preferRemoteUrl, includeQr: false },
        { gateway: { mode: "remote", remote: { url: "wss://primary.example" } } },
      );
      expectResolutionOptions({ useLocalGateway: !preferRemoteUrl, preferRemoteUrl });
    },
  );

  it.each([
    { bootstrapProfile: "node", scopes: [] },
    {
      bootstrapProfile: "limited",
      scopes: [
        "operator.approvals",
        "operator.questions",
        "operator.read",
        "operator.talk.secrets",
        "operator.write",
      ],
    },
    {
      bootstrapProfile: "voice-node",
      scopes: ["operator.read", "operator.talk"],
    },
  ])("requests the exact $bootstrapProfile setup grant", async ({ bootstrapProfile, scopes }) => {
    const respond = await runSetupCode({ includeQr: false, bootstrapProfile });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expectResolutionOptions({
      bootstrapProfile: {
        roles: bootstrapProfile === "node" ? ["node"] : ["node", "operator"],
        scopes,
        ...(bootstrapProfile === "voice-node" ? { purpose: "voice-node" } : {}),
      },
    });
  });

  it("mints from a secure fallback and preserves its public context path", async () => {
    const payload = {
      ...okResolution.payload,
      url: "ws://192.168.1.20:18789/openclaw-gw",
      urls: ["ws://192.168.1.20:18789/openclaw-gw", "wss://gateway.tailnet.example/public-gateway"],
      expiresAtMs: 123_456,
    };
    mocks.resolvePairingSetupFromConfig.mockResolvedValue({
      ...okResolution,
      payload,
    });
    // Keep storage substitution test-local: this shard shares a non-isolated worker
    // with the real mint/redeem test, where a leaked module mock creates unbacked codes.
    const registerDevicePairingJoinCode = mockJoinCode();

    const respond = await runSetupCode({ includeQr: false, joinUrl: true });

    expectResolutionOptions({ bootstrapProfile: { roles: ["node"], scopes: [] } });
    expect(registerDevicePairingJoinCode).toHaveBeenCalledWith({
      payload,
      expiresAtMs: okResolution.expiresAtMs,
      context: expect.objectContaining({ admission: expect.any(Object) }),
      assertCurrent: expect.any(Function),
    });
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      joinUrl: `https://gateway.tailnet.example/public-gateway/j/${"a".repeat(22)}`,
    });
  });

  it("retains the original requester authority while resolving a join setup", async () => {
    const entered = createDeferred();
    const release = createDeferred();
    let current = true;
    const { options, respond } = createOptions({ includeQr: false, joinUrl: true });
    options.hasCurrentClientAuthority = () => current;
    mocks.resolvePairingSetupFromConfig.mockImplementationOnce(async () => {
      entered.resolve();
      await release.promise;
      return okResolution;
    });
    const register = mockJoinCode();
    const pending = Promise.resolve(setupHandler("setupCode")(options));
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "setup resolution was not reached");
      current = false;
      options.hasCurrentClientAuthority = () => true;
    } finally {
      release.resolve();
      await pending;
    }

    expect(register).not.toHaveBeenCalled();
    expectSetupError(respond, "requester authority changed");
  });

  it.each([
    ["https://pair.example", "/gateway"],
    ["https://pair.example/extra", "/extra"],
  ])("preserves the Control UI path for configured join URL %s", async (publicUrl, basePath) => {
    const pairing = await vi.importActual<typeof import("../../pairing/setup-code.js")>(
      "../../pairing/setup-code.js",
    );
    mocks.resolvePairingSetupFromConfig.mockImplementation((cfg, options) =>
      pairing.resolvePairingSetupFromConfig(cfg, {
        ...options,
        issuedBootstrap: { token: "boot-123", setupId: "setup-123", expiresAtMs: 123_456 },
      }),
    );
    mocks.encodePairingSetupCode.mockImplementation(pairing.encodePairingSetupCode);
    mockJoinCode();
    vi.spyOn(gatewayRpc, "callGatewayFromCliWithTransport").mockImplementation(
      async (method, _opts, params) => {
        expect(method).toBe("device.pair.setupCode");
        if (!isRecord(params)) {
          throw new Error("Expected pairing RPC parameters");
        }
        const respond = await runSetupCode(params, {
          gateway: {
            bind: "loopback",
            controlUi: { basePath: "/gateway" },
            auth: { mode: "token", token: "gateway-token" },
          },
          plugins: {
            entries: { "device-pair": { config: { publicUrl } } },
          },
        });
        expect(respond.mock.calls[0]?.[0]).toBe(true);
        return respond.mock.calls[0]?.[1];
      },
    );
    const writeJson = vi.spyOn(defaultRuntime, "writeJson").mockImplementation(() => {});
    const program = new Command().exitOverride();
    registerDevicesCli(program);

    await program.parseAsync(["devices", "join-code", "--json"], { from: "user" });

    const joinUrl = `https://pair.example${basePath}/j/${"a".repeat(22)}`;
    expect(writeJson).toHaveBeenCalledWith({
      joinUrl,
      ...joinCommands(joinUrl),
    });
  });

  it.each([
    ["published release", "package", "2026.9.9", true, false, "openclaw@2026.9.9"],
    ["unpublished beta", "package", "2026.9.9-beta.1", false, true, "openclaw@beta"],
    ["unpublished release", "package", "2026.9.9", false, true, "openclaw@latest"],
    ["source checkout", "git", "2026.9.9", false, true, "openclaw@dev"],
    ["offline registry", "package", "2026.9.9", false, false, "openclaw"],
  ] as const)(
    "mints Gateway-owned join commands for %s",
    async (_name, kind, version, exact, tag, spec) => {
      mocks.version = version;
      mocks.readInstallStatus.mockReturnValue({ status: { installKind: kind } });
      mocks.encodePairingSetupCode.mockReturnValue("SETUP");
      mockJoinCode();
      if (kind === "package") {
        mockHttp.intercept({
          url: `https://registry.npmjs.org/openclaw/${version}`,
          reply: exact ? { json: { version } } : { status: 404, json: {} },
        });
      }
      if (!exact) {
        mockHttp.intercept({
          url: `https://registry.npmjs.org/openclaw/${kind === "git" ? "dev" : version.includes("beta") ? "beta" : "latest"}`,
          reply: tag ? { json: { version: "2026.9.9" } } : { status: 404, json: {} },
        });
      }
      const respond = await runSetupCode({ joinUrl: true, includeQr: false });
      const joinUrl = `https://gw.example:8443/j/${"a".repeat(22)}`;
      const { versionNote, ...commands } = joinCommands(joinUrl, spec);
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        ...commands,
        ...(exact ? {} : { versionNote }),
      });
      if (exact) {
        expect(respond.mock.calls[0]?.[1]).not.toHaveProperty("versionNote");
      }
    },
  );

  it.each([{ joinUrl: true, bootstrapProfile: "voice-node" }, { bogus: true }])(
    "rejects invalid setup params %j before touching pairing helpers",
    async (params) => {
      const respond = await runSetupCode(params);
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(mocks.resolvePairingSetupFromConfig).not.toHaveBeenCalled();
    },
  );

  it.each(["oversized", "failed"])("keeps the setup code when QR rendering is %s", async (mode) => {
    if (mode === "failed") {
      mocks.renderQrPngDataUrl.mockRejectedValue(new Error("qr boom"));
    } else {
      mocks.renderQrPngDataUrl.mockResolvedValue(`data:image/png;base64,${"a".repeat(20_000)}`);
    }
    const respond = await runSetupCode({});
    expectSetupResponse(respond, expect.objectContaining({ setupCode: "SETUP-CODE-XYZ" }));
    expect(respond.mock.calls[0]?.[1].qrDataUrl).toBeUndefined();
  });

  it("responds with an invalid-request error when setup cannot be resolved", async () => {
    mocks.resolvePairingSetupFromConfig.mockResolvedValue({
      ok: false,
      error: "Gateway auth is not configured (no token or password).",
    });

    const respond = await runSetupCode({});

    expectSetupError(respond, "Gateway auth is not configured");
    expect(mocks.encodePairingSetupCode).not.toHaveBeenCalled();
  });
});

describe("device.pair.setupStatus", () => {
  async function runSetupStatus(params: Record<string, unknown>) {
    const { options, respond } = createOptions(params);
    await setupHandler("setupStatus")(options);
    return expectDefined(respond.mock.calls[0], "respond.mock.calls[0] test invariant");
  }

  beforeEach(() => mocks.readDevicePairSetupCompletion.mockReset());

  it.each([
    ["setup-123", "confirmed", "full", "Pixel 9", "completion"],
    ["setup-uncertain", "uncertain", "limited", undefined, "deliveryUncertain"],
  ] as const)(
    "returns the recorded %s delivery outcome without retention bookkeeping",
    async (setupId, deliveryState, access, deviceName, field) => {
      const identity = {
        setupId,
        deviceId: "device-123",
        access,
        ...(deviceName ? { deviceName } : {}),
      };
      mocks.readDevicePairSetupCompletion.mockResolvedValue({
        ...identity,
        deliveryState,
        completedAtMs: 1_800_000_000_000,
        retainUntilMs: 1_800_000_600_000,
      });
      const response = await runSetupStatus({ setupId });
      expect(mocks.readDevicePairSetupCompletion).toHaveBeenCalledWith({ setupId });
      expect(response).toEqual([
        true,
        { [field]: { ...identity, ts: 1_800_000_000_000 } },
        undefined,
      ]);
    },
  );

  it("returns an empty result when no completion is recorded", async () => {
    mocks.readDevicePairSetupCompletion.mockResolvedValue(null);

    expect(await runSetupStatus({ setupId: "setup-unknown" })).toEqual([true, {}, undefined]);
  });

  it("rejects unknown params before reading pairing state", async () => {
    const [ok] = await runSetupStatus({ setupId: "setup-123", bogus: true });

    expect(ok).toBe(false);
    expect(mocks.readDevicePairSetupCompletion).not.toHaveBeenCalled();
  });

  it("reports an unavailable error when the completion store throws", async () => {
    mocks.readDevicePairSetupCompletion.mockRejectedValue(new Error("state db locked"));

    expect(await runSetupStatus({ setupId: "setup-123" })).toEqual([
      false,
      undefined,
      expect.objectContaining({ message: expect.stringContaining("state db locked") }),
    ]);
  });
});
