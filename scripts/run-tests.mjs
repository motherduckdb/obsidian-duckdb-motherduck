import esbuild from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const root = process.cwd();
const testDir = path.join(root, "test");
const outDir = path.join(tmpdir(), `obsidian-duckdb-motherduck-tests-${process.pid}`);

async function findTests(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findTests(fullPath));
    } else if (entry.name.endsWith(".test.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

const testFiles = await findTests(testDir);
if (testFiles.length === 0) {
  console.error("No test files found.");
  process.exit(1);
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: testFiles,
  outdir: outDir,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: "inline",
  external: ["node:*"],
  logLevel: "silent",
});

const outFiles = testFiles.map((file) =>
  path.join(outDir, path.basename(file).replace(/\.ts$/, ".js")),
);
const result = spawnSync(process.execPath, ["--test", ...outFiles], {
  stdio: "inherit",
});

await rm(outDir, { recursive: true, force: true });
process.exit(result.status ?? 1);
