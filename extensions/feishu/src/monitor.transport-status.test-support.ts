import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeishuStatusSink } from "./monitor.js";
import { getGatewayPort } from "./monitor.webhook.test-helpers.js";
import type { ResolvedFeishuAccount } from "./types.js";

type StatusPatch = Parameters<FeishuStatusSink>[0];

function createRecordingSink(): { sink: FeishuStatusSink; calls: StatusPatch[] } {
  const calls: StatusPatch[] = [];
  return {
    sink: (patch) => {
      calls.push(patch);
    },
    calls,
  };
}

async function loadTransportModule() {
  return await import("./monitor.transport.js");
}

function account(
  accountId: string,
  config: ResolvedFeishuAccount["config"] = { connectionMode: "websocket" },
): ResolvedFeishuAccount {
  return {
    accountId,
    selectionSource: "explicit",
    enabled: true,
    configured: true,
    appId: "app",
    appSecret: "secret",
    domain: "https://open.feishu.cn",
    encryptKey: undefined,
    verificationToken: undefined,
    config,
  };
}

async function startWebSocket(accountId: string) {
  const recorder = createRecordingSink();
  const abort = new AbortController();
  const { monitorWebSocket } = await loadTransportModule();
  const monitor = monitorWebSocket({
    account: account(accountId),
    accountId,
    abortSignal: abort.signal,
    eventDispatcher: { register: () => undefined } as never,
    statusSink: recorder.sink,
  });
  return { ...recorder, abort, monitor };
}

function expectPatch(actual: StatusPatch | undefined, expected: StatusPatch) {
  expect(actual).toMatchObject(expected);
  expect(actual?.lastTransportActivityAt).toBeUndefined();
}

let nowValue: number;
function installClock(initialNow: number) {
  beforeEach(() => {
    nowValue = initialNow;
    vi.spyOn(Date, "now").mockImplementation(() => nowValue);
  });
  afterEach(() => vi.restoreAllMocks());
}

describe("monitorWebSocket status publishing", () => {
  installClock(1_700_000_000_000);
  it("publishes connected state when the WS SDK reports ready or reconnected", async () => {
    const fakeWsClient = {
      start: vi.fn(async () => undefined),
      close: vi.fn(),
    };
    const wsClientModule = await import("./client.js");
    let callbacks:
      | {
          onReady?: () => void;
          onReconnected?: () => void;
          onReconnecting?: () => void;
        }
      | undefined;
    vi.spyOn(wsClientModule, "createFeishuWSClient").mockImplementation(
      async (_account, nextCallbacks) => {
        callbacks = nextCallbacks as typeof callbacks;
        return fakeWsClient as never;
      },
    );

    const recorder = await startWebSocket("acct-1");
    await new Promise<void>((resolve) => {
      setImmediate(() => resolve());
    });
    expect(recorder.calls).toEqual([]);

    callbacks?.onReady?.();
    expectPatch(recorder.calls[0], {
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: nowValue,
      lastEventAt: nowValue,
      lastError: null,
    });
    expect(recorder.calls[0]?.terminalDisconnect).toBeUndefined();

    nowValue += 1_000;
    callbacks?.onReconnected?.();
    expectPatch(recorder.calls[1], {
      connected: true,
      lifecycle: "ready",
      lastConnectedAt: nowValue,
      lastEventAt: nowValue,
      lastError: null,
    });

    nowValue += 1_000;
    callbacks?.onReconnecting?.();
    expectPatch(recorder.calls[2], {
      connected: false,
      lifecycle: "recovering",
      lastEventAt: nowValue,
    });
    recorder.abort.abort();
    await recorder.monitor;
  });

  it("publishes disconnected when WS handshake throws", async () => {
    const wsClientModule = await import("./client.js");
    vi.spyOn(wsClientModule, "createFeishuWSClient").mockRejectedValue(new Error("boom"));

    const recorder = await startWebSocket("acct-2");
    setImmediate(() => recorder.abort.abort());
    await recorder.monitor;

    const disconnected = recorder.calls.find((c) => c.connected === false);
    expect(disconnected).toBeDefined();
    expectPatch(disconnected, { lifecycle: "recovering", lastEventAt: nowValue });
  });

  it("publishes blocked for the SDK terminal WebSocket error", async () => {
    let onError: ((error: Error) => void) | undefined;
    const wsClientModule = await import("./client.js");
    vi.spyOn(wsClientModule, "createFeishuWSClient").mockImplementation(
      async (_account, callbacks) => {
        onError = callbacks?.onError;
        return { start: vi.fn(async () => undefined), close: vi.fn() } as never;
      },
    );

    const recorder = await startWebSocket("acct-terminal");

    await vi.waitFor(() => expect(onError).toBeTypeOf("function"));
    onError?.(new Error("WebSocket reconnect exhausted after 3 attempts"));
    await vi.waitFor(() =>
      expect(recorder.calls).toContainEqual(
        expect.objectContaining({
          connected: false,
          lifecycle: "blocked",
          terminalDisconnect: true,
        }),
      ),
    );
    recorder.abort.abort();
    await recorder.monitor;
  });
});

describe("monitorWebhook status publishing", () => {
  installClock(1_700_000_001_000);

  it("publishes connected after Gateway route registration", async () => {
    await getGatewayPort();
    const recorder = createRecordingSink();
    const { monitorWebhook } = await loadTransportModule();

    const abortController = new AbortController();

    const monitorPromise = monitorWebhook({
      account: {
        ...account("webhook-acct", { connectionMode: "webhook", webhookPath: "/feishu/events" }),
        encryptKey: "ek",
        verificationToken: "vt",
      },
      accountId: "webhook-acct",
      abortSignal: abortController.signal,
      eventDispatcher: { register: () => undefined, invoke: vi.fn() } as never,
      statusSink: recorder.sink,
    });

    const connected = recorder.calls.find((c) => c.connected === true);
    expect(connected).toBeDefined();
    expectPatch(connected, {
      lifecycle: "ready",
      lastConnectedAt: nowValue,
      lastEventAt: nowValue,
    });

    abortController.abort();
    await monitorPromise;
  });
});
