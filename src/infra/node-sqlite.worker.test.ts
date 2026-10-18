import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runNodeScript } from "../../test/helpers/run-node-script.js";

it("admits the loaded SQLite library once before sibling workers open databases", async ({
  signal,
}) => {
  const preload = fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url));
  const sqliteUrl = new URL("./node-sqlite.ts", import.meta.url).href;
  const runtimeUrl = new URL("./sqlite-runtime-initialize.ts", import.meta.url).href;
  const workerSource = `
    const { parentPort } = require("node:worker_threads");
    const { DatabaseSync } = require("node:sqlite");
    let probes = 0;
    const prepare = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (sql) {
      if (sql.includes("sqlite_version()")) probes++;
      return prepare.call(this, sql);
    };
    import(${JSON.stringify(sqliteUrl)}).then(({ openNodeSqliteDatabase }) => {
      const db = openNodeSqliteDatabase(":memory:");
      const row = db.prepare("SELECT 42 AS value").get();
      db.close();
      parentPort.postMessage({ probes, value: row.value });
    });
  `;
  const result = await runNodeScript(
    [
      "--import",
      preload,
      "--input-type=module",
      "-e",
      `
        import { once } from "node:events";
        import { DatabaseSync } from "node:sqlite";
        import { Worker } from "node:worker_threads";
        let probes = 0;
        const prepare = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function (sql) {
          if (sql.includes("sqlite_version()")) probes++;
          return prepare.call(this, sql);
        };
        const { initializeSqliteRuntime } = await import(${JSON.stringify(runtimeUrl)});
        await initializeSqliteRuntime();
        const workers = [0, 1].map(() => new Worker(${JSON.stringify(workerSource)}, {
          eval: true, execArgv: ["--import", ${JSON.stringify(preload)}],
        }));
        const rows = await Promise.all(workers.map(async (worker) => {
          const exited = once(worker, "exit");
          const [row] = await once(worker, "message");
          await exited;
          return row;
        }));
        console.log(JSON.stringify({ probes, rows }));
      `,
    ],
    { ...process.env, NODE_OPTIONS: "" },
    undefined,
    { signal },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({
    probes: 1,
    rows: [
      { probes: 0, value: 42 },
      { probes: 0, value: 42 },
    ],
  });
});
