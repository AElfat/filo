// filo's explorer: left sidebar with the favorite folders and the tree
// of the open folder. Files open in a tab.
// State (favorites, open folder, visibility) persisted in config.

import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import * as docs from "./docs";
import { showContextMenu } from "./ctxmenu";
import { t } from "./i18n";

interface Entry {
  name: string;
  path: string;
  isDir: boolean;
}

interface SidebarState {
  favorites: string[];
  root: string | null;
  visible: boolean;
}

let state: SidebarState = { favorites: [], root: null, visible: false };
// folders expanded in the tree: survive re-renders
const expanded = new Set<string>();
// quick filter on the current folder (not persisted)
let query = "";
let searchSeq = 0;

const panel = () => document.querySelector<HTMLElement>("#explorer")!;
const button = () => document.querySelector<HTMLButtonElement>("#btn-explorer")!;

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;

// Stroke icons consistent with the toolbar (32 grid rendered at 14px).
const svg = (inner: string) =>
  `<svg viewBox="0 0 32 32" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
const ICONS = {
  folder: svg(
    '<path d="M3 25V7a2 2 0 0 1 2-2h8l3 4h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  ),
  folderOpen: svg(
    '<path d="M3 25V7a2 2 0 0 1 2-2h8l3 4h9a2 2 0 0 1 2 2v3"/><path d="M6 25l3-8h20l-3 8z"/>',
  ),
  file: svg(
    '<path d="M19 3H9a2 2 0 0 0-2 2v22a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9z"/><path d="M19 3v6h6"/>',
  ),
  star: svg(
    '<path d="M16 4l3.7 7.6 8.3 1.2-6 5.9 1.4 8.3-7.4-3.9-7.4 3.9 1.4-8.3-6-5.9 8.3-1.2z"/>',
  ),
};

async function saveState(): Promise<void> {
  try {
    await invoke("save_config", {
      name: "sidebar",
      contents: JSON.stringify(state),
    });
  } catch {
    // best-effort: the sidebar must never block the app
  }
}

export async function initExplorer(): Promise<void> {
  try {
    const raw = await invoke<string | null>("load_config", { name: "sidebar" });
    if (raw) state = { ...state, ...JSON.parse(raw) };
  } catch {
    // first launch: default state
  }
  applyVisibility();
  if (state.visible) render();

  // right-click on the sidebar background (rows have their own menus)
  panel().addEventListener("contextmenu", (e) => {
    if ((e.target as HTMLElement).closest(".exp-row, .exp-fav")) return;
    e.preventDefault();
    showContextMenu(e.clientX, e.clientY, [
      { label: t("exp.openFolder"), action: () => void chooseRoot() },
    ]);
  });
}

export function toggleExplorer(): void {
  state.visible = !state.visible;
  applyVisibility();
  if (state.visible) render();
  void saveState();
}

function applyVisibility(): void {
  panel().hidden = !state.visible;
  button().classList.toggle("active", state.visible);
}

/** Redraws the whole sidebar (also called on language change). */
export function render(): void {
  if (!state.visible) return;
  const box = panel();
  box.replaceChildren();

  // ── Favorites ──
  const favTitle = document.createElement("div");
  favTitle.className = "panel-section-title exp-title";
  const favLabel = document.createElement("span");
  favLabel.textContent = t("exp.favs");
  favTitle.appendChild(favLabel);
  box.appendChild(favTitle);

  if (state.favorites.length === 0) {
    const hint = document.createElement("p");
    hint.className = "panel-hint";
    hint.textContent = t("exp.favEmpty");
    box.appendChild(hint);
  }
  for (const fav of state.favorites) {
    const row = document.createElement("div");
    row.className = "exp-fav" + (fav === state.root ? " current" : "");
    const main = document.createElement("button");
    main.className = "exp-fav-main";
    main.title = fav;
    main.innerHTML = `<span class="exp-ic">${ICONS.folder}</span>`;
    const name = document.createElement("span");
    name.className = "exp-name";
    name.textContent = baseName(fav);
    main.appendChild(name);
    main.addEventListener("click", () => {
      state.root = fav;
      void saveState();
      render();
    });
    const removeFav = () => {
      state.favorites = state.favorites.filter((f) => f !== fav);
      void saveState();
      render();
    };
    const x = document.createElement("button");
    x.className = "exp-x";
    x.textContent = "×";
    x.title = t("exp.removeFav");
    x.addEventListener("click", (e) => {
      e.stopPropagation();
      removeFav();
    });
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, [
        {
          label: t("ctx.open"),
          action: () => {
            state.root = fav;
            void saveState();
            render();
          },
        },
        { label: t("ctx.copyPath"), action: () => void writeText(fav) },
        "sep",
        { label: t("exp.removeFav"), danger: true, action: removeFav },
      ]);
    });
    row.append(main, x);
    box.appendChild(row);
  }

  // ── Explore ──
  const title = document.createElement("div");
  title.className = "panel-section-title exp-title";
  const label = document.createElement("span");
  label.className = "exp-name";
  label.textContent = state.root ? baseName(state.root) : t("exp.explore");
  if (state.root) label.title = state.root;
  title.appendChild(label);
  const spacer = document.createElement("span");
  spacer.className = "exp-spacer";
  title.appendChild(spacer);
  if (state.root && !state.favorites.includes(state.root)) {
    const star = document.createElement("button");
    star.className = "exp-btn";
    star.innerHTML = ICONS.star;
    star.title = t("exp.addFav");
    star.addEventListener("click", () => {
      state.favorites.push(state.root!);
      void saveState();
      render();
    });
    title.appendChild(star);
  }
  const openBtn = document.createElement("button");
  openBtn.className = "exp-btn";
  openBtn.innerHTML = ICONS.folder;
  openBtn.title = t("exp.openFolder");
  openBtn.addEventListener("click", () => void chooseRoot());
  title.appendChild(openBtn);
  box.appendChild(title);

  if (!state.root) {
    const hint = document.createElement("p");
    hint.className = "panel-hint";
    hint.textContent = t("exp.empty");
    box.appendChild(hint);
    return;
  }

  // quick filter: tree when empty, recursive results while typing
  const search = document.createElement("input");
  search.type = "text";
  search.className = "exp-search";
  search.placeholder = t("exp.search");
  search.spellcheck = false;
  search.autocomplete = "off";
  search.value = query;
  box.appendChild(search);

  const content = document.createElement("div");
  content.className = "exp-tree";
  box.appendChild(content);

  const showTree = () => {
    content.replaceChildren();
    void renderDir(content, state.root!, 0);
  };
  const showResults = async () => {
    const seq = ++searchSeq;
    let results: Entry[] = [];
    try {
      results = await invoke<Entry[]>("search_dir", {
        root: state.root,
        query,
      });
    } catch {
      // folder vanished in the meantime: empty list
    }
    if (seq !== searchSeq) return; // a newer search already started
    content.replaceChildren();
    if (results.length === 0) {
      const hint = document.createElement("p");
      hint.className = "panel-hint";
      hint.textContent = t("exp.noMatch");
      content.appendChild(hint);
      return;
    }
    const rootLen = state.root!.length;
    for (const r of results) {
      const row = document.createElement("button");
      row.className = "exp-row";
      row.style.paddingLeft = "8px";
      row.title = r.path;
      const ic = document.createElement("span");
      ic.className = "exp-ic";
      ic.innerHTML = ICONS.file;
      const name = document.createElement("span");
      name.className = "exp-name";
      name.textContent = r.name;
      row.append(ic, name);
      // relative path of the containing folder, dimmed
      const rel = r.path
        .slice(rootLen)
        .replace(/^[\\/]/, "")
        .slice(0, -r.name.length)
        .replace(/[\\/]$/, "");
      if (rel) {
        const dim = document.createElement("span");
        dim.className = "exp-dim";
        dim.textContent = rel;
        row.appendChild(dim);
      }
      row.addEventListener("click", () => void docs.openPath(r.path));
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        showContextMenu(ev.clientX, ev.clientY, [
          { label: t("ctx.open"), action: () => void docs.openPath(r.path) },
          "sep",
          { label: t("ctx.copyPath"), action: () => void writeText(r.path) },
        ]);
      });
      content.appendChild(row);
    }
  };

  let timer: number | undefined;
  search.addEventListener("input", () => {
    query = search.value.trim();
    window.clearTimeout(timer);
    timer = window.setTimeout(
      () => (query ? void showResults() : showTree()),
      150,
    );
  });
  search.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && query) {
      e.stopPropagation();
      query = "";
      search.value = "";
      showTree();
    } else if (e.key === "Enter") {
      content.querySelector<HTMLButtonElement>(".exp-row")?.click();
    }
  });

  if (query) void showResults();
  else showTree();
}

async function chooseRoot(): Promise<void> {
  const sel = await openDialog({ directory: true });
  if (!sel || Array.isArray(sel)) return;
  state.root = sel;
  void saveState();
  render();
}

/** Fills container with the contents of path (one level, lazy). */
async function renderDir(
  container: HTMLElement,
  path: string,
  depth: number,
): Promise<void> {
  let entries: Entry[];
  try {
    entries = await invoke<Entry[]>("list_dir", { path });
  } catch {
    const err = document.createElement("div");
    err.className = "exp-err";
    err.style.paddingLeft = `${14 + depth * 14}px`;
    err.textContent = `⚠ ${t("exp.error")}`;
    container.appendChild(err);
    return;
  }
  for (const e of entries) {
    const row = document.createElement("button");
    row.className = "exp-row";
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.title = e.path;
    const ic = document.createElement("span");
    ic.className = "exp-ic";
    const name = document.createElement("span");
    name.className = "exp-name";
    name.textContent = e.name;
    if (e.isDir) {
      ic.innerHTML = ICONS.folder;
      row.append(ic, name);
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        showContextMenu(ev.clientX, ev.clientY, [
          {
            label: t("exp.addFav"),
            disabled: state.favorites.includes(e.path),
            action: () => {
              state.favorites.push(e.path);
              void saveState();
              render();
            },
          },
          "sep",
          { label: t("ctx.copyPath"), action: () => void writeText(e.path) },
        ]);
      });

      const children = document.createElement("div");
      children.hidden = true;
      let loaded = false;
      const toggle = async () => {
        if (!loaded) {
          loaded = true;
          await renderDir(children, e.path, depth + 1);
        }
        children.hidden = !children.hidden;
        ic.innerHTML = children.hidden ? ICONS.folder : ICONS.folderOpen;
        if (children.hidden) expanded.delete(e.path);
        else expanded.add(e.path);
      };
      row.addEventListener("click", () => void toggle());
      container.append(row, children);
      if (expanded.has(e.path)) void toggle();
    } else {
      ic.innerHTML = ICONS.file;
      row.append(ic, name);
      row.addEventListener("click", () => void docs.openPath(e.path));
      row.addEventListener("contextmenu", (ev) => {
        ev.preventDefault();
        showContextMenu(ev.clientX, ev.clientY, [
          { label: t("ctx.open"), action: () => void docs.openPath(e.path) },
          "sep",
          { label: t("ctx.copyPath"), action: () => void writeText(e.path) },
        ]);
      });
      container.append(row);
    }
  }
}
