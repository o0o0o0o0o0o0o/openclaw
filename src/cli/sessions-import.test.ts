import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionCatalogHost } from "../../packages/gateway-protocol/src/index.js";
import { ExpectedCliError } from "./failure-output.js";
import { registerStatusHealthSessionsCommands } from "./program/register.status-health-sessions.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(),
  runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
}));
vi.mock("./session-target.js", () => ({ callSessionTargetGateway: mocks.callGateway }));
vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime: mocks.runtime,
}));
const { callGateway, runtime } = mocks;
const output = () => JSON.parse(String(runtime.log.mock.calls[0]?.[0]));
const methods = () => callGateway.mock.calls.map(([params]) => params.method);
const expectCall = (index: number, expected: object) =>
  expect(callGateway).toHaveBeenNthCalledWith(index, expect.objectContaining(expected));

async function run(args: string) {
  const program = new Command().enablePositionalOptions();
  registerStatusHealthSessionsCommands(program);
  await program.parseAsync(args.split(" "), { from: "user" });
}

function host(threadIds: string[], options: Partial<SessionCatalogHost> = {}) {
  return {
    hostId: "gateway:local",
    kind: "gateway",
    sessions: threadIds.map((threadId) => ({ threadId })),
    ...options,
  };
}

function catalog(id: string, hosts: ReturnType<typeof host>[], error?: object) {
  return { id, hosts, ...(error ? { error } : {}) };
}
const page = (...catalogs: ReturnType<typeof catalog>[]) => ({ catalogs });
const stale = (message: string) => ({ code: "catalog_stale", message });

const imported = {
  sessionKey: "agent:main:imported-session",
  importedItems: 2,
  totalItems: 2,
  complete: true,
  created: true,
};

describe("sessions import CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGateway.mockReset();
  });

  it("pages each catalog host, preserves source homes, and continues after row failure", async () => {
    callGateway
      .mockResolvedValueOnce(
        page(
          catalog("claude", [host(["first", "broken"], { nextCursor: "older" })]),
          catalog("codex", [
            {
              ...host([], { hostId: "node:desktop", kind: "node" }),
              sessions: [
                {
                  threadId: "codex-thread",
                  sourceHomeId: "work-home",
                  name: "  Native Codex title  ",
                },
              ],
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(imported)
      .mockRejectedValueOnce(new Error("Source is unavailable"))
      .mockResolvedValueOnce(page(catalog("claude", [host(["last"])])))
      .mockResolvedValueOnce({ ...imported, created: false, importedItems: 0 })
      .mockResolvedValueOnce({ ...imported, created: false, importedItems: 1 });

    await run(
      "sessions --agent work --json import --all --url ws://gateway.test --token test-token",
    );

    expect(methods()).toEqual([
      "sessions.catalog.list",
      "sessions.catalog.import",
      "sessions.catalog.import",
      "sessions.catalog.list",
      "sessions.catalog.import",
      "sessions.catalog.import",
    ]);
    expectCall(4, {
      request: {
        agentId: "work",
        catalogId: "claude",
        limitPerHost: 100,
        hostIds: ["gateway:local"],
        cursors: { "gateway:local": "older" },
      },
    });
    expectCall(6, {
      gateway: expect.objectContaining({ url: "ws://gateway.test", token: "test-token" }),
      requiredScope: "operator.write",
      request: {
        catalogId: "codex",
        hostId: "node:desktop",
        threadId: "codex-thread",
        sourceHomeId: "work-home",
        displayName: "Native Codex title",
        agentId: "work",
      },
    });
    expect(output()).toMatchObject({
      ok: false,
      operation: "import",
      results: [
        { threadId: "first", status: "imported", importedItems: 2 },
        { threadId: "broken", status: "failed", error: "Source is unavailable" },
        { threadId: "last", status: "unchanged", importedItems: 0 },
        { threadId: "codex-thread", status: "updated", importedItems: 1 },
      ],
      summary: { imported: 1, updated: 1, unchanged: 1, failed: 1 },
    });
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("imports visible partial rows while reporting listing errors and stopping stale paging", async () => {
    callGateway
      .mockResolvedValueOnce(
        page(
          catalog(
            "claude",
            [host(["visible"], { nextCursor: "stale", error: stale("Host stale") })],
            stale("Catalog stale"),
          ),
        ),
      )
      .mockResolvedValueOnce(imported);

    await run("sessions import --all --json");

    expect(methods()).toEqual(["sessions.catalog.list", "sessions.catalog.import"]);
    expect(output()).toMatchObject({
      ok: false,
      results: [
        { catalogId: "claude", status: "failed", error: "Catalog stale" },
        { hostId: "gateway:local", status: "failed", error: "Host stale" },
        { threadId: "visible", status: "imported", importedItems: 2 },
      ],
      summary: { imported: 1, failed: 2 },
    });
    expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it("honors the total dry-run limit without issuing writes or fetching another page", async () => {
    callGateway.mockResolvedValueOnce(
      page(catalog("claude", [host(["first", "second"], { nextCursor: "older" })])),
    );
    await run(
      "sessions import --all --catalog claude --host gateway:local --limit 1 --dry-run --json",
    );
    expect(callGateway).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        method: "sessions.catalog.list",
        request: { catalogId: "claude", hostIds: ["gateway:local"], limitPerHost: 1 },
      }),
    );
    expect(output()).toMatchObject({
      ok: true,
      dryRun: true,
      results: [{ threadId: "first", status: "would_import" }],
      summary: { wouldImport: 1, failed: 0 },
    });
    expect(runtime.exit).not.toHaveBeenCalled();
  });

  it("imports an explicit locator and warns about bounded history in human output", async () => {
    callGateway.mockResolvedValueOnce({ ...imported, complete: false, totalItems: 50_001 });
    await run(
      "sessions import claude thread --host gateway:local --source-home home --password test-password --timeout 90000",
    );
    expect(callGateway).toHaveBeenCalledExactlyOnceWith({
      gateway: { url: undefined, token: undefined, password: "test-password" },
      method: "sessions.catalog.import",
      request: {
        catalogId: "claude",
        hostId: "gateway:local",
        threadId: "thread",
        sourceHomeId: "home",
      },
      requiredScope: "operator.write",
      timeoutMs: 90_000,
    });
    expect(runtime.log.mock.calls[0]?.[0]).toContain("2 new / 50001 source items (incomplete:");
    expect(runtime.log).toHaveBeenLastCalledWith("1 imported; 0 updated; 0 unchanged; 0 failed.");
  });

  it.each([
    ["claude", [host([], { hostId: "gateway:other" }), host([])], "gateway:local"],
    ["opencode", [host([], { kind: "node" }), host([], { hostId: "gateway" })], "gateway"],
    ["custom", [host([], { hostId: "node:desktop", kind: "node" })], undefined],
    [
      "custom",
      [host([], { hostId: "gateway:first" }), host([], { hostId: "gateway:second" })],
      undefined,
    ],
  ])("selects a host for %s from %j: %s", async (catalogId, hosts, expectedHost) => {
    callGateway.mockResolvedValueOnce(page(catalog(catalogId, hosts)));
    if (expectedHost) {
      callGateway.mockResolvedValueOnce(imported);
    }
    await run(`sessions import ${catalogId} thread ${expectedHost ? "--agent work " : ""}--json`);
    if (expectedHost) {
      expectCall(1, {
        method: "sessions.catalog.list",
        request: { catalogId, agentId: "work", limitPerHost: 1 },
      });
      expectCall(2, {
        method: "sessions.catalog.import",
        request: { catalogId, threadId: "thread", hostId: expectedHost, agentId: "work" },
      });
      expect(callGateway).toHaveBeenCalledTimes(2);
      expect(runtime.exit).not.toHaveBeenCalled();
    } else {
      expect(callGateway).toHaveBeenCalledTimes(1);
      expect(output()).toMatchObject({
        ok: false,
        results: [{ status: "failed", error: expect.stringContaining("Pass --host <hostId>") }],
      });
      expect(runtime.exit).toHaveBeenCalledExactlyOnceWith(1);
    }
  });

  it.each([
    "sessions import --all claude thread",
    "sessions import claude",
    "sessions import --all --limit 0",
    "sessions import --all --source-home home",
    "sessions import claude thread --catalog codex",
  ])("rejects invalid selection: %s", async (args) => {
    await expect(run(args)).rejects.toBeInstanceOf(ExpectedCliError);
    expect(callGateway).not.toHaveBeenCalled();
  });
});
