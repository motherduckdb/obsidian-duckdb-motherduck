# MotherDuck Obsidian Plugin — Design

## Context

Personal "LLM wiki" use case: notes in an Obsidian vault are read by LLM agents, so cached SQL results need to live as plain markdown *alongside* the query (not as sidecar files or interactive widgets). Two features are in scope:

1. **Query caching.** A ` ```motherduck ` code block in a note can be "frozen": the plugin runs the SQL, writes the result as a markdown table directly below the block, bracketed by sentinel comments. Both human readers and LLMs see `query + result` as one document.
2. **Dives embedding.** A ` ```motherduck-dive ` block renders a MotherDuck Dive as an iframe for interactive exploration.

Target: desktop-only for the prototype. Publish to Obsidian community plugins eventually. MotherDuck branding / product surface is part of the value.

## Intended user flows

Three complementary trigger surfaces, all going through the same plugin code:

1. **Human in Obsidian, live preview.** User writes a SQL block, clicks ▶ Run in reading mode, sees the result inline — ephemeral, doesn't modify the file.
2. **Human in Obsidian, freeze.** Command palette → "Freeze MotherDuck query at cursor" → plugin writes sentinel-bracketed markdown table below the block, persistent.
3. **Agent on the command line.** Claude Code or any script calls `obsidian eval code="app.plugins.getPlugin('motherduck').api.refreshFile('<path>')"` to refresh all queries in a note. Plugin does the work; agent is a thin trigger.

Flows 2 and 3 produce identical on-disk output — same sentinel format, same renderer. One source of truth.

## Architecture

```
┌────────────────────────────────────────────────────────┐
│ Obsidian Plugin = single source of truth               │
│                                                        │
│   ┌─────────────────────────────────────────────────┐  │
│   │ Cache block format (parse + write)              │  │
│   │ Sentinel: <!-- md:cache hash=… ts=… rows=… -->  │  │
│   └─────────────────────────────────────────────────┘  │
│                                                        │
│   ┌─────────────────────────────────────────────────┐  │
│   │ SQL execution (swappable Runtime interface)     │  │
│   │   v1: @duckdb/node-api (desktop-only)           │  │
│   │   v2: @motherduck/wasm-client (once unblocked)  │  │
│   └─────────────────────────────────────────────────┘  │
│                                                        │
│   ┌─────────────────────────────────────────────────┐  │
│   │ Commands + API                                  │  │
│   │   motherduck:refresh-current-note               │  │
│   │   motherduck:freeze-at-cursor                   │  │
│   │   motherduck:refresh-folder                     │  │
│   │   app.plugins.getPlugin('motherduck').api.*     │  │
│   └─────────────────────────────────────────────────┘  │
│                                                        │
│   ┌─────────────────────────────────────────────────┐  │
│   │ Reading-mode UI                                 │  │
│   │   ```motherduck → SQL panel + ▶ Run + table     │  │
│   │   ```motherduck-dive → iframe embed             │  │
│   └─────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────┘
         ▲                              ▲
    human clicks ▶                 agent calls
  or command palette          obsidian eval code="…"
                               (or URI handler)
```

## Why the plugin is the right primitive (vs. a Claude Code skill)

An earlier version of this plan pivoted to a Claude Code skill that did the work entirely agent-side (run SQL via MCP, write markdown via Edit tool, no plugin). It would technically work for the agent flow. But the plugin delivers materially more:

|                                                 | Plugin | Skill |
|-------------------------------------------------|:------:|:-----:|
| Human clicks ▶ in a note, sees result inline   |   ✓    |   ✗   |
| Freeze query result without leaving Obsidian    |   ✓    |   ✗   |
| Works when Claude Code isn't running            |   ✓    |   ✗   |
| Syntax-highlighted SQL + native rendering       |   ✓    |   ✗   |
| Dives iframe embed                              |   ✓    |   ✗   |
| Agent-triggered refresh on schedule             |   ✓    |   ✓   |
| Published to Obsidian community                 |   ✓    |   ✗   |
| Discoverable to non-agent Obsidian users        |   ✓    |   ✗   |
| MotherDuck product surface                      |   ✓    |   ✗   |

The plugin owns execution and file-writing. The agent simply *triggers* it via `obsidian eval` — same code path as the human pressing a button. A skill in addition is fine but strictly optional (it'd just be a thin wrapper that calls the same plugin API).

## Execution backend — prototype

### Choice: `@duckdb/node-api`

Native Node.js bindings to DuckDB, ships prebuilt `.node` binaries per `{platform}-{arch}`. MotherDuck support is built in:

```ts
const instance = await DuckDBInstance.fromCache('md:?motherduck_token=' + token);
const connection = await instance.connect();
const result = await connection.run('SELECT 42');
```

Use `DuckDBInstance.fromCache(...)` not `.create(...)` — without caching, every query re-downloads the MD extension + re-fetches the catalog (~1 s hit per query).

### Trade-offs vs. WASM (today)

| Dimension                   | `@duckdb/node-api`              | `@motherduck/wasm-client`        |
|----------------------------|---------------------------------|----------------------------------|
| Works in Obsidian today    | ✓                               | ✗ (see blockers below)           |
| Query performance          | Native, fastest                 | WASM, ~20–50% slower             |
| Distribution size          | ~20 MB per platform (~60 MB total if bundled all) | ~7 MB gzipped, one build |
| Desktop support            | macOS arm64/x64, Win, Linux     | Same                             |
| Mobile (iOS/Android)       | ✗ (no native addons)            | ✓ (in theory, once unblocked)    |
| Community plugin review    | Native addons uncommon, adds scrutiny | Standard JS bundle, clean       |
| Upstream fragility         | Stable                          | Library assumes browser context  |

WASM is the better long-term distribution story. But today, Node.js actually works, so prototype with it and revisit once WASM is unblocked.

## WASM limitations — deep dive

There are **two** separate things people conflate when saying "WASM doesn't work in Electron apps". They have different causes, different statuses, different fixes. I'll name them explicitly.

### Blocker 1 — SharedArrayBuffer / Cross-Origin Isolation

**What it is.** The classic DuckDB-WASM build uses `SharedArrayBuffer` to let a worker and the main thread share memory efficiently. Modern browsers only allow `SharedArrayBuffer` if the page is "cross-origin isolated" — i.e. served with `Cross-Origin-Opener-Policy: same-origin` *and* `Cross-Origin-Embedder-Policy: require-corp` headers. Obsidian's renderer doesn't set those headers, and plugins can't change them.

**Status: LIFTED.** MotherDuck recently shipped a "cooperative networking" path in the WASM extension that doesn't need SharedArrayBuffer. We can opt into it from the SDK via `useDuckDBWasmCOI: false`, and the MD extension on the server side delivers a SAB-free build. Good. **This is not what's blocking us now.**

### Blocker 2 — Cross-origin `importScripts` in Electron workers

**What it is.** DuckDB's WASM worker isn't bundled into the SDK (to keep it small and allow CDN updates). Instead, the SDK does this pattern at runtime:

```js
// simplified, from @duckdb/duckdb-wasm:
const bootstrapSource = `importScripts("${bundle.mainWorker}");`;
const blobURL = URL.createObjectURL(
  new Blob([bootstrapSource], { type: 'text/javascript' })
);
const worker = new Worker(blobURL);
```

It creates a tiny "bootstrap" blob worker (same-origin by construction), and inside it calls `importScripts('https://app.motherduck.com/.../duckdb-worker.js')` to pull in the real worker code cross-origin from the MD CDN.

**Why this works in browsers but fails in Obsidian.** In a standard `https://` browser page, cross-origin `importScripts()` inside a classic worker is allowed if the server sends permissive CORS headers. MD's CDN sends `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`. Server side is fine.

Obsidian, however, is an Electron app. Obsidian's renderer runs at a custom scheme: `app://obsidian.md`. In Electron, custom schemes have to be explicitly flagged as "CORS-enabled" via `protocol.registerSchemesAsPrivileged({ corsEnabled: true })` to make cross-origin subresource loading work. Obsidian doesn't set that flag. The result: Chromium rejects the `importScripts(httpsUrl)` call inside the blob worker with `NetworkError`, regardless of what headers the server sends. *This is exactly the same reason Obsidian plugins need `requestUrl()` instead of `fetch()` for plain HTTP requests.*

**The failure signature** (captured in the Phase 0 spike):

```
Uncaught NetworkError: Failed to execute 'importScripts' on 'WorkerGlobalScope':
The script at 'https://app.motherduck.com/main@…/duckdb-browser-eh.worker.1.33.1-dev39.0.js'
failed to load.
  at blob:app://obsidian.md/<uuid>
```

**Important: this is not a bug in DuckDB-WASM.** The `importScripts` bootstrap pattern is standard, used by most WASM libraries (pyodide, onnxruntime-web, sql.js, ffmpeg.wasm). It's the *right* choice for the 99% case (browsers on `https://`). It's also more memory-efficient than the alternative. DuckDB-WASM just didn't need to work inside custom-scheme Electron renderers until now.

### What would unblock WASM

The fix is conceptually simple: replace the `importScripts(crossOriginUrl)` step with `fetch(crossOriginUrl) → text → new Blob(text) → Worker(blobURL)`. This moves the cross-origin network request from `importScripts` (which Obsidian blocks) to `fetch` (which works because MD's CORS is permissive). The worker then runs from a same-origin blob. The worker itself fetches `.wasm` via plain `fetch`, which also works.

Concretely:

```js
// today (blocked in Obsidian):
const source = `importScripts("${bundle.mainWorker}");`;
const worker = new Worker(URL.createObjectURL(new Blob([source], {type:'text/javascript'})));

// after the fix (works everywhere):
const source = await (await fetch(bundle.mainWorker)).text();
const worker = new Worker(URL.createObjectURL(new Blob([source], {type:'text/javascript'})));
```

Estimated size of the change: ~10 lines in `@duckdb/duckdb-wasm`'s worker factory, plus a feature flag to preserve the old behavior as the default.

### Where the fix actually lives — confirmed by reading the source

**Not in `@duckdb/duckdb-wasm` upstream. In the MotherDuck mono repo.**

Traced through the code in `motherduckdb/mono`:

- `ts/packages/wasm-client/src/instantiateDB.ts` calls `createDuckDBWasmInstance` from `@motherduck/wasm-instance`.
- `ts/packages/wasm-instance/src/createDuckDBWasmInstance.ts` calls `createWorkerUrl(bundle.mainWorker)` then `new Worker(workerURL)`.
- `ts/packages/wasm-instance/src/createWorkerUrl.ts` — if URL starts with `http(s)://`, delegates to `createCrossOriginWorkerUrl`.
- `ts/packages/wasm-instance/src/createCrossOriginWorkerUrl.ts` — **the 5-line function that does `importScripts(url)` in a blob.** This is MotherDuck-authored, not `@duckdb/duckdb-wasm`.

The file even carries a comment acknowledging the workaround:

> "Browsers won't load the root script for a worker from another origin, even with appropriate headers. But the `importScripts` function will."

So the whole "cross-origin worker URL" logic is MD-owned, and the fix is entirely internal to `@motherduck/wasm-instance`.

### The fix (concrete diff)

`ts/packages/wasm-instance/src/createCrossOriginWorkerUrl.ts`:

```ts
// Before:
export function createCrossOriginWorkerUrl(workerUrl: string): string {
  return URL.createObjectURL(
    new Blob([`importScripts("${workerUrl}");`], { type: 'text/javascript' }),
  );
}

// After:
export async function createCrossOriginWorkerUrl(workerUrl: string): Promise<string> {
  // Fetch the worker source and inline it into a same-origin blob,
  // so we don't depend on cross-origin `importScripts` (which is
  // blocked in Electron custom-scheme renderers even when server
  // CORS headers allow it).
  const source = await (await fetch(workerUrl)).text();
  return URL.createObjectURL(
    new Blob([source], { type: 'text/javascript' }),
  );
}
```

That signature change (now `async`) requires two small follow-ups:

- `createWorkerUrl.ts` — the `crossOrigin` branch becomes `await createCrossOriginWorkerUrl(url)`. Function itself becomes `async`.
- `createDuckDBWasmInstance.ts` — already `await`s `createWorkerUrl` path-chain, just needs the signature chain to propagate.

Total: ~10–15 lines changed across 2–3 files.

### Rollout — three options, pick one

| Option | What | Effort | Ship surface |
|---|---|---|---|
| **A. Patch your own `node_modules` via `patch-package`** | Modify the minified published `@motherduck/wasm-client` inside the Obsidian plugin's deps. No mono changes. | ~30 min | Only this plugin |
| **B. Fix in the mono, build a private `wasm-client` tarball, install in plugin** | Fix `wasm-instance` in the mono, `pnpm build`, `pnpm pack` the wasm-client, install the tarball in the plugin via `file:` | ~1–2 hours | Only this plugin (still unpublished) |
| **C. Fix in the mono, land via normal PR, publish `@motherduck/wasm-client@0.9.0`** | Same code change as B, but goes through internal review and gets published to npm. | Depends on review cycle | Anyone using `@motherduck/wasm-client` (customers embedding in Electron / VS Code / browser extensions) |

**Recommended: B first, then C.**
- B validates the fix works end-to-end in Obsidian using real compiled MD code (not a hand-written patch against minified output). Low risk, ~1 hour.
- If B works, C is the same diff pushed through review. The ask is concrete and small; you've already proven it works.
- Option A is only useful if for some reason the mono is off the table — the patch-package against minified code is fragile (needs re-applying on every wasm-client version bump).

### Why MotherDuck should care

This isn't niche — the `importScripts` block happens to trip every non-`https://` embedder:

- **Obsidian plugins** — current pain point.
- **VS Code extensions** — `vscode-webview://` scheme, same class of restriction. Any "MotherDuck inside your editor" story hits this.
- **Electron apps by MD customers** — anyone building a local-first app on top of MotherDuck.
- **Browser extensions** — `chrome-extension://` origin, same restriction.
- **Tauri apps** — custom scheme, same restriction.

The cooperative-network work unblocked SharedArrayBuffer-less *browsers*. This is the next shoe: SharedArrayBuffer-less *embedded renderers*. Same customers will eventually ask.

And since the code is inside the MD mono repo (not upstream `@duckdb/duckdb-wasm`), the fix doesn't depend on any external party's release cycle.

### What to do with WASM right now

Don't. Prototype with `@duckdb/node-api`, architect the plugin so the runtime is swappable (a single `Runtime` interface — see below). When WASM is unblocked, flipping runtimes is a ~50-line change and unlocks mobile distribution + cleaner community-plugin review.

## Runtime abstraction

Everything in the plugin talks to the execution engine through one interface:

```ts
export interface Runtime {
  init(token: string): Promise<void>;
  runQuery(sql: string): Promise<{ rows: Record<string, unknown>[]; columns: string[] }>;
  close(): Promise<void>;
}
```

v1 implementation: `NodeApiRuntime` wrapping `@duckdb/node-api`.
v2 implementation: `WasmRuntime` wrapping `@motherduck/wasm-client` (once blocker 2 is fixed).

Nothing in `cache.ts`, `render.ts`, `dive.ts`, or the block processors knows which runtime is underneath.

## Cache block format

The sentinel convention is the contract between the plugin, the agent, and the human reader:

~~~markdown
```motherduck
SELECT brand, SUM(revenue) FROM sales GROUP BY 1 ORDER BY 2 DESC LIMIT 10
```
<!-- md:cache hash=a3f847b2 ts=2026-04-21T14:22:00Z rows=10 -->
| brand | sum(revenue) |
| ----- | ------------ |
| acme  | 42000        |
| …     | …            |
<!-- md:cache-end -->
~~~

- `hash` — first 8 chars of sha-256 of the trimmed SQL. Used to detect when a user edited the SQL since last refresh.
- `ts` — ISO-8601 UTC timestamp of the refresh.
- `rows` — number of rows in the cached table (pre-truncation).
- Refresh strategy: if `hash` matches and `ts` is within TTL → skip; if hash mismatches → rerun; if no sentinel → rerun; force-refresh bypasses TTL.
- Row cap: 100 inline by default; larger results get a truncation notice + optional CSV export to `.motherduck/<slug>.csv`.

## Phased delivery

1. **Phase 1 — core plugin (prototype).** Node-API runtime, settings tab, `motherduck` block processor with ▶ Run, "Refresh current note" command, "Freeze at cursor" command, API exposed on plugin instance for `obsidian eval`. ~2–3 days.
2. **Phase 2 — agent ergonomics.** URI handler (`obsidian://motherduck-refresh?file=…`), "Refresh folder" command, batch API. Draft a `md-refresh` Claude Code skill that wraps the plugin API for discoverability. ~1 day.
3. **Phase 3 — Dives embed.** `motherduck-dive` block + iframe auth flow. Blocked on confirming the Dives embed-session API. ~1–2 days.
4. **Phase 4 — WASM migration.** When blocker 2 is fixed upstream, add `WasmRuntime`, setting to select runtime, drop `isDesktopOnly`. ~half day.
5. **Phase 5 — Community plugin submission.** README, screenshots, demo vault, PR to `obsidianmd/obsidian-releases`. Review is slow (weeks).

## Files (proposed layout)

```
motherduck-obsidian-plugin/
├── manifest.json                 # isDesktopOnly: true (Phase 1–3), false after Phase 4
├── package.json
├── esbuild.config.mjs            # externals for @duckdb/*
├── main.ts                       # plugin class: onload, commands, API
├── src/
│   ├── runtime/
│   │   ├── index.ts              # Runtime interface
│   │   ├── node.ts               # NodeApiRuntime (Phase 1)
│   │   └── wasm.ts               # WasmRuntime (Phase 4, stub until then)
│   ├── cache.ts                  # sentinel parse/write
│   ├── render.ts                 # Arrow-ish rows → markdown table
│   ├── dive.ts                   # iframe block processor
│   └── settings.ts               # settings tab + types
├── PLAN.md                       # this file
└── README.md                     # usage / install
```

## Open questions

- **Dives embed-session API shape.** Public docs say "requires Business plan" but don't show the endpoint. Needs internal confirmation. Phase 3 can ship with a pre-generated embed URL as a stopgap.
- **Native addon distribution in community plugins.** `@duckdb/node-api` ships `.node` binaries. esbuild needs a loader for `.node` files, and the plugin dir needs the correct prebuilt per user platform. Common approach: bundle all prebuilts (~60 MB across 4 platforms). Uncommon in community plugins — call it out in the submission PR.
- **Token storage.** Plaintext in `data.json` under the plugin folder. Acceptable for prototype with a README warning. Keychain integration adds complexity that isn't worth it until v1.0.
- **Obsidian Sync bloat.** Large frozen tables balloon vault history. Row cap mitigates it; `.motherduck/` folder gets a `.syncignore` recommendation.

## Verification

1. **Phase 1 smoke test.** Install in vault → settings → token → create note with ` ```motherduck\nSELECT 42\n``` ` → reading mode → click ▶ Run → result table appears below block. Then "Freeze at cursor" → note file now contains the sentinel block on disk.
2. **Agent trigger.** From the command line: `obsidian eval code="app.plugins.getPlugin('motherduck').api.refreshFile('<path>')"` → note updates, plugin reports count of refreshed blocks.
3. **Hash detection.** Edit the SQL in a frozen block → run "Refresh current note" → the corresponding sentinel block gets replaced with fresh data.
4. **Cross-platform.** Test install on macOS arm64, macOS x64, Windows x64, Linux x64 — verify correct prebuilt is picked.
5. **Failure modes.** Bad token → clear error in settings + per-block error rendering. Offline → clear error, frozen caches still readable. Malformed SQL → error rendered in the block, no vault write.

## Summary — what's changing from the original spike plan

- Architecture **pivoted** from "plugin executes everything in-renderer via WASM" to "plugin executes via Node-API + exposes commands and API; humans and agents both trigger through it". Fewer moving parts.
- WASM path **deferred, not abandoned**. Limitations documented so the MD/DuckDB-WASM team has a concrete ask. Runtime is abstracted so migration is cheap once unblocked.
- Skill path **dropped as primary**. Optional later if it adds discoverability for agent-first workflows.
- Dives embedding **retained** in scope, Phase 3.
- Community plugin publication **retained** as the end state, Phase 5.
