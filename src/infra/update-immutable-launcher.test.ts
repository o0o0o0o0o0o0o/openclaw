import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createHotSqliteRollbackJournal } from "../../test/helpers/sqlite-hot-journal.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  fileIdentity,
  immutableDescriptor,
  readBytes,
  readText,
  withDatabase,
} from "./package-update-activation-fixtures.test-support.js";
import {
  resolvePackageActivationAnchor,
  resolvePackageActivationControl,
} from "./package-update-activation-paths.js";
import { installImmutableLauncher } from "./update-immutable-generation.js";
import type { ImmutableInstallDescriptor } from "./update-immutable-install-schema.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
const writeGenerationFile = (generation: string, name: string, source: string) => {
  fs.mkdirSync(path.join(generation, "dist"), { recursive: true, mode: 0o755 });
  fs.writeFileSync(path.join(generation, "package.json"), '{"type":"module"}');
  fs.writeFileSync(path.join(generation, "dist", name), source, { mode: 0o444 });
};
const suiteTemporary = useAutoCleanupTempDirTracker(afterAll);

describe.runIf(process.platform === "linux" && process.getuid?.() === 0)(
  "immutable launcher activation admission",
  () => {
    let runtime: string;
    beforeAll(() => {
      runtime = fs.realpathSync(process.execPath);
      if (fs.statSync(runtime).uid !== 0) {
        runtime = path.join(suiteTemporary.make("immutable-launcher-runtime-"), "node");
        fs.copyFileSync(process.execPath, runtime);
        fs.chownSync(runtime, 0, 0);
        fs.chmodSync(runtime, 0o755);
      }
    });
    afterEach(() => vi.restoreAllMocks());

    const previousLauncher = (version: number) =>
      fs
        .readFileSync(
          new URL(`../../test/fixtures/immutable-update/launcher-v${version}.mjs`, import.meta.url),
          "utf8",
        )
        .replace(/^#![^\n]*\n/u, `#!${runtime}\n`);

    async function setup(install = true) {
      const parent = temporary.make("immutable-launch-admission-");
      const root = path.join(parent, "installation");
      const oldSha = "a".repeat(40),
        nextSha = "b".repeat(40);
      for (const sha of [oldSha, nextSha]) {
        writeGenerationFile(
          path.join(root, "releases", sha),
          "index.js",
          `console.log(${JSON.stringify(sha)});`,
        );
      }
      fs.symlinkSync(`releases/${oldSha}`, path.join(root, "current"));
      const control = resolvePackageActivationControl(resolvePackageActivationAnchor(root));
      const journal = path.join(control, "operation.sqlite");
      const launcher = path.join(root, "bin", "openclaw-gateway");
      const installLauncher = () => installImmutableLauncher({ root, runtimePath: runtime });
      if (install) {
        await installLauncher();
      } else {
        fs.mkdirSync(path.dirname(launcher), { mode: 0o755 });
      }
      const generation = (sha: string) => ({
        sha,
        path: path.join(root, "releases", sha),
        identity: fileIdentity(path.join(root, "releases", sha)),
        buildDigest: "c".repeat(64),
      });
      const descriptor: ImmutableInstallDescriptor = {
        ...immutableDescriptor(root, oldSha, "c".repeat(64), {
          scope: "system",
          unit: "fixture.service",
          account: "fixture",
          stateDir: path.join(parent, "state"),
          configPath: path.join(parent, "state", "config.json"),
          profile: null,
        }),
        version: 2,
        activationEnabled: true,
        runtime: { path: runtime, identity: "fixture-runtime" },
      };
      const write = (activation: unknown, legacy = false) => {
        fs.mkdirSync(control, { mode: 0o755, recursive: true });
        withDatabase(journal, (db) => {
          db.exec(
            `CREATE TABLE IF NOT EXISTS immutable_installation (slot INTEGER PRIMARY KEY, revision INTEGER NOT NULL, descriptor_json TEXT NOT NULL, prepared_json TEXT NOT NULL${legacy ? "" : ", activation_json TEXT NOT NULL"}) STRICT`,
          );
          db.prepare(
            legacy
              ? "INSERT OR REPLACE INTO immutable_installation VALUES (1, 0, ?, 'null')"
              : "INSERT OR REPLACE INTO immutable_installation VALUES (1, 0, ?, 'null', ?)",
          ).run(JSON.stringify(descriptor), ...(legacy ? [] : [JSON.stringify(activation)]));
        });
        fs.chmodSync(journal, 0o644);
      };
      const select = (sha: string) => {
        fs.unlinkSync(path.join(root, "current"));
        fs.symlinkSync(`releases/${sha}`, path.join(root, "current"));
        descriptor.current = {
          ...generation(sha),
          pointerIdentity: fileIdentity(path.join(root, "current")),
        };
      };
      const operation = (phase: string) => ({
        operation: {
          version: 1,
          operationId: "00000000-0000-4000-8000-000000000001",
          phase,
          authority: { installKey: root },
          previous: generation(oldSha),
          candidate: generation(nextSha),
        },
      });
      const launch = () => spawnSync(launcher, [], { encoding: "utf8", timeout: 5000 });
      const expectLaunch = (stdout = "", context = "") => {
        const result = launch();
        expect(
          { status: result.status, stdout: stdout ? result.stdout.trim() : result.stdout },
          `${context}: ${result.stderr}`,
        ).toEqual({ status: stdout ? 0 : 78, stdout });
      };
      const seedLauncher = (previous: string) => {
        fs.writeFileSync(launcher, previous, { mode: 0o755 });
        fs.mkdirSync(control, { mode: 0o755 });
      };
      const upgrade = (version: 1 | 2, assertCurrent = () => {}) =>
        installImmutableLauncher({
          root,
          runtimePath: runtime,
          upgrade: { version, assertCurrent },
        });
      return {
        root,
        control,
        journal,
        launcher,
        descriptor,
        oldSha,
        nextSha,
        write,
        select,
        operation,
        launch,
        expectLaunch,
        seedLauncher,
        upgrade,
        installLauncher,
      };
    }

    it("pins lazy imports to one generation and refuses escaping pointers or foreign launchers", async () => {
      const f = await setup();
      const { root, launcher } = f;
      const previous = f.descriptor.current.path;
      const next = path.join(root, "releases", f.nextSha);
      for (const [generation, value] of [
        [previous, "previous"],
        [next, "next"],
      ] as const) {
        fs.writeFileSync(
          path.join(generation, "dist", "lazy.js"),
          `export default ${JSON.stringify(value)};`,
        );
      }
      fs.unlinkSync(path.join(root, "current"));
      fs.symlinkSync(previous, path.join(root, "current"));
      const payload = `
import fs from "node:fs";
fs.symlinkSync(${JSON.stringify(next)}, ${JSON.stringify(path.join(root, "replacement"))});
fs.renameSync(${JSON.stringify(path.join(root, "replacement"))}, ${JSON.stringify(path.join(root, "current"))});
console.log(JSON.stringify({cwd: process.cwd(), entry: process.argv[1], args: process.argv.slice(2), lazy: (await import("./lazy.js")).default}));
`;
      fs.writeFileSync(path.join(previous, "dist", "index.js"), payload, { mode: 0o444 });
      expect(await f.installLauncher()).toBe(launcher);
      const launched = spawnSync(launcher, ["--port", "19547"], { encoding: "utf8" });
      expect(launched.stderr).not.toContain("Cannot start");
      expect(launched.status).toBe(0);
      expect(JSON.parse(launched.stdout)).toEqual({
        cwd: previous,
        entry: path.join(previous, "dist", "index.js"),
        args: ["gateway", "--port", "19547"],
        lazy: "previous",
      });
      expect(fs.realpathSync(path.join(root, "current"))).toBe(next);
      fs.unlinkSync(path.join(root, "current"));
      fs.symlinkSync(path.dirname(root), path.join(root, "current"));
      const refused = spawnSync(launcher, [], { encoding: "utf8" });
      expect(refused.status).toBe(78);
      expect(refused.stderr).toContain("direct releases/<full-sha>");
      fs.writeFileSync(launcher, "foreign launcher\n");
      await expect(f.installLauncher()).rejects.toThrow("conflicts");
      expect(readText(launcher)).toBe("foreign launcher\n");
    });

    it("gates supervisor replacements through durable stop phases until the owner authorizes startup", async () => {
      const f = await setup();
      for (const [phase, selected, allowed] of [
        ["prepared", f.oldSha, true],
        ["draining", f.oldSha, true],
        ["stopping", f.oldSha, false],
        ["stopped", f.oldSha, false],
        ["publishing", f.oldSha, false],
        ["starting", f.nextSha, true],
        ["verifying", f.nextSha, true],
        ["rollback-stopping", f.nextSha, false],
        ["rollback-publishing", f.nextSha, false],
        ["rollback-starting", f.oldSha, true],
        ["rolled-back", f.oldSha, true],
      ] as const) {
        f.select(selected);
        f.write(f.operation(phase));
        f.expectLaunch(allowed ? selected : "", phase);
      }
    });

    it("fences a supervisor replacement after the original host exits before native stop dispatch", async () => {
      const f = await setup();
      const entry = path.join(f.descriptor.current.path, "dist", "index.js");
      fs.writeFileSync(
        entry,
        `console.log("Gateway admitted"); await new Promise(resolve => { process.stdin.once("end", resolve); process.stdin.resume(); });`,
      );
      fs.chmodSync(entry, 0o444);
      f.write(f.operation("draining"));
      const original = spawn(f.launcher, [], { stdio: ["pipe", "pipe", "pipe"] });
      const closed = new Promise<number | null>((resolve) => {
        original.once("close", resolve);
      });
      const started = new Promise<void>((resolve, reject) => {
        original.stdout.once("data", () => resolve());
        original.once("error", reject);
        original.once("exit", () => reject(new Error("Original fixture exited before admission")));
      });
      try {
        await started;
        // The real control marker is durable before the owned old process exits.
        f.write(f.operation("stopping"));
        original.stdin.end();
        expect(await closed).toBe(0);
        f.expectLaunch();
        f.write(f.operation("rollback-starting"));
        f.expectLaunch("Gateway admitted");
      } finally {
        if (original.exitCode === null) {
          original.kill("SIGKILL");
        }
        await closed;
      }
    });

    it("preserves no-record and version-1 preparation launches across a bridge pointer change", async () => {
      const f = await setup();
      expect(f.launch().stdout.trim()).toBe(f.oldSha);
      f.descriptor.version = 1;
      delete f.descriptor.activationEnabled;
      f.write(null, true);
      fs.unlinkSync(path.join(f.root, "current"));
      fs.symlinkSync(`releases/${f.nextSha}`, path.join(f.root, "current"));
      f.expectLaunch(f.nextSha);
    });

    it("admits a version-3 bridge while the published v2 launcher refuses before execution", async () => {
      const f = await setup();
      f.descriptor.version = 3;
      f.descriptor.releaseRetention = {
        version: 1,
        mode: "inspect",
        keepVerifiedGenerations: 3,
        pins: [],
      };
      f.write(null);
      f.expectLaunch();
      fs.writeFileSync(
        path.join(f.descriptor.current.path, "package.json"),
        JSON.stringify({
          type: "module",
          openclaw: { immutableInstallDescriptorVersion: 3 },
        }),
      );
      f.expectLaunch(f.oldSha);
      fs.writeFileSync(f.launcher, previousLauncher(2));
      const before = readBytes(f.journal);
      f.expectLaunch();
      expect(readBytes(f.journal)).toEqual(before);
    });

    it("refuses malformed, unknown and mismatched version-2 startup state", async () => {
      const f = await setup();
      for (const activation of [
        [],
        { operation: null },
        f.operation("future-phase"),
        f.operation("recovery-required"),
        f.operation("starting"),
      ]) {
        f.write(activation);
        f.expectLaunch();
      }
      f.write(null);
      fs.unlinkSync(path.join(f.root, "current"));
      fs.symlinkSync(`releases/${f.nextSha}`, path.join(f.root, "current"));
      expect(f.launch().status).toBe(78);
      fs.unlinkSync(f.journal);
      f.expectLaunch();
    });

    it("refuses a hot activation journal without replaying or changing its source bytes", async () => {
      const f = await setup();
      f.write(f.operation("stopping"));
      createHotSqliteRollbackJournal({
        path: f.journal,
        mutationSql: "UPDATE immutable_installation SET activation_json='null'",
      });
      const before = [readBytes(f.journal), readBytes(`${f.journal}-journal`)];
      f.expectLaunch();
      expect([readBytes(f.journal), readBytes(`${f.journal}-journal`)]).toEqual(before);
    });

    it.each([1, 2] as const)(
      "upgrades only the exact opted-in v%i launcher and retains its original bytes",
      async (version) => {
        const f = await setup(false);
        const previous = previousLauncher(version);
        f.seedLauncher(previous);
        await expect(f.installLauncher()).rejects.toThrow("conflicts");
        const oldIdentity = fileIdentity(f.launcher);
        await f.upgrade(version);
        expect(fileIdentity(f.launcher)).not.toBe(oldIdentity);
        expect(readText(f.control, `openclaw-gateway.v${version}`)).toBe(previous);
        f.write(f.operation("stopping"));
        expect(f.launch().status).toBe(78);
        const current = readBytes(f.launcher);
        await f.upgrade(version);
        expect(readBytes(f.launcher)).toEqual(current);
      },
    );

    it.each([1, 2] as const)(
      "preserves an unknown launcher despite explicit v%i upgrade authorization",
      async (version) => {
        const f = await setup(false);
        const previous = `#!${runtime}\n// custom operator launcher\n`;
        f.seedLauncher(previous);
        await expect(f.upgrade(version)).rejects.toThrow(`known v${version} upgrade`);
        expect(readText(f.launcher)).toBe(previous);
        expect(fs.readdirSync(f.control)).toEqual([]);
      },
    );

    it("keeps the original launcher when upgrade authority is revoked after backup publication", async () => {
      const f = await setup(false);
      const previous = previousLauncher(1);
      f.seedLauncher(previous);
      let current = true;
      const rename = fs.renameSync;
      vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
        rename(source, destination);
        if (String(destination) === path.join(f.control, "openclaw-gateway.v1")) {
          current = false;
        }
      });
      await expect(
        f.upgrade(1, () => {
          if (!current) {
            throw new Error("upgrade authority ended");
          }
        }),
      ).rejects.toThrow("upgrade authority ended");
      expect(readText(f.launcher)).toBe(previous);
      expect(readText(f.control, "openclaw-gateway.v1")).toBe(previous);
    });
  },
);
