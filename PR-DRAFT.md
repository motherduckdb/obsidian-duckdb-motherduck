## Why

The recent **cooperative-networking** work dropped the `SharedArrayBuffer` / cross-origin-isolation requirement on `@motherduck/wasm-client`, unblocking plain `https://` pages. This PR closes the second distribution blocker: **Electron-style embedders** — Obsidian plugins, VS Code extensions, Tauri apps, browser extensions.

Together, the WASM SDK now works in custom-scheme renderers out of the box. A "MotherDuck for Obsidian" community plugin is ~300 KB of JS running pure WASM — no native addons, no per-platform prebuilds.

## Problem

`createCrossOriginWorkerUrl` wrapped the remote URL in a blob worker whose body is `importScripts("${url}")`. That works on `https://` (server CORS handles it), but **Chromium refuses cross-origin `importScripts` inside a worker whose origin is a custom Electron scheme** (`app://`, `vscode-webview://`, `chrome-extension://`) — the scheme isn't registered with `corsEnabled: true`, so the block happens before CORS headers are consulted.

Captured in an Obsidian plugin spike using `@motherduck/wasm-client@0.8.1`:

```
Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope':
  The script at 'https://app.motherduck.com/main@.../duckdb-browser-eh.worker.1.33.1-dev39.0.js' failed to load.
  at blob:app://obsidian.md/<uuid>
```

## Fix

Move the cross-origin network hop from `importScripts` (blocked) to `fetch` (respects CORS — works). The Worker still runs from a same-origin blob — just with the real source inlined instead of a bootstrap wrapper.

```diff
-export function createCrossOriginWorkerUrl(url: string): string {
-  return URL.createObjectURL(new Blob([`importScripts("${url}");`], ...));
-}
+export async function createCrossOriginWorkerUrl(url: string): Promise<string> {
+  const response = await fetch(url);
+  if (!response.ok) throw new Error(`Failed to fetch worker source from ${url}: ${response.status} ${response.statusText}`);
+  return URL.createObjectURL(new Blob([await response.text()], ...));
+}
```

Signature becomes `async`. Two `await`s added in `createDuckDBWasmInstance` (already `async`). 3 files, +19 / -9 lines.

## Tests

New `test/createWorkerUrl.test.ts` — 6 tests, browser-mode vitest (the same suite that ran before):

- `createWorkerUrl` with local path → returned unchanged, no fetch.
- `createWorkerUrl` with https → returns a same-origin blob URL, `crossOrigin: true`.
- `createCrossOriginWorkerUrl` with non-OK response → throws with descriptive message.
- `createCrossOriginWorkerUrl` happy path → blob content equals fetched source verbatim.
- **Smoke test** — spawns a real `new Worker(blobUrl)`, sends a message, asserts it boots and responds. Implicitly catches a revert (the old wrapper would fail to load its `importScripts` target).
- **Regression test** — asserts blob body does NOT contain `importScripts(`, with a comment naming the Electron/Obsidian `app://` context.

We can't simulate the Electron scheme block in vitest browser mode (Chrome on `http://localhost`, where cross-origin `importScripts` is allowed). The regression guard is at the **pattern level** — fails immediately if the old wrapper is reintroduced.

## Why this is portable

- Server CORS on our CDN is already permissive (`access-control-allow-origin: *`, `cross-origin-resource-policy: cross-origin`), so `fetch` cross-origin works identically to what `importScripts` was doing.
- Resulting Worker still runs from a same-origin blob URL.
- Worker source byte-for-byte unchanged.
- Transient ~150 KB string on main thread during init. One-time cost.
- Explicit HTTP error is better DX than the previous silent `importScripts` NetworkError.

## Downstream unblocks

Obsidian plugins · VS Code extensions · Tauri apps · browser extensions · any customer Electron app embedding `@motherduck/wasm-client`.

## Release notes

> `@motherduck/wasm-client`: unblock usage in Electron-style embedders (Obsidian plugins, VS Code extensions, Tauri apps, browser extensions). The DuckDB Wasm worker is now fetched and inlined into a same-origin blob instead of loaded via cross-origin `importScripts`. No behavior change on `https://` hosts.
