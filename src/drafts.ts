// Crash recovery. The text of every modified document is mirrored into
// the app's data folder (drafts/), one JSON file per document: a .filo
// bundle (text + metadata) plus the original path and the cursor. A
// draft is removed when the document is saved or closed, and all of
// them at a clean exit; whatever is still there at the next start was
// left by a crash and gets reopened as unsaved tabs.

import { invoke } from "@tauri-apps/api/core";
import {
  activeDoc,
  docClosedHooks,
  docSavedHooks,
  docTitle,
  getView,
  newDocFromImport,
  openPath,
  replaceDocText,
  syncActiveState,
  type Doc,
} from "./docs";
import { makeBundle, parseBundle, type Bundle } from "./bundle";
import { getMeta, reanchor, setDraftHook, setMetaEffect, type DocMeta } from "./meta";
import { refreshPanels } from "./panels";

interface Draft extends Bundle {
  path: string | null;
  cursor: number;
}

const keys = new Map<string, string>(); // doc id → draft file key
const timers = new Map<string, number>();
const DELAY = 1500; // ms after the last change

function keyFor(doc: Doc): string {
  let k = keys.get(doc.id);
  if (!k) {
    k = crypto.randomUUID();
    keys.set(doc.id, k);
  }
  return k;
}

/** Called on every change: writes the draft shortly after the last one. */
export function scheduleDraft(doc: Doc): void {
  window.clearTimeout(timers.get(doc.id));
  timers.set(
    doc.id,
    window.setTimeout(() => void writeDraft(doc), DELAY),
  );
}

async function writeDraft(doc: Doc): Promise<void> {
  timers.delete(doc.id);
  if (!doc.dirty) return; // saved in the meantime
  if (doc.id === activeDoc()?.id) syncActiveState();
  const text = doc.state.doc.toString();
  const draft: Draft = {
    ...makeBundle({
      name: docTitle(doc),
      encoding: doc.encoding,
      eol: doc.eol,
      bom: doc.bom,
      text,
      meta: getMeta(doc),
    }),
    path: doc.path,
    cursor: doc.state.selection.main.head,
  };
  const key = keyFor(doc);
  await invoke("draft_save", { key, contents: JSON.stringify(draft) });
  // saved or closed while the write was in flight: the draft is stale
  if (!doc.dirty || keys.get(doc.id) !== key) {
    await invoke("draft_delete", { key });
  }
}

async function dropDraft(doc: Doc): Promise<void> {
  window.clearTimeout(timers.get(doc.id));
  timers.delete(doc.id);
  const key = keys.get(doc.id);
  if (!key) return;
  keys.delete(doc.id);
  await invoke("draft_delete", { key });
}

/** Clean exit: nothing to recover next time. */
export async function clearDrafts(): Promise<void> {
  for (const id of timers.keys()) window.clearTimeout(timers.get(id));
  timers.clear();
  keys.clear();
  await invoke("drafts_clear");
}

function applyMeta(doc: Doc, meta: DocMeta, text: string): void {
  // positions are exact for the draft text (same hash): fast path of
  // the usual re-anchoring
  const effect = setMetaEffect.of({ ...meta, anchors: reanchor(meta, text) });
  if (activeDoc()?.id === doc.id) {
    getView().dispatch({ effects: effect });
    syncActiveState();
  } else {
    doc.state = doc.state.update({ effects: effect }).state;
  }
}

/** Reopens the drafts left by a crash. Returns the recovered titles. */
export async function recoverDrafts(): Promise<string[]> {
  const raws = await invoke<string[]>("drafts_load");
  if (raws.length === 0) return [];
  const recovered: Doc[] = [];
  for (const raw of raws) {
    const bundle = parseBundle(raw);
    if (!bundle) continue; // not a draft of ours: nothing to do with it
    const extra = JSON.parse(raw) as { path?: unknown; cursor?: unknown };
    const path = typeof extra.path === "string" ? extra.path : null;
    const cursor = typeof extra.cursor === "number" ? extra.cursor : 0;

    let doc: Doc | null = null;
    if (path) {
      // the file still exists: reopen it and put the unsaved text on top
      const exists =
        (await invoke<number | null>("file_mtime", { path })) !== null;
      if (exists) doc = await openPath(path);
      if (doc) replaceDocText(doc, bundle.text, cursor);
    }
    if (!doc) {
      doc = newDocFromImport(bundle.text, bundle.name, bundle);
      doc.state = doc.state.update({
        selection: { anchor: Math.min(cursor, bundle.text.length) },
      }).state;
      if (activeDoc()?.id === doc.id) getView().setState(doc.state);
    }
    if (bundle.meta) applyMeta(doc, bundle.meta, bundle.text);
    recovered.push(doc);
  }
  // the old files have served their purpose; the recovered documents
  // are dirty again and get fresh drafts of their own
  await invoke("drafts_clear");
  for (const d of recovered) scheduleDraft(d);
  if (recovered.length > 0) refreshPanels();
  return recovered.map(docTitle);
}

docSavedHooks.push(dropDraft);
docClosedHooks.push((doc) => void dropDraft(doc));
setDraftHook(scheduleDraft);
