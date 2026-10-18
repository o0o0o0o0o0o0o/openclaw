import type { SessionsStorageStatusResult } from "@openclaw/gateway-protocol";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { createGatewayHarness } from "../../lib/config/config-test-harness.ts";
import {
  createRuntimeConfigCapability,
  type RuntimeConfigCapability,
} from "../../lib/config/runtime-config-capability.ts";
import { cleanupSolid, mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { flush, waitForSolid } from "../../test-helpers/solid-settle.ts";
import { SessionStorageSettings } from "./session-storage.tsx";

const configs: RuntimeConfigCapability[] = [];
function inventory(
  count: number,
  maintenance: Partial<SessionsStorageStatusResult["maintenance"]> = {},
): SessionsStorageStatusResult {
  return {
    agents: [
      {
        agentId: "main",
        storePath: "/synthetic/agent.sqlite",
        hotTranscripts: count,
        coldTranscripts: 0,
        databaseBytes: 4096,
        walBytes: 0,
        archiveBytes: 0,
        embeddedArchiveBytes: 0,
      },
    ],
    maintenance: {
      running: false,
      lastStartedAt: null,
      lastCompletedAt: null,
      lastError: null,
      archivedTranscripts: 0,
      externalizedTranscripts: 0,
      ...maintenance,
    },
  };
}
async function mount() {
  const config = { session: { maintenance: { coldStorage: { enabled: true, afterDays: 30 } } } };
  const respond = async (method: string): Promise<unknown> =>
    method === "sessions.storage.status"
      ? inventory(7)
      : {
          config,
          hash: "raw-one",
          configRevisionHash: "revision-one",
          appliedConfigHash: "revision-one",
          valid: true,
          issues: [],
          raw: JSON.stringify(config),
        };
  const request = vi.fn(respond);
  const reply = (method: string, read: () => Promise<unknown>) => (called: string) =>
    called === method ? read() : respond(called);
  const client = { request } as unknown as GatewayBrowserClient;
  const { gateway, publish } = createGatewayHarness(client);
  const runtimeConfig = createRuntimeConfigCapability(gateway);
  configs.push(runtimeConfig);
  await runtimeConfig.ensureLoaded();
  const context = { gateway, runtimeConfig } as unknown as ApplicationContext;
  const provider = createSolidApplicationContextProvider(context);
  const { container: page, unmount } = mountSolid(() => <SessionStorageSettings />, {
    wrapper: provider.wrapper,
  });
  await waitText(page, "7 uncompressed");
  return { page, context, runtimeConfig, request, client, respond, reply, publish, unmount };
}
function button(page: HTMLElement, label: string) {
  return [...page.querySelectorAll("button")].find((item) => item.textContent?.trim() === label)!;
}
function click(page: HTMLElement, label: string) {
  const control = button(page, label);
  expect(control.disabled).toBe(false);
  control.click();
  flush();
}

function waitText(page: HTMLElement, text: string) {
  return waitForSolid(() => expect(page.textContent).toContain(text));
}

function waitRunning(page: HTMLElement) {
  return waitForSolid(() =>
    expect(page.querySelector(".settings-status")?.textContent).toContain("Running"),
  );
}
afterEach(() => {
  cleanupSolid();
  for (const config of configs.splice(0)) {
    config.dispose();
  }
  vi.restoreAllMocks();
});

it.each(["client", "handshake", "reconnect"])(
  "rejects a delayed inventory after the Gateway %s changes",
  async (change) => {
    const { page, context, request, client, reply, publish } = await mount();
    const previous = createDeferred<SessionsStorageStatusResult>();
    request.mockImplementation(reply("sessions.storage.status", () => previous.promise));
    click(page, "Refresh");
    await waitForSolid(() =>
      expect(
        request.mock.calls.filter(([method]) => method === "sessions.storage.status"),
      ).toHaveLength(2),
    );
    expect(page.textContent).toContain("7 uncompressed");
    const currentRequest = vi.fn(reply("sessions.storage.status", async () => inventory(42)));
    if (change === "client") {
      publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
    } else {
      request.mockImplementation(currentRequest);
      if (change === "reconnect") {
        const hello = context.gateway.snapshot.hello;
        publish(false, client, hello);
        publish(true, client, hello);
      } else {
        publish(true, client);
      }
    }
    await waitText(page, "42 uncompressed");
    previous.resolve(inventory(700));
    await previous.promise;
    flush();
    expect(page.textContent).toContain("42 uncompressed");
    expect(page.textContent).not.toContain("700 uncompressed");
  },
);

it("does not publish an old Gateway's completed run after a new connection", async () => {
  const { page, request, reply, publish } = await mount();
  const previous = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementation(reply("sessions.storage.run", () => previous.promise));
  click(page, "Run now");
  await waitForSolid(() =>
    expect(request.mock.calls.some(([method]) => method === "sessions.storage.run")).toBe(true),
  );
  const currentRequest = vi.fn(reply("sessions.storage.status", async () => inventory(42)));
  publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
  await waitText(page, "42 uncompressed");
  previous.resolve(inventory(700, { archivedTranscripts: 693 }));
  await previous.promise;
  flush();
  expect(page.textContent).not.toContain("Batch completed");
  expect(page.textContent).not.toContain("700 uncompressed");
  expect(button(page, "Run now").disabled).toBe(false);
});

it("keeps a days draft and inventory through reconnect and retires them on client replacement", async () => {
  const { page, runtimeConfig, request, respond, reply, publish, client } = await mount();
  const input = page.querySelector<HTMLInputElement>('input[type="number"]')!;
  input.value = "14";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  request.mockImplementation(reply("sessions.storage.status", async () => inventory(42)));
  click(page, "Refresh");
  await waitText(page, "42 uncompressed");
  expect(input.value).toBe("14");
  expect(runtimeConfig.state.configFormDirty).toBe(false);

  publish(false, client, null);
  flush();
  expect(input.value).toBe("14");
  expect(page.textContent).toContain("42 uncompressed");
  expect(input.disabled).toBe(true);
  const reconnect = createDeferred<SessionsStorageStatusResult>();
  request.mockImplementation(reply("sessions.storage.status", () => reconnect.promise));
  publish(true, client);
  flush();
  expect(input.value).toBe("14");
  expect(page.textContent).toContain("42 uncompressed");
  reconnect.resolve(inventory(21));
  await waitText(page, "21 uncompressed");
  expect(input.value).toBe("14");

  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  expect(runtimeConfig.state.configFormDirty).toBe(false);
  expect(request.mock.calls.some(([method]) => method === "config.set")).toBe(false);

  const currentRequest = vi.fn(respond);
  publish(true, { request: currentRequest } as unknown as GatewayBrowserClient);
  await waitText(page, "7 uncompressed");
  expect(input.value).toBe("30");
});

it("retires the days draft and inventory when a fresh hello removes access", async () => {
  const { page, context, client, publish } = await mount();
  const input = page.querySelector<HTMLInputElement>('input[type="number"]')!;
  input.value = "14";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  const hello = context.gateway.snapshot.hello!;
  publish(true, client, { ...hello, auth: { ...hello.auth, scopes: [] } });
  flush();
  expect(input.value).toBe("30");
  expect(input.disabled).toBe(true);
  expect(page.textContent).not.toContain("7 uncompressed");
});

async function startBackgroundRun() {
  const mounted = await mount();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const running = inventory(7, { running: true, lastStartedAt: 100 });
  let nextStatus: () => Promise<SessionsStorageStatusResult> = async () => running;
  mounted.request.mockImplementation((method) =>
    method === "sessions.storage.run"
      ? Promise.resolve(running)
      : method === "sessions.storage.status"
        ? nextStatus()
        : mounted.respond(method),
  );
  click(mounted.page, "Run now");
  await waitForSolid(() => expect(mounted.page.textContent).toContain("Background batch started."));
  await waitRunning(mounted.page);
  return {
    ...mounted,
    running,
    setStatus: (read: typeof nextStatus) => {
      nextStatus = read;
    },
  };
}

it("tracks an accepted job until completion and stops polling while idle", async () => {
  const { page, request, setStatus } = await startBackgroundRun();
  const reads = () =>
    request.mock.calls.filter(([method]) => method === "sessions.storage.status").length;
  const acceptedReads = reads();
  expect(page.textContent).not.toContain("Batch completed");
  await vi.advanceTimersByTimeAsync(2_000);
  expect(reads()).toBe(acceptedReads + 1);
  setStatus(async () =>
    inventory(5, {
      lastCompletedAt: 200,
      archivedTranscripts: 2,
      externalizedTranscripts: 3,
    }),
  );
  await vi.advanceTimersByTimeAsync(2_000);
  await waitText(page, "Batch completed. 2 transcripts archived.");
  expect(page.textContent).toContain("3 compressed archives moved from the database to files.");
  const finishedReads = reads();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(reads()).toBe(finishedReads);
});

it("observes a followed run completing while the same client reconnects", async () => {
  const { page, client, publish, setStatus } = await startBackgroundRun();
  publish(false, client, null);
  flush();
  expect(page.textContent).toContain("Background batch started.");
  setStatus(async () => inventory(5, { lastCompletedAt: 200, archivedTranscripts: 2 }));
  publish(true, client);
  await waitText(page, "Batch completed. 2 transcripts archived.");
});

it("stops polling after a status failure and resumes only after an explicit refresh", async () => {
  const { page, request, running, setStatus } = await startBackgroundRun();
  setStatus(async () => {
    throw new Error("Worker status unavailable");
  });
  await vi.advanceTimersByTimeAsync(2_000);
  await waitText(page, "Worker status unavailable");
  expect(page.textContent).toContain("Refresh to check the current maintenance state.");
  const failedReads = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls).toHaveLength(failedReads);
  setStatus(async () => running);
  click(page, "Refresh");
  await waitRunning(page);
  setStatus(async () =>
    inventory(7, {
      lastCompletedAt: 200,
      lastError: "Archive publication failed",
    }),
  );
  await vi.advanceTimersByTimeAsync(2_000);
  await waitText(page, "Archive publication failed");
  expect(page.textContent).not.toContain("Batch completed");
  const terminalReads = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls).toHaveLength(terminalReads);
});

it.each(["detach", "disconnect", "replace"])("retires background polling on %s", async (change) => {
  const { page, request, respond, publish, unmount } = await startBackgroundRun();
  if (change === "detach") {
    unmount();
  } else if (change === "disconnect") {
    publish(false);
  } else {
    publish(true, { request: vi.fn(respond) } as unknown as GatewayBrowserClient);
  }
  flush();
  const previousCalls = request.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(request.mock.calls).toHaveLength(previousCalls);
  if (change === "replace") {
    expect(page.textContent).not.toContain("Background batch started.");
  } else if (change === "disconnect") {
    expect(page.textContent).toContain("Background batch started.");
  }
});
