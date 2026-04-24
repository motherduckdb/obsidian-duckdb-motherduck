import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";
import fs from "node:fs/promises";

const prod = process.argv[2] === "production";

// DuckDB WASM ships its worker as a regular .js file. Import it as a text
// string so we can wrap it in a same-origin Blob URL at runtime (the Electron
// custom-scheme renderer can't load cross-origin worker scripts directly).
const duckdbWorkerAsText = {
  name: "duckdb-worker-as-text",
  setup(build) {
    build.onLoad(
      { filter: /@duckdb[\\\/]duckdb-wasm[\\\/]dist[\\\/]duckdb-browser-(eh|mvp)\.worker\.js$/ },
      async (args) => ({
        contents: await fs.readFile(args.path, "utf8"),
        loader: "text",
      }),
    );
  },
};

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtins],
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  outfile: "main.js",
  minify: prod,
  plugins: [duckdbWorkerAsText],
});

if (prod) {
  await context.rebuild();
  context.dispose();
} else {
  await context.watch();
}
