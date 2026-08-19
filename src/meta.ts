// The heart of filo's distinctive features: stable anchors and
// per-document metadata.
//
// Every feature (links, notes, groups) hangs off an "anchor": a position
// in the document with a stable ID. Two mechanisms keep it alive:
//
// 1. WHILE TYPING — positions are remapped on every edit via
//    ChangeSet.mapPos (inside the StateField below).
// 2. BETWEEN SESSIONS — the metadata stores, for each anchor, the
//    surrounding text (context). If the file was modified by another
//    program, the context is searched for in the new text and the
//    anchor repositioned (re-anchoring). If it can't be found, the
//    anchor is marked "broken" and shown to the user.
//
// The document ALWAYS stays plain text: metadata lives in the app's
// central store (one JSON record per document, see lib.rs). The old
// `document.ext.meta` sidecar is only migrated and removed.

import { StateEffect, StateField } from "@codemirror/state";
import { invoke } from "@tauri-apps/api/core";
import { featureExtensions } from "./editor";
import {
  activeDoc,
  docLoadedHooks,
  docSavedHooks,
  getView,
  type Doc,
} from "./docs";

// ── Sidecar data model ────────────────────────────────────────────────

export interface AnchorCtx {
  before: string;
  after: string;
}

export interface MetaAnchor {
  id: string;
  pos: number;
  /** Text context for re-anchoring (absent only in memory). */
  ctx?: AnchorCtx;
  broken?: boolean;
}

export interface MetaTarget {
  anchorId: string;
  label: string;
}

export interface MetaLink {
  anchorId: string;
  /** Path of the target file; null = same document. */
  targetFile: string | null;
  targetId: string;
  /** Label of the target at creation time (for the chip). */
  label?: string;
}

export interface MetaNote {
  anchorId: string;
  text: string;
}

export interface MetaGroup {
  id: string;
  fromAnchorId: string;
  toAnchorId: string;
  label: string;
  color: string;
  collapsed: boolean;
}

export interface DocMeta {
  version: 1;
  docHash: string;
  anchors: MetaAnchor[];
  targets: MetaTarget[];
  links: MetaLink[];
  notes: MetaNote[];
  groups: MetaGroup[];
}

export function emptyMeta(): DocMeta {
  return {
    version: 1,
    docHash: "",
    anchors: [],
    targets: [],
    links: [],
    notes: [],
    groups: [],
  };
}

export function isMetaEmpty(m: DocMeta): boolean {
  return (
    m.targets.length === 0 &&
    m.links.length === 0 &&
    m.notes.length === 0 &&
    m.groups.length === 0
  );
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Pure functions (testable) ─────────────────────────────────────────

/** 32-bit FNV-1a hash of the text, as hex. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

const CTX_LEN = 24;

export function ctxAround(text: string, pos: number): AnchorCtx {
  return {
    before: text.slice(Math.max(0, pos - CTX_LEN), pos),
    after: text.slice(pos, pos + CTX_LEN),
  };
}

/** All occurrences of `needle` in `haystack` (at most `cap`). */
function findAll(haystack: string, needle: string, cap = 200): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = haystack.indexOf(needle);
  while (i !== -1 && out.length < cap) {
    out.push(i);
    i = haystack.indexOf(needle, i + 1);
  }
  return out;
}

function nearest(candidates: number[], to: number): number | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, c) =>
    Math.abs(c - to) < Math.abs(best - to) ? c : best,
  );
}

/**
 * Re-anchoring: given the saved meta and the file's current text,
 * returns the anchors with updated positions. If the text hash matches
 * the saved one the positions are already valid; otherwise each anchor
 * is located again via its context.
 */
export function reanchor(meta: DocMeta, text: string): MetaAnchor[] {
  const unchanged = meta.docHash !== "" && hashText(text) === meta.docHash;
  return meta.anchors.map((a) => {
    if (unchanged) {
      return { ...a, pos: Math.min(a.pos, text.length), broken: false };
    }
    const ctx = a.ctx ?? { before: "", after: "" };

    // 1. full context (before+after)
    const full = ctx.before + ctx.after;
    if (full) {
      const hit = nearest(findAll(text, full), a.pos);
      if (hit !== null) {
        return { ...a, pos: hit + ctx.before.length, broken: false };
      }
    }
    // 2. following text only
    if (ctx.after) {
      const hit = nearest(findAll(text, ctx.after), a.pos);
      if (hit !== null) return { ...a, pos: hit, broken: false };
    }
    // 3. preceding text only
    if (ctx.before) {
      const hit = nearest(findAll(text, ctx.before), a.pos);
      if (hit !== null) {
        return { ...a, pos: hit + ctx.before.length, broken: false };
      }
    }
    // not found: broken (position clamped to the maximum allowed)
    return { ...a, pos: Math.min(a.pos, text.length), broken: true };
  });
}

// ── StateField: the meta lives INSIDE the document state ──────────────
// That way each tab has its own, and positions remap on their own.

export const setMetaEffect = StateEffect.define<DocMeta>();
export const metaChangedEffect = StateEffect.define<null>(); // generic signal

export const addTargetEffect = StateEffect.define<{
  anchor: MetaAnchor;
  target: MetaTarget;
}>();
export const addLinkEffect = StateEffect.define<{
  anchor: MetaAnchor;
  link: MetaLink;
}>();
export const addNoteEffect = StateEffect.define<{
  anchor: MetaAnchor;
  note: MetaNote;
}>();
export const updateNoteEffect = StateEffect.define<{
  anchorId: string;
  text: string;
}>();
export const addGroupEffect = StateEffect.define<{
  from: MetaAnchor;
  to: MetaAnchor;
  group: MetaGroup;
}>();
export const toggleGroupEffect = StateEffect.define<string>(); // groupId
export const removeItemEffect = StateEffect.define<{
  kind: "target" | "link" | "note" | "group";
  id: string; // anchorId (or groupId for groups)
}>();

export const metaField = StateField.define<DocMeta>({
  create: emptyMeta,
  update(meta, tr) {
    let m = meta;
    if (tr.docChanged) {
      m = {
        ...m,
        anchors: m.anchors.map((a) => ({
          ...a,
          pos: tr.changes.mapPos(a.pos),
        })),
      };
    }
    for (const e of tr.effects) {
      if (e.is(setMetaEffect)) {
        m = e.value;
      } else if (e.is(addTargetEffect)) {
        m = {
          ...m,
          anchors: [...m.anchors, e.value.anchor],
          targets: [...m.targets, e.value.target],
        };
      } else if (e.is(addLinkEffect)) {
        m = {
          ...m,
          anchors: [...m.anchors, e.value.anchor],
          links: [...m.links, e.value.link],
        };
      } else if (e.is(addNoteEffect)) {
        m = {
          ...m,
          anchors: [...m.anchors, e.value.anchor],
          notes: [...m.notes, e.value.note],
        };
      } else if (e.is(updateNoteEffect)) {
        m = {
          ...m,
          notes: m.notes.map((n) =>
            n.anchorId === e.value.anchorId
              ? { ...n, text: e.value.text }
              : n,
          ),
        };
      } else if (e.is(addGroupEffect)) {
        m = {
          ...m,
          anchors: [...m.anchors, e.value.from, e.value.to],
          groups: [...m.groups, e.value.group],
        };
      } else if (e.is(toggleGroupEffect)) {
        m = {
          ...m,
          groups: m.groups.map((g) =>
            g.id === e.value ? { ...g, collapsed: !g.collapsed } : g,
          ),
        };
      } else if (e.is(removeItemEffect)) {
        m = removeItem(m, e.value.kind, e.value.id);
      }
    }
    return m;
  },
});

function removeItem(
  m: DocMeta,
  kind: "target" | "link" | "note" | "group",
  id: string,
): DocMeta {
  const dropAnchors = new Set<string>();
  let next = m;
  if (kind === "target") {
    dropAnchors.add(id);
    next = {
      ...m,
      targets: m.targets.filter((t) => t.anchorId !== id),
      // links pointing at this target stay but will show up as broken;
      // the user sees them in the panel and can remove them
    };
  } else if (kind === "link") {
    dropAnchors.add(id);
    next = { ...m, links: m.links.filter((l) => l.anchorId !== id) };
  } else if (kind === "note") {
    dropAnchors.add(id);
    next = { ...m, notes: m.notes.filter((n) => n.anchorId !== id) };
  } else {
    const g = m.groups.find((g) => g.id === id);
    if (g) {
      dropAnchors.add(g.fromAnchorId);
      dropAnchors.add(g.toAnchorId);
    }
    next = { ...m, groups: m.groups.filter((g) => g.id !== id) };
  }
  return {
    ...next,
    anchors: next.anchors.filter((a) => !dropAnchors.has(a.id)),
  };
}

export function getMeta(doc: Doc): DocMeta {
  return doc.state.field(metaField);
}

export function anchorPos(meta: DocMeta, anchorId: string): number | null {
  const a = meta.anchors.find((a) => a.id === anchorId);
  return a && !a.broken ? a.pos : null;
}

// ── Sidecar serialization and persistence ─────────────────────────────

/** Prepares the meta for saving: fresh context for every anchor
 *  plus the text hash. */
export function serializeMeta(meta: DocMeta, text: string): DocMeta {
  return {
    ...meta,
    docHash: hashText(text),
    anchors: meta.anchors.map((a) => ({
      id: a.id,
      pos: Math.min(a.pos, text.length),
      ctx: ctxAround(text, Math.min(a.pos, text.length)),
      ...(a.broken ? { broken: true } : {}),
    })),
  };
}

export async function saveSidecar(doc: Doc): Promise<void> {
  if (!doc.path) return;
  const meta = getMeta(doc);
  if (isMetaEmpty(meta)) {
    await invoke("meta_delete", { path: doc.path });
    return;
  }
  const text = doc.state.doc.toString();
  const serialized = serializeMeta(meta, text);
  await invoke("meta_save", {
    path: doc.path,
    docHash: serialized.docHash,
    contents: JSON.stringify(serialized),
  });
}

// The group color ends up in a style attribute: a tampered record
// must not be able to inject arbitrary CSS.
const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;
const FALLBACK_COLOR = "#4a6fa5";

export function sanitizeMeta(meta: DocMeta): DocMeta {
  return {
    ...meta,
    groups: meta.groups.map((g) =>
      SAFE_COLOR.test(g.color) ? g : { ...g, color: FALLBACK_COLOR },
    ),
  };
}

export async function loadSidecar(doc: Doc, diskText: string): Promise<void> {
  if (!doc.path) return;

  // 1. old format: .meta file next to the document → migrate to the
  //    central store and remove the extra file
  let raw = await invoke<string | null>("read_sidecar", { path: doc.path });
  const migrating = raw !== null;

  // 2. central store (with adoption if the file was moved)
  if (!raw) {
    raw = await invoke<string | null>("meta_load", {
      path: doc.path,
      diskHash: hashText(diskText),
    });
  }
  if (!raw) return;
  let meta: DocMeta;
  try {
    meta = sanitizeMeta({ ...emptyMeta(), ...JSON.parse(raw) });
  } catch {
    return; // corrupt record: better to ignore it than block opening
  }
  if (migrating) {
    await invoke("meta_save", {
      path: doc.path,
      docHash: meta.docHash ?? "",
      contents: raw,
    });
    await invoke("delete_sidecar", { path: doc.path });
  }
  const anchors = reanchor(meta, diskText);
  const effect = setMetaEffect.of({ ...meta, anchors });
  if (activeDoc()?.id === doc.id) {
    // the document is mounted in the view: the dispatch updates it too
    getView().dispatch({ effects: effect });
    doc.state = getView().state;
  } else {
    doc.state = doc.state.update({ effects: effect }).state;
  }
}

// Sidecar save for metadata-only changes (note edited, group
// collapsed…) while the document is clean: light debounce.
const metaTimers = new Map<string, number>();

export function saveMetaSoon(doc: Doc) {
  if (!doc.path || doc.dirty) return; // if dirty, it saves with the document
  window.clearTimeout(metaTimers.get(doc.id));
  metaTimers.set(
    doc.id,
    window.setTimeout(() => void saveSidecar(doc), 500),
  );
}

// ── Hooking into the document lifecycle and the editor ────────────────

featureExtensions.push(metaField);
docLoadedHooks.push(loadSidecar);
docSavedHooks.push(saveSidecar);
