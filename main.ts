import {
  App,
  MarkdownPostProcessorContext,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from "obsidian";
import { Row, Runtime } from "./src/runtime";
import { DuckDBWasmRuntime } from "./src/runtime/duckdb";
import { MotherDuckRuntime } from "./src/runtime/motherduck";
import { DUCKDB_ICON, MOTHERDUCK_ICON } from "./src/icons";

interface Settings {
  mdToken: string;
  dbPath: string;
  rowCap: number;
}

const DEFAULTS: Settings = { mdToken: "", dbPath: ":memory:", rowCap: 100 };

export default class MotherDuckPlugin extends Plugin {
  settings!: Settings;
  runtime: Runtime | null = null;
  api!: {
    refreshFile: (path: string) => Promise<string>;
    runQuery: (sql: string) => Promise<{ rows: Row[]; columns: string[] }>;
  };

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new SettingsTab(this.app, this));

    this.registerMarkdownCodeBlockProcessor("motherduck", (src, el, ctx) =>
      this.renderBlock(src, el, ctx),
    );

    this.addCommand({
      id: "refresh-current-note",
      name: "Refresh all MotherDuck queries in this note",
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
      name: "Freeze MotherDuck query at cursor",
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
      name: "Reset DuckDB/MotherDuck connection",
      callback: async () => {
        await this.resetRuntime();
        new Notice("connection reset");
      },
    });

    this.api = {
      refreshFile: (path: string) => this.refreshFile(path),
      runQuery: (sql: string) => this.runQuery(sql),
    };
    console.log("[motherduck] loaded");
  }

  async onunload() {
    await this.resetRuntime();
  }

  async resetRuntime() {
    try {
      await this.runtime?.close();
    } catch (e) {
      console.error("[motherduck] close failed", e);
    }
    this.runtime = null;
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  // ----------------- runtime -----------------

  async getRuntime(): Promise<Runtime> {
    if (this.runtime) return this.runtime;
    this.runtime = this.settings.mdToken
      ? new MotherDuckRuntime(this.settings.mdToken)
      : new DuckDBWasmRuntime(this.settings.dbPath);
    await this.runtime.init();
    return this.runtime;
  }

  async runQuery(sql: string): Promise<{ rows: Row[]; columns: string[] }> {
    const rt = await this.getRuntime();
    return rt.runQuery(sql);
  }

  // ----------------- freeze / refresh -----------------

  async refreshFile(path: string): Promise<string> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`not a file: ${path}`);
    const content = await this.app.vault.read(file);
    const result = await this.processAllBlocks(content);
    if (result.newContent !== content) {
      await this.app.vault.modify(file, result.newContent);
    }
    return `Refreshed ${result.refreshed} block(s), ${result.errored} error(s) in ${path}`;
  }

  async freezeAtCursor(file: TFile, cursorLine: number): Promise<string> {
    const content = await this.app.vault.read(file);
    const blocks = findBlocks(content);
    const hit = blocks.find((b) => cursorLine >= b.startLine && cursorLine <= b.endLine);
    if (!hit) throw new Error("no ```motherduck block at cursor");
    const newContent = await this.freezeBlock(content, hit);
    if (newContent !== content) await this.app.vault.modify(file, newContent);
    return `Froze 1 block`;
  }

  async processAllBlocks(content: string): Promise<{ newContent: string; refreshed: number; errored: number }> {
    const blocks = findBlocks(content);
    let working = content;
    let refreshed = 0;
    let errored = 0;
    // Process from last to first so line offsets stay valid as we mutate content
    for (let i = blocks.length - 1; i >= 0; i--) {
      try {
        working = await this.freezeBlock(working, blocks[i]);
        refreshed++;
      } catch (e) {
        console.error("[motherduck] block error", e);
        errored++;
      }
    }
    return { newContent: working, refreshed, errored };
  }

  async freezeBlock(content: string, block: FencedBlock): Promise<string> {
    const { rows, columns } = await this.runQuery(block.sql);
    const mdTable = renderMarkdownTable(rows, columns, block.sql, this.settings.rowCap);
    return writeSentinelAfterBlock(content, block, mdTable);
  }

  // ----------------- reading-mode renderer -----------------

  renderBlock(src: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) {
    const sql = src.trim();
    if (!sql) {
      el.createEl("em", { text: "empty motherduck block" });
      return;
    }

    const wrap = el.createDiv({ cls: "motherduck-block" });
    wrap.style.border = "1px solid var(--background-modifier-border)";
    wrap.style.borderRadius = "6px";
    wrap.style.padding = "10px";
    wrap.style.margin = "8px 0";

    const pre = wrap.createEl("pre");
    pre.style.margin = "0 0 8px 0";
    pre.style.fontSize = "0.85em";
    pre.createEl("code", { text: sql });

    const btnRow = wrap.createDiv();
    btnRow.style.display = "flex";
    btnRow.style.gap = "8px";
    btnRow.style.alignItems = "center";

    const runBtn = btnRow.createEl("button", { text: "▶ Run" });
    const freezeBtn = btnRow.createEl("button", { text: "📌 Freeze" });
    const status = btnRow.createEl("span");
    status.style.fontSize = "0.85em";
    status.style.opacity = "0.7";

    const resultEl = wrap.createDiv();
    resultEl.style.marginTop = "8px";
    resultEl.style.overflowX = "auto";

    runBtn.addEventListener("click", async () => {
      resultEl.empty();
      status.setText("running…");
      runBtn.setAttr("disabled", "true");
      const t0 = performance.now();
      try {
        const { rows, columns } = await this.runQuery(sql);
        const dt = Math.round(performance.now() - t0);
        status.setText(`${rows.length} row(s) · ${dt} ms`);
        renderDomTable(resultEl, rows, columns, this.settings.rowCap);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.setText("error");
        const errEl = resultEl.createEl("pre");
        errEl.style.color = "var(--text-error)";
        errEl.style.whiteSpace = "pre-wrap";
        errEl.setText(msg);
      } finally {
        runBtn.removeAttribute("disabled");
      }
    });

    freezeBtn.addEventListener("click", async () => {
      status.setText("freezing…");
      freezeBtn.setAttr("disabled", "true");
      try {
        const file = this.app.workspace.getActiveFile();
        if (!file) throw new Error("no active file");
        const info = ctx.getSectionInfo(el);
        if (!info) throw new Error("cannot locate block position");
        const content = await this.app.vault.read(file);
        const block: FencedBlock = { sql, startLine: info.lineStart, endLine: info.lineEnd };
        const newContent = await this.freezeBlock(content, block);
        if (newContent !== content) await this.app.vault.modify(file, newContent);
        status.setText("frozen ✓");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.setText(`error: ${msg}`);
        console.error("[motherduck] freeze failed", e);
      } finally {
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
}

function findBlocks(content: string): FencedBlock[] {
  const lines = content.split("\n");
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^```motherduck\s*$/);
    if (open) {
      const start = i;
      i++;
      const sqlLines: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        sqlLines.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        blocks.push({ sql: sqlLines.join("\n"), startLine: start, endLine: i });
        i++;
      }
    } else {
      i++;
    }
  }
  return blocks;
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

function renderMarkdownTable(rows: Row[], columns: string[], sql: string, rowCap: number): string {
  const hash = simpleHash(sql.trim());
  const ts = new Date().toISOString();
  const totalRows = rows.length;
  const shown = rows.slice(0, rowCap);

  const open = `<!-- md:cache hash=${hash} ts=${ts} rows=${totalRows} -->`;
  const close = `<!-- md:cache-end -->`;

  if (totalRows === 0 || columns.length === 0) {
    return `${open}\n\n_(0 rows)_\n\n${close}`;
  }
  const header = "| " + columns.join(" | ") + " |";
  const sep = "| " + columns.map(() => "---").join(" | ") + " |";
  const body = shown.map((r) => "| " + columns.map((c) => escapeCell(r[c])).join(" | ") + " |");
  const truncated =
    totalRows > rowCap ? `\n\n> … ${totalRows - rowCap} more rows hidden (cap ${rowCap})` : "";
  // Blank lines around the table + around the sentinel comments are required
  // so markdown parsers don't fuse them into a single HTML block and skip table rendering.
  return `${open}\n\n${header}\n${sep}\n${body.join("\n")}${truncated}\n\n${close}`;
}

function renderDomTable(parent: HTMLElement, rows: Row[], columns: string[], rowCap: number) {
  if (rows.length === 0) {
    parent.createEl("em", { text: "(0 rows)" });
    return;
  }
  const shown = rows.slice(0, rowCap);
  const table = parent.createEl("table");
  table.style.borderCollapse = "collapse";
  table.style.fontSize = "0.85em";
  const thead = table.createEl("thead").createEl("tr");
  for (const c of columns) {
    const th = thead.createEl("th", { text: c });
    th.style.borderBottom = "1px solid var(--background-modifier-border)";
    th.style.padding = "4px 8px";
    th.style.textAlign = "left";
  }
  const tbody = table.createEl("tbody");
  for (const row of shown) {
    const tr = tbody.createEl("tr");
    for (const c of columns) {
      const td = tr.createEl("td");
      td.style.borderBottom = "1px solid var(--background-modifier-border)";
      td.style.padding = "4px 8px";
      const v = row[c];
      td.setText(v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  if (rows.length > rowCap) {
    const more = parent.createEl("div", {
      text: `… ${rows.length - rowCap} more rows hidden (cap ${rowCap})`,
    });
    more.style.opacity = "0.7";
    more.style.fontSize = "0.85em";
    more.style.marginTop = "4px";
  }
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

    const active = this.plugin.settings.mdToken ? "motherduck" : "duckdb";
    const modeEl = this.containerEl.createEl("p", { cls: "setting-item-description" });
    modeEl.setText(
      active === "motherduck"
        ? "Token detected: queries run against MotherDuck (cloud)."
        : "No token set: queries run against local DuckDB WASM. Scroll down to connect to MotherDuck.",
    );

    renderSectionHeader(this.containerEl, DUCKDB_ICON, "DuckDB", active === "duckdb");

    new Setting(this.containerEl)
      .setName("Database path")
      .setDesc("`:memory:` for an ephemeral in-memory database (default). File path support is coming.")
      .addText((t) =>
        t
          .setPlaceholder(":memory:")
          .setValue(this.plugin.settings.dbPath)
          .onChange(async (v) => {
            this.plugin.settings.dbPath = v.trim() || ":memory:";
            await this.plugin.saveSettings();
            await this.plugin.resetRuntime();
          }),
      );

    renderSectionHeader(this.containerEl, MOTHERDUCK_ICON, "MotherDuck", active === "motherduck");

    new Setting(this.containerEl)
      .setName("MotherDuck token")
      .setDesc("Optional. Paste a MotherDuck access token to query the cloud instead of local DuckDB. Stored in plaintext in data.json; dev/test only.")
      .addText((t) =>
        t
          .setPlaceholder("eyJ… (leave empty for local DuckDB)")
          .setValue(this.plugin.settings.mdToken)
          .onChange(async (v) => {
            this.plugin.settings.mdToken = v.trim();
            await this.plugin.saveSettings();
            await this.plugin.resetRuntime();
            this.display();
          }),
      );

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
              this.plugin.settings.rowCap = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}

function renderSectionHeader(parent: HTMLElement, svgMarkup: string, title: string, active: boolean) {
  const row = parent.createDiv();
  row.style.display = "flex";
  row.style.alignItems = "center";
  row.style.gap = "10px";
  row.style.marginTop = "24px";
  row.style.marginBottom = "8px";
  row.style.paddingBottom = "6px";
  row.style.borderBottom = "1px solid var(--background-modifier-border)";
  row.style.opacity = active ? "1" : "0.55";

  const iconWrap = row.createDiv();
  iconWrap.style.display = "flex";
  iconWrap.style.alignItems = "center";
  iconWrap.innerHTML = svgMarkup;

  const h = row.createEl("h3", { text: title });
  h.style.margin = "0";

  if (active) {
    const badge = row.createEl("span", { text: "active" });
    badge.style.marginLeft = "auto";
    badge.style.fontSize = "0.75em";
    badge.style.padding = "2px 8px";
    badge.style.borderRadius = "10px";
    badge.style.background = "var(--interactive-accent)";
    badge.style.color = "var(--text-on-accent)";
  }
}
