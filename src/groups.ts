// Line grouping.
//
// Ctrl+G on a selection → group with a label and color: colored bar in
// the margin on every line, chip with the label on the first line.
// The group can be collapsed/expanded (click on the chip) and the state
// persists in the document metadata.

import {
  Decoration,
  EditorView,
  GutterMarker,
  WidgetType,
  gutter,
  type DecorationSet,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import { foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import {
  addGroupEffect,
  ctxAround,
  metaField,
  newId,
  removeItemEffect,
  saveMetaSoon,
  toggleGroupEffect,
  type DocMeta,
  type MetaGroup,
} from "./meta";
import {
  activeDoc,
  docLoadedHooks,
  getView,
  syncActiveState,
  type Doc,
} from "./docs";
import { featureExtensions } from "./editor";
import { modal } from "./ui";
import { refreshPanels } from "./panels";
import { t } from "./i18n";

export const GROUP_COLORS = [
  "#4a6fa5", // blue
  "#5e9c76", // green
  "#c2884d", // amber
  "#a5684a", // terracotta
  "#8a6fb5", // purple
  "#b5546f", // magenta
];

/** Current range (line from/to) of a group; null if broken. */
export function groupRange(
  meta: DocMeta,
  g: MetaGroup,
  doc: { lineAt(pos: number): { from: number; to: number } ; length: number },
): { from: number; to: number } | null {
  const a = meta.anchors.find((x) => x.id === g.fromAnchorId);
  const b = meta.anchors.find((x) => x.id === g.toAnchorId);
  if (!a || !b || a.broken || b.broken) return null;
  const start = doc.lineAt(Math.min(a.pos, doc.length));
  const end = doc.lineAt(Math.min(Math.max(b.pos, a.pos), doc.length));
  return { from: start.from, to: end.to };
}

/** Ctrl+G — creates a group from the selected lines. */
export async function createGroup(): Promise<void> {
  const doc = activeDoc();
  if (!doc) return;
  const view = getView();
  const sel = view.state.selection.main;
  const startLine = view.state.doc.lineAt(sel.from);
  const endLine = view.state.doc.lineAt(sel.to);

  // Ctrl+G on lines touching an existing group: offer to remove it —
  // never create overlapping groups piling on top of each other.
  const metaNow = view.state.field(metaField);
  const overlapping = metaNow.groups.find((g) => {
    const r = groupRange(metaNow, g, view.state.doc);
    return r && r.from <= endLine.to && r.to >= startLine.from;
  });
  if (overlapping) {
    const choice = await modal(
      t("group.exists.title"),
      t("group.exists.body", overlapping.label),
      [
        { id: "rimuovi", label: t("group.remove"), primary: true },
        { id: "annulla", label: t("btn.cancel") },
      ],
    );
    if (choice === "rimuovi") removeGroup(overlapping.id);
    view.focus();
    return;
  }

  if (endLine.number === startLine.number) {
    await modal(t("group.needMulti.title"), t("group.needMulti.body"), [
      { id: "ok", label: t("btn.ok"), primary: true },
    ]);
    view.focus();
    return;
  }

  // form: label + color
  const form = document.createElement("div");
  form.className = "prefs-form";
  const colorRow = GROUP_COLORS.map(
    (c, i) =>
      `<label class="color-choice"><input type="radio" name="group-color" value="${c}" ${
        i === 0 ? "checked" : ""
      }/><span class="color-dot" style="background:${c}"></span></label>`,
  ).join("");
  form.innerHTML = `
    <label>${t("group.label")} <input id="group-label" type="text" spellcheck="false" autocomplete="off" /></label>
    <div class="color-choices">${colorRow}</div>
    <p class="form-hint">${t("group.lines", startLine.number, endLine.number)}</p>
  `;
  const labelInput = form.querySelector<HTMLInputElement>("#group-label")!;
  window.setTimeout(() => labelInput.focus(), 0);

  const choice = await modal(t("group.title"), form, [
    { id: "crea", label: t("group.create"), primary: true },
    { id: "annulla", label: t("btn.cancel") },
  ]);
  if (choice !== "crea") {
    view.focus();
    return;
  }
  const label =
    labelInput.value.trim() ||
    t("group.lines", startLine.number, endLine.number);
  const color =
    form.querySelector<HTMLInputElement>('input[name="group-color"]:checked')
      ?.value ?? GROUP_COLORS[0];

  const text = view.state.doc.toString();
  const from = { id: newId(), pos: startLine.from, ctx: ctxAround(text, startLine.from) };
  const to = { id: newId(), pos: endLine.to, ctx: ctxAround(text, endLine.to) };
  view.dispatch({
    effects: addGroupEffect.of({
      from,
      to,
      group: {
        id: newId(),
        fromAnchorId: from.id,
        toAnchorId: to.id,
        label,
        color,
        collapsed: false,
      },
    }),
  });
  syncActiveState();
  saveMetaSoon(doc);
  refreshPanels();
  view.focus();
}

/** Removes a group (Ctrl+G on the group, right-click on chip/gutter,
 *  panel). The fold, if active, is unfolded first. */
export function removeGroup(groupId: string): void {
  const doc = activeDoc();
  if (!doc) return;
  const view = getView();
  const meta = view.state.field(metaField);
  const g = meta.groups.find((g) => g.id === groupId);
  if (!g) return;
  const range = groupRange(meta, g, view.state.doc);
  if (range && range.to > range.from) {
    const existing = foldAt(view.state, range);
    if (existing) view.dispatch({ effects: unfoldEffect.of(existing) });
  }
  view.dispatch({
    effects: removeItemEffect.of({ kind: "group", id: groupId }),
  });
  syncActiveState();
  saveMetaSoon(doc);
  refreshPanels();
}

/** Is there an active fold inside this range? Returns the first one. */
function foldAt(
  state: EditorState,
  range: { from: number; to: number },
): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(range.from, range.to, (from, to) => {
    found = { from, to };
    return false;
  });
  return found;
}

/** Collapses/expands a group (chip, placeholder, gutter or panel).
 *  Decides based on the REAL fold state, not the saved flag: that way
 *  no open/close path can drift out of sync. */
export function toggleGroup(groupId: string): void {
  const doc = activeDoc();
  if (!doc) return;
  const view = getView();
  const meta = view.state.field(metaField);
  const g = meta.groups.find((g) => g.id === groupId);
  if (!g) return;
  const range = groupRange(meta, g, view.state.doc);
  if (!range || range.to <= range.from) return;

  const existing = foldAt(view.state, range);
  const effects: unknown[] = [];
  if (existing) {
    effects.push(unfoldEffect.of(existing));
    if (g.collapsed) effects.push(toggleGroupEffect.of(groupId));
  } else {
    // fold the WHOLE section, first line included: only the chip remains
    effects.push(foldEffect.of({ from: range.from, to: range.to }));
    if (!g.collapsed) effects.push(toggleGroupEffect.of(groupId));
  }
  view.dispatch({ effects: effects as never });
  syncActiveState();
  saveMetaSoon(doc);
  refreshPanels();
}

// Reconciliation: if a group fold gets opened/closed by other means
// (click on the "…" placeholder, gutter arrow, folding shortcuts),
// the `collapsed` flag in the meta is realigned to the real state.
const foldSync = EditorView.updateListener.of((update) => {
  if (!update.state.field(metaField, false)) return;
  const before = foldedRanges(update.startState);
  const after = foldedRanges(update.state);
  if (before === after) return;
  const meta = update.state.field(metaField);
  const stale: string[] = [];
  for (const g of meta.groups) {
    const range = groupRange(meta, g, update.state.doc);
    if (!range || range.to <= range.from) continue;
    const folded = foldAt(update.state, range) !== null;
    if (folded !== g.collapsed) stale.push(g.id);
  }
  if (stale.length === 0) return;
  // deferred dispatch: you can't dispatch inside an update
  window.setTimeout(() => {
    const view = getView();
    view.dispatch({ effects: stale.map((id) => toggleGroupEffect.of(id)) });
    syncActiveState();
    const doc = activeDoc();
    if (doc) saveMetaSoon(doc);
    refreshPanels();
  }, 0);
});

// On sidecar load, restore the persisted collapsed states.
async function restoreCollapsed(doc: Doc): Promise<void> {
  const meta = doc.state.field(metaField);
  const effects: unknown[] = [];
  for (const g of meta.groups) {
    if (!g.collapsed) continue;
    const range = groupRange(meta, g, doc.state.doc);
    if (!range || range.to <= range.from) continue;
    effects.push(foldEffect.of({ from: range.from, to: range.to }));
  }
  if (effects.length === 0) return;
  if (activeDoc()?.id === doc.id) {
    getView().dispatch({ effects: effects as never });
    doc.state = getView().state;
  } else {
    doc.state = doc.state.update({ effects: effects as never }).state;
  }
}

// ── Decorations ───────────────────────────────────────────────────────

class GroupChipWidget extends WidgetType {
  constructor(
    readonly group: MetaGroup,
  ) {
    super();
  }

  eq(other: GroupChipWidget) {
    return (
      other.group.id === this.group.id &&
      other.group.label === this.group.label &&
      other.group.collapsed === this.group.collapsed &&
      other.group.color === this.group.color
    );
  }

  toDOM() {
    const chip = document.createElement("span");
    chip.className = "filo-group-chip";
    chip.style.setProperty("--group-color", this.group.color);
    chip.textContent = `${this.group.collapsed ? "▸" : "▾"} ${this.group.label}`;
    chip.title = this.group.collapsed
      ? t("group.collapsed.chip")
      : t("group.expand.chip");
    // preventDefault on mousedown keeps the editor from moving the
    // selection; the action fires on click (with pointerdown as backup
    // when the group is folded and the click gets swallowed by the fold)
    chip.addEventListener("mousedown", (e) => e.preventDefault());
    let handled = false;
    const toggle = (e: Event) => {
      e.preventDefault();
      if (handled) return;
      handled = true;
      window.setTimeout(() => (handled = false), 250);
      toggleGroup(this.group.id);
    };
    chip.addEventListener("pointerdown", toggle);
    chip.addEventListener("click", toggle);
    chip.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      removeGroup(this.group.id);
    });
    return chip;
  }

  ignoreEvent() {
    return true;
  }
}

const groupDecorations = EditorView.decorations.compute([metaField], (state) => {
  const meta = state.field(metaField);
  const decos: { from: number; to: number; deco: Decoration }[] = [];

  for (const g of meta.groups) {
    const range = groupRange(meta, g, state.doc);
    if (!range) continue;
    // colored bar on every line of the group
    for (let pos = range.from; pos <= range.to; ) {
      const line = state.doc.lineAt(pos);
      decos.push({
        from: line.from,
        to: line.from,
        deco: Decoration.line({
          class: "filo-group-line",
          attributes: { style: `--group-color:${g.color}` },
        }),
      });
      if (line.to >= range.to) break;
      pos = line.to + 1;
    }
    // the label shows in the text ONLY when the group is closed (it
    // stands for the hidden content); when open the control lives in
    // the gutter, so the text stays clean
    if (g.collapsed) {
      decos.push({
        from: range.from,
        to: range.from,
        deco: Decoration.widget({ widget: new GroupChipWidget(g), side: -1 }),
      });
    }
  }

  decos.sort((x, y) => x.from - y.from || x.to - y.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decos) builder.add(d.from, d.to, d.deco);
  return builder.finish() as DecorationSet;
});

// ── Group gutter: colored arrow next to the line numbers ──────────────

class GroupGutterMarker extends GutterMarker {
  constructor(readonly group: MetaGroup) {
    super();
  }

  eq(other: GroupGutterMarker) {
    return (
      other.group.id === this.group.id &&
      other.group.collapsed === this.group.collapsed &&
      other.group.color === this.group.color &&
      other.group.label === this.group.label
    );
  }

  toDOM() {
    const el = document.createElement("span");
    el.className = "filo-group-gutter-marker";
    el.style.color = this.group.color;
    el.textContent = this.group.collapsed ? "▸" : "▾";
    el.title = t(
      "group.gutter.tip",
      this.group.label,
      this.group.collapsed ? t("group.expand") : t("group.collapse"),
    );
    return el;
  }
}

const groupGutter = gutter({
  class: "filo-gutter-groups",
  markers(view) {
    const meta = view.state.field(metaField);
    const items: { pos: number; marker: GroupGutterMarker }[] = [];
    for (const g of meta.groups) {
      const range = groupRange(meta, g, view.state.doc);
      if (!range) continue;
      items.push({
        pos: view.state.doc.lineAt(range.from).from,
        marker: new GroupGutterMarker(g),
      });
    }
    items.sort((a, b) => a.pos - b.pos);
    const builder = new RangeSetBuilder<GutterMarker>();
    for (const it of items) builder.add(it.pos, it.pos, it.marker);
    return builder.finish();
  },
  domEventHandlers: {
    mousedown(view, line, event) {
      // right-click is handled by contextmenu: only the left one here
      if ((event as MouseEvent).button !== 0) return false;
      const meta = view.state.field(metaField);
      for (const g of meta.groups) {
        const range = groupRange(meta, g, view.state.doc);
        if (
          range &&
          view.state.doc.lineAt(range.from).from === line.from
        ) {
          toggleGroup(g.id);
          return true;
        }
      }
      return false;
    },
    contextmenu(view, line, event) {
      const meta = view.state.field(metaField);
      for (const g of meta.groups) {
        const range = groupRange(meta, g, view.state.doc);
        if (
          range &&
          view.state.doc.lineAt(range.from).from === line.from
        ) {
          event.preventDefault();
          event.stopPropagation(); // no editor context menu
          removeGroup(g.id);
          return true;
        }
      }
      return false;
    },
  },
});

featureExtensions.push(groupDecorations);
featureExtensions.push(groupGutter);
featureExtensions.push(foldSync);
docLoadedHooks.push(async (doc) => restoreCollapsed(doc));
