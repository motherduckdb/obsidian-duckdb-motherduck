import { App, Notice, PluginSettingTab, Setting, TFile, type Plugin } from "obsidian";
import { DUCKDB_ICON, MOTHERDUCK_ICON } from "./icons";
import { formatLogTimestamp } from "./schedule";
import type { Connection, QueryRunResult, Settings, SweepResult } from "./types";

export interface SettingsTabHost {
  app: App;
  settings: Settings;
  saveSettings(): Promise<void>;
  resetRuntimes(only?: Connection): Promise<void>;
  runQuery(sql: string, connection: Connection): Promise<QueryRunResult>;
  startScheduler(): void;
  stopScheduler(): void;
  runManualSweep(): Promise<SweepResult>;
}

export class SettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: SettingsTabHost & Plugin) {
    super(app, plugin);
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
            this.display();
          }
        }),
      );

    this.renderActivityLog();

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

    new Setting(this.containerEl)
      .setName("Cell character cap")
      .setDesc(
        "Max characters per cell in rendered and frozen tables; longer values are truncated with an ellipsis. Hover a truncated cell in the live result to see the full value.",
      )
      .addText((t) =>
        t
          .setPlaceholder("80")
          .setValue(String(this.plugin.settings.cellCharCap))
          .onChange(async (v) => {
            const n = parseInt(v, 10);
            if (!Number.isNaN(n) && n > 0) {
              this.plugin.settings.cellCharCap = Math.min(Math.floor(n), 10000);
              await this.plugin.saveSettings();
            }
          }),
      );
  }

  private renderActivityLog() {
    const logTitle = this.containerEl.createEl("h4", { text: "Activity log" });
    logTitle.style.marginTop = "16px";
    logTitle.style.marginBottom = "4px";

    if (this.plugin.settings.refreshLog.length === 0) {
      this.containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "No refreshes recorded yet.",
      });
      return;
    }

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
