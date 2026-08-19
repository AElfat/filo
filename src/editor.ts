// CodeMirror 6 editor configuration.
//
// filo's philosophy: no superfluous formatting. Syntax highlighting
// exists only for the essential data formats (JSON, XML); everything else
// is plain text. Features are editing-oriented: search, folding
// (grouping), history, multiple selections.
//
// Multi-document: there is ONE single EditorView; each document owns its
// own EditorState (created with buildDocState) which gets mounted into
// the view when its tab becomes active.

import { Compartment, EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentLess,
  indentMore,
} from "@codemirror/commands";
import type { KeyBinding } from "@codemirror/view";
import {
  highlightSelectionMatches,
  search,
  searchKeymap,
} from "@codemirror/search";
import {
  bracketMatching,
  codeFolding,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { lintGutter } from "@codemirror/lint";
import { json } from "@codemirror/lang-json";
import { xml } from "@codemirror/lang-xml";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import type { Prefs } from "./prefs";

export type Lang = "json" | "xml" | "markdown" | "testo";

/** Infers the language from the file extension. Anything that isn't an
 *  essential data format (or Markdown) stays plain text, on purpose. */
export function detectLang(path: string | null): Lang {
  if (!path) return "testo";
  const ext = path.split(".").pop()?.toLowerCase();
  if (ext === "json") return "json";
  if (ext === "xml" || ext === "svg" || ext === "xaml") return "xml";
  if (ext === "md" || ext === "markdown") return "markdown";
  return "testo";
}

// Compartments: allow reconfiguring language/theme/font at runtime
// without recreating the states.
export const languageCompartment = new Compartment();
export const themeCompartment = new Compartment();
export const fontCompartment = new Compartment();
export const wrapCompartment = new Compartment(); // word wrap
export const extrasCompartment = new Compartment(); // lint and per-language tools

export function langExtension(lang: Lang): Extension {
  if (lang === "json") return json();
  if (lang === "xml") return xml();
  if (lang === "markdown") return markdown();
  return [];
}

// Extra per-language extensions (lint, data tools): the provider is
// registered by datatools.ts to avoid a circular import.
let extrasProvider: (lang: Lang) => Extension = () => [];

export function setExtrasProvider(p: (lang: Lang) => Extension) {
  extrasProvider = p;
}

export function extrasFor(lang: Lang): Extension {
  return extrasProvider(lang);
}

// Tab key in text-editor style (not IDE):
// - plain cursor or selection on ONE single line → inserts a tab at the
//   cursor (replacing any selection), like Notepad++
// - selection touching MULTIPLE lines → indents the block (Shift+Tab outdents)
const tabKeymap: KeyBinding[] = [
  {
    key: "Tab",
    run(view) {
      const { state } = view;
      const multiLine = state.selection.ranges.some(
        (r) =>
          !r.empty &&
          state.doc.lineAt(r.from).number !== state.doc.lineAt(r.to).number,
      );
      if (multiLine) return indentMore(view);
      view.dispatch(
        state.update(state.replaceSelection("\t"), {
          scrollIntoView: true,
          userEvent: "input",
        }),
      );
      return true;
    },
    shift: indentLess,
  },
];

// Structural theme (metrics); colors live in styles.css and in the dark theme.
const filoTheme = EditorView.theme({
  "&": { height: "100%" },
  ".cm-scroller": { lineHeight: "1.6" },
  "&.cm-focused": { outline: "none" },
});

export function themeExtension(prefs: Prefs): Extension {
  return prefs.theme === "scuro" ? oneDark : [];
}

export function wrapExtension(prefs: Prefs): Extension {
  return prefs.wrap ? EditorView.lineWrapping : [];
}

export function fontExtension(prefs: Prefs): Extension {
  return EditorView.theme({
    ".cm-scroller": {
      fontFamily: `'${prefs.fontFamily}', Consolas, monospace`,
      fontSize: `${prefs.fontSize}px`,
    },
  });
}

// Italian translation of CodeMirror's panels (search, go to line).
const phrasesIt = EditorState.phrases.of({
  Find: "Cerca",
  Replace: "Sostituisci",
  next: "successivo",
  previous: "precedente",
  all: "tutti",
  "match case": "maiusc/minusc",
  "by word": "parola intera",
  regexp: "regex",
  replace: "sostituisci",
  "replace all": "sostituisci tutti",
  close: "chiudi",
  "Go to line": "Vai alla riga",
  go: "vai",
  "current match": "risultato corrente",
  "replaced $ matches": "$ sostituzioni effettuate",
  "replaced match on line $": "sostituito alla riga $",
  "on line": "alla riga",
});

export interface EditorHandlers {
  /** The active document was modified. */
  docChanged(): void;
  /** The cursor moved (1-based line/column). */
  cursorMoved(line: number, col: number): void;
}

let handlers: EditorHandlers | null = null;

const updateListener = EditorView.updateListener.of((update) => {
  if (!handlers) return;
  if (update.docChanged) handlers.docChanged();
  if (update.selectionSet || update.docChanged) {
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    handlers.cursorMoved(line.number, head - line.from + 1);
  }
});

/** Additional extensions registered by the features (links, notes, groups…).
 *  They must be set BEFORE creating the first states. */
export const featureExtensions: Extension[] = [];

export function buildDocState(
  text: string,
  lang: Lang,
  prefs: Prefs,
  extraKeymap: readonly { key: string; run: (view: EditorView) => boolean }[] = [],
): EditorState {
  return EditorState.create({
    doc: text,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      rectangularSelection(),
      history(),
      indentOnInput(),
      bracketMatching(),
      codeFolding({
        placeholderText: "…",
      }),
      foldGutter(),
      lintGutter(),
      search({ top: true }),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      phrasesIt,
      languageCompartment.of(langExtension(lang)),
      themeCompartment.of(themeExtension(prefs)),
      fontCompartment.of(fontExtension(prefs)),
      wrapCompartment.of(wrapExtension(prefs)),
      extrasCompartment.of(extrasProvider(lang)),
      ...featureExtensions,
      filoTheme,
      updateListener,
      keymap.of([
        ...extraKeymap,
        ...tabKeymap,
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        ...foldKeymap,
      ]),
    ],
  });
}

export function createView(parent: HTMLElement, h: EditorHandlers): EditorView {
  handlers = h;
  return new EditorView({ parent });
}
