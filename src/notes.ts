// Footnotes.
//
// Ctrl+N at a point in the text → numbered superscript marker (¹) and a
// note in the panel at the bottom of the window. Numbering follows the
// position order in the text, like in a real document. Clicking the
// marker opens the note; from the panel you jump back to the marker.

import {
  Decoration,
  EditorView,
  WidgetType,
  type DecorationSet,
} from "@codemirror/view";
import { RangeSetBuilder } from "@codemirror/state";
import {
  addNoteEffect,
  ctxAround,
  metaField,
  newId,
  saveMetaSoon,
  type DocMeta,
} from "./meta";
import { activeDoc, getView, syncActiveState } from "./docs";
import { featureExtensions } from "./editor";
import { focusNote, refreshPanels, showNotesPanel } from "./panels";
import { t } from "./i18n";

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";

export function toSuperscript(n: number): string {
  return String(n)
    .split("")
    .map((d) => SUPERSCRIPT[Number(d)] ?? d)
    .join("");
}

/** Note numbering by position in the text: anchorId → number. */
export function noteNumbers(meta: DocMeta): Map<string, number> {
  const ordered = meta.notes
    .map((n) => ({
      id: n.anchorId,
      pos: meta.anchors.find((a) => a.id === n.anchorId)?.pos ?? Infinity,
    }))
    .sort((a, b) => a.pos - b.pos);
  const map = new Map<string, number>();
  ordered.forEach((n, i) => map.set(n.id, i + 1));
  return map;
}

/** Ctrl+N — creates a note at the cursor. */
export function createNote(): void {
  const doc = activeDoc();
  if (!doc) return;
  const view = getView();
  const pos = view.state.selection.main.head;
  const anchor = {
    id: newId(),
    pos,
    ctx: ctxAround(view.state.doc.toString(), pos),
  };
  view.dispatch({
    effects: addNoteEffect.of({
      anchor,
      note: { anchorId: anchor.id, text: "" },
    }),
  });
  syncActiveState();
  saveMetaSoon(doc);
  showNotesPanel(true);
  refreshPanels();
  focusNote(anchor.id);
}

// ── Decorations: the superscript marker ───────────────────────────────

class NoteRefWidget extends WidgetType {
  constructor(
    readonly anchorId: string,
    readonly number: number,
    readonly broken: boolean,
  ) {
    super();
  }

  eq(other: NoteRefWidget) {
    return (
      other.anchorId === this.anchorId &&
      other.number === this.number &&
      other.broken === this.broken
    );
  }

  toDOM() {
    const sup = document.createElement("span");
    sup.className = "filo-note-ref" + (this.broken ? " broken" : "");
    sup.textContent = toSuperscript(this.number);
    sup.title = this.broken
      ? t("notes.ref.broken")
      : t("notes.ref.tip", this.number);
    sup.addEventListener("mousedown", (e) => {
      e.preventDefault();
      showNotesPanel(true);
      refreshPanels();
      focusNote(this.anchorId);
    });
    return sup;
  }

  ignoreEvent() {
    return true;
  }
}

const noteDecorations = EditorView.decorations.compute([metaField], (state) => {
  const meta = state.field(metaField);
  const numbers = noteNumbers(meta);
  const decos: { pos: number; deco: Decoration }[] = [];

  for (const n of meta.notes) {
    const a = meta.anchors.find((a) => a.id === n.anchorId);
    if (!a) continue;
    decos.push({
      pos: Math.min(a.pos, state.doc.length),
      deco: Decoration.widget({
        widget: new NoteRefWidget(
          n.anchorId,
          numbers.get(n.anchorId) ?? 0,
          !!a.broken,
        ),
        side: 1,
      }),
    });
  }

  decos.sort((x, y) => x.pos - y.pos);
  const builder = new RangeSetBuilder<Decoration>();
  for (const d of decos) builder.add(d.pos, d.pos, d.deco);
  return builder.finish() as DecorationSet;
});

featureExtensions.push(noteDecorations);
