import { App, MarkdownPostProcessorContext, Notice, TFile, setIcon } from "obsidian";
import { DUCKDB_ICON, MOTHERDUCK_ICON } from "./icons";
import { findCacheHashAfterLine } from "./markdown";
import { shortPathLabel } from "./path";
import { renderDomTable, simpleHash } from "./table";
import type { Connection, QueryRunResult, Settings } from "./types";

export interface QueryBlockHost {
  app: App;
  settings: Settings;
  runQuery(sql: string, connection: Connection): Promise<QueryRunResult>;
  freezeRenderedBlock(
    ctx: MarkdownPostProcessorContext,
    el: HTMLElement,
    sql: string,
    connection: Connection,
  ): Promise<void>;
  clearRenderedBlock(ctx: MarkdownPostProcessorContext, el: HTMLElement): Promise<void>;
}

export function renderQueryBlock(
  host: QueryBlockHost,
  connection: Connection,
  src: string,
  el: HTMLElement,
  ctx: MarkdownPostProcessorContext,
) {
  const sql = src.trim();
  if (!sql) {
    el.createEl("em", { text: connection === "cloud" ? "empty motherduck block" : "empty duckdb block" });
    return;
  }

  const wrap = el.createDiv({ cls: "motherduck-block" });
  const badge = wrap.createDiv({ cls: "motherduck-block__badge" });
  const iconWrap = badge.createDiv({ cls: "motherduck-block__engine-icon" });
  iconWrap.innerHTML = connection === "cloud" ? MOTHERDUCK_ICON : DUCKDB_ICON;

  if (connection === "cloud") {
    badge.createEl("span", { text: "MotherDuck" });
  } else {
    badge.createEl("span", { text: "DuckDB " });
    badge.createEl("code", { text: shortPathLabel(host.settings.dbPath) });
  }

  const info = ctx.getSectionInfo(el);
  const cachedHash = info ? findCacheHashAfterLine(info.text, info.lineEnd) : null;
  if (cachedHash && cachedHash !== simpleHash(`${connection}\n${sql}`)) {
    const warn = badge.createEl("span", { cls: "motherduck-block__stale-warn" });
    warn.title =
      "The frozen result below was produced by a different query or connection. Run/Freeze to update it.";
    warn.appendText("⚠ cache stale");
  }

  attachRefreshDropdown(host, badge, ctx);

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

  let clearBtn: HTMLButtonElement | null = null;
  if (cachedHash) {
    clearBtn = btnRow.createEl("button", { cls: "motherduck-block__button" });
    setIcon(clearBtn, "eraser");
    clearBtn.appendText("Clear");
    clearBtn.title = "Remove the frozen result below this block";
    clearBtn.setAttr("aria-label", "Remove the frozen result below this block");
  }

  const status = btnRow.createEl("span", { cls: "motherduck-block__status" });
  const resultEl = wrap.createDiv({ cls: "motherduck-block__result" });

  runBtn.addEventListener("click", async () => {
    resultEl.empty();
    status.setText("running…");
    setButtonsDisabled(true);
    const t0 = performance.now();
    try {
      const { rows, columns } = await host.runQuery(sql, connection);
      const dt = Math.round(performance.now() - t0);
      status.setText(`${rows.length} row(s) · ${dt} ms`);
      renderDomTable(resultEl, rows, columns, host.settings.rowCap, host.settings.cellCharCap);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      status.setText("error");
      resultEl.createEl("pre", { cls: "motherduck-block__error", text: msg });
    } finally {
      setButtonsDisabled(false);
    }
  });

  freezeBtn.addEventListener("click", async () => {
    status.setText("freezing…");
    setButtonsDisabled(true);
    try {
      await host.freezeRenderedBlock(ctx, el, sql, connection);
      status.setText("frozen ✓");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      status.setText(`error: ${msg}`);
      console.error("[motherduck] freeze failed", e);
    } finally {
      setButtonsDisabled(false);
    }
  });

  if (clearBtn) {
    clearBtn.addEventListener("click", async () => {
      status.setText("clearing…");
      setButtonsDisabled(true);
      try {
        await host.clearRenderedBlock(ctx, el);
        status.setText("cleared ✓");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        status.setText(`error: ${msg}`);
        console.error("[motherduck] clear failed", e);
      } finally {
        setButtonsDisabled(false);
      }
    });
  }

  function setButtonsDisabled(disabled: boolean) {
    for (const btn of [runBtn, freezeBtn, clearBtn]) {
      if (!btn) continue;
      if (disabled) btn.setAttr("disabled", "true");
      else btn.removeAttribute("disabled");
    }
  }
}

function attachRefreshDropdown(
  host: QueryBlockHost,
  parent: HTMLElement,
  ctx: MarkdownPostProcessorContext,
) {
  const file = host.app.vault.getAbstractFileByPath(ctx.sourcePath);
  if (!(file instanceof TFile)) return;

  const group = parent.createDiv({ cls: "motherduck-refresh-control" });
  const iconHost = group.createDiv({ cls: "motherduck-refresh-control__icon" });
  setIcon(iconHost, "refresh-cw");

  const select = group.createEl("select", { cls: "motherduck-refresh-control__select" }) as HTMLSelectElement;
  select.title = "Auto-refresh this note (writes to its frontmatter)";
  select.setAttr("aria-label", "Auto-refresh this note");

  const opts: Array<{ value: "" | "daily" | "weekly"; label: string }> = [
    { value: "", label: "Refresh: none" },
    { value: "daily", label: "Refresh: daily" },
    { value: "weekly", label: "Refresh: weekly" },
  ];
  for (const opt of opts) {
    const o = select.createEl("option");
    o.value = opt.value;
    o.text = opt.label;
  }

  const fm = host.app.metadataCache.getFileCache(file)?.frontmatter;
  const current = fm?.["duckdb-motherduck-refresh"];
  select.value = current === "daily" || current === "weekly" ? current : "";

  select.addEventListener("change", async () => {
    const v = select.value as "" | "daily" | "weekly";
    try {
      await host.app.fileManager.processFrontMatter(file, (fmEdit) => {
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
