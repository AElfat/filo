// Links between lines and between pages (files).
//
// - Ctrl+L: marks the current line as a TARGET (◎)
// - Ctrl+K: creates a LINK (↗) at the cursor, picking the target
//   among those of all open documents
// - click on the link: jumps to the target (opening the file if needed)
// - Alt+←: goes back after a jump

import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  addLinkEffect,
  addTargetEffect,
  anchorPos,
  ctxAround,
  getMeta,
  metaField,
  newId,
  removeItemEffect,
  saveMetaSoon,
  type MetaLink,
} from "./meta";
import {
  activate as activateDoc,
  activeDoc,
  docTitle,
  getDocs,
  getView,
  openPath,
  syncActiveState,
  type Doc,
} from "./docs";
import { featureExtensions } from "./editor";
import { modal, pickerModal } from "./ui";
import { refreshPanels } from "./panels";
import { dirOf, makeRelative, resolveTarget } from "./paths";
import { t as tr } from "./i18n";

// ── "Go back" stack (Alt+←) ───────────────────────────────────────────

interface Spot {
  docId: string;
  pos: number;
}

const backStack: Spot[] = [];

function here(): Spot | null {
  const doc = activeDoc();
  if (!doc) return null;
  return { docId: doc.id, pos: getView().state.selection.main.head };
}

export function goBack(): boolean {
  const spot = backStack.pop();
  if (!spot) return false;
  const doc = getDocs().find((d) => d.id === spot.docId);
  if (!doc) return goBack(); // the document was closed: keep going back
  jumpTo(doc, Math.min(spot.pos, doc.state.doc.length), false);
  return true;
}

export function jumpTo(doc: Doc, pos: number, remember = true) {
  if (remember) {
    const h = here();
    if (h) backStack.push(h);
  }
  const view = getView();
  if (activeDoc()?.id !== doc.id) {
    activateDoc(doc.id);
  }
  view.dispatch({
    selection: { anchor: Math.min(pos, view.state.doc.length) },
    scrollIntoView: true,
  });
  view.focus();
}

// ── Commands ──────────────────────────────────────────────────────────

/** Ctrl+L — toggle: marks the line as a target, or unmarks it
 *  if it already is one. */
export function createTarget(): boolean {
  const doc = activeDoc();
  if (!doc) return false;
  const view = getView();
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const meta = view.state.field(metaField);

  // already a target on this line? then Ctrl+L removes it
  const existing = meta.targets.find((t) => {
    const p = anchorPos(meta, t.anchorId);
    return p !== null && p >= line.from && p <= line.to;
  });
  if (existing) {
    view.dispatch({
      effects: removeItemEffect.of({ kind: "target", id: existing.anchorId }),
    });
    syncActiveState();
    saveMetaSoon(doc);
    refreshPanels();
    return true;
  }

  const label = line.text.trim().slice(0, 40) || `riga ${line.number}`;
  const anchor = {
    id: newId(),
    pos: line.from,
    ctx: ctxAround(view.state.doc.toString(), line.from),
  };
  view.dispatch({
    effects: addTargetEffect.of({
      anchor,
      target: { anchorId: anchor.id, label },
    }),
  });
  syncActiveState();
  saveMetaSoon(doc);
  refreshPanels();
  return true;
}

/** Ctrl+K — creates a link at the cursor. */
export async function createRef(): Promise<void> {
  const doc = activeDoc();
  if (!doc) return;

  // available targets: from all open documents
  syncActiveState();
  const choices: {
    label: string;
    detail?: string;
    targetId: string;
    file: string | null;
  }[] = [];
  for (const d of getDocs()) {
    const meta = getMeta(d);
    for (const t of meta.targets) {
      const sameDoc = d.id === doc.id;
      if (!sameDoc && !d.path) continue; // never-saved file: not linkable
      choices.push({
        label: `◎ ${t.label}`,
        detail: sameDoc ? tr("link.thisDoc") : docTitle(d),
        targetId: t.anchorId,
        file: sameDoc ? null : d.path,
      });
    }
  }
  if (choices.length === 0) {
    await modal(tr("link.none.title"), tr("link.none.body"), [
      { id: "ok", label: tr("btn.ok"), primary: true },
    ]);
    return;
  }

  const idx = await pickerModal(tr("link.pick.title"), choices);
  if (idx < 0) return;
  const chosen = choices[idx];

  const view = getView();
  const pos = view.state.selection.main.head;
  const anchor = {
    id: newId(),
    pos,
    ctx: ctxAround(view.state.doc.toString(), pos),
  };
  // path relative to the source document's folder: move the whole
  // folder and the links keep working
  const targetFile =
    chosen.file && doc.path
      ? makeRelative(dirOf(doc.path), chosen.file)
      : chosen.file;
  view.dispatch({
    effects: addLinkEffect.of({
      anchor,
      link: {
        anchorId: anchor.id,
        targetFile,
        targetId: chosen.targetId,
        label: chosen.label.replace(/^◎ /, ""),
      },
    }),
  });
  syncActiveState();
  saveMetaSoon(doc);
  refreshPanels();
  view.focus();
}

/** Removes a link (right-click on the chip or from the panel). */
export function removeRef(anchorId: string): void {
  const doc = activeDoc();
  if (!doc) return;
  getView().dispatch({
    effects: removeItemEffect.of({ kind: "link", id: anchorId }),
  });
  syncActiveState();
  saveMetaSoon(doc);
  refreshPanels();
}

/** Follows a link (click on the chip or from the panel). */
export async function followLink(link: MetaLink): Promise<void> {
  let target: Doc | null = null;
  if (link.targetFile === null) {
    target = activeDoc();
  } else {
    const resolved = resolveTarget(activeDoc()?.path ?? null, link.targetFile);
    target =
      getDocs().find((d) => d.path?.toLowerCase() === resolved.toLowerCase()) ??
      (await openPath(resolved));
  }
  if (!target) return;
  syncActiveState();
  const meta = getMeta(target);
  const pos = anchorPos(meta, link.targetId);
  if (pos === null) {
    await modal(tr("link.notFound.title"), tr("link.notFound.body"), [
      { id: "ok", label: tr("btn.ok"), primary: true },
    ]);
    return;
  }
  jumpTo(target, pos);
}

// ── Decorations ───────────────────────────────────────────────────────

class RefWidget extends WidgetType {
  constructor(
    readonly link: MetaLink,
    readonly broken: boolean,
  ) {
    super();
  }

  eq(other: RefWidget) {
    return (
      other.link.anchorId === this.link.anchorId &&
      other.broken === this.broken &&
      other.link.label === this.link.label
    );
  }

  toDOM() {
    const span = document.createElement("span");
    span.className = "filo-ref" + (this.broken ? " broken" : "");
    span.textContent = `↗${this.link.label ? " " + this.link.label : ""}`;
    span.title = this.broken
      ? tr("link.broken.tip")
      : tr(
          "link.target.tip",
          this.link.label ?? tr("panel.ref"),
          this.link.targetFile
            ? tr("link.target.inFile", this.link.targetFile.split(/[\\/]/).pop()!)
            : "",
        );
    span.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return; // the right button is for removal
      e.preventDefault();
      void followLink(this.link);
    });
    span.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation(); // the editor's context menu must not open
      removeRef(this.link.anchorId);
    });
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

const linkDecorations = EditorView.decorations.compute([metaField], (state) => {
  const meta = state.field(metaField);
  const decos: { from: number; to: number; deco: Decoration }[] = [];

  for (const t of meta.targets) {
    const a = meta.anchors.find((a) => a.id === t.anchorId);
    if (!a || a.broken) continue;
    const line = state.doc.lineAt(Math.min(a.pos, state.doc.length));
    decos.push({
      from: line.from,
      to: line.from,
      deco: Decoration.line({ class: "filo-target-line" }),
    });
  }
  for (const l of meta.links) {
    const a = meta.anchors.find((a) => a.id === l.anchorId);
    if (!a) continue;
    decos.push({
      from: Math.min(a.pos, state.doc.length),
      to: Math.min(a.pos, state.doc.length),
      deco: Decoration.widget({
        widget: new RefWidget(l, !!a.broken),
        side: 1,
      }),
    });
  }

  decos.sort((x, y) => x.from - y.from || x.to - y.to);
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decos) builder.add(d.from, d.to, d.deco);
  return builder.finish() as DecorationSet;
});

featureExtensions.push(linkDecorations);
