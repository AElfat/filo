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
