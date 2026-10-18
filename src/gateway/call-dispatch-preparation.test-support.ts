import { expect, it, vi } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../packages/gateway-protocol/src/server-capabilities.js";
import { createDeferred } from "../../test/helpers/promise.js";
import type { callGateway } from "./call.js";
import type { GatewayClientRequestOptions } from "./client.js";

export function registerGatewayCallDispatchPreparationTests(
  setup: () => {
    call: typeof callGateway;
    request: () => { method?: string } | null;
    setRequest: (
      request: (
        method: string,
        params: unknown,
        opts?: GatewayClientRequestOptions,
      ) => Promise<unknown>,
    ) => void;
    setStop: (stop: () => Promise<void>) => void;
    setFeatures: (methods: string[], capabilities: string[]) => void;
    hello: () => void;
    close: (code: number, reason: string) => void;
  },
): void {
  function preparing(options: Partial<Parameters<typeof callGateway>[0]>) {
    const harness = setup();
    const entered = createDeferred();
    const prepared = createDeferred();
    const call = harness.call({
      method: "agent",
      onHelloOk: () => entered.resolve(),
      prepareDispatchCurrent: () => prepared.promise,
      ...options,
    });
    return { ...harness, entered, prepared, call };
  }

  it.each([
    ["secrets.resolve", "method", "secrets.resolve", undefined],
    ["gateway.restart.request", "capability", "gateway-restart-target-safe-v1", undefined],
    ["agent", "capability", GATEWAY_SERVER_CAPS.AGENT_SESSION_ID_CREATE, undefined],
    [
      "models.authSetApiKey",
      "capability",
      GATEWAY_SERVER_CAPS.MODELS_AUTH_SET_API_KEY_OWNER,
      { provider: "fixture", apiKey: "synthetic-api-key", expectedOwnerId: "owner" },
    ],
    [
      "models.authLogin",
      "capability",
      GATEWAY_SERVER_CAPS.MODELS_AUTH_LOGIN_OWNER,
      { authChoice: "fixture/device", sessionId: "login", expectedOwnerId: "owner" },
    ],
  ] as const)("requires %s support before dispatch", async (method, kind, feature, params) => {
    const harness = setup();
    harness.setFeatures(
      params ? [method] : ["health"],
      params ? [GATEWAY_SERVER_CAPS.LOCAL_STATE_OWNER_ROUTING] : [],
    );
    const error = new RegExp(
      `does not support required ${kind} "${feature.replaceAll(".", "\\.")}".*update or restart the active gateway`,
      "i",
    );
    await expect(
      harness.call({
        method,
        params,
        requiredMethods: kind === "method" || params ? [method] : undefined,
        requiredCapabilities: kind === "capability" ? [feature] : undefined,
      }),
    ).rejects.toThrow(error);
    expect(harness.request()).toBeNull();
  });

  it("keeps the authenticated connection open for wizard follow-up requests", async () => {
    const harness = setup();
    const stop = vi.fn(async () => {});
    const methods: string[] = [];
    harness.setStop(stop);
    harness.setRequest(async (method) => {
      methods.push(method);
      return { ok: true };
    });
    await harness.call({
      method: "models.authLogin",
      onResponse: async (request) => {
        expect(stop).not.toHaveBeenCalled();
        await request("wizard.next", { sessionId: "login" });
        await request("wizard.cancel", { sessionId: "login" });
        expect(stop).not.toHaveBeenCalled();
      },
    });
    expect(methods).toEqual(["models.authLogin", "wizard.next", "wizard.cancel"]);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("joins terminal cleanup after the connection closes during a wizard", async () => {
    const harness = setup();
    const entered = createDeferred();
    const cleanup = createDeferred();
    let settled = false;
    const pending = harness.call({
      method: "models.authLogin",
      onResponse: async (_request, signal) => {
        const aborted = Promise.withResolvers<void>();
        signal.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await aborted.promise;
        await cleanup.promise;
      },
    });
    const markSettled = () => {
      settled = true;
    };
    void pending.then(markSettled, markSettled);
    const rejected = expect(pending).rejects.toThrow("gateway closed");
    await entered.promise;
    harness.close(1001, "gone");
    await Promise.resolve();
    expect(settled).toBe(false);
    cleanup.resolve();
    await rejected;
  });

  it("does not dispatch a request when its hello observer aborts the connection", async () => {
    const harness = setup();
    const controller = new AbortController();
    const onSignalAbort = vi.fn();
    const stop = vi.fn(async () => {});
    harness.setStop(stop);

    await expect(
      harness.call({
        method: "agent",
        signal: controller.signal,
        onHelloOk: () => controller.abort(),
        onSignalAbort,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(harness.request()).toBeNull();
    expect(onSignalAbort).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledOnce();
  });

  it.each([
    ["current", false, ""],
    ["revoked", false, "dispatch owner revoked"],
    ["rejected", false, "preparation failed"],
    ["abort", true, "gateway request aborted"],
    ["close", true, "gateway closed"],
    ["timeout", true, "gateway timeout"],
  ] as const)(
    "checks dispatch authority and connection liveness after preparation: %s",
    async (outcome, interrupted, error) => {
      if (interrupted) {
        vi.useFakeTimers();
      }
      const controller = new AbortController();
      const onSignalAbort = vi.fn();
      let current = false;
      const assertDispatchCurrent = vi.fn(() => {
        if (!current) {
          throw new Error("dispatch owner revoked");
        }
      });
      const { call, entered, prepared, request, close } = preparing({
        assertDispatchCurrent,
        ...(interrupted ? { timeoutMs: 50, signal: controller.signal, onSignalAbort } : {}),
      });
      const result =
        outcome === "current"
          ? expect(call).resolves.toEqual({ ok: true })
          : expect(call).rejects.toThrow(error);

      await entered.promise;
      expect(request()).toBeNull();
      expect(assertDispatchCurrent).not.toHaveBeenCalled();
      current = outcome === "current";
      if (outcome === "abort") {
        controller.abort();
      } else if (outcome === "close") {
        close(1001, "connection retired");
      } else if (outcome === "timeout") {
        await vi.advanceTimersByTimeAsync(50);
      } else if (outcome === "rejected") {
        prepared.reject(new Error("preparation failed"));
      } else {
        prepared.resolve();
      }
      await result;
      if (interrupted) {
        prepared.resolve();
        await prepared.promise;
        expect(request()).toBeNull();
        expect(onSignalAbort).not.toHaveBeenCalled();
      } else {
        expect(request()?.method).toBe(outcome === "current" ? "agent" : undefined);
      }
      expect(assertDispatchCurrent).toHaveBeenCalledTimes(
        interrupted || outcome === "rejected" ? 0 : 1,
      );
    },
  );

  it.each(["resolve", "reject"])(
    "ignores stale preparation %s after a replacement hello starts its request",
    async (outcome) => {
      const harness = setup();
      const entered = createDeferred();
      const stalePreparation = createDeferred();
      const dispatched = createDeferred();
      const response = createDeferred<{ ok: boolean }>();
      const stop = vi.fn(async () => {});
      harness.setStop(stop);
      const request = vi.fn(() => {
        dispatched.resolve();
        return response.promise;
      });
      harness.setRequest(request);
      const call = harness.call({
        method: "agent",
        onHelloOk: () => entered.resolve(),
        prepareDispatchCurrent: vi
          .fn<() => Promise<void>>()
          .mockReturnValueOnce(stalePreparation.promise)
          .mockResolvedValue(undefined),
      });
      await entered.promise;
      expect(request).not.toHaveBeenCalled();
      harness.hello();
      await dispatched.promise;
      if (outcome === "reject") {
        stalePreparation.reject(new Error("retired preparation failed"));
      } else {
        stalePreparation.resolve();
      }
      await stalePreparation.promise.catch(() => {});
      expect(request).toHaveBeenCalledOnce();
      expect(stop).not.toHaveBeenCalled();
      response.resolve({ ok: true });
      await expect(call).resolves.toEqual({ ok: true });
    },
  );
}
