// filo's multi-document management.
//
// There is a single EditorView; each document owns its own EditorState.
// When a tab becomes active, its state is mounted into the view; the
// previous document's state is saved into its Doc.

import { invoke } from "@tauri-apps/api/core";
import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import type { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  buildDocState,
  detectLang,
  extrasCompartment,
  extrasFor,
  langExtension,
  languageCompartment,
  type Lang,
} from "./editor";
import { modal } from "./ui";
import type { Prefs } from "./prefs";
import { t } from "./i18n";

export interface FileContents {
  text: string;
  encoding: string;
  eol: string;
  bom: boolean;
}

export interface Doc {
  id: string;
  path: string | null;
  state: EditorState;
  // Scroll is NOT part of the EditorState: it must be kept aside to
  // find the position again when coming back to the tab.
  scroll?: StateEffect<unknown>;
  dirty: boolean;
  lang: Lang;
  encoding: string; // "utf-8" | "windows-1252"
  eol: string; // "lf" | "crlf"
  bom: boolean;
  preview?: boolean; // Markdown shown in preview instead of the editor
  mtime?: number; // last known modification on disk (ms), for the reload prompt
  suggestedName?: string; // save-dialog default for docs imported from a bundle
}

export const FILE_FILTERS = [
  { name: "Testo", extensions: ["txt", "md", "log", "csv"] },
  { name: "JSON", extensions: ["json"] },
  { name: "XML", extensions: ["xml", "svg", "xaml"] },
  { name: "Tutti i file", extensions: ["*"] },
];

// The open dialog also lists exported bundles (see bundle.ts).
const OPEN_FILTERS = [
  ...FILE_FILTERS.slice(0, -1),
  { name: "filo", extensions: ["filo"] },
  FILE_FILTERS[FILE_FILTERS.length - 1],
];

// Hooks used by the features (document metadata): registered by meta.ts.
export const docLoadedHooks: ((doc: Doc, diskText: string) => Promise<void>)[] = [];
export const docSavedHooks: ((doc: Doc) => Promise<void>)[] = [];
export const docActivatedHooks: ((doc: Doc) => void)[] = [];

let view: EditorView;
let prefs: Prefs;
let docs: Doc[] = [];
let activeId = "";
let onUpdate: () => void = () => {};
let counter = 0;

export function initDocs(v: EditorView, p: Prefs, update: () => void) {
  view = v;
  prefs = p;
  onUpdate = update;
}

export function setPrefsRef(p: Prefs) {
  prefs = p;
}

export function getDocs(): readonly Doc[] {
  return docs;
}

export function getView(): EditorView {
  return view;
}

export function activeDoc(): Doc | null {
  return docs.find((d) => d.id === activeId) ?? null;
}

export function docTitle(doc: Doc): string {
  return doc.path ? doc.path.split(/[\\/]/).pop()! : t("doc.new", doc.id);
}

async function diskMtime(path: string): Promise<number | undefined> {
  try {
    return (await invoke<number | null>("file_mtime", { path })) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Copies the view's live state back into the active Doc. */
export function syncActiveState() {
  const doc = activeDoc();
  if (doc) {
    doc.state = view.state;
    doc.scroll = view.scrollSnapshot();
  }
}

export function markActiveDirty() {
  const doc = activeDoc();
  if (doc && !doc.dirty) {
    doc.dirty = true;
    onUpdate();
  }
}

export function newDoc(text = ""): Doc {
  counter += 1;
  const doc: Doc = {
    id: String(counter),
    path: null,
    state: buildDocState(text, "testo", prefs),
    dirty: false,
    lang: "testo",
    encoding: "utf-8",
    eol: "crlf", // the natural default on Windows
    bom: false,
  };
  docs.push(doc);
  activate(doc.id);
  return doc;
}

export function activate(id: string) {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return;
  syncActiveState();
  activeId = id;
  view.setState(doc.state);
  // setState starts back at the top of the document: restore the saved
  // scroll or, on first activation, bring the cursor into view.
  view.dispatch({
    effects:
      doc.scroll ?? EditorView.scrollIntoView(doc.state.selection.main.head),
  });
  for (const h of docActivatedHooks) h(doc);
  onUpdate();
  view.focus();
}

// Exported bundles (.filo) are handled by bundle.ts, which registers
// its importer here to avoid a circular import.
let bundleImporter: ((raw: string) => Promise<Doc | null>) | null = null;

export function setBundleImporter(f: (raw: string) => Promise<Doc | null>) {
  bundleImporter = f;
}

/** Opens a file from disk (or activates the tab if it's already open). */
export async function openPath(path: string): Promise<Doc | null> {
  const already = docs.find((d) => d.path === path);
  if (already) {
    activate(already.id);
    return already;
  }
  let contents: FileContents;
  try {
    contents = await invoke<FileContents>("read_file", { path });
  } catch (e) {
    await modal(t("open.error.title"), String(e), [
      { id: "ok", label: t("btn.ok"), primary: true },
    ]);
    return null;
  }

  // .filo bundle: becomes a new unsaved document with its metadata;
  // the normal load hooks (central store, recents) don't apply.
  if (path.toLowerCase().endsWith(".filo") && bundleImporter) {
    return bundleImporter(contents.text);
  }

  const lang = detectLang(path);
  counter += 1;
  const doc: Doc = {
    id: String(counter),
    path,
    state: buildDocState(contents.text, lang, prefs),
    dirty: false,
    lang,
    encoding: contents.encoding,
    eol: contents.eol,
    bom: contents.bom,
    mtime: await diskMtime(path),
  };
  docs.push(doc);

  // Empty, untouched "new document" tab? Replace it.
  const emptyNew = docs.find(
    (d) => !d.path && !d.dirty && d.state.doc.length === 0 && d.id !== doc.id,
  );
  if (emptyNew && docs.length === 2) {
    docs = docs.filter((d) => d.id !== emptyNew.id);
  }

  activate(doc.id);
  for (const h of docLoadedHooks) await h(doc, contents.text);
  onUpdate();
  return doc;
}

/** Creates the document produced by importing a bundle (unsaved, dirty:
 *  the user decides where it lands with Save As). */
export function newDocFromImport(
  text: string,
  name: string,
  fmt: { encoding: string; eol: string; bom: boolean },
): Doc {
  counter += 1;
  const doc: Doc = {
    id: String(counter),
    path: null,
    state: buildDocState(text, detectLang(name), prefs),
    dirty: true,
    lang: detectLang(name),
    encoding: fmt.encoding,
    eol: fmt.eol,
    bom: fmt.bom,
    suggestedName: name,
  };
  docs.push(doc);
  activate(doc.id);
  return doc;
}

export async function openWithDialog() {
  const sel = await openDialog({ multiple: true, filters: OPEN_FILTERS });
  if (!sel) return;
  for (const p of Array.isArray(sel) ? sel : [sel]) {
    await openPath(p);
  }
}

/** Saves a document. Returns false if the user cancelled. */
export async function saveDoc(doc: Doc, forceDialog = false): Promise<boolean> {
  if (doc.id === activeId) syncActiveState();
  let path = doc.path;
  if (forceDialog || !path) {
    const chosen = await saveDialog({
      filters: FILE_FILTERS,
      defaultPath: doc.suggestedName, // set for docs imported from a bundle
    });
    if (!chosen) return false;
    path = chosen;
    doc.suggestedName = undefined;
  }
  try {
    await invoke("write_file", {
      path,
      contents: doc.state.doc.toString(),
      encoding: doc.encoding,
      eol: doc.eol,
      bom: doc.bom,
    });
  } catch (e) {
    await modal(t("save.error.title"), String(e), [
      { id: "ok", label: t("btn.ok"), primary: true },
    ]);
    return false;
  }
  if (path !== doc.path) {
    doc.path = path;
    const lang = detectLang(path);
    if (lang !== doc.lang) {
      doc.lang = lang;
      setDocLang(doc, lang);
    }
  }
  doc.dirty = false;
  doc.mtime = await diskMtime(path);
  for (const h of docSavedHooks) await h(doc);
  onUpdate();
  return true;
}

export async function saveActive(forceDialog = false): Promise<boolean> {
  const doc = activeDoc();
  return doc ? saveDoc(doc, forceDialog) : false;
}

/** Saves all modified documents; stops if the user cancels. */
export async function saveAll(): Promise<void> {
  for (const d of dirtyDocs()) {
    if (!(await saveDoc(d))) return;
  }
}

export function setDocLang(doc: Doc, lang: Lang) {
  doc.lang = lang;
  const effects = [
    languageCompartment.reconfigure(langExtension(lang)),
    extrasCompartment.reconfigure(extrasFor(lang)),
  ];
  if (doc.id === activeId) {
    view.dispatch({ effects });
  } else {
    doc.state = doc.state.update({ effects }).state;
  }
  onUpdate();
}

/** Closes a tab; asks what to do with unsaved changes.
 *  Returns false if the user cancels. */
export async function closeDoc(id: string): Promise<boolean> {
  const doc = docs.find((d) => d.id === id);
  if (!doc) return true;
  if (doc.id === activeId) syncActiveState();

  if (doc.dirty) {
    const choice = await modal(
      t("close.title"),
      t("close.one", docTitle(doc)),
      [
        { id: "salva", label: t("btn.save"), primary: true },
        { id: "scarta", label: t("btn.dontSave") },
        { id: "annulla", label: t("btn.cancel") },
      ],
    );
    if (choice === "annulla") return false;
    if (choice === "salva") {
      const ok = await saveDoc(doc);
      if (!ok) return false;
    }
  }

  if (doc.path) {
    // for Ctrl+Shift+T: only documents on disk can be reopened
    closedStack.push({ path: doc.path, cursor: doc.state.selection.main.head });
    if (closedStack.length > 10) closedStack.shift();
  }

  const idx = docs.findIndex((d) => d.id === id);
  docs = docs.filter((d) => d.id !== id);
  if (docs.length === 0) {
    newDoc(); // there is always at least one tab
    return true;
  }
  if (id === activeId) {
    activate(docs[Math.min(idx, docs.length - 1)].id);
  } else {
    onUpdate();
  }
  return true;
}

export function cycleTab(forward = true) {
  if (docs.length < 2) return;
  const idx = docs.findIndex((d) => d.id === activeId);
  const next = (idx + (forward ? 1 : -1) + docs.length) % docs.length;
  activate(docs[next].id);
}

// ── Reopen closed tab (Ctrl+Shift+T) ──────────────────────────────────

const closedStack: { path: string; cursor: number }[] = [];

export async function reopenLastClosed(): Promise<void> {
  const last = closedStack.pop();
  if (!last) return;
  const doc = await openPath(last.path);
  if (!doc) return; // file vanished in the meantime
  const pos = Math.min(last.cursor, doc.state.doc.length);
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
}

/** Moves tab `id` before `beforeId` (to the end if null). */
export function moveDoc(id: string, beforeId: string | null) {
  const from = docs.findIndex((d) => d.id === id);
  if (from === -1 || id === beforeId) return;
  const [moved] = docs.splice(from, 1);
  const to = beforeId ? docs.findIndex((d) => d.id === beforeId) : docs.length;
  docs.splice(to === -1 ? docs.length : to, 0, moved);
  onUpdate();
}

export function dirtyDocs(): Doc[] {
  syncActiveState();
  return docs.filter((d) => d.dirty);
}

// ── File modified by another program ──────────────────────────────────
// Checked when the window regains focus and when a tab is activated:
// if the modification time on disk doesn't match the known one, a
// reload is offered (with re-anchoring of the metadata).

let askingReload = false;

export async function checkActiveExternal(): Promise<void> {
  const doc = activeDoc();
  if (!doc?.path || doc.mtime === undefined || askingReload) return;
  const now = await diskMtime(doc.path);
  if (now === undefined || now === doc.mtime) return;

  askingReload = true;
  try {
    const choice = await modal(
      t("reload.title"),
      t(doc.dirty ? "reload.body.dirty" : "reload.body", docTitle(doc)),
      [
        { id: "ricarica", label: t("reload.yes"), primary: !doc.dirty },
        { id: "ignora", label: t("reload.no"), primary: doc.dirty },
      ],
    );
    if (choice === "ricarica") await reloadFromDisk(doc);
    else doc.mtime = now; // don't ask again until it changes again
  } finally {
    askingReload = false;
    view.focus();
  }
}

async function reloadFromDisk(doc: Doc): Promise<void> {
  let contents: FileContents;
  try {
    contents = await invoke<FileContents>("read_file", { path: doc.path });
  } catch {
    return; // file gone: keep the in-memory content
  }
  const cursor = doc.state.selection.main.head;
  doc.state = buildDocState(contents.text, doc.lang, prefs);
  doc.encoding = contents.encoding;
  doc.eol = contents.eol;
  doc.bom = contents.bom;
  doc.dirty = false;
  doc.scroll = undefined;
  doc.mtime = await diskMtime(doc.path!);
  const pos = Math.min(cursor, doc.state.doc.length);
  doc.state = doc.state.update({ selection: { anchor: pos } }).state;
  if (doc.id === activeId) view.setState(doc.state);
  for (const h of docLoadedHooks) await h(doc, contents.text);
  if (doc.id === activeId) {
    view.dispatch({ scrollIntoView: true, selection: { anchor: pos } });
  }
  onUpdate();
}

// ── Session ───────────────────────────────────────────────────────────

interface SessionDoc {
  path: string;
  cursor: number;
}
interface Session {
  files: SessionDoc[];
  active: number;
}

export function collectSession(): Session {
  syncActiveState();
  const withPath = docs.filter((d) => d.path);
  return {
    files: withPath.map((d) => ({
      path: d.path!,
      cursor: d.state.selection.main.head,
    })),
    active: Math.max(
      0,
      withPath.findIndex((d) => d.id === activeId),
    ),
  };
}

export async function saveSession() {
  try {
    await invoke("save_config", {
      name: "session",
      contents: JSON.stringify(collectSession()),
    });
  } catch {
    // the session is best-effort: never block exit over this
  }
}

export async function restoreSession(): Promise<boolean> {
  try {
    const raw = await invoke<string | null>("load_config", { name: "session" });
    if (!raw) return false;
    const session: Session = JSON.parse(raw);
    if (!session.files?.length) return false;
    let opened = 0;
    for (const f of session.files) {
      const doc = await openPath(f.path);
      if (doc) {
        opened += 1;
        // restore the cursor (clamped to the file's current length)
        const pos = Math.min(f.cursor ?? 0, doc.state.doc.length);
        if (doc.id === activeId) {
          view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
        } else {
          doc.state = doc.state.update({ selection: { anchor: pos } }).state;
        }
      }
    }
    if (opened > 0 && session.active >= 0) {
      const target = docs.filter((d) => d.path)[session.active];
      if (target) activate(target.id);
    }
    return opened > 0;
  } catch {
    return false;
  }
}
