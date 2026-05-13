import esbuild from "esbuild";
import process from "node:process";
import { builtinModules } from "node:module";
import fs from "node:fs/promises";

const prod = process.argv[2] === "production";

// DuckDB WASM ships its worker as a regular .js file. Import it as a text
// string so we can wrap it in a same-origin Blob URL at runtime (the Electron
// custom-scheme renderer can't load cross-origin worker scripts directly).
//
// While we're at it, strip the body of `_emscripten_async_load_script`. The
// helper is Emscripten runtime boilerplate (gets emitted into every -sASYNCIFY
// build); it calls `document.createElement("script")` and `eval(data)`. In our
// usage it is dead code in two ways:
//   1. Workers have no `document` global, so reaching the createElement call
//      would throw immediately.
//   2. DuckDB-wasm's own code paths never invoke the helper; it is only
//      exposed via the wasm imports table for the generic Emscripten case.
// Replacing the body with a throw stub keeps the symbol bound (the imports
// table reference stays valid) while removing the patterns the Obsidian
// Community scanner heuristically flags as "dynamic script creation" and
// "eval of network response".
const STRIP_EMSCRIPTEN_SCRIPT_LOADER =
  /var _emscripten_async_load_script=function\(url,onload,onerror\)\{[\s\S]*?\};(?=_emscripten_async_load_script\.sig)/g;
const ASYNC_LOAD_SCRIPT_STUB =
  'var _emscripten_async_load_script=function(){throw new Error("emscripten_async_load_script unreachable in worker context")};';

const duckdbWorkerAsText = {
  name: "duckdb-worker-as-text",
  setup(build) {
    build.onLoad(
      { filter: /@duckdb[\\\/]duckdb-wasm[\\\/]dist[\\\/]duckdb-browser-(eh|mvp)\.worker\.js$/ },
      async (args) => {
        const raw = await fs.readFile(args.path, "utf8");
        const stripped = raw.replace(STRIP_EMSCRIPTEN_SCRIPT_LOADER, ASYNC_LOAD_SCRIPT_STUB);
        if (stripped === raw) {
          throw new Error(
            `esbuild config: _emscripten_async_load_script strip pattern did not match ${args.path}; ` +
              `the duckdb-wasm build may have changed shape. Inspect and update the regex.`,
          );
        }
        return { contents: stripped, loader: "text" };
      },
    );
  },
};

const context = await esbuild.context({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", ...builtinModules],
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
