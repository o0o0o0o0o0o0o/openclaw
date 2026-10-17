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

const { pluginMutationHandlers: pluginsHandlers } = await import("./plugins-mutations.js");
const application = { operationId: "test-operation", generation: 42, pluginIds: ["workboard"] };
const applyRuntime = vi.fn<NonNullable<GatewayRequestContext["applyPluginLifecycleChange"]>>();
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
    context: { applyPluginLifecycleChange: applyRuntime } as GatewayRequestContext,
    respond: (success, _result, requestError) => {
      ok = success;
      error = requestError;
    },
  });
  return { ok, error };
}
function expectUnavailable(result: unknown, failure: Error) {
  expect(result).toMatchObject({
    ok: false,
    error: { code: "UNAVAILABLE", message: failure.message },
  });
}

describe("plugin lifecycle invoker ownership", () => {
  beforeEach(() => {
    applyRuntime.mockReset().mockResolvedValue(application);
    for (const operation of Object.values(managementMocks)) {
      operation.mockReset();
    }
  });

  const createInvocation = (fence: "signal" | "guard" | "client" | "lease") => {
    const controller = new AbortController();
    const failure = new Error(
      {
        signal: "plugin request aborted",
        client: "Plugin mutation authority is no longer active.",
        lease: "plugin mutation lease lost",
        guard: "plugin mutation owner closed",
      }[fence],
    );
    let open = true;
    return {
      failure,
      invocation: {
        signal: controller.signal,
        hasCurrentClientAuthority: () => fence !== "client" || open,
        sessionMutationCommitGuard: vi.fn(() => {
          if (fence === "guard" && !open) {
            throw failure;
          }
        }),
      },
      assertInvokerOwned: () => {
        if (fence === "lease" && !open) {
          throw failure;
        }
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

  it.each(["signal", "guard", "client"] as const)(
    "rejects closed %s before management dispatch",
    async (fence) => {
      const owner = createInvocation(fence);
      managementMocks.reload.mockResolvedValue({ application });
      owner.close();
      expectUnavailable(await callHandler(owner.invocation), owner.failure);
      expect(managementMocks.reload).not.toHaveBeenCalled();
      expect(applyRuntime).not.toHaveBeenCalled();
    },
  );

  it.each([
    ...(["signal", "guard", "client"] as const).flatMap((fence) =>
      (["persistence", "runtime", "publication"] as const).map((checkpoint) => ({
        fence,
        checkpoint,
      })),
    ),
    { fence: "lease", checkpoint: "publication" } as const,
  ])(
    "rejects retained reload $checkpoint work after $fence closes",
    async ({ fence, checkpoint }) => {
      const owner = createInvocation(fence);
      const entered = createDeferred();
      const paused = createDeferred();
      const persist = vi.fn();
      if (checkpoint === "publication") {
        applyRuntime.mockImplementation(async (change) => {
          entered.resolve();
          await paused.promise;
          change.assertInvokerOwned?.();
          persist();
          return application;
        });
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
        return {
          application: await expectDefined(
            options.applyRuntime,
            "managed runtime apply",
          )({
            config: {},
            pluginIds: ["workboard"],
            reason: "reload",
            assertInvokerOwned: fence === "lease" ? owner.assertInvokerOwned : undefined,
          }),
        };
      });
      const pending = callHandler(owner.invocation);
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("reload completed before queued publication");
          }),
        ]);
        expect(managementMocks.reload).toHaveBeenCalledOnce();
        owner.close();
        paused.resolve();
        expectUnavailable(await pending, owner.failure);
        expect(persist).not.toHaveBeenCalled();
        if (fence === "lease") {
          expect(owner.invocation.signal.aborted).toBe(false);
          expect(owner.invocation.sessionMutationCommitGuard).toHaveBeenCalled();
        }
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
