# DuckDB & MotherDuck for Obsidian

Run DuckDB SQL directly inside your notes. Freeze the results as a plain markdown table so both you and any agent that reads the vault see `query + result` as one document.

Works entirely offline with local DuckDB WASM. Paste a MotherDuck token to query your cloud data instead.

## What it does

- **`duckdb` / `motherduck` code blocks**: render a SQL panel in reading mode with a ▶ Run button.
- **Freeze**: "Freeze MotherDuck query at cursor" or the 📌 button in reading mode runs the query and writes the result as a markdown table directly below the block, bracketed by sentinel comments.
- **Refresh**: "Refresh all MotherDuck queries in this note" re-runs every frozen block. Unchanged SQL keeps its cached output; edited SQL re-runs.
- **Plugin API**: `app.plugins.getPlugin('duckdb-motherduck').api.refreshFile(path)` and `.runQuery(sql)`, so Claude Code / other agents can trigger refreshes via `obsidian eval`.

## Freeze format

````markdown
```motherduck
SELECT brand, SUM(revenue) FROM sales GROUP BY 1 ORDER BY 2 DESC LIMIT 10
```
<!-- md:cache hash=a3f847b2 ts=2026-04-24T14:22:00Z rows=10 -->

| brand | sum(revenue) |
| ----- | ------------ |
| acme  | 42000        |
| …     | …            |

<!-- md:cache-end -->
````

The sentinel carries a SQL hash, timestamp, and row count. Editing the SQL changes the hash → the next refresh re-runs that block. Leaving it alone keeps the cache.

## Modes

The plugin picks a backend based on whether a MotherDuck token is set:

| Mode        | Backend                   | Needs token | Reaches cloud |
|-------------|---------------------------|-------------|---------------|
| DuckDB      | `@duckdb/duckdb-wasm`     | no          | no            |
| MotherDuck  | `@motherduck/wasm-client` | yes         | yes           |

Switch modes from the settings tab. The active mode is shown with a badge.

## Install (manual, for now)

The plugin isn't in the Obsidian community store yet. To install:

1. Clone this repo.
2. `npm install && npm run build` — produces `main.js`.
3. Copy `main.js` and `manifest.json` into `<your-vault>/.obsidian/plugins/duckdb-motherduck/`.
4. In Obsidian: Settings → Community plugins → enable *DuckDB & MotherDuck*.

## Usage

Create a code block:

````markdown
```motherduck
SELECT 42 AS answer, now() AS ts
```
````

In reading mode, click ▶ Run for an ephemeral result, or 📌 Freeze to persist it below the block. From the command palette:

- **Refresh all MotherDuck queries in this note** — re-runs every block (or every frozen block) in the current note.
- **Freeze MotherDuck query at cursor** — freezes the block the cursor is on.
- **Reset DuckDB/MotherDuck connection** — drops the current connection; useful after changing the token.

## Settings

- **DuckDB → Database path** — `:memory:` (default) for an ephemeral in-memory database. Persistent file paths are a future option.
- **MotherDuck → Token** — optional. Empty means local DuckDB. Stored plaintext in the plugin's `data.json` (see Security below).
- **General → Row cap** — max rows rendered inline or written into a frozen table. A truncation notice is appended if exceeded.

## Agent trigger

Both the human button and the agent flow share the same code path. From a shell (with the [Obsidian CLI](https://github.com/Yakitrak/obsidian-cli) installed):

```sh
obsidian eval code="app.plugins.getPlugin('duckdb-motherduck').api.refreshFile('path/to/note.md')"
```

…or wire it into a Claude Code skill. The plugin reports the number of blocks refreshed.

## Build from source

```sh
npm install
npm run build     # production bundle → main.js
npm run dev       # watch mode, rebuilds on save
```

`main.js` ends up around 2 MB because the DuckDB WASM worker script is bundled inline. The `.wasm` binary itself is fetched from jsDelivr at runtime (see *Remote assets* below).

## Remote assets

When running in DuckDB mode (no token), the plugin fetches the DuckDB WASM binary (~7 MB gzipped) from jsDelivr the first time a query runs:

```
https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@<version>/dist/duckdb-eh.wasm
```

When running in MotherDuck mode (token set), the MotherDuck WASM extension is fetched from `https://app.motherduck.com/` during connection setup.

No other network activity is added by the plugin.

## Requirements

- Obsidian 1.5+
- Desktop (tested on macOS; Windows/Linux expected to work). Mobile: should work with DuckDB mode; untested.
- Internet connection on first use (to download wasm assets). Cached by the browser after.

## Security

The MotherDuck token, if set, is stored plaintext in `<vault>/.obsidian/plugins/duckdb-motherduck/data.json`. Don't commit that file. Don't share your vault publicly with a token in it. Keychain integration is not implemented.

Queries run locally (DuckDB mode) or against your MotherDuck account (MotherDuck mode). No telemetry is sent by the plugin.

## Known limitations

- **Ephemeral database only** — `:memory:` is the only DuckDB path tested end-to-end. File paths are wired through but not exercised.
- **No mobile validation** — the architecture supports mobile (pure WASM, no native deps), but hasn't been tested on iOS/Android.
- **MotherDuck mode requires a local patch** — see `patches/` for the cross-origin worker fix. Will be removed once a fix is released upstream.

## License

MIT. See `LICENSE`.
