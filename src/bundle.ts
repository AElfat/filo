// Export/import of .filo bundles: a single JSON file carrying the text
// AND its metadata (links, notes, groups), so a document can be shared
// with everything the central store normally keeps local. Opening a
// bundle recreates the document as a new unsaved tab; where it lands is
// decided by the user with Save As.

import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  activeDoc,
  docTitle,
  getView,
  newDocFromImport,
  setBundleImporter,
  syncActiveState,
  type Doc,
} from "./docs";
import {
  emptyMeta,
  getMeta,
  isMetaEmpty,
  reanchor,
  sanitizeMeta,
  serializeMeta,
  setMetaEffect,
  type DocMeta,
} from "./meta";
import { refreshPanels } from "./panels";
import { modal } from "./ui";
import { t } from "./i18n";

export interface Bundle {
  filo: 1; // format version
  name: string; // original file name (Save As default)
  encoding: string;
  eol: string;
  bom: boolean;
  text: string;
  meta: DocMeta | null; // null when the document has no metadata
}

// ── Pure helpers (tested in tests/bundle.test.ts) ─────────────────────

export function makeBundle(doc: {
  name: string;
  encoding: string;
  eol: string;
  bom: boolean;
  text: string;
  meta: DocMeta;
}): Bundle {
  return {
    filo: 1,
    name: doc.name,
    encoding: doc.encoding,
    eol: doc.eol,
    bom: doc.bom,
    text: doc.text,
    meta: isMetaEmpty(doc.meta) ? null : serializeMeta(doc.meta, doc.text),
  };
}

/** Parses and validates a bundle; null if it isn't one. */
export function parseBundle(raw: string): Bundle | null {
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof b !== "object" || b === null) return null;
  const o = b as Record<string, unknown>;
  if (o.filo !== 1) return null;
  if (typeof o.text !== "string" || typeof o.name !== "string") return null;
  return {
    filo: 1,
    name: o.name,
    encoding: o.encoding === "windows-1252" ? "windows-1252" : "utf-8",
    eol: o.eol === "lf" ? "lf" : "crlf",
    bom: o.bom === true,
    text: o.text,
    meta:
      typeof o.meta === "object" && o.meta !== null
        ? sanitizeMeta({ ...emptyMeta(), ...(o.meta as Partial<DocMeta>) })
        : null,
  };
}

// ── Export ────────────────────────────────────────────────────────────

export async function exportBundle(doc?: Doc | null): Promise<void> {
  syncActiveState();
  const target = doc ?? activeDoc();
  if (!target) return;
  const text = target.state.doc.toString();
  const bundle = makeBundle({
    name: docTitle(target),
    encoding: target.encoding,
    eol: target.eol,
    bom: target.bom,
    text,
    meta: getMeta(target),
  });
  const chosen = await saveDialog({
    filters: [{ name: "filo", extensions: ["filo"] }],
    defaultPath: `${docTitle(target)}.filo`,
  });
  if (!chosen) return;
  try {
    await invoke("write_file", {
      path: chosen,
      contents: JSON.stringify(bundle),
      encoding: "utf-8",
      eol: "lf",
      bom: false,
    });
  } catch (e) {
    await modal(t("save.error.title"), String(e), [
      { id: "ok", label: t("btn.ok"), primary: true },
    ]);
  }
}

// ── Import (registered as the .filo handler of openPath) ─────────────

async function importBundle(raw: string): Promise<Doc | null> {
  const bundle = parseBundle(raw);
  if (!bundle) {
    await modal(t("import.invalid.title"), t("import.invalid.body"), [
      { id: "ok", label: t("btn.ok"), primary: true },
    ]);
    return null;
  }
  const doc = newDocFromImport(bundle.text, bundle.name, bundle);
  if (bundle.meta) {
    // positions are exact for the bundled text (same hash), so this is
    // just the fast path of the usual re-anchoring
    const anchors = reanchor(bundle.meta, bundle.text);
    getView().dispatch({
      effects: setMetaEffect.of({ ...bundle.meta, anchors }),
    });
    syncActiveState();
    refreshPanels();
  }
  return doc;
}

setBundleImporter(importBundle);
