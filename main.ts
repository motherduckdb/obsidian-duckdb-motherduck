import { MarkdownPostProcessorContext, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { FileLock } from "./src/file-lock";
import { findBlocks, writeSentinelAfterBlock, type FencedBlock } from "./src/markdown";
import { renderQueryBlock } from "./src/query-block";
import { RuntimeManager } from "./src/runtime/manager";
import { isOverdue } from "./src/schedule";
import { SettingsTab } from "./src/settings-tab";
import { renderMarkdownTable } from "./src/table";
import {
  DEFAULTS,
  LOG_CAP,
  STARTUP_DELAY_MS,
  SWEEP_INTERVAL_MS,
  type Cadence,
  type Connection,
  type QueryRunResult,
  type RefreshLogEntry,
  type Settings,
  type SweepResult,
} from "./src/types";

export default class MotherDuckPlugin extends Plugin {
  settings!: Settings;
  private runtimeManager = new RuntimeManager(() => this.settings);
  private fileLocks = new FileLock();
  private sweepTimeout: number | null = null;
  private sweepInterval: number | null = null;
  private sweepRunning = false;
  api!: {
    refreshFile: (path: string) => Promise<string>;
    runQuery: (sql: string, connection?: Connection) => Promise<QueryRunResult>;
  };

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor("duckdb", (src, el, ctx) =>
      renderQueryBlock(this, "local", src, el, ctx),
    );
    this.registerMarkdownCodeBlockProcessor("motherduck", (src, el, ctx) =>
      renderQueryBlock(this, "cloud", src, el, ctx),
    );

    this.registerMarkdownPostProcessor((el, ctx) => {
      const info = ctx.getSectionInfo(el);
      if (!info) return;
      const lines = info.text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/<!-- md:cache hash=/.test(lines[i])) continue;
        let j = i + 1;
        while (j < lines.length && !/<!-- md:cache-end -->/.test(lines[j])) j++;
        if (j >= lines.length) break;
        if (info.lineStart >= i && info.lineEnd <= j) {
          el.addClass("motherduck-cache-block");
          return;
        }
        i = j;
      }
    });

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
      id: "refresh-at-cursor",
      name: "Refresh query at cursor",
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

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async resetRuntimes(only?: Connection) {
    await this.runtimeManager.reset(only);
  }

  async runQuery(sql: string, connection: Connection): Promise<QueryRunResult> {
    return this.runtimeManager.runQuery(sql, connection);
  }

  startScheduler() {
    if (this.sweepInterval !== null || this.sweepTimeout !== null) return;
    this.sweepTimeout = window.setTimeout(() => {
      this.sweepTimeout = null;
      if (this.settings.scheduleEnabled) void this.runScheduledSweep();
    }, STARTUP_DELAY_MS);
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

  async runScheduledSweep(): Promise<SweepResult> {
    return this.runSweepInternal({
      trigger: "schedule",
      candidates: this.discoverScheduledNotes(),
      ignoreCadence: false,
      stampLastOnSuccess: true,
    });
  }

  async runManualSweep(): Promise<SweepResult> {
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

  async refreshFile(path: string): Promise<string> {
    const r = await this.refreshFileDetailed(path);
    return `Refreshed ${r.refreshed} block(s), ${r.errored} error(s) in ${path}`;
  }

  async refreshFileDetailed(
    path: string,
  ): Promise<{ refreshed: number; errored: number; firstError?: string }> {
    return this.fileLocks.run(path, async () => {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) throw new Error(`not a file: ${path}`);
      const content = await this.app.vault.read(file);
      const result = await this.processAllBlocks(content);
      await this.modifyIfUnchanged(file, content, result.newContent);
      return { refreshed: result.refreshed, errored: result.errored, firstError: result.firstError };
    });
  }

  async freezeAtCursor(file: TFile, cursorLine: number): Promise<string> {
    return this.fileLocks.run(file.path, async () => {
      const content = await this.app.vault.read(file);
      const blocks = findBlocks(content);
      const hit = blocks.find((b) => cursorLine >= b.startLine && cursorLine <= b.endLine);
      if (!hit) throw new Error("no ```duckdb or ```motherduck block at cursor");
      const newContent = await this.freezeBlock(content, hit);
      await this.modifyIfUnchanged(file, content, newContent);
      return "Refreshed 1 block";
    });
  }

  async freezeRenderedBlock(
    ctx: MarkdownPostProcessorContext,
    el: HTMLElement,
    sql: string,
    connection: Connection,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
    if (!(file instanceof TFile)) throw new Error(`not a file: ${ctx.sourcePath}`);

    await this.fileLocks.run(file.path, async () => {
      const info = ctx.getSectionInfo(el);
      if (!info) throw new Error("cannot locate block position");
      const content = await this.app.vault.read(file);
      const block =
        findBlocks(content).find(
          (candidate) => candidate.startLine === info.lineStart && candidate.endLine === info.lineEnd,
        ) ?? { sql, startLine: info.lineStart, endLine: info.lineEnd, connection };
      const newContent = await this.freezeBlock(content, block);
      await this.modifyIfUnchanged(file, content, newContent);
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
      this.settings.cellCharCap,
    );
    return writeSentinelAfterBlock(content, block, mdTable);
  }

  private async runSweepInternal(opts: {
    trigger: "schedule" | "manual";
    candidates: Array<{ file: TFile; cadence: Cadence | null; lastRefresh: string | null }>;
    ignoreCadence: boolean;
    stampLastOnSuccess: boolean;
    stampPredicate?: (file: TFile) => boolean;
  }): Promise<SweepResult> {
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
        }
      }
    } finally {
      this.sweepRunning = false;
    }

    return { refreshed, errored, checked };
  }

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
}
