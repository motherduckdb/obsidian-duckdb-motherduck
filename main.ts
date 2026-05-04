import {
  App,
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  setIcon,
} from "obsidian";
import { Row, Runtime } from "./src/runtime";
import { DuckDBWasmRuntime } from "./src/runtime/duckdb";
import { MotherDuckRuntime } from "./src/runtime/motherduck";
import { DUCKDB_ICON, MOTHERDUCK_ICON } from "./src/icons";

type Connection = "local" | "cloud";
type Cadence = "daily" | "weekly";

const CADENCE_MS: Record<Cadence, number> = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
};

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const STARTUP_DELAY_MS = 5 * 1000; // delay before the first post-load sweep
const LOG_CAP = 100;

interface RefreshLogEntry {
  ts: string; // ISO timestamp
  path: string;
  trigger: "schedule" | "manual";
  blocks: number;
  errored: number;
  errorMessage?: string; // top-level error if the refresh threw before producing per-block counts
}

interface Settings {
  mdToken: string;
  dbPath: string;
  rowCap: number;
  scheduleEnabled: boolean;
  refreshLog: RefreshLogEntry[];
}

const DEFAULTS: Settings = {
  mdToken: "",
  dbPath: ":memory:",
  rowCap: 100,
  scheduleEnabled: false,
  refreshLog: [],
};

export default class MotherDuckPlugin extends Plugin {
  settings!: Settings;
  // One cached runtime per connection. They're independent: changing the local
  // db path resets only the local runtime, changing the token resets only the
  // cloud one. Queries on different connections in the same note coexist.
  private localRuntime: Runtime | null = null;
  private cloudRuntime: Runtime | null = null;
  private localRuntimePromise: Promise<Runtime> | null = null;
  private cloudRuntimePromise: Promise<Runtime> | null = null;
  private runtimeGeneration: Record<Connection, number> = {
    local: 0,
    cloud: 0,
  };
  private queryQueues: Record<Connection, Promise<unknown>> = {
    local: Promise.resolve(),
    cloud: Promise.resolve(),
  };
  private fileLocks = new Map<string, Promise<void>>();
  // Scheduler state. `sweepInterval` is the setInterval ID (or null when the
  // scheduler is off); `sweepRunning` prevents overlapping sweeps if a previous
  // one is still working when the next interval fires.
  private sweepTimeout: number | null = null;
  private sweepInterval: number | null = null;
  private sweepRunning = false;
  api!: {
    refreshFile: (path: string) => Promise<string>;
    runQuery: (sql: string, connection?: Connection) => Promise<{ rows: Row[]; columns: string[] }>;
  };

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    // Two fence types, same render pipeline. The connection arg is the only
    // thing that varies; everything below it (run / freeze / table render) is
    // identical regardless of which engine the SQL lands on.
    this.registerMarkdownCodeBlockProcessor("duckdb", (src, el, ctx) =>
      this.renderBlock("local", src, el, ctx),
    );
    this.registerMarkdownCodeBlockProcessor("motherduck", (src, el, ctx) =>
      this.renderBlock("cloud", src, el, ctx),
    );

    this.addCommand({
      id: "refresh-current-note",
      name: "Refresh all queries in this note",
      editorCallback: async (_editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        try {
          const msg = await this.refreshFile(view.file.path);
          new Notice(msg);
        } catch (e) {
          new Notice(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: "freeze-at-cursor",
      name: "Freeze query at cursor",
      editorCallback: async (editor, view) => {
        if (!(view instanceof MarkdownView) || !view.file) return;
        try {
          const msg = await this.freezeAtCursor(view.file, editor.getCursor().line);
          new Notice(msg);
        } catch (e) {
          new Notice(`error: ${e instanceof Error ? e.message : String(e)}`);
        }
      },
    });

    this.addCommand({
      id: "reset-connection",
      name: "Reset DuckDB/MotherDuck connections",
      callback: async () => {
        await this.resetRuntimes();
        new Notice("connections reset");
      },
    });

    this.api = {
      refreshFile: (path: string) => this.refreshFile(path),
      runQuery: (sql: string, connection: Connection = "local") => this.runQuery(sql, connection),
    };

    if (this.settings.scheduleEnabled) {
      this.startScheduler();
    }

    console.log("[motherduck] loaded");
  }

  async onunload() {
    this.stopScheduler();
    await this.resetRuntimes();
  }

  async resetRuntimes(only?: Connection) {
    if (!only || only === "local") {
      this.runtimeGeneration.local++;
      this.localRuntimePromise = null;
      this.queryQueues.local = Promise.resolve();
      try {
        await this.localRuntime?.close();
      } catch (e) {
        console.error("[motherduck] close local failed", e);
      }
      this.localRuntime = null;
    }
    if (!only || only === "cloud") {
      this.runtimeGeneration.cloud++;
      this.cloudRuntimePromise = null;
      this.queryQueues.cloud = Promise.resolve();
      try {
        await this.cloudRuntime?.close();
      } catch (e) {
        console.error("[motherduck] close cloud failed", e);
      }
      this.cloudRuntime = null;
    }
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ----------------- runtime -----------------

  async getRuntime(connection: Connection): Promise<Runtime> {
    if (connection === "cloud") {
      if (!this.settings.mdToken) {
        throw new Error("MotherDuck token not set. Configure it in plugin settings.");
      }
      if (this.cloudRuntime) return this.cloudRuntime;
      if (!this.cloudRuntimePromise) {
        const rt = new MotherDuckRuntime(this.settings.mdToken);
        const generation = this.runtimeGeneration.cloud;
        this.cloudRuntimePromise = rt
          .init()
          .then(() => {
            if (this.runtimeGeneration.cloud !== generation) {
              void rt.close();
              throw new Error("MotherDuck connection reset while initializing. Retry the query.");
            }
            this.cloudRuntime = rt;
            return rt;
          })
          .catch(async (e) => {
            await rt.close().catch((closeError) => {
              console.error("[motherduck] close failed after cloud init error", closeError);
            });
            throw e;
          })
          .finally(() => {
            this.cloudRuntimePromise = null;
          });
      }
      return this.cloudRuntimePromise;
    }
    if (this.localRuntime) return this.localRuntime;
    if (!this.localRuntimePromise) {
      const rt = new DuckDBWasmRuntime(this.settings.dbPath);
      const generation = this.runtimeGeneration.local;
      this.localRuntimePromise = rt
        .init()
          .then(() => {
            if (this.runtimeGeneration.local !== generation) {
              void rt.close();
              throw new Error("DuckDB connection reset while initializing. Retry the query.");
            }
            this.localRuntime = rt;
            return rt;
          })
          .catch(async (e) => {
            await rt.close().catch((closeError) => {
              console.error("[motherduck] close failed after local init error", closeError);
            });
            throw e;
          })
          .finally(() => {
            this.localRuntimePromise = null;
          });
    }
    return this.localRuntimePromise;
  }

  async runQuery(sql: string, connection: Connection): Promise<{ rows: Row[]; columns: string[] }> {
    return this.enqueueQuery(connection, async () => {
      const rt = await this.getRuntime(connection);
      return rt.runQuery(sql);
    });
  }

  private enqueueQuery<T>(connection: Connection, op: () => Promise<T>): Promise<T> {
    const previous = this.queryQueues[connection].catch(() => undefined);
    const next = previous.then(op);
    this.queryQueues[connection] = next.catch(() => undefined);
    return next;
  }

  // Append a small <select> to the given parent, mapped to the host note's
  // `duckdb-motherduck-refresh` frontmatter. None / Daily / Weekly. Selecting
  // None removes the property; selecting a cadence sets it. Updates persist via
  // Obsidian's processFrontMatter, which preserves YAML structure and other keys.
  private attachRefreshDropdown(parent: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const sourcePath = ctx.sourcePath;
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return;

    // Group the icon + dropdown together and right-align as a unit, so the
    // icon is visually attached to the select rather than floating between
    // the badge label and the picker.
    const group = parent.createDiv({ cls: "motherduck-refresh-control" });

    const iconHost = group.createDiv({ cls: "motherduck-refresh-control__icon" });
    setIcon(iconHost, "refresh-cw");

    const select = group.createEl("select", { cls: "motherduck-refresh-control__select" }) as HTMLSelectElement;
    select.title = "Auto-refresh this note (writes to its frontmatter)";
    select.setAttr("aria-label", "Auto-refresh this note");

    const opts: Array<{ value: "" | Cadence; label: string }> = [
      { value: "", label: "Refresh: none" },
      { value: "daily", label: "Refresh: daily" },
      { value: "weekly", label: "Refresh: weekly" },
    ];
    for (const opt of opts) {
      const o = select.createEl("option");
      o.value = opt.value;
      o.text = opt.label;
    }

    // Initialize from existing frontmatter.
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const current = fm?.["duckdb-motherduck-refresh"];
    select.value = current === "daily" || current === "weekly" ? current : "";

    select.addEventListener("change", async () => {
      const v = select.value as "" | Cadence;
      try {
        await this.app.fileManager.processFrontMatter(file, (fmEdit) => {
          if (v === "") {
            delete fmEdit["duckdb-motherduck-refresh"];
          } else {
            fmEdit["duckdb-motherduck-refresh"] = v;
          }
        });
      } catch (e) {
        console.error("[motherduck] failed to update refresh cadence frontmatter", e);
        new Notice("failed to update refresh cadence");
      }
    });
  }

  // ----------------- scheduler -----------------

  startScheduler() {
    if (this.sweepInterval !== null || this.sweepTimeout !== null) return;
    // Initial post-load sweep, after a short delay to let Obsidian finish booting.
    this.sweepTimeout = window.setTimeout(() => {
      this.sweepTimeout = null;
      if (this.settings.scheduleEnabled) void this.runScheduledSweep();
    }, STARTUP_DELAY_MS);
    // Then sweep at the regular interval.
    this.sweepInterval = this.registerInterval(
      window.setInterval(() => {
        if (this.settings.scheduleEnabled) void this.runScheduledSweep();
      }, SWEEP_INTERVAL_MS),
    );
  }

  stopScheduler() {
    if (this.sweepTimeout !== null) {
      window.clearTimeout(this.sweepTimeout);
      this.sweepTimeout = null;
    }
    if (this.sweepInterval !== null) {
      window.clearInterval(this.sweepInterval);
      this.sweepInterval = null;
    }
  }

  // Schedule-driven sweep: only opt-in notes (those with the
  // `duckdb-motherduck-refresh` frontmatter property), respects each note's
  // cadence so we only touch ones that are actually overdue. Updates
  // `duckdb-motherduck-refresh-last` after each successful refresh so the
  // next cadence window starts from now.
  async runScheduledSweep(): Promise<{ refreshed: number; errored: number; checked: number }> {
    return this.runSweepInternal({
      trigger: "schedule",
      candidates: this.discoverScheduledNotes(),
      ignoreCadence: false,
      stampLastOnSuccess: true,
    });
  }

  // Manual sweep, the user clicked the button. Refreshes every note in the
  // vault that contains a SQL block, regardless of frontmatter opt-in. Doesn't
  // touch the last-refresh timestamp on notes that aren't opted in (they have
  // no cadence, so a `last` value would be meaningless), but does update it on
  // ones that are, so a manual click also resets their cadence window.
  async runManualSweep(): Promise<{ refreshed: number; errored: number; checked: number }> {
    const all = await this.discoverNotesWithBlocks();
    const optedIn = new Set(this.discoverScheduledNotes().map((c) => c.file.path));
    return this.runSweepInternal({
      trigger: "manual",
      candidates: all.map((file) => ({ file, cadence: null, lastRefresh: null })),
      ignoreCadence: true,
      stampLastOnSuccess: false,
      stampPredicate: (file) => optedIn.has(file.path),
    });
  }

  private async runSweepInternal(opts: {
    trigger: "schedule" | "manual";
    candidates: Array<{ file: TFile; cadence: Cadence | null; lastRefresh: string | null }>;
    ignoreCadence: boolean;
    stampLastOnSuccess: boolean;
    stampPredicate?: (file: TFile) => boolean;
  }): Promise<{ refreshed: number; errored: number; checked: number }> {
    if (this.sweepRunning) {
      console.log("[motherduck] sweep skipped: previous sweep still running");
      return { refreshed: 0, errored: 0, checked: 0 };
    }
    this.sweepRunning = true;
    let refreshed = 0;
    let errored = 0;
    let checked = 0;
    try {
      for (const { file, cadence, lastRefresh } of opts.candidates) {
        checked++;
        if (!opts.ignoreCadence && cadence && !isOverdue(cadence, lastRefresh)) continue;
        // Don't stomp on a note the user is currently editing.
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile?.path === file.path) {
          console.log(`[motherduck] sweep: skipping ${file.path}, active editor`);
          continue;
        }
        try {
          const result = await this.refreshFileDetailed(file.path);
          const shouldStamp =
            opts.stampLastOnSuccess || (opts.stampPredicate?.(file) ?? false);
          if (shouldStamp) {
            await this.app.fileManager.processFrontMatter(file, (fm) => {
              fm["duckdb-motherduck-refresh-last"] = new Date().toISOString();
            });
          }
          await this.appendLog({
            ts: new Date().toISOString(),
            path: file.path,
            trigger: opts.trigger,
            blocks: result.refreshed,
            errored: result.errored,
            errorMessage: result.firstError,
          });
          if (result.errored > 0) errored++;
          else refreshed++;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[motherduck] sweep: refresh failed for ${file.path}:`, e);
          await this.appendLog({
            ts: new Date().toISOString(),
            path: file.path,
            trigger: opts.trigger,
            blocks: 0,
            errored: 0,
            errorMessage: msg,
          });
          errored++;
          // Leave the last-refresh timestamp alone so the next sweep retries
          // instead of waiting a full cadence.
        }
      }
    } finally {
      this.sweepRunning = false;
    }
    return { refreshed, errored, checked };
  }

  // Scan all markdown files for the opt-in frontmatter property. Reads from
  // Obsidian's metadata cache (already-parsed), so this is sub-millisecond
  // even on large vaults.
  private discoverScheduledNotes(): Array<{
    file: TFile;
    cadence: Cadence;
    lastRefresh: string | null;
  }> {
    const out: Array<{ file: TFile; cadence: Cadence; lastRefresh: string | null }> = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const raw = fm["duckdb-motherduck-refresh"];
      if (raw !== "daily" && raw !== "weekly") continue;
      const lastRaw = fm["duckdb-motherduck-refresh-last"];
      const lastRefresh = typeof lastRaw === "string" ? lastRaw : null;
      out.push({ file, cadence: raw, lastRefresh });
    }
    return out;
  }

  // Scan every markdown file's source for at least one duckdb/motherduck
  // fence. Reads each file (slower than discoverScheduledNotes which uses the
  // metadata cache) but only fires on the manual button, where a
  // few-seconds-once-per-click cost is acceptable.
  private async discoverNotesWithBlocks(): Promise<TFile[]> {
    const out: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const content = await this.app.vault.cachedRead(file);
      if (findBlocks(content).length > 0) {
        out.push(file);
      }
    }
    return out;
  }

  private async appendLog(entry: RefreshLogEntry) {
    this.settings.refreshLog.unshift(entry);
    if (this.settings.refreshLog.length > LOG_CAP) {
      this.settings.refreshLog.length = LOG_CAP;
    }
    await this.saveSettings();
  }

  private async withFileLock<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = this.fileLocks.get(path) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const next = previous.catch(() => undefined).then(() => gate);
    this.fileLocks.set(path, next);
    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      release();
      if (this.fileLocks.get(path) === next) this.fileLocks.delete(path);
    }
  }

  private async modifyIfUnchanged(file: TFile, baseContent: string, newContent: string): Promise<boolean> {
    if (newContent === baseContent) return false;
    const latest = await this.app.vault.read(file);
    if (latest !== baseContent) {
      throw new Error(
        `${file.path} changed while queries were running; not overwriting newer edits. Retry the refresh.`,
      );
    }
    await this.app.vault.modify(file, newContent);
    return true;
  }

  // ----------------- freeze / refresh -----------------

  async refreshFile(path: string): Promise<string> {
    const r = await this.refreshFileDetailed(path);
    return `Refreshed ${r.refreshed} block(s), ${r.errored} error(s) in ${path}`;
  }

  async refreshFileDetailed(
    path: string,
  ): Promise<{ refreshed: number; errored: number; firstError?: string }> {
    return this.withFileLock(path, async () => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`not a file: ${path}`);
      const content = await this.app.vault.read(file);
      const result = await this.processAllBlocks(content);
      await this.modifyIfUnchanged(file, content, result.newContent);
      return { refreshed: result.refreshed, errored: result.errored, firstError: result.firstError };
    });
  }

  async freezeAtCursor(file: TFile, cursorLine: number): Promise<string> {
    return this.withFileLock(file.path, async () => {
      const content = await this.app.vault.read(file);
      const blocks = findBlocks(content);
      const hit = blocks.find((b) => cursorLine >= b.startLine && cursorLine <= b.endLine);
      if (!hit) throw new Error("no ```duckdb or ```motherduck block at cursor");
      const newContent = await this.freezeBlock(content, hit);
      await this.modifyIfUnchanged(file, content, newContent);
      return `Froze 1 block`;
    });
  }

  async processAllBlocks(
    content: string,
  ): Promise<{ newContent: string; refreshed: number; errored: number; firstError?: string }> {
    const blocks = findBlocks(content);
    let working = content;
    let refreshed = 0;
    let errored = 0;
    let firstError: string | undefined;
    // Process from last to first so line offsets stay valid as we mutate content
    for (let i = blocks.length - 1; i >= 0; i--) {
      try {
        working = await this.freezeBlock(working, blocks[i]);
        refreshed++;
      } catch (e) {
        console.error("[motherduck] block error", e);
        errored++;
        if (!firstError) firstError = e instanceof Error ? e.message : String(e);
      }
    }
    return { newContent: working, refreshed, errored, firstError };
  }

  async freezeBlock(content: string, block: FencedBlock): Promise<string> {
    const { rows, columns } = await this.runQuery(block.sql, block.connection);
    const mdTable = renderMarkdownTable(
      rows,
      columns,
      block.sql,
      block.connection,
      this.settings.rowCap,
    );
    return writeSentinelAfterBlock(content, block, mdTable);
  }

  // ----------------- reading-mode renderer -----------------

  renderBlock(connection: Connection, src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const sql = src.trim();
    if (!sql) {
      el.createEl("em", { text: connection === "cloud" ? "empty motherduck block" : "empty duckdb block" });
      return;
    }

    const wrap = el.createDiv({ cls: "motherduck-block" });

    // Connection badge above the SQL: tells the reader at a glance whether
    // this block hits the local DuckDB or MotherDuck cloud, mapping 1:1 to
    // the section names in plugin settings.
    const badge = wrap.createDiv({ cls: "motherduck-block__badge" });
    const iconWrap = badge.createDiv({ cls: "motherduck-block__engine-icon" });
    iconWrap.innerHTML = connection === "cloud" ? MOTHERDUCK_ICON : DUCKDB_ICON;
    if (connection === "cloud") {
      badge.createEl("span", { text: "MotherDuck" });
    } else {
      badge.createEl("span", { text: "DuckDB " });
      badge.createEl("code", { text: shortPathLabel(this.settings.dbPath) });
    }

    // Refresh-cadence dropdown, right-aligned in the badge row. Reads from and
    // writes to the host note's `duckdb-motherduck-refresh` frontmatter so users
    // don't have to learn the property name. Note-scoped, not block-scoped:
    // changing it in one block updates the note's frontmatter and therefore
    // every block in the note (other blocks pick up the change on next render).
    this.attachRefreshDropdown(badge, ctx);

    const pre = wrap.createEl("pre", { cls: "motherduck-block__sql" });
    pre.createEl("code", { text: sql });

    const btnRow = wrap.createDiv({ cls: "motherduck-block__controls" });

    const runBtn = btnRow.createEl("button", { cls: "motherduck-block__button" });
    setIcon(runBtn, "play");
    runBtn.appendText("Run");
    runBtn.title = "Run query";
    runBtn.setAttr("aria-label", "Run query");

    const freezeBtn = btnRow.createEl("button", { cls: "motherduck-block__button" });
    setIcon(freezeBtn, "pin");
    freezeBtn.appendText("Freeze");
    freezeBtn.title = "Run and freeze result below this block";
    freezeBtn.setAttr("aria-label", "Run and freeze result below this block");

    const status = btnRow.createEl("span", { cls: "motherduck-block__status" });

    const resultEl = wrap.createDiv({ cls: "motherduck-block__result" });

    runBtn.addEventListener("click", async () => {
      resultEl.empty();
      status.setText("running…");
      runBtn.setAttr("disabled", "true");
      freezeBtn.setAttr("disabled", "true");
      const t0 = performance.now();
      try {
        const { rows, columns } = await this.runQuery(sql, connection);
        const dt = Math.round(performance.now() - t0);
        status.setText(`${rows.length} row(s) · ${dt} ms`);
        renderDomTable(resultEl, rows, columns, this.settings.rowCap);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.setText("error");
        const errEl = resultEl.createEl("pre", { cls: "motherduck-block__error" });
        errEl.setText(msg);
      } finally {
        runBtn.removeAttribute("disabled");
        freezeBtn.removeAttribute("disabled");
      }
    });

    freezeBtn.addEventListener("click", async () => {
      status.setText("freezing…");
      runBtn.setAttr("disabled", "true");
      freezeBtn.setAttr("disabled", "true");
      try {
        const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (!(file instanceof TFile)) throw new Error(`not a file: ${ctx.sourcePath}`);
        await this.withFileLock(file.path, async () => {
          const info = ctx.getSectionInfo(el);
          if (!info) throw new Error("cannot locate block position");
          const content = await this.app.vault.read(file);
          const block =
            findBlocks(content).find(
              (candidate) =>
                candidate.startLine === info.lineStart && candidate.endLine === info.lineEnd,
            ) ?? { sql, startLine: info.lineStart, endLine: info.lineEnd, connection };
          const newContent = await this.freezeBlock(content, block);
          await this.modifyIfUnchanged(file, content, newContent);
        });
        status.setText("frozen ✓");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.setText(`error: ${msg}`);
        console.error("[motherduck] freeze failed", e);
      } finally {
        runBtn.removeAttribute("disabled");
        freezeBtn.removeAttribute("disabled");
      }
    });
  }
}

// ----------------- helpers -----------------

interface FencedBlock {
  sql: string;
  startLine: number; // line of opening ```
  endLine: number; // line of closing ```
  connection: Connection;
}

function findBlocks(content: string): FencedBlock[] {
  const lines = content.split("\n");
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*(motherduck|duckdb)(?:\s+.*)?$/);
    if (open) {
      const fence = open[1];
      const fenceChar = fence[0];
      const closeRe = new RegExp(`^ {0,3}${escapeRegExp(fenceChar)}{${fence.length},}\\s*$`);
      const connection: Connection = open[2] === "duckdb" ? "local" : "cloud";
      const start = i;
      i++;
      const sqlLines: string[] = [];
      while (i < lines.length && !closeRe.test(lines[i])) {
        sqlLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        blocks.push({ sql: sqlLines.join("\n"), startLine: start, endLine: i, connection });
        i++;
      }
    } else {
      i++;
    }
  }
  return blocks;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function writeSentinelAfterBlock(content: string, block: FencedBlock, mdTable: string): string {
  const lines = content.split("\n");
  const afterBlock = block.endLine + 1;
  // Look ahead past optional blank line + existing sentinel block
  let cutEnd = afterBlock;
  // Skip blank lines between code block and potential sentinel
  let j = afterBlock;
  while (j < lines.length && lines[j].trim() === "") j++;
  if (j < lines.length && /<!-- md:cache hash=/.test(lines[j])) {
    // find matching end sentinel
    let k = j;
    while (k < lines.length && !/<!-- md:cache-end -->/.test(lines[k])) k++;
    if (k < lines.length) cutEnd = k + 1;
  }
  const before = lines.slice(0, afterBlock).join("\n");
  const rest = lines.slice(cutEnd).join("\n");
  return before + "\n\n" + mdTable + (rest ? "\n\n" + rest : "\n");
}

// Short-form display of the configured local DB path: keeps `:memory:` as-is
// and strips directory parts off real paths / URIs so the block badge stays
// compact (e.g. `opfs://notes.duckdb` -> `notes.duckdb`).
// True if a note's `lastRefresh` timestamp is older than its cadence interval,
// or if it's missing/unparseable (treat as never-refreshed and therefore due).
function isOverdue(cadence: Cadence, lastRefresh: string | null): boolean {
  if (!lastRefresh) return true;
  const last = Date.parse(lastRefresh);
  if (Number.isNaN(last)) return true;
  return Date.now() - last >= CADENCE_MS[cadence];
}

// Friendly local-time render of an ISO timestamp for the activity log.
function formatLogTimestamp(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function shortPathLabel(rawPath: string): string {
  const v = (rawPath || "").trim();
  if (!v || v === ":memory:") return ":memory:";
  const m = v.match(/[^/\\]+$/);
  return m ? m[0] : v;
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16).padStart(8, "0");
}

function escapeCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ").replace(/\r/g, "");
}

function renderMarkdownTable(
  rows: Row[],
  columns: string[],
  sql: string,
  connection: Connection,
  rowCap: number,
): string {
  const hash = simpleHash(`${connection}\n${sql.trim()}`);
  const ts = new Date().toISOString();
  const totalRows = rows.length;
  const cap = normalizedRowCap(rowCap);
  const shown = rows.slice(0, cap);

  const open = `<!-- md:cache hash=${hash} conn=${connection} ts=${ts} rows=${totalRows} -->`;
  const close = `<!-- md:cache-end -->`;

  if (columns.length === 0) {
    return `${open}\n\n_(0 rows)_\n\n${close}`;
  }
  const header = "| " + columns.map(escapeCell).join(" | ") + " |";
  const sep = "| " + columns.map(() => "---").join(" | ") + " |";
  const body = shown.map((r) => "| " + columns.map((c) => escapeCell(r[c])).join(" | ") + " |");
  const truncated =
    totalRows > cap ? `\n\n> … ${totalRows - cap} more rows hidden (cap ${cap})` : "";
  const emptyNotice = totalRows === 0 ? "\n\n> 0 rows" : "";
  // Blank lines around the table + around the sentinel comments are required
  // so markdown parsers don't fuse them into a single HTML block and skip table rendering.
  return `${open}\n\n${header}\n${sep}\n${body.join("\n")}${emptyNotice}${truncated}\n\n${close}`;
}

function renderDomTable(parent: HTMLElement, rows: Row[], columns: string[], rowCap: number) {
  if (columns.length === 0) {
    parent.createEl("em", { text: "(0 rows)" });
    return;
  }
  const cap = normalizedRowCap(rowCap);
  const shown = rows.slice(0, cap);
  const table = parent.createEl("table", { cls: "motherduck-result-table" });
  const thead = table.createEl("thead").createEl("tr");
  for (const c of columns) {
    const th = thead.createEl("th", { text: c });
  }
  const tbody = table.createEl("tbody");
  for (const row of shown) {
    const tr = tbody.createEl("tr");
    for (const c of columns) {
      const td = tr.createEl("td");
      const v = row[c];
      td.setText(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  if (rows.length === 0) {
    const empty = parent.createEl("div", { cls: "motherduck-muted", text: "0 rows" });
    empty.style.marginTop = "4px";
  }
  if (rows.length > cap) {
    const more = parent.createEl("div", {
      cls: "motherduck-muted",
      text: `… ${rows.length - cap} more rows hidden (cap ${cap})`,
    });
    more.style.marginTop = "4px";
  }
}

function normalizedRowCap(rowCap: number): number {
  return Number.isFinite(rowCap) && rowCap > 0
    ? Math.min(Math.floor(rowCap), 10000)
    : DEFAULTS.rowCap;
}

// ----------------- settings tab -----------------

class SettingsTab extends PluginSettingTab {
  plugin: MotherDuckPlugin;
  constructor(app: App, plugin: MotherDuckPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }
  display(): void {
    this.containerEl.empty();

    const intro = this.containerEl.createEl("p", { cls: "setting-item-description" });
    intro.setText(
      "Run SQL in your notes against a local DuckDB file or your MotherDuck workspace. " +
        "Results render live, and can be frozen as inline markdown tables, either per-block via the Freeze button or in bulk via the 'Refresh all queries' command.",
    );

    renderSectionHeader(this.containerEl, DUCKDB_ICON, "DuckDB", {
      text: "Used by ```duckdb code blocks. ",
      linkText: "duckdb.org",
      href: "https://duckdb.org",
    });

    new Setting(this.containerEl)
      .setName("Path to local DuckDB file")
      .setDesc(
        createFragment((frag) => {
          frag.appendText("Default ");
          frag.createEl("code", { text: ":memory:" });
          frag.appendText(
            " is an ephemeral in-memory database. Or paste an absolute path to query an existing on-disk file (read-only, writes don't persist back). Examples: ",
          );
          frag.createEl("code", { text: "/Users/you/data.duckdb" });
          frag.appendText(", ");
          frag.createEl("code", { text: "/home/you/data.duckdb" });
          frag.appendText(", ");
          frag.createEl("code", { text: "C:\\Users\\you\\data.duckdb" });
          frag.appendText(".");
        }),
      )
      .addText((t) =>
        t
          .setPlaceholder(":memory:")
          .setValue(this.plugin.settings.dbPath)
          .onChange(async (v) => {
            this.plugin.settings.dbPath = v.trim() || ":memory:";
            await this.plugin.saveSettings();
            await this.plugin.resetRuntimes("local");
          }),
      );

    new Setting(this.containerEl)
      .setName("Test DuckDB connection")
      .setDesc("Runs a tiny local query using the current DuckDB setting.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("Testing...");
          try {
            const result = await this.plugin.runQuery("SELECT 42 AS ok", "local");
            new Notice(`DuckDB ok (${result.rows.length} row)`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`DuckDB error: ${msg}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText("Test");
          }
        }),
      );

    renderSectionHeader(this.containerEl, MOTHERDUCK_ICON, "MotherDuck", {
      text: "Used by ```motherduck code blocks. ",
      linkText: "motherduck.com",
      href: "https://motherduck.com",
    });

    new Setting(this.containerEl)
      .setName("MotherDuck token")
      .setDesc(
        createFragment((frag) => {
          frag.appendText(
            "Paste a MotherDuck access token to query the cloud instead of local DuckDB. Stored unencrypted in ",
          );
          frag.createEl("code", { text: "data.json" });
          frag.appendText(" inside this vault's plugin folder; if you sync this vault publicly, unset the token first.");
          frag.createEl("br");
          frag.createEl("br");
          frag.appendText("Get a token: prefer a ");
          const sa = frag.createEl("a", {
            href: "https://motherduck.com/docs/key-tasks/service-accounts-guide/create-and-configure-service-accounts/",
            text: "service account token",
          });
          sa.setAttr("target", "_blank");
          sa.setAttr("rel", "noopener noreferrer");
          frag.appendText(" (scoped permissions, individually revocable) or use a ");
          const pat = frag.createEl("a", {
            href: "https://motherduck.com/docs/key-tasks/authenticating-and-connecting-to-motherduck/authenticating-to-motherduck/#authentication-using-an-access-token",
            text: "personal access token",
          });
          pat.setAttr("target", "_blank");
          pat.setAttr("rel", "noopener noreferrer");
          frag.appendText(".");
        }),
      )
      .addText((t) => {
        t.inputEl.type = "password";
        t.inputEl.autocomplete = "off";
        t.setPlaceholder("eyJ... (leave empty for local DuckDB)")
          .setValue(this.plugin.settings.mdToken)
          .onChange(async (v) => {
            this.plugin.settings.mdToken = v.trim();
            await this.plugin.saveSettings();
            await this.plugin.resetRuntimes("cloud");
          });
      });

    new Setting(this.containerEl)
      .setName("Test MotherDuck connection")
      .setDesc("Runs a tiny cloud query using the current token.")
      .addButton((b) =>
        b.setButtonText("Test").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("Testing...");
          try {
            const result = await this.plugin.runQuery("SELECT 42 AS ok", "cloud");
            new Notice(`MotherDuck ok (${result.rows.length} row)`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`MotherDuck error: ${msg}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText("Test");
          }
        }),
      );

    this.containerEl.createEl("h3", { text: "Scheduled refresh" });

    const scheduleDesc = this.containerEl.createEl("p", { cls: "setting-item-description" });
    scheduleDesc.appendText("Pick a cadence in the ");
    scheduleDesc.createEl("code", { text: "Refresh" });
    scheduleDesc.appendText(" dropdown above any SQL block to opt that note in. The plugin writes ");
    scheduleDesc.createEl("code", { text: "duckdb-motherduck-refresh" });
    scheduleDesc.appendText(
      " to the note's frontmatter, sweeps once an hour while Obsidian is running, and refreshes overdue notes. The active editor is skipped to avoid stomping in-progress edits.",
    );

    new Setting(this.containerEl)
      .setName("Auto-refresh scheduled notes")
      .setDesc("When on, opted-in notes refresh automatically based on their cadence.")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.scheduleEnabled).onChange(async (v) => {
          this.plugin.settings.scheduleEnabled = v;
          await this.plugin.saveSettings();
          if (v) this.plugin.startScheduler();
          else this.plugin.stopScheduler();
        }),
      );

    new Setting(this.containerEl)
      .setName("Refresh all notes with queries now")
      .setDesc("Sweeps every note in the vault that has a SQL block, ignoring cadence and frontmatter opt-in. Available even when auto-refresh is off.")
      .addButton((b) =>
        b.setButtonText("Refresh now").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("Refreshing...");
          try {
            const r = await this.plugin.runManualSweep();
            new Notice(
              `Refreshed ${r.refreshed} note(s), ${r.errored} error(s), ${r.checked} scanned`,
            );
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            new Notice(`error: ${msg}`);
          } finally {
            b.setDisabled(false);
            b.setButtonText("Refresh now");
            this.display(); // re-render so the new log entries show up
          }
        }),
      );

    const logTitle = this.containerEl.createEl("h4", { text: "Activity log" });
    logTitle.style.marginTop = "16px";
    logTitle.style.marginBottom = "4px";

    if (this.plugin.settings.refreshLog.length === 0) {
      const empty = this.containerEl.createEl("p", { cls: "setting-item-description" });
      empty.setText("No refreshes recorded yet.");
    } else {
      const logEl = this.containerEl.createDiv();
      logEl.style.maxHeight = "300px";
      logEl.style.overflowY = "auto";
      logEl.style.border = "1px solid var(--background-modifier-border)";
      logEl.style.borderRadius = "6px";
      logEl.style.padding = "8px";
      logEl.style.fontSize = "0.85em";
      logEl.style.fontFamily = "var(--font-monospace)";
      logEl.style.lineHeight = "1.5";

      for (const entry of this.plugin.settings.refreshLog.slice(0, 30)) {
        const row = logEl.createDiv();
        const ts = row.createEl("span", { text: formatLogTimestamp(entry.ts) });
        ts.style.opacity = "0.7";
        row.appendText("  ");
        const trigger = row.createEl("span", { text: entry.trigger });
        trigger.style.opacity = "0.7";
        row.appendText("  ");

        const linkEl = row.createEl("a", { text: entry.path });
        linkEl.style.cursor = "pointer";
        linkEl.addEventListener("click", (e) => {
          e.preventDefault();
          const f = this.plugin.app.vault.getAbstractFileByPath(entry.path);
          if (f instanceof TFile) {
            this.plugin.app.workspace.getLeaf().openFile(f);
          }
        });

        // Three shapes:
        //   no errors       -> "N refreshed"
        //   per-block errors -> "N refreshed, M errored: <first message>"
        //   refresh threw   -> "error: <message>"
        if (entry.blocks === 0 && entry.errored === 0 && entry.errorMessage) {
          row.appendText("  ");
          const err = row.createEl("span", { text: `error: ${entry.errorMessage}` });
          err.style.color = "var(--text-error)";
        } else {
          row.appendText(`  ${entry.blocks} refreshed`);
          if (entry.errored > 0) {
            const err = row.createEl("span", {
              text: entry.errorMessage
                ? `, ${entry.errored} errored: ${entry.errorMessage}`
                : `, ${entry.errored} errored`,
            });
            err.style.color = "var(--text-error)";
          }
        }
      }

      new Setting(this.containerEl).addButton((b) =>
        b.setButtonText("Clear log").onClick(async () => {
          this.plugin.settings.refreshLog = [];
          await this.plugin.saveSettings();
          this.display();
        }),
      );
    }

    this.containerEl.createEl("h3", { text: "General" });

    new Setting(this.containerEl)
      .setName("Row cap")
      .setDesc("Max rows rendered inline / frozen. Truncation notice appended if exceeded.")
      .addText((t) =>
        t
          .setPlaceholder("100")
          .setValue(String(this.plugin.settings.rowCap))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.rowCap = Math.min(Math.floor(n), 10000);
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}

function renderSectionHeader(
  parent: HTMLElement,
  svgMarkup: string,
  title: string,
  tagline?: { text: string; linkText: string; href: string },
) {
  const row = parent.createDiv();
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "10px";
  row.style.marginTop = "24px";
  row.style.marginBottom = tagline ? "4px" : "8px";
  row.style.paddingBottom = "6px";
  row.style.borderBottom = "1px solid var(--background-modifier-border)";

  const iconWrap = row.createDiv();
  iconWrap.style.display = "flex";
  iconWrap.style.alignItems = "center";
  iconWrap.innerHTML = svgMarkup;

  const h = row.createEl("h3", { text: title });
  h.style.margin = "0";

  if (tagline) {
    const desc = parent.createEl("p", { cls: "setting-item-description" });
    desc.style.marginTop = "0";
    desc.style.marginBottom = "8px";
    desc.appendText(tagline.text);
    const a = desc.createEl("a", { href: tagline.href, text: tagline.linkText });
    a.setAttr("target", "_blank");
    a.setAttr("rel", "noopener noreferrer");
  }
}
