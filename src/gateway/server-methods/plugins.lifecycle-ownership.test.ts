import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ErrorShape } from "../../../packages/gateway-protocol/src/index.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { installManagedPlugin } from "../../plugins/management-mutations.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

const managementMocks = vi.hoisted(() => ({
  install: vi.fn(),
  refreshMetadata: vi.fn(),
  reload: vi.fn(),
  setEnabled: vi.fn(),
  uninstall: vi.fn(),
}));
vi.mock("../../plugins/management-mutations.js", () => ({
  installManagedPlugin: managementMocks.install,
  refreshManagedPlugins: managementMocks.refreshMetadata,
  reloadManagedPlugin: managementMocks.reload,
  setManagedPluginEnabled: managementMocks.setEnabled,
}));
vi.mock("../../plugins/management-uninstall.js", () => ({
  uninstallManagedPlugin: managementMocks.uninstall,
}));
vi.mock("../../plugins/catalog-search.js", () => ({ searchInstallablePluginPackages: vi.fn() }));

const { pluginMutationHandlers: pluginsHandlers } = await import("./plugins-mutations.js");
const application = { operationId: "test-operation", generation: 42, pluginIds: ["workboard"] };
const applyRuntime = vi.fn<NonNullable<GatewayRequestContext["applyPluginLifecycleChange"]>>();
const context: Pick<GatewayRequestContext, "applyPluginLifecycleChange"> = {
  applyPluginLifecycleChange: applyRuntime,
};
type ManagedMutationOptions = Pick<
  Parameters<typeof installManagedPlugin>[0],
  "applyRuntime" | "beforePersistentApply" | "signal"
>;

async function callHandler(
  invocation: Pick<
    GatewayRequestHandlerOptions,
    "signal" | "sessionMutationCommitGuard" | "hasCurrentClientAuthority"
  >,
) {
  const method = "plugins.reload";
  const params = { plugins: [{ pluginId: "workboard" }] };
  let ok: boolean | null = null;
  let error: ErrorShape | undefined;
  await expectDefined(
    pluginsHandlers[method],
    "plugin lifecycle handler",
  )({
    ...invocation,
    req: { type: "req", id: "plugin-lifecycle", method, params },
    params,
    client: null,
    isWebchatConnect: () => false,
    // This fixture supplies the sole Gateway capability consumed by these lifecycle handlers.
    context: context as GatewayRequestContext,
    respond: (success, _result, requestError) => {
      ok = success;
      error = requestError;
    },
  });
  return { ok, error };
}
function applyReload(options: ManagedMutationOptions, assertInvokerOwned?: () => void) {
  return expectDefined(
    options.applyRuntime,
    "managed runtime apply",
  )({
    config: {},
    pluginIds: ["workboard"],
    reason: "reload",
    assertInvokerOwned,
  });
}
async function waitForPublication(entered: Promise<unknown>, pending: Promise<unknown>) {
  await Promise.race([
    entered,
    pending.then(() => {
      throw new Error("reload completed before queued publication");
    }),
  ]);
}

describe("plugin lifecycle invoker ownership", () => {
  beforeEach(() => {
    applyRuntime.mockReset().mockResolvedValue(application);
    for (const operation of Object.values(managementMocks)) {
      operation.mockReset();
    }
  });

  it("preserves the management lease guard while the request remains open", async () => {
    const controller = new AbortController();
    const requestGuard = vi.fn();
    const entered = createDeferred();
    const released = createDeferred();
    const publish = vi.fn();
    const failure = new Error("plugin mutation lease lost");
    let leaseOwned = true;
    applyRuntime.mockImplementation(
      async (change: Parameters<NonNullable<ManagedMutationOptions["applyRuntime"]>>[0]) => {
        entered.resolve();
        await released.promise;
        change.assertInvokerOwned?.();
        publish();
        return application;
      },
    );
    managementMocks.reload.mockImplementation(async (options: ManagedMutationOptions) => ({
      application: await applyReload(options, () => {
        if (!leaseOwned) {
          throw failure;
        }
      }),
    }));
    const pending = callHandler({
      signal: controller.signal,
      sessionMutationCommitGuard: requestGuard,
    });
    try {
      await waitForPublication(entered.promise, pending);
      leaseOwned = false;
      released.resolve();
      expect(await pending).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: failure.message },
      });
      expect(controller.signal.aborted).toBe(false);
      expect(requestGuard).toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
    } finally {
      released.resolve();
      await pending;
    }
  });
  describe.each(["signal", "guard", "client"] as const)("closed %s", (fence) => {
    const createInvocation = () => {
      const controller = new AbortController();
      const failure = new Error(
        fence === "signal"
          ? "plugin request aborted"
          : fence === "client"
            ? "Plugin mutation authority is no longer active."
            : "plugin mutation owner closed",
      );
      let open = true;
      return {
        failure,
        invocation: {
          signal: controller.signal,
          hasCurrentClientAuthority: () => fence !== "client" || open,
          sessionMutationCommitGuard: () => {
            if (fence === "guard" && !open) {
              throw failure;
            }
          },
        },
        close: () => {
          if (fence === "signal") {
            controller.abort(failure);
          } else {
            open = false;
          }
        },
      };
    };

    it("rejects reload before management dispatch", async () => {
      const owner = createInvocation();
      managementMocks.reload.mockResolvedValue({ application });
      owner.close();
      expect(await callHandler(owner.invocation)).toMatchObject({
        ok: false,
        error: { code: "UNAVAILABLE", message: owner.failure.message },
      });
      expect(managementMocks.reload).not.toHaveBeenCalled();
      expect(applyRuntime).not.toHaveBeenCalled();
    });

    it.each(["persistence", "runtime", "publication"] as const)(
      "rejects retained reload %s work after an await",
      async (checkpoint) => {
        const owner = createInvocation();
        const entered = createDeferred();
        const paused = createDeferred();
        const persist = vi.fn();
        if (checkpoint === "publication") {
          applyRuntime.mockImplementation(
            async (change: Parameters<NonNullable<ManagedMutationOptions["applyRuntime"]>>[0]) => {
              entered.resolve();
              await paused.promise;
              change.assertInvokerOwned?.();
              persist();
              return application;
            },
          );
        }
        managementMocks.reload.mockImplementation(async (options: ManagedMutationOptions) => {
          if (checkpoint !== "publication") {
            entered.resolve();
            await paused.promise;
          }
          if (checkpoint === "persistence") {
            options.beforePersistentApply?.();
            persist();
            return { application };
          }
          return { application: await applyReload(options) };
        });
        const pending = callHandler(owner.invocation);
        try {
          await waitForPublication(entered.promise, pending);
          expect(managementMocks.reload).toHaveBeenCalledOnce();
          owner.close();
          paused.resolve();
          expect(await pending).toMatchObject({
            ok: false,
            error: { code: "UNAVAILABLE", message: owner.failure.message },
          });
          expect(persist).not.toHaveBeenCalled();
          expect(applyRuntime).toHaveBeenCalledTimes(checkpoint === "publication" ? 1 : 0);
          expect(managementMocks.reload).toHaveBeenCalledWith(
            expect.objectContaining({
              signal: owner.invocation.signal,
              beforePersistentApply: expect.any(Function),
              applyRuntime: expect.any(Function),
            }),
          );
        } finally {
          paused.resolve();
          await pending;
        }
      },
    );
  });
});
