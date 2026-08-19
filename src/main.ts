// filo's entry point: creates the view, handles tabs, session,
// preferences, shortcuts, drag&drop, "Open with" and safe close.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  createView,
  fontCompartment,
  fontExtension,
  themeCompartment,
  themeExtension,
  wrapCompartment,
  wrapExtension,
} from "./editor";
import * as docs from "./docs";
import { buildPrefsPage, defaultPrefs, loadPrefs, savePrefs, type Prefs } from "./prefs";
import { modal, renderTabs, type TabInfo } from "./ui";
import "./meta";
import { getRecents, initRecents, removeRecent } from "./recents";
import { exportBundle } from "./bundle";
import { createRef, createTarget, goBack } from "./links";
import { createNote } from "./notes";
import { createGroup } from "./groups";
import {
  refreshPanels,
  toggleNotesPanel,
  toggleSidePanel,
} from "./panels";
import { jsonPathAt, minify, prettyPrint } from "./datatools";
import * as explorer from "./explorer";
import { showContextMenu, type CtxEntry } from "./ctxmenu";
import { redo, selectAll, undo } from "@codemirror/commands";
import { readText, writeText } from "@tauri-apps/plugin-clipboard-manager";
import { showAbout } from "./about";
import { applyPreviewState, initPreview, isPreview, togglePreview } from "./preview";
import { setLang, t } from "./i18n";
import "./styles.css";

const el = {
  editor: document.querySelector<HTMLElement>("#editor")!,
  preview: document.querySelector<HTMLElement>("#preview")!,
  prefsPage: document.querySelector<HTMLElement>("#prefs-page")!,
  printArea: document.querySelector<HTMLElement>("#print-area")!,
  tabs: document.querySelector<HTMLElement>("#tabs")!,
  statusPos: document.querySelector<HTMLElement>("#status-pos")!,
  statusCount: document.querySelector<HTMLElement>("#status-count")!,
  statusPath: document.querySelector<HTMLElement>("#status-path")!,
  statusExtra: document.querySelector<HTMLElement>("#status-extra")!,
  statusLang: document.querySelector<HTMLElement>("#status-lang")!,
  statusEnc: document.querySelector<HTMLElement>("#status-enc")!,
  statusEol: document.querySelector<HTMLElement>("#status-eol")!,
  btnExplorer: document.querySelector<HTMLButtonElement>("#btn-explorer")!,
  btnNew: document.querySelector<HTMLButtonElement>("#btn-new")!,
  btnOpen: document.querySelector<HTMLButtonElement>("#btn-open")!,
  btnSave: document.querySelector<HTMLButtonElement>("#btn-save")!,
  btnSaveAs: document.querySelector<HTMLButtonElement>("#btn-save-as")!,
  btnPrefs: document.querySelector<HTMLButtonElement>("#btn-prefs")!,
  btnTarget: document.querySelector<HTMLButtonElement>("#btn-target")!,
  btnRef: document.querySelector<HTMLButtonElement>("#btn-ref")!,
  btnNote: document.querySelector<HTMLButtonElement>("#btn-note")!,
  btnGroup: document.querySelector<HTMLButtonElement>("#btn-group")!,
  btnPanelSide: document.querySelector<HTMLButtonElement>("#btn-panel-side")!,
  btnPanelNotes: document.querySelector<HTMLButtonElement>("#btn-panel-notes")!,
  btnPretty: document.querySelector<HTMLButtonElement>("#btn-pretty")!,
  btnMinify: document.querySelector<HTMLButtonElement>("#btn-minify")!,
  btnPreview: document.querySelector<HTMLButtonElement>("#btn-preview")!,
  brand: document.querySelector<HTMLButtonElement>("#brand")!,
  winMin: document.querySelector<HTMLButtonElement>("#win-min")!,
  winMax: document.querySelector<HTMLButtonElement>("#win-max")!,
  winClose: document.querySelector<HTMLButtonElement>("#win-close")!,
};

// The Settings tab is not a document: it lives next to the file tabs,
// identified by an id that can't collide with the numeric ones.
const PREFS_TAB = "__prefs__";
let prefsTabOpen = false;
let prefsTabActive = false;

let prefs: Prefs;
let sessionTimer: number | undefined;
let lastTitle = "";
let updateQueued = false;

// Applies all the static labels (toolbar, status) in the current language.
function applyStaticI18n() {
  // buttons are icons: the language lives in the tooltips
  el.btnExplorer.title = t("tb.explorer.tip");
  el.btnNew.title = t("tb.new.tip");
  el.btnOpen.title = t("tb.open.tip");
  el.btnSave.title = t("tb.save.tip");
  el.btnSaveAs.title = t("tb.saveAs.tip");
  el.btnTarget.title = t("tb.target.tip");
  el.btnRef.title = t("tb.ref.tip");
  el.btnNote.title = t("tb.note.tip");
  el.btnGroup.title = t("tb.group.tip");
  el.btnPretty.title = t("tb.pretty.tip");
  el.btnMinify.title = t("tb.minify.tip");
  el.btnPanelSide.title = t("tb.links.tip");
  el.btnPanelNotes.title = t("tb.notes.tip");
  el.btnPrefs.title = t("tb.prefs.tip");
  el.brand.title = t("tb.about.tip");
  el.winMin.title = t("win.min");
  el.winMax.title = t("win.max");
  el.winClose.title = t("win.close");
  el.statusEnc.title = t("status.enc.tip");
  el.statusEol.title = t("status.eol.tip");
  el.statusPos.textContent = t("status.pos", 1, 1);
  document.documentElement.lang = prefs.lang;
  explorer.render();
}

function applyPrefs(p: Prefs) {
  const langChanged = !prefs || prefs.lang !== p.lang;
  prefs = p;
  setLang(p.lang);
  docs.setPrefsRef(p);
  document.documentElement.dataset.theme = p.theme;
  if (langChanged) {
    applyStaticI18n();
    onUpdate();
  }
  const effects = [
    themeCompartment.reconfigure(themeExtension(p)),
    fontCompartment.reconfigure(fontExtension(p)),
    wrapCompartment.reconfigure(wrapExtension(p)),
  ];
  docs.getView().dispatch({ effects });
  // update the states of the inactive tabs too
  for (const d of docs.getDocs()) {
    if (d.id !== docs.activeDoc()?.id) {
      d.state = d.state.update({ effects }).state;
    }
  }
}

function scheduleSessionSave() {
  window.clearTimeout(sessionTimer);
  sessionTimer = window.setTimeout(() => void docs.saveSession(), 2000);
}

function onUpdate() {
  // coalesce: many back-to-back calls (e.g. fast typing)
  // produce ONE single UI update per frame
  if (updateQueued) return;
  updateQueued = true;
  window.requestAnimationFrame(() => {
    updateQueued = false;
    doUpdate();
  });
}

function doUpdate() {
  const list = docs.getDocs();
  const active = docs.activeDoc();
  const tabList: TabInfo[] = list.map((d) => ({
    id: d.id,
    title: docs.docTitle(d),
    dirty: d.dirty,
    active: !prefsTabActive && d.id === active?.id,
  }));
  if (prefsTabOpen) {
    tabList.push({
      id: PREFS_TAB,
      title: t("prefs.title"),
      dirty: false,
      active: prefsTabActive,
      fixed: true,
    });
  }
  renderTabs(el.tabs, tabList, {
    select: (id) => {
      if (id === PREFS_TAB) {
        prefsTabActive = true;
        onUpdate();
      } else {
        prefsTabActive = false;
        docs.activate(id);
      }
    },
    close: (id) => {
      if (id === PREFS_TAB) closePrefsTab();
      else void docs.closeDoc(id);
    },
    reorder: (id, beforeId) => {
      if (id === PREFS_TAB) return;
      docs.moveDoc(id, beforeId === PREFS_TAB ? null : beforeId);
    },
  });
  // the preview button only shows up for Markdown; it reflects the state
  el.btnPreview.hidden = active?.lang !== "markdown";
  el.btnPreview.classList.toggle("active", isPreview(active));
  el.btnPreview.title = isPreview(active)
    ? t("tb.editMode.tip")
    : t("tb.preview.tip");
  applyPreviewState();
  // the Settings tab covers editor and preview while active
  el.prefsPage.hidden = !prefsTabActive;
  if (prefsTabActive) {
    el.editor.hidden = true;
    el.preview.hidden = true;
  }

  if (active) {
    el.statusLang.textContent =
      active.lang === "testo" ? t("status.lang.testo") : active.lang;
    el.statusEnc.textContent = active.encoding.toUpperCase();
    el.statusEol.textContent = active.eol === "crlf" ? "CRLF" : "LF";
    const title = `${docs.docTitle(active)}${active.dirty ? " •" : ""} — filo`;
    if (title !== lastTitle) {
      // the title goes through an IPC call: never repeat it unchanged
      lastTitle = title;
      void getCurrentWindow().setTitle(title);
    }
  }
  refreshPanels();
  scheduleCounts();
  scheduleSessionSave();
}

// ── Word and character count in the status bar ───────────────────────
// Of the selection if any, otherwise of the whole document; on huge
// files only characters are shown (counting words is expensive).

let countTimer: number | undefined;

function scheduleCounts() {
  window.clearTimeout(countTimer);
  countTimer = window.setTimeout(updateCounts, 150);
}

function updateCounts() {
  const state = docs.getView().state;
  const sel = state.selection.main;
  const selText = sel.empty ? null : state.sliceDoc(sel.from, sel.to);
  const chars = selText ? selText.length : state.doc.length;
  const text =
    selText ?? (state.doc.length > 2_000_000 ? null : state.doc.toString());
  el.statusCount.textContent =
    text === null
      ? t("status.chars", chars)
      : t(selText ? "status.countSel" : "status.count",
          text.match(/\S+/g)?.length ?? 0, chars);
}

// ── Text size on the fly (Ctrl+wheel, Ctrl+plus/minus/0) ─────────────

let fontSaveTimer: number | undefined;

function setFontSize(px: number) {
  const size = Math.min(32, Math.max(8, Math.round(px)));
  if (size === prefs.fontSize) return;
  applyPrefs({ ...prefs, fontSize: size });
  if (prefsTabOpen) renderPrefsPage();
  window.clearTimeout(fontSaveTimer);
  fontSaveTimer = window.setTimeout(() => void savePrefs(prefs), 500);
}

function toggleWrap() {
  const next = { ...prefs, wrap: !prefs.wrap };
  applyPrefs(next);
  void savePrefs(next);
  if (prefsTabOpen) renderPrefsPage();
}

// ── Print (Ctrl+P) ────────────────────────────────────────────────────
// CodeMirror virtualizes lines: printing uses a dedicated area with the
// full text (or the Markdown preview's HTML).

function printActive() {
  const doc = docs.activeDoc();
  if (!doc) return;
  const preview = isPreview(doc);
  el.printArea.classList.toggle("markdown-body", preview);
  if (preview) el.printArea.innerHTML = el.preview.innerHTML;
  else el.printArea.textContent = docs.getView().state.doc.toString();
  window.print();
}

// ── Startup ───────────────────────────────────────────────────────────

async function boot() {
  prefs = await loadPrefs();
  setLang(prefs.lang);
  document.documentElement.dataset.theme = prefs.theme;
  applyStaticI18n();

  const view = createView(el.editor, {
    docChanged() {
      // markActiveDirty calls onUpdate only on the clean → dirty
      // transition: no extra work on every keystroke
      docs.markActiveDirty();
    },
    cursorMoved(line, col) {
      el.statusPos.textContent = t("status.pos", line, col);
      scheduleCounts();
      const doc = docs.activeDoc();
      el.statusPath.textContent =
        doc?.lang === "json"
          ? (jsonPathAt(
              docs.getView().state,
              docs.getView().state.selection.main.head,
            ) ?? "")
          : "";
    },
  });
  docs.initDocs(view, prefs, onUpdate);
  await initRecents();

  const restored = await docs.restoreSession();
  const cli = await invoke<string[]>("get_cli_files");
  for (const p of cli) await docs.openPath(p);
  if (!restored && cli.length === 0) docs.newDoc();

  // Second instance ("Open with filo"): receives the paths and opens them here.
  await listen<string[]>("open-files", async (e) => {
    for (const p of e.payload ?? []) await docs.openPath(p);
  });

  // Drag files onto the window to open them.
  await getCurrentWebview().onDragDropEvent(async (e) => {
    if (e.payload.type === "drop") {
      for (const p of e.payload.paths) await docs.openPath(p);
    }
  });

  // Safe close: never lose changes without asking.
  let closing = false;
  await getCurrentWindow().onCloseRequested(async (e) => {
    if (closing) return;
    e.preventDefault();
    const dirty = docs.dirtyDocs();
    if (dirty.length > 0) {
      const names = dirty.map((d) => docs.docTitle(d)).join(", ");
      const choice = await modal(
        t("close.title"),
        t("close.many", names),
        [
          { id: "salva", label: t("close.saveExit"), primary: true },
          { id: "scarta", label: t("close.discardExit") },
          { id: "annulla", label: t("btn.cancel") },
        ],
      );
      if (choice === "annulla") return;
      if (choice === "salva") {
        for (const d of dirty) {
          const ok = await docs.saveDoc(d);
          if (!ok) return; // "save as" dialog cancelled: stay open
        }
      }
    }
    closing = true;
    await docs.saveSession();
    await getCurrentWindow().destroy();
  });

  initPreview();
  wireToolbar();
  wireWindowControls();
  wireShortcuts();
  wireNativeGuards();
  initContextMenus();
  wireStatusbar();
  await explorer.initExplorer();

  // File modified by another program: checked when the window comes
  // back to the foreground and when switching tabs.
  void getCurrentWindow().onFocusChanged((e) => {
    if (e.payload) void docs.checkActiveExternal();
  });
  docs.docActivatedHooks.push(() => void docs.checkActiveExternal());

  // the print area must not stay filled in memory
  window.addEventListener("afterprint", () => el.printArea.replaceChildren());

  // mouse wheel over the tabs = horizontal scrolling
  el.tabs.addEventListener(
    "wheel",
    (e) => {
      if (e.deltaY !== 0) {
        e.preventDefault();
        el.tabs.scrollLeft += e.deltaY;
      }
    },
    { passive: false },
  );
  onUpdate();
  view.focus();
}

function wireToolbar() {
  el.btnExplorer.addEventListener("click", () => explorer.toggleExplorer());
  el.btnNew.addEventListener("click", () => docs.newDoc());
  el.btnOpen.addEventListener("click", () => void docs.openWithDialog());
  // right-click on Open: the recently opened files
  el.btnOpen.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation(); // the titlebar menu must not open
    const items: CtxEntry[] = getRecents().map((p) => ({
      label: p.split(/[\\/]/).pop()!,
      action: () =>
        void docs.openPath(p).then((d) => {
          if (!d) removeRecent(p); // file gone: drop it from the list
        }),
    }));
    const r = el.btnOpen.getBoundingClientRect();
    showContextMenu(
      r.left,
      r.bottom + 2,
      items.length > 0
        ? items
        : [{ label: t("recents.empty"), disabled: true, action: () => {} }],
    );
  });
  el.btnSave.addEventListener("click", () => void docs.saveActive());
  el.btnSaveAs.addEventListener("click", () => void docs.saveActive(true));
  el.btnPrefs.addEventListener("click", () => openPrefsTab());
  el.btnTarget.addEventListener("click", () => createTarget());
  el.btnRef.addEventListener("click", () => void createRef());
  el.btnNote.addEventListener("click", () => createNote());
  el.btnGroup.addEventListener("click", () => void createGroup());
  el.btnPanelSide.addEventListener("click", () => toggleSidePanel());
  el.btnPanelNotes.addEventListener("click", () => toggleNotesPanel());
  el.btnPretty.addEventListener("click", () => void prettyPrint());
  el.btnMinify.addEventListener("click", () => void minify());
  el.btnPreview.addEventListener("click", () => {
    togglePreview();
    onUpdate();
  });
  el.brand.addEventListener("click", () => void showAbout());
}

// ── Settings tab ──────────────────────────────────────────────────────

function renderPrefsPage() {
  el.prefsPage.replaceChildren(
    buildPrefsPage(prefs, (next) => {
      const langChanged = prefs.lang !== next.lang;
      applyPrefs(next);
      void savePrefs(next);
      // language change: the page itself must be redrawn in the new language
      if (langChanged) renderPrefsPage();
    }),
  );
}

function openPrefsTab() {
  prefsTabOpen = true;
  prefsTabActive = true;
  renderPrefsPage();
  onUpdate();
}

function closePrefsTab() {
  prefsTabOpen = false;
  prefsTabActive = false;
  onUpdate();
  docs.getView().focus();
}

// ── Window controls (the toolbar is also the titlebar) ────────────────

function wireWindowControls() {
  const win = getCurrentWindow();
  el.winMin.addEventListener("click", () => void win.minimize());
  el.winMax.addEventListener("click", () => void win.toggleMaximize());
  el.winClose.addEventListener("click", () => void win.close());
  // the maximize/restore icon follows the window's real state
  const refresh = async () => {
    const max = await win.isMaximized();
    el.winMax.textContent = max ? "\uE923" : "\uE922";
    el.winMax.title = max ? t("win.restore") : t("win.max");
  };
  window.addEventListener("resize", () => void refresh());
  void refresh();
  // the Maximize area is "non-client" (snap layout): the hover comes
  // from the backend, not from the webview's mouse
  void listen<boolean>("max-hover", (e) => {
    el.winMax.classList.toggle("hover", e.payload);
  });
}

function wireShortcuts() {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
        return;
      }
      // Esc closes the Settings tab (but never underneath an open
      // modal or context menu)
      if (
        e.key === "Escape" &&
        prefsTabActive &&
        !document.querySelector(".modal-overlay") &&
        !document.querySelector(".ctx-menu")
      ) {
        e.preventDefault();
        closePrefsTab();
        return;
      }
      // Alt+Z: word wrap, like in real editors
      if (e.altKey && !e.ctrlKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        toggleWrap();
        return;
      }
      if (!e.ctrlKey) return;
      const key = e.key.toLowerCase();
      // Ctrl+plus/minus/0: text size
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        setFontSize(prefs.fontSize + 1);
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        setFontSize(prefs.fontSize - 1);
        return;
      }
      if (e.key === "0") {
        e.preventDefault();
        setFontSize(defaultPrefs.fontSize);
        return;
      }
      if (e.altKey && key === "f") {
        e.preventDefault();
        void prettyPrint();
        return;
      }
      if (e.altKey && key === "m") {
        e.preventDefault();
        void minify();
        return;
      }
      if (e.altKey && key === "s") {
        e.preventDefault();
        void docs.saveAll();
        return;
      }
      if (e.shiftKey && key === "v") {
        e.preventDefault();
        togglePreview();
        onUpdate();
        return;
      }
      if (key === "l") {
        e.preventDefault();
        createTarget();
      } else if (key === "k") {
        e.preventDefault();
        void createRef();
      } else if (key === "n") {
        e.preventDefault();
        createNote();
      } else if (key === "g") {
        e.preventDefault();
        void createGroup();
      } else if (key === "b" && !e.shiftKey) {
        e.preventDefault();
        explorer.toggleExplorer();
      } else if (key === "o" && !e.shiftKey) {
        e.preventDefault();
        void docs.openWithDialog();
      } else if (key === "s") {
        e.preventDefault();
        void docs.saveActive(e.shiftKey);
      } else if (key === "t" && !e.shiftKey) {
        e.preventDefault();
        docs.newDoc();
      } else if (key === "t" && e.shiftKey) {
        e.preventDefault();
        void docs.reopenLastClosed();
      } else if (key === "e" && e.shiftKey) {
        e.preventDefault();
        void exportBundle();
      } else if (key === "p" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        printActive();
      } else if (key === "w" && !e.shiftKey) {
        e.preventDefault();
        if (prefsTabActive) {
          closePrefsTab();
        } else {
          const active = docs.activeDoc();
          if (active) void docs.closeDoc(active.id);
        }
      } else if (e.key === "Tab") {
        e.preventDefault();
        if (prefsTabActive) {
          // from the Settings tab go back to the active document
          prefsTabActive = false;
          const active = docs.activeDoc();
          if (active) docs.activate(active.id);
        } else {
          docs.cycleTab(!e.shiftKey);
        }
      } else if (e.key === ",") {
        e.preventDefault();
        openPrefsTab();
      }
    },
    true,
  );
}

// filo is not a browser: Chromium's context menu and browser
// shortcuts (devtools, reload, print, zoom, find in page) get
// neutralized. The features' right-clicks (groups, links) don't pass
// through here: they handle the event on the target and never reach
// the default.
function wireNativeGuards() {
  window.addEventListener("contextmenu", (e) => e.preventDefault());
  // no browser suggestions/history in text fields: applies to every
  // input in the app, including CodeMirror's panels
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) {
      t.autocomplete = "off";
    }
  });
  window.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.toLowerCase();
      const blocked =
        e.key === "F12" || // devtools
        e.key === "F5" || // reload
        e.key === "F3" || // find in page
        e.key === "F7" || // caret browsing
        (e.ctrlKey && e.shiftKey && ["i", "j", "c"].includes(k)) || // devtools
        (e.ctrlKey && ["r", "u", "j"].includes(k)); // reload, view source…
      if (blocked) e.preventDefault();
    },
    true,
  );
  // Ctrl+wheel: text size (not browser zoom)
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey) {
        e.preventDefault();
        setFontSize(prefs.fontSize + (e.deltaY < 0 ? 1 : -1));
      }
    },
    { passive: false },
  );
}

// ── Per-zone context menus ────────────────────────────────────────────
// The browser default is blocked by wireNativeGuards; here each zone
// opens filo's menu with the standard commands for its context.

function initContextMenus() {
  // editor: standard editing commands
  el.editor.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const view = docs.getView();
    const sel = view.state.selection.main;
    showContextMenu(e.clientX, e.clientY, [
      {
        label: t("ctx.undo"),
        shortcut: "Ctrl+Z",
        action: () => {
          undo(view);
          view.focus();
        },
      },
      {
        label: t("ctx.redo"),
        shortcut: "Ctrl+Y",
        action: () => {
          redo(view);
          view.focus();
        },
      },
      "sep",
      {
        label: t("ctx.cut"),
        shortcut: "Ctrl+X",
        disabled: sel.empty,
        action: async () => {
          await writeText(view.state.sliceDoc(sel.from, sel.to));
          view.dispatch({ changes: { from: sel.from, to: sel.to } });
          view.focus();
        },
      },
      {
        label: t("ctx.copy"),
        shortcut: "Ctrl+C",
        disabled: sel.empty,
        action: async () => {
          await writeText(view.state.sliceDoc(sel.from, sel.to));
          view.focus();
        },
      },
      {
        label: t("ctx.paste"),
        shortcut: "Ctrl+V",
        action: async () => {
          try {
            const text = await readText();
            if (text) view.dispatch(view.state.replaceSelection(text));
          } catch {
            // clipboard empty or non-text
          }
          view.focus();
        },
      },
      "sep",
      {
        label: t("ctx.selectAll"),
        shortcut: "Ctrl+A",
        action: () => {
          selectAll(view);
          view.focus();
        },
      },
      "sep",
      {
        label: t("ctx.print"),
        shortcut: "Ctrl+P",
        action: () => printActive(),
      },
    ]);
  });

  // markdown preview: copy the selection
  el.preview.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const selText = document.getSelection()?.toString() ?? "";
    showContextMenu(e.clientX, e.clientY, [
      {
        label: t("ctx.copy"),
        shortcut: "Ctrl+C",
        disabled: !selText,
        action: () => void writeText(selText),
      },
      "sep",
      {
        label: t("ctx.selectAll"),
        shortcut: "Ctrl+A",
        action: () => {
          const range = document.createRange();
          range.selectNodeContents(el.preview);
          const s = document.getSelection();
          s?.removeAllRanges();
          s?.addRange(range);
        },
      },
    ]);
  });

  // tabs: close / close others / copy path
  el.tabs.addEventListener("contextmenu", (e) => {
    const tabEl = (e.target as HTMLElement).closest<HTMLElement>(".tab");
    if (!tabEl?.dataset.id) return; // tab strip background: no menu
    e.preventDefault();
    const id = tabEl.dataset.id;
    if (id === PREFS_TAB) {
      showContextMenu(e.clientX, e.clientY, [
        {
          label: t("btn.close"),
          shortcut: "Ctrl+W",
          action: () => closePrefsTab(),
        },
      ]);
      return;
    }
    const d = docs.getDocs().find((d) => d.id === id);
    if (!d) return;
    showContextMenu(e.clientX, e.clientY, [
      {
        label: t("btn.close"),
        shortcut: "Ctrl+W",
        action: () => void docs.closeDoc(id),
      },
      {
        label: t("ctx.closeOthers"),
        disabled: docs.getDocs().length < 2 && !prefsTabOpen,
        action: () => void closeOtherTabs(id),
      },
      "sep",
      {
        label: t("ctx.saveAll"),
        shortcut: "Ctrl+Alt+S",
        disabled: !docs.getDocs().some((x) => x.dirty),
        action: () => void docs.saveAll(),
      },
      {
        label: t("ctx.export"),
        shortcut: "Ctrl+Shift+E",
        action: () => void exportBundle(d),
      },
      {
        label: t("ctx.copyPath"),
        disabled: !d.path,
        action: () => void writeText(d.path!),
      },
    ]);
  });

  // titlebar: window menu
  document
    .querySelector<HTMLElement>("#toolbar")!
    .addEventListener("contextmenu", (e) => {
      e.preventDefault();
      void (async () => {
        const win = getCurrentWindow();
        const max = await win.isMaximized();
        showContextMenu(e.clientX, e.clientY, [
          {
            label: max ? t("win.restore") : t("win.max"),
            action: () => void win.toggleMaximize(),
          },
          { label: t("win.min"), action: () => void win.minimize() },
          "sep",
          {
            label: t("win.close"),
            shortcut: "Alt+F4",
            danger: true,
            action: () => void win.close(),
          },
        ]);
      })();
    });
}

async function closeOtherTabs(keepId: string) {
  for (const d of [...docs.getDocs()]) {
    if (d.id !== keepId) {
      const ok = await docs.closeDoc(d.id);
      if (!ok) return; // the user cancelled: stop here
    }
  }
  if (prefsTabOpen) closePrefsTab();
}

function wireStatusbar() {
  // Click on the encoding: toggles UTF-8 ⇄ Windows-1252 (applied on save).
  // The title is set by applyStaticI18n.
  el.statusEnc.addEventListener("click", () => {
    const doc = docs.activeDoc();
    if (!doc) return;
    doc.encoding = doc.encoding === "utf-8" ? "windows-1252" : "utf-8";
    if (doc.encoding === "windows-1252") doc.bom = false;
    doc.dirty = true;
    onUpdate();
  });
  // Click on the line ending: toggles CRLF ⇄ LF (title in applyStaticI18n).
  el.statusEol.addEventListener("click", () => {
    const doc = docs.activeDoc();
    if (!doc) return;
    doc.eol = doc.eol === "crlf" ? "lf" : "crlf";
    doc.dirty = true;
    onUpdate();
  });
}

// Unexpected errors must never be silent: they show up in the status
// bar instead of vanishing into the console.
function showError(msg: string) {
  el.statusExtra.textContent = `⚠ ${msg}`;
  el.statusExtra.style.color = "var(--danger)";
  window.setTimeout(() => {
    el.statusExtra.textContent = "";
    el.statusExtra.style.color = "";
  }, 8000);
}
window.addEventListener("error", (e) => showError(e.message));
window.addEventListener("unhandledrejection", (e) =>
  showError(String(e.reason)),
);

void boot();
