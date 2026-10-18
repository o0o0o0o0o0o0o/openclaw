import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  prepareBundledPluginRuntime,
  stageBundledPluginRuntime,
} from "../../scripts/stage-bundled-plugin-runtime.mts";
import { readInstalledPluginOverview } from "../../src/plugins/installed-plugin-overview.js";
import { createPluginCache, withPluginCache } from "../../src/plugins/plugin-cache.js";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createCommandFixture } from "../helpers/command-fixture.js";

let repoRoot: string;
let runtimeRoot: string;
let aliasRoot: string;
const read = (file: string) => fs.readFileSync(file, "utf8");
const inode = (file: string) => fs.statSync(file).ino;
const runtimeFile = (file: string) => path.join(runtimeRoot, "extensions/demo", file);
const stagingDirs = () =>
  fs.readdirSync(repoRoot).filter((name) => name.startsWith(".openclaw-runtime-"));
function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
beforeEach(async () => {
  repoRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "openclaw-stage-runtime-"));
  runtimeRoot = path.join(repoRoot, "dist-runtime");
  aliasRoot = path.join(repoRoot, "dist/extensions/node_modules/openclaw");
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.promises.rm(repoRoot, { recursive: true, force: true });
});

describe("stageBundledPluginRuntime", () => {
  it("copies files when Windows rejects runtime overlay symlinks", async () => {
    write(path.join(repoRoot, "dist/extensions/acpx/assets/fixture.txt"), "asset-body\n");
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const symlinkSpy = vi
      .spyOn(fs, "symlinkSync")
      .mockImplementation((_target, targetPath, type) => {
        if (
          String(targetPath).includes(`${path.sep}dist-runtime${path.sep}`) &&
          type !== "junction"
        ) {
          throw Object.assign(new Error("no symlink privilege"), { code: "EPERM" });
        }
        return undefined;
      });

    stageBundledPluginRuntime({ repoRoot });
    const output = path.join(runtimeRoot, "extensions/acpx/assets/fixture.txt");
    expect(read(output)).toBe("asset-body\n");
    expect(fs.lstatSync(output).isSymbolicLink()).toBe(false);
    expect(symlinkSpy).toHaveBeenCalled();
  });

  it("refuses to stage through a symlinked dist root", async () => {
    const targetDir = path.join(repoRoot, "gateway-dist");
    const pluginFile = path.join(targetDir, "extensions", "acpx", "index.js");
    write(pluginFile, "export {};\n");
    const distLink = path.join(repoRoot, "dist");
    await fs.promises.symlink(targetDir, distLink, "dir");

    expect(() => stageBundledPluginRuntime({ repoRoot })).toThrow(/symbolic link/u);
    expect(await fs.promises.readlink(distLink)).toBe(targetDir);
    expect(read(pluginFile)).toBe("export {};\n");
    for (const output of [runtimeRoot, path.join(targetDir, "extensions/node_modules")]) {
      await expect(fs.promises.stat(output)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});

function writeRuntimeFixture() {
  const files = {
    "package.json": JSON.stringify({
      name: "openclaw",
      type: "module",
      exports: { "./plugin-sdk/demo": "./dist/plugin-sdk/demo.js" },
    }),
    "dist/plugin-sdk/demo.js": "export const generation = 'candidate';\n",
    "dist/extensions/demo/index.js": "export const generation = 'candidate';\n",
    "dist/extensions/demo/package.json": '{"name":"demo","type":"module"}\n',
    "dist/extensions/demo/assets/info.txt": "candidate asset\n",
    "dist/extensions/demo/README.md": "# Candidate plugin\n",
  };
  for (const [relative, content] of Object.entries(files)) {
    write(path.join(repoRoot, relative), content);
  }
}

describe("prepareBundledPluginRuntime", () => {
  beforeEach(writeRuntimeFixture);

  it("admits a cold source checkout before its dependencies are installed", async (context) => {
    const command = createCommandFixture(context, "tree");
    const coldRoot = command.createTempDir("openclaw-cold-source-");
    const { collectRuntimeImportClosure } =
      await import("../../scripts/lib/runtime-import-closure.mts");
    const sourceRoot = process.cwd();
    try {
      for (const file of collectRuntimeImportClosure(sourceRoot, [
        "scripts/stage-bundled-plugin-runtime.mts",
      ])) {
        const target = path.join(coldRoot, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(sourceRoot, file), target);
      }
      write(path.join(coldRoot, "package.json"), '{"name":"openclaw","type":"module"}');
      const owner = pathToFileURL(
        path.join(sourceRoot, "scripts/lib/source-update-artifact-preflight.mts"),
      ).href;
      const result = await command.run(
        resolveTestNodeExecPath(),
        [
          "--input-type=module",
          "--eval",
          `import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { inspectSourceUpdateArtifacts } from ${JSON.stringify(owner)};
execFileSync("git", ["init", "--quiet"]);
const admission = await inspectSourceUpdateArtifacts(process.cwd());
try {
  assert(admission.lock);
  assert(fs.existsSync(".artifacts/dist-artifacts.lock/owner.json"));
  assert.equal(admission.sourceRuntimePrepared, true);
} finally {
  await admission.lock?.release();
}`,
        ],
        { cwd: coldRoot, env: { ...process.env, NODE_OPTIONS: "" } },
      );
      expect(result.status, result.stderr).toBe(0);
      for (const entry of [
        "node_modules",
        "dist",
        "dist-runtime",
        ".artifacts/dist-artifacts.lock/owner.json",
      ]) {
        expect(fs.existsSync(path.join(coldRoot, entry)), entry).toBe(false);
      }
      expect(fs.readdirSync(coldRoot).some((entry) => entry.startsWith(".openclaw-runtime-"))).toBe(
        false,
      );
    } finally {
      await command.lifetime.cleanup();
    }
  });

  it("prepares both roots without mutation and publishes imports valid at their final paths", async () => {
    const prepared = prepare(true);
    for (const root of [runtimeRoot, aliasRoot, path.dirname(aliasRoot)]) {
      expect(fs.existsSync(root), root).toBe(false);
    }
    await prepared.publish(() => undefined);
    await prepared.cleanup();
    const runtime = await import(pathToFileURL(runtimeFile("index.js")).href);
    const sdk = await import(pathToFileURL(path.join(aliasRoot, "plugin-sdk/demo.js")).href);
    expect(runtime.generation).toBe("candidate");
    expect(
      withPluginCache(createPluginCache(), () =>
        readInstalledPluginOverview({
          rootDir: runtimeFile(""),
          origin: "bundled",
          providers: [],
          channels: [],
        }),
      )?.readme,
    ).toBe("# Candidate plugin\n");
    expect(sdk.generation).toBe("candidate");
    expect(read(runtimeFile("assets/info.txt"))).toBe("candidate asset\n");
    const before = [runtimeRoot, aliasRoot].map(inode);
    const unchanged = prepare(false);
    await unchanged.publish(() => {
      throw new Error("unchanged artifacts need no publication authority");
    });
    await unchanged.cleanup();
    expect([runtimeRoot, aliasRoot].map(inode)).toEqual(before);
  });

  it("preserves canonical static assets without writing through staging links", async () => {
    vi.stubEnv("OPENCLAW_RUNTIME_POSTBUILD_STATIC_ASSETS", undefined);
    const sourceRoot = path.join(repoRoot, "dist/extensions/demo");
    const staticAssets = ["index.html", "assets/app.js", "assets/app.css"].map((name) => ({
      source: `client/${name}`,
      output: `dist/control-ui/${name}`,
    }));
    fs.writeFileSync(
      path.join(sourceRoot, "package.json"),
      JSON.stringify({ name: "demo", type: "module", openclaw: { build: { staticAssets } } }),
    );
    for (const asset of staticAssets) {
      write(path.join(sourceRoot, asset.output), `raw ${asset.output}\n`);
    }
    stageBundledPluginRuntime({ repoRoot });
    const aliasBefore = inode(aliasRoot);
    const liveStatic = runtimeFile("dist/control-ui");
    fs.rmSync(liveStatic, { recursive: true });
    const firstAsset = path.join(sourceRoot, staticAssets[0]!.output);
    const sourceBefore = fs.statSync(firstAsset).mtimeMs;
    const prepared = prepare(true);
    expect(fs.existsSync(liveStatic)).toBe(false);
    expect(fs.statSync(firstAsset).mtimeMs).toBe(sourceBefore);
    await prepared.publish(() => undefined);
    await prepared.cleanup();
    expect(inode(aliasRoot)).toBe(aliasBefore);
    for (const asset of staticAssets) {
      const output = runtimeFile(asset.output);
      expect(fs.lstatSync(output).isFile()).toBe(true);
      expect(read(output)).toBe(`raw ${asset.output}\n`);
    }
    const unchanged = prepare(false);
    await unchanged.cleanup();
  });

  it("detects stale mode even when every required path exists", async () => {
    stageBundledPluginRuntime({ repoRoot });
    fs.chmodSync(runtimeFile("package.json"), 0o444);
    const prepared = prepare(true);
    await prepared.cleanup();
  });

  it("leaves both live roots intact when preparation fails", async () => {
    stageBundledPluginRuntime({ repoRoot });
    const before = [runtimeRoot, aliasRoot].map(inode);
    const originalWrite = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, "writeFileSync").mockImplementation((target, ...args) => {
      if (String(target).includes(".openclaw-runtime-")) {
        throw new Error("staging write failed");
      }
      return originalWrite(target, ...args);
    });
    expect(() => prepareBundledPluginRuntime({ repoRoot })).toThrow("staging write failed");
    expect([runtimeRoot, aliasRoot].map(inode)).toEqual(before);
    expect(stagingDirs()).toEqual([]);
    expect(fs.readdirSync(path.dirname(aliasRoot))).toEqual(["openclaw"]);
  });

  it("restores originals when alias publication fails", async () => {
    stageBundledPluginRuntime({ repoRoot });
    writeOriginals();
    const prepared = prepareBundledPluginRuntime({ repoRoot });
    const originalRename = fs.renameSync.bind(fs);
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (String(destination) === aliasRoot && path.basename(String(source)) === "candidate") {
        throw new Error("alias publication failed");
      }
      originalRename(source, destination);
    });
    await expect(prepared.publish(() => undefined)).rejects.toThrow("alias publication failed");
    await prepared.cleanup();
    expect([runtimeRoot, aliasRoot].map((root) => read(path.join(root, "original.txt")))).toEqual([
      "original runtime",
      "original alias",
    ]);
    expect(fs.readdirSync(path.dirname(aliasRoot))).toEqual(["openclaw"]);
  });

  it("keeps live paths present when authority is revoked between root swaps", async () => {
    stageBundledPluginRuntime({ repoRoot });
    writeOriginals();
    const aliasBefore = inode(aliasRoot);
    const prepared = prepareBundledPluginRuntime({ repoRoot });
    let checks = 0;
    await expect(
      prepared.publish(() => {
        expect(
          [runtimeRoot, aliasRoot].map(fs.existsSync),
          "authority checks must not expose absent roots",
        ).toEqual([true, true]);
        if (++checks > 1) {
          throw new Error("authority revoked");
        }
      }),
    ).rejects.toThrow("Runtime publication and restoration failed");
    await prepared.cleanup();
    expect(fs.existsSync(runtimeFile("index.js"))).toBe(true);
    expect(inode(aliasRoot)).toBe(aliasBefore);
    const retained = stagingDirs()[0];
    expect(read(path.join(repoRoot, retained!, "previous/original.txt"))).toBe("original runtime");
  });

  it("keeps supported Windows copy fallbacks unchanged", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const symbolicLink = vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("no symlink privilege"), { code: "EPERM" });
    });
    stageBundledPluginRuntime({ repoRoot });
    const copied = prepare(false);
    await copied.cleanup();
    symbolicLink.mockRestore();
    const prepared = prepare(false);
    await prepared.cleanup();
    expect(fs.lstatSync(runtimeFile("assets/info.txt")).isFile()).toBe(true);
  });
});

function writeOriginals() {
  write(path.join(runtimeRoot, "original.txt"), "original runtime");
  write(path.join(aliasRoot, "original.txt"), "original alias");
}

function prepare(changed: boolean) {
  const prepared = prepareBundledPluginRuntime({ repoRoot });
  expect(prepared.changed).toBe(changed);
  return prepared;
}
