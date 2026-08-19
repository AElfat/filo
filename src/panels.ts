// filo's panels: side (links, groups, broken items) and bottom
// (footnotes). Plain DOM, rebuilt on every refresh.

import {
  anchorPos,
  metaField,
  removeItemEffect,
  saveMetaSoon,
  updateNoteEffect,
  type DocMeta,
} from "./meta";
import { activeDoc, docActivatedHooks, getView, syncActiveState } from "./docs";
import { followLink, jumpTo } from "./links";
import { noteNumbers, toSuperscript } from "./notes";
import { groupRange, removeGroup, toggleGroup } from "./groups";
import { t as tr } from "./i18n";

const sidePanel = () => document.querySelector<HTMLElement>("#side-panel")!;
const notesPanel = () => document.querySelector<HTMLElement>("#notes-panel")!;

let sideVisible = false;
let notesVisible = false;

export function toggleSidePanel() {
  sideVisible = !sideVisible;
  refreshPanels();
}

export function toggleNotesPanel() {
  notesVisible = !notesVisible;
  refreshPanels();
}

export function showNotesPanel(visible: boolean) {
  notesVisible = visible;
}

function activeMeta(): DocMeta | null {
  // the active document is always mounted in the view
  return activeDoc() ? getView().state.field(metaField) : null;
}

function dispatchRemove(kind: "target" | "link" | "note" | "group", id: string) {
  const doc = activeDoc();
  if (!doc) return;
  if (kind === "group") {
    // single removal path for groups (also unfolds the fold)
    removeGroup(id);
    return;
  }
  getView().dispatch({ effects: removeItemEffect.of({ kind, id }) });
  syncActiveState();
  saveMetaSoon(doc);
  refreshPanels();
}

// ── Side panel ────────────────────────────────────────────────────────

function section(title: string): HTMLElement {
  const h = document.createElement("h3");
  h.className = "panel-section-title";
  h.textContent = title;
  return h;
}

function panelRow(
  label: string,
  detail: string | null,
  onClick: (() => void) | null,
  onRemove: (() => void) | null,
  colorDot?: string,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "panel-row";
  const main = document.createElement("button");
  main.className = "panel-row-main";
  if (colorDot) {
    const dot = document.createElement("span");
    dot.className = "color-dot small";
    dot.style.background = colorDot;
    main.appendChild(dot);
  }
  const l = document.createElement("span");
  l.className = "panel-row-label";
  l.textContent = label;
  main.appendChild(l);
  if (detail) {
    const d = document.createElement("span");
    d.className = "panel-row-detail";
    d.textContent = detail;
    main.appendChild(d);
  }
  if (onClick) main.addEventListener("click", onClick);
  else main.disabled = true;
  row.appendChild(main);
  if (onRemove) {
    const x = document.createElement("button");
    x.className = "panel-row-remove";
    x.textContent = "✕";
    x.title = tr("panel.row.remove");
    x.addEventListener("click", onRemove);
    row.appendChild(x);
  }
  return row;
}

function hint(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "panel-hint";
  p.textContent = text;
  return p;
}

function renderSide() {
  const panel = sidePanel();
  panel.hidden = !sideVisible;
  if (!sideVisible) return;
  panel.replaceChildren();
  const doc = activeDoc();
  const meta = activeMeta();
  if (!doc || !meta) return;
  const state = getView().state;

  panel.appendChild(section(tr("panel.targets")));
  if (meta.targets.length === 0) {
    panel.appendChild(hint(tr("panel.targets.hint")));
  }
  for (const target of meta.targets) {
    const pos = anchorPos(meta, target.anchorId);
    const line = pos !== null ? state.doc.lineAt(pos).number : null;
    panel.appendChild(
      panelRow(
        target.label,
        line !== null ? tr("panel.row.line", line) : tr("panel.row.broken"),
        pos !== null ? () => jumpTo(doc, pos) : null,
        () => dispatchRemove("target", target.anchorId),
      ),
    );
  }

  panel.appendChild(section(tr("panel.refs")));
  if (meta.links.length === 0) {
    panel.appendChild(hint(tr("panel.refs.hint")));
  }
  for (const l of meta.links) {
    const file = l.targetFile ? l.targetFile.split(/[\\/]/).pop() : null;
    panel.appendChild(
      panelRow(
        l.label ?? tr("panel.ref"),
        file ?? tr("link.thisDoc"),
        () => void followLink(l),
        () => dispatchRemove("link", l.anchorId),
      ),
    );
  }

  panel.appendChild(section(tr("panel.groups")));
  if (meta.groups.length === 0) {
    panel.appendChild(hint(tr("panel.groups.hint")));
  }
  for (const g of meta.groups) {
    const range = groupRange(meta, g, state.doc);
    const detail = range
      ? tr(
          "panel.group.range",
          state.doc.lineAt(range.from).number,
          state.doc.lineAt(range.to).number,
        ) + (g.collapsed ? tr("panel.group.closed") : "")
      : tr("panel.row.broken");
    const row = panelRow(
      g.label,
      detail,
      range ? () => jumpTo(doc, range.from) : null,
      () => dispatchRemove("group", g.id),
      g.color,
    );
    if (range) {
      const fold = document.createElement("button");
      fold.className = "panel-row-remove";
      fold.textContent = g.collapsed ? "▸" : "▾";
      fold.title = g.collapsed ? tr("panel.expand") : tr("panel.collapse");
      fold.addEventListener("click", () => toggleGroup(g.id));
      row.insertBefore(fold, row.lastElementChild);
    }
    panel.appendChild(row);
  }

  // broken items (anchors not found again after external changes)
  const brokenIds = new Set(
    meta.anchors.filter((a) => a.broken).map((a) => a.id),
  );
  if (brokenIds.size > 0) {
    panel.appendChild(section(tr("panel.broken")));
    panel.appendChild(hint(tr("panel.broken.hint")));
    for (const target of meta.targets.filter((x) => brokenIds.has(x.anchorId))) {
      panel.appendChild(
        panelRow(`◎ ${target.label}`, null, null, () =>
          dispatchRemove("target", target.anchorId),
        ),
      );
    }
    for (const l of meta.links.filter((l) => brokenIds.has(l.anchorId))) {
      panel.appendChild(
        panelRow(`↗ ${l.label ?? tr("panel.ref")}`, null, null, () =>
          dispatchRemove("link", l.anchorId),
        ),
      );
    }
    for (const n of meta.notes.filter((n) => brokenIds.has(n.anchorId))) {
      panel.appendChild(
        panelRow(
          `¹ ${n.text.slice(0, 30) || tr("panel.emptyNote")}`,
          null,
          null,
          () => dispatchRemove("note", n.anchorId),
        ),
      );
    }
    for (const g of meta.groups.filter(
      (g) => brokenIds.has(g.fromAnchorId) || brokenIds.has(g.toAnchorId),
    )) {
      panel.appendChild(
        panelRow(`▦ ${g.label}`, null, null, () =>
          dispatchRemove("group", g.id),
        ),
      );
    }
  }
}

// ── Notes panel ───────────────────────────────────────────────────────

function renderNotes() {
  const panel = notesPanel();
  panel.hidden = !notesVisible;
  if (!notesVisible) return;
  panel.replaceChildren();
  const doc = activeDoc();
  const meta = activeMeta();
  if (!doc || !meta) return;

  const title = section(tr("notes.title"));
  panel.appendChild(title);
  if (meta.notes.length === 0) {
    panel.appendChild(hint(tr("notes.empty")));
    return;
  }

  const numbers = noteNumbers(meta);
  const ordered = [...meta.notes].sort(
    (a, b) => (numbers.get(a.anchorId) ?? 0) - (numbers.get(b.anchorId) ?? 0),
  );
  for (const n of ordered) {
    const row = document.createElement("div");
    row.className = "note-row";

    const num = document.createElement("button");
    num.className = "note-num";
    num.textContent = toSuperscript(numbers.get(n.anchorId) ?? 0);
    num.title = tr("notes.goRef.tip");
    const pos = anchorPos(meta, n.anchorId);
    if (pos !== null) {
      num.addEventListener("click", () => jumpTo(doc, pos));
    } else {
      num.disabled = true;
    }
    row.appendChild(num);

    const ta = document.createElement("textarea");
    ta.className = "note-text";
    ta.rows = 1;
    ta.placeholder = tr("notes.placeholder");
    ta.value = n.text;
    ta.dataset.anchor = n.anchorId;
    ta.addEventListener("input", () => {
      autoGrow(ta);
      getView().dispatch({
        effects: updateNoteEffect.of({ anchorId: n.anchorId, text: ta.value }),
      });
      syncActiveState();
      saveMetaSoon(doc);
    });
    row.appendChild(ta);

    const x = document.createElement("button");
    x.className = "panel-row-remove";
    x.textContent = "✕";
    x.title = tr("notes.delete.tip");
    x.addEventListener("click", () => dispatchRemove("note", n.anchorId));
    row.appendChild(x);

    panel.appendChild(row);
    autoGrow(ta);
  }
}

function autoGrow(ta: HTMLTextAreaElement) {
  ta.style.height = "auto";
  ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
}

export function focusNote(anchorId: string) {
  window.setTimeout(() => {
    const ta = notesPanel().querySelector<HTMLTextAreaElement>(
      `textarea[data-anchor="${anchorId}"]`,
    );
    ta?.focus();
    ta?.scrollIntoView({ block: "nearest" });
  }, 0);
}

// ── Refresh ───────────────────────────────────────────────────────────

export function refreshPanels() {
  renderSide();
  renderNotes();
}

docActivatedHooks.push(() => refreshPanels());
