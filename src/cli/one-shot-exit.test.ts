import { spawnSync } from "node:child_process";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { defaultRuntime, ExitError } from "../runtime.js";
import {
  exitCliAfterOutput,
  requestExitAfterOneShotOutput,
  runCliWithExitFinalization,
} from "./one-shot-exit.js";
import {
  exitAfterSignalExitBarriers,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "./signal-exit-barrier.js";

const successfulRun = async () => {};
const ignoreError = () => {};
const proxyChildTempDir = useAutoCleanupTempDirTracker(afterAll).make("openclaw-proxy-child-tmp-");
const moduleUrl = (relative: string) => JSON.stringify(new URL(relative, import.meta.url).href);
const reject = (error: unknown) => () => Promise.reject(error);
type Completion = Parameters<typeof runCliWithExitFinalization>[0];
function complete(
  run: Completion["run"] = successfulRun,
  finalize?: Completion["finalize"],
  onError: Completion["onError"] = ignoreError,
  runtime?: Completion["runtime"],
) {
  return runCliWithExitFinalization({ run, finalize, onError, runtime });
}

function expectChildExit(result: ReturnType<typeof runCliChild>, status: number) {
  expect(result.error).toBeUndefined();
  expect(result).toMatchObject({ status, signal: null });
}

function runCliChild(script: string, envOverrides: NodeJS.ProcessEnv = {}, maxBuffer?: number) {
  const env = { ...process.env, ...envOverrides };
  delete env.VITEST;
  delete env.VITEST_POOL_ID;
  delete env.VITEST_WORKER_ID;
  return spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    encoding: "utf8",
    env,
    timeout: 30_000,
    ...(maxBuffer ? { maxBuffer } : {}),
  });
}

let previousExitCode: typeof process.exitCode;
beforeEach(() => {
  previousExitCode = process.exitCode;
  process.exitCode = undefined;
});
afterEach(() => {
  process.exitCode = previousExitCode;
  vi.restoreAllMocks();
});

it("unwinds the injected runtime with its requested code", () => {
  const exit = vi.fn();
  const runtime = { ...defaultRuntime, exit };
  const defaultExit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {});
  let thrown: unknown;
  try {
    exitCliAfterOutput(runtime, 7);
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(ExitError);
  expect(thrown).toMatchObject({ code: 7 });
  expect(defaultExit).not.toHaveBeenCalled();
  expect(exit).toHaveBeenCalledExactlyOnceWith(7);
});

it.each([
  { outcome: "cleanup failure after success", commandExit: undefined },
  {
    outcome: "deferred exit with failed reporter",
    commandExit: 7,
    reporterRethrows: true,
  },
])("leaves $outcome owned by the injected runtime", async ({ commandExit, reporterRethrows }) => {
  const commandFailure = commandExit === undefined ? undefined : new ExitError(commandExit);
  const cleanupFailure = new Error("state cleanup failed");
  const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  const onError = vi.fn((error: unknown) => {
    if (reporterRethrows) {
      throw error;
    }
  });
  await expect(
    complete(
      async () => {
        if (commandFailure) {
          throw commandFailure;
        }
      },
      reject(cleanupFailure),
      onError,
      runtime,
    ),
  ).rejects.toBe(commandFailure ?? cleanupFailure);
  expect(onError).toHaveBeenCalledExactlyOnceWith(cleanupFailure);
  expect(runtime.exit).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
});

it("does not finalize a long-lived command until its run settles", async () => {
  const finish = createDeferred();
  const finalize = vi.fn(async () => {});
  const running = complete(() => finish.promise, finalize);
  requestExitAfterOneShotOutput(defaultRuntime, 7);
  await Promise.resolve();
  expect(finalize).not.toHaveBeenCalled();
  expect(process.exitCode).toBeUndefined();
  finish.resolve();
  await running;
  expect(finalize).toHaveBeenCalledOnce();
  expect(process.exitCode).toBe(7);
});

it.each([
  { requested: 0, signal: "SIGTERM" as const, expected: 143 },
  { requested: "0", signal: "SIGINT" as const, expected: 130 },
  { requested: 7, signal: "SIGTERM" as const, expected: 7 },
])(
  "retains an accepted signal over pending success ($requested, $signal)",
  async ({ requested, signal, expected }) => {
    const cleanup = createDeferred();
    const unregister = registerSignalExitGate(cleanup.promise);
    const finalize = vi.fn(async () => {});
    exitAfterSignalExitBarriers(requested);
    const signalDrain = waitForSignalExitBarriers(signal);
    const completing = complete(successfulRun, finalize);
    try {
      await Promise.resolve();
      expect(finalize).not.toHaveBeenCalled();
      cleanup.resolve();
      await Promise.all([signalDrain, completing]);
      expect(process.exitCode).toBe(expected);
      expect(finalize).toHaveBeenCalledOnce();
    } finally {
      cleanup.resolve();
      await Promise.all([signalDrain, completing]);
      unregister();
    }
  },
);

it("joins caller-owned cleanup before publishing completion", async () => {
  const closed = createDeferred();
  const entered = createDeferred();
  const running = complete(reject(new ExitError(7)), async () => {
    entered.resolve();
    await closed.promise;
  });
  try {
    await entered.promise;
    expect(process.exitCode).toBeUndefined();
  } finally {
    closed.resolve();
    await running;
  }
  expect(process.exitCode).toBe(7);
});

it("reports failure before replacing a queued successful outcome", async () => {
  const order: string[] = [];
  requestExitAfterOneShotOutput(defaultRuntime, 0);
  await complete(
    reject(new Error("command failed")),
    async () => {
      order.push("closed");
    },
    async () => {
      await Promise.resolve();
      order.push("reported");
      process.exitCode = 6;
    },
  );
  expect(order).toEqual(["reported", "closed"]);
  expect(process.exitCode).toBe(6);
});

it("defaults an unrecorded outcome to success", async () => {
  await complete(async () => {
    requestExitAfterOneShotOutput();
    process.exitCode = undefined;
  });
  expect(process.exitCode).toBe(0);
});

it.each(["before cleanup", "during cleanup"])(
  "retains terminal signal outcome %s",
  async (phase) => {
    await complete(
      async () => {
        requestExitAfterOneShotOutput(defaultRuntime, 0);
        if (phase === "before cleanup") {
          exitAfterSignalExitBarriers(143);
        }
      },
      async () => {
        if (phase === "during cleanup") {
          exitAfterSignalExitBarriers(143);
        }
      },
    );
    expect(process.exitCode).toBe(143);
  },
);

it("drains large piped JSON before a deferred ExitError without reporting another error", () => {
  const payloadBytes = 1024 * 1024;
  const script = `
      import { runCliWithExitFinalization } from ${moduleUrl("./one-shot-exit.ts")};
      import { defaultRuntime, ExitError } from ${moduleUrl("../runtime.ts")};
      await runCliWithExitFinalization({
        run: async () => {
          defaultRuntime.writeJson({ ok: false, payload: "x".repeat(${payloadBytes}) });
          throw new ExitError(7);
        },
        onError: (error) => {
          process.stderr.write("unexpected error: " + String(error));
          process.exitCode = 1;
        },
      });
    `;

  const result = runCliChild(script, {}, 2 * payloadBytes);

  expectChildExit(result, 7);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    `${JSON.stringify({ ok: false, payload: "x".repeat(payloadBytes) }, null, 2)}\n`,
  );
});

it("keeps the real proxy command exit truthful when --help is consumed as a proxy URL", () => {
  const script = `
      import { Command, CommanderError } from "commander";
      import { setRuntimeConfigSnapshot } from ${moduleUrl("../config/runtime-snapshot.ts")};
      import { resolveCliArgvInvocation } from ${moduleUrl("./argv-invocation.ts")};
      import { registerProxyCli } from ${moduleUrl("./proxy-cli.ts")};
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${moduleUrl("./one-shot-exit.ts")};

      setRuntimeConfigSnapshot({});
      const argv = ["node", "openclaw", "proxy", "validate", ...${JSON.stringify(["--proxy-url", "--help", "--json"])}];
      await runCliWithExitFinalization({
        run: async () => {
          const program = new Command().enablePositionalOptions().exitOverride();
          registerProxyCli(program);
          try {
            await program.parseAsync(argv);
          } catch (error) {
            if (!(error instanceof CommanderError) || error.exitCode !== 0) {
              throw error;
            }
            process.exitCode = error.exitCode;
          }
          if (resolveCliArgvInvocation(argv).hasHelpOrVersion) {
            requestExitAfterOneShotOutput();
          }
        },
        onError: (error) => { throw error; },
      });
    `;

  const result = runCliChild(script, {
    OPENCLAW_STATE_DIR: "/dev/null",
    OPENCLAW_CONFIG_PATH: "/dev/null",
    TMPDIR: proxyChildTempDir,
    TEMP: proxyChildTempDir,
    TMP: proxyChildTempDir,
    NODE_DISABLE_COMPILE_CACHE: "1",
  });

  expectChildExit(result, 1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    ok: false,
    config: {
      errors: ["proxyUrl must use http:// or https://"],
    },
  });
});

it.each([
  { name: "deferred hooks failure", exitCode: 1, explicitRequest: true },
  {
    name: "natural successful completion",
    exitCode: 0,
    explicitRequest: false,
  },
])("keeps real dual-TTY JSON clean for $name", ({ exitCode, explicitRequest }) => {
  const script = `
      import { requestExitAfterOneShotOutput, runCliWithExitFinalization } from ${moduleUrl("./one-shot-exit.ts")};
      import { defaultRuntime } from ${moduleUrl("../runtime.ts")};
      import { loggingState } from ${moduleUrl("../logging/state.ts")};
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      loggingState.forceConsoleToStderr = true;
      await runCliWithExitFinalization({
        run: async () => {
          defaultRuntime.writeStdout(JSON.stringify({ ok: ${exitCode === 0} }));
          ${explicitRequest ? `requestExitAfterOneShotOutput(defaultRuntime, ${exitCode});` : ""}
        },
        finalize: async () => {
          await Promise.resolve();
          process.stderr.write("finalized\\n");
        },
        onError: (error) => { throw error; },
      });
    `;

  const result = runCliChild(script);

  expectChildExit(result, exitCode);
  expect(JSON.parse(result.stdout)).toEqual({ ok: exitCode === 0 });
  expect(result.stderr.startsWith("finalized\n")).toBe(true);
  if (explicitRequest) {
    expect(result.stderr).toContain("\x1b[?25h");
  } else {
    expect(result.stderr).toBe("finalized\n");
  }
});

it("keeps real dual-TTY JSON clean after a fatal unhandled rejection", () => {
  const script = `
      import { defaultRuntime } from ${moduleUrl("../runtime.ts")};
      import { loggingState } from ${moduleUrl("../logging/state.ts")};
      import { installUnhandledRejectionHandler } from ${moduleUrl("../infra/unhandled-rejections.ts")};
      Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
      Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
      loggingState.forceConsoleToStderr = true;
      installUnhandledRejectionHandler();
      defaultRuntime.writeJson({ ok: false });
      const error = Object.assign(new Error("expected fatal test"), {
        code: "ERR_OUT_OF_MEMORY",
      });
      process.emit("unhandledRejection", error, Promise.resolve());
    `;

  const result = runCliChild(script);

  expectChildExit(result, 1);
  expect(JSON.parse(result.stdout)).toEqual({ ok: false });
  expect(result.stderr).toContain("\x1b[?25h");
});
