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

type Connection = "local" | "cloud";

interface Settings {
  mdToken: string;
  dbPath: string;
  rowCap: number;
}

const DEFAULTS: Settings = { mdToken: "", dbPath: ":memory:", rowCap: 100 };

export default class MotherDuckPlugin extends Plugin {
  settings!: Settings;
  // One cached runtime per connection. They're independent: changing the local
  // db path resets only the local runtime, changing the token resets only the
  // cloud one. Queries on different connections in the same note coexist.
  private localRuntime: Runtime | null = null;
  private cloudRuntime: Runtime | null = null;
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
    console.log("[motherduck] loaded");
  }

  async onunload() {
    await this.resetRuntimes();
  }

  async resetRuntimes(only?: Connection) {
    if (!only || only === "local") {
      try {
        await this.localRuntime?.close();
      } catch (e) {
        console.error("[motherduck] close local failed", e);
      }
      this.localRuntime = null;
    }
    if (!only || only === "cloud") {
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
      this.cloudRuntime = new MotherDuckRuntime(this.settings.mdToken);
      await this.cloudRuntime.init();
      return this.cloudRuntime;
    }
    if (this.localRuntime) return this.localRuntime;
    this.localRuntime = new DuckDBWasmRuntime(this.settings.dbPath);
    await this.localRuntime.init();
    return this.localRuntime;
  }

  async runQuery(sql: string, connection: Connection): Promise<{ rows: Row[]; columns: string[] }> {
    const rt = await this.getRuntime(connection);
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
    if (!hit) throw new Error("no ```duckdb or ```motherduck block at cursor");
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
    const { rows, columns } = await this.runQuery(block.sql, block.connection);
    const mdTable = renderMarkdownTable(rows, columns, block.sql, this.settings.rowCap);
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
    wrap.style.border = "1px solid var(--background-modifier-border)";
    wrap.style.borderRadius = "6px";
    wrap.style.padding = "10px";
    wrap.style.margin = "8px 0";

    // Connection badge above the SQL: tells the reader at a glance whether
    // this block hits the local DuckDB or MotherDuck cloud, mapping 1:1 to
    // the section names in plugin settings.
    const badge = wrap.createDiv();
    badge.style.display = "flex";
    badge.style.alignItems = "center";
    badge.style.gap = "6px";
    badge.style.fontSize = "0.8em";
    badge.style.opacity = "0.75";
    badge.style.marginBottom = "6px";
    const iconWrap = badge.createDiv();
    iconWrap.style.display = "flex";
    iconWrap.style.alignItems = "center";
    iconWrap.innerHTML = connection === "cloud" ? MOTHERDUCK_ICON : DUCKDB_ICON;
    const svg = iconWrap.querySelector("svg");
    if (svg) {
      svg.setAttribute("width", "14");
      svg.setAttribute("height", "14");
    }
    if (connection === "cloud") {
      badge.createEl("span", { text: "MotherDuck" });
    } else {
      badge.createEl("span", { text: "DuckDB " });
      badge.createEl("code", { text: shortPathLabel(this.settings.dbPath) });
    }

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
        const { rows, columns } = await this.runQuery(sql, connection);
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
        const block: FencedBlock = { sql, startLine: info.lineStart, endLine: info.lineEnd, connection };
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
  connection: Connection;
}

function findBlocks(content: string): FencedBlock[] {
  const lines = content.split("\n");
  const blocks: FencedBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const open = lines[i].match(/^```(motherduck|duckdb)\s*$/);
    if (open) {
      const connection: Connection = open[1] === "duckdb" ? "local" : "cloud";
      const start = i;
      i++;
      const sqlLines: string[] = [];
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
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
