// filo's user preferences: theme, font, size. Persisted as JSON in the
// app's config folder (Rust load/save_config commands).

import { invoke } from "@tauri-apps/api/core";
import {
  detectSystemLang,
  LANG_NAMES,
  t,
  type Lang4,
} from "./i18n";

export interface Prefs {
  theme: "chiaro" | "scuro";
  fontFamily: string;
  fontSize: number;
  lang: Lang4;
  wrap: boolean; // word wrap (Alt+Z)
}

export const defaultPrefs: Prefs = {
  theme: "chiaro",
  fontFamily: "Cascadia Code",
  fontSize: 14,
  lang: "it",
  wrap: true,
};

export async function loadPrefs(): Promise<Prefs> {
  try {
    const raw = await invoke<string | null>("load_config", { name: "prefs" });
    if (!raw) {
      // first launch: start from the Windows language
      return { ...defaultPrefs, lang: detectSystemLang() };
    }
    return { ...defaultPrefs, ...JSON.parse(raw) };
  } catch {
    return { ...defaultPrefs, lang: detectSystemLang() };
  }
}

export async function savePrefs(p: Prefs): Promise<void> {
  await invoke("save_config", {
    name: "prefs",
    contents: JSON.stringify(p, null, 2),
  });
}

// Shortcuts shown at the bottom of the Settings page: {C} and {S} are
// the localized Ctrl/Shift names, {D} the word for "drag".
const SHORTCUTS: [group: string, items: [combo: string, desc: string][]][] = [
  ["keys.file", [
    ["{C}+T", "keys.new"],
    ["{C}+O", "keys.open"],
    ["{C}+S", "keys.save"],
    ["{C}+{S}+S", "keys.saveAs"],
    ["{C}+Alt+S", "keys.saveAll"],
    ["{C}+W", "keys.close"],
    ["{C}+{S}+T", "keys.reopen"],
    ["{C}+Tab / {C}+{S}+Tab", "keys.nextTab"],
    ["{C}+{S}+E", "keys.export"],
    ["{C}+P", "keys.print"],
  ]],
  ["keys.edit", [
    ["{C}+Z / {C}+Y", "keys.undo"],
    ["{C}+D", "keys.nextOcc"],
    ["{C}+{S}+L", "keys.allOcc"],
    ["Alt+↑ / Alt+↓", "keys.moveLine"],
    ["{S}+Alt+↑ / {S}+Alt+↓", "keys.copyLine"],
    ["{C}+{S}+K", "keys.deleteLine"],
    ["{C}+Alt+↑ / {C}+Alt+↓", "keys.addCursor"],
    ["Alt+{D}", "keys.rectSel"],
    ["Tab / {S}+Tab", "keys.indent"],
  ]],
  ["keys.find", [
    ["{C}+F", "keys.find"],
    ["F3 / {S}+F3", "keys.findNext"],
    ["{C}+Alt+G", "keys.gotoLine"],
    ["Alt+←", "keys.back"],
  ]],
  ["keys.filo", [
    ["{C}+L", "keys.target"],
    ["{C}+K", "keys.link"],
    ["{C}+N", "keys.note"],
    ["{C}+G", "keys.group"],
  ]],
  ["keys.view", [
    ["{C}+B", "keys.explorer"],
    ["{C}+{S}+V", "keys.preview"],
    ["Alt+Z", "keys.wrap"],
    ["{C}++ / {C}+- / {C}+0", "keys.zoom"],
    ["{C}+Alt+F / {C}+Alt+M", "keys.format"],
    ["{C}+,", "keys.prefs"],
  ]],
];

function shortcutsHtml(): string {
  const combo = (c: string) =>
    c
      .split("{C}").join(t("key.ctrl"))
      .split("{S}").join(t("key.shift"))
      .split("{D}").join(t("key.drag"));
  return SHORTCUTS.map(
    ([group, items]) =>
      `<div class="keys-group">${t(group)}</div>` +
      items
        .map(
          ([c, d]) =>
            `<div class="keys-row"><span>${t(d)}</span><kbd>${combo(c)}</kbd></div>`,
        )
        .join(""),
  ).join("");
}

/** Settings page (lives in a tab, not a modal):
 *  every change is reported immediately via onChange. */
export function buildPrefsPage(
  current: Prefs,
  onChange: (next: Prefs) => void,
): HTMLElement {
  const page = document.createElement("div");
  page.className = "prefs-page-inner";
  const langOptions = (Object.keys(LANG_NAMES) as Lang4[])
    .map((l) => `<option value="${l}">${LANG_NAMES[l]}</option>`)
    .join("");
  page.innerHTML = `
    <h1>${t("prefs.title")}</h1>
    <p class="prefs-live">${t("prefs.live")}</p>
    <div class="prefs-form">
      <label>${t("prefs.lang")}
        <select id="pref-lang">${langOptions}</select>
      </label>
      <label>${t("prefs.theme")}
        <select id="pref-theme">
          <option value="chiaro">${t("prefs.theme.light")}</option>
          <option value="scuro">${t("prefs.theme.dark")}</option>
        </select>
      </label>
      <label>${t("prefs.font")}
        <input id="pref-font" type="text" spellcheck="false" autocomplete="off" />
      </label>
      <label>${t("prefs.size")}
        <span class="stepper">
          <input id="pref-size" type="number" min="8" max="32" autocomplete="off" />
          <span class="stepper-btns">
            <button type="button" class="step-up" tabindex="-1">▴</button>
            <button type="button" class="step-down" tabindex="-1">▾</button>
          </span>
        </span>
      </label>
      <label class="prefs-check">
        <span>${t("prefs.wrap")}</span>
        <input id="pref-wrap" type="checkbox" />
      </label>
    </div>
    <h2 class="keys-title">${t("keys.title")}</h2>
    ${shortcutsHtml()}
  `;
  const lang = page.querySelector<HTMLSelectElement>("#pref-lang")!;
  const theme = page.querySelector<HTMLSelectElement>("#pref-theme")!;
  const font = page.querySelector<HTMLInputElement>("#pref-font")!;
  const size = page.querySelector<HTMLInputElement>("#pref-size")!;
  const wrap = page.querySelector<HTMLInputElement>("#pref-wrap")!;
  lang.value = current.lang;
  theme.value = current.theme;
  font.value = current.fontFamily;
  size.value = String(current.fontSize);
  wrap.checked = current.wrap;

  const emit = () =>
    onChange({
      lang: (lang.value as Lang4) || "it",
      theme: theme.value === "scuro" ? "scuro" : "chiaro",
      fontFamily: font.value.trim() || defaultPrefs.fontFamily,
      fontSize: Math.min(32, Math.max(8, Number(size.value) || 14)),
      wrap: wrap.checked,
    });
  for (const c of [lang, theme, font, size, wrap]) {
    c.addEventListener("change", emit);
  }
  page
    .querySelector<HTMLButtonElement>(".step-up")!
    .addEventListener("click", () => {
      size.stepUp();
      emit();
    });
  page
    .querySelector<HTMLButtonElement>(".step-down")!
    .addEventListener("click", () => {
      size.stepDown();
      emit();
    });
  return page;
}
