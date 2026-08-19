// Recent files: the last 10 documents opened or saved to disk,
// persisted in config. Shown by right-clicking the Open button.

import { invoke } from "@tauri-apps/api/core";
import { docLoadedHooks, docSavedHooks } from "./docs";

const MAX = 10;
let list: string[] = [];

export async function initRecents(): Promise<void> {
  try {
    const raw = await invoke<string | null>("load_config", { name: "recents" });
    if (raw) list = (JSON.parse(raw) as string[]).slice(0, MAX);
  } catch {
    // first launch or corrupted record: empty list
  }
}

function save(): void {
  void invoke("save_config", {
    name: "recents",
    contents: JSON.stringify(list),
  }).catch(() => {
    // best-effort, like the session
  });
}

export function addRecent(path: string): void {
  list = [path, ...list.filter((p) => p.toLowerCase() !== path.toLowerCase())];
  if (list.length > MAX) list = list.slice(0, MAX);
  save();
}

/** A recent that no longer opens (file gone) leaves the list. */
export function removeRecent(path: string): void {
  list = list.filter((p) => p.toLowerCase() !== path.toLowerCase());
  save();
}

export function getRecents(): readonly string[] {
  return list;
}

docLoadedHooks.push(async (doc) => {
  if (doc.path) addRecent(doc.path);
});
docSavedHooks.push(async (doc) => {
  if (doc.path) addRecent(doc.path);
});
