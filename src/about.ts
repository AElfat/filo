// "About filo" screen: app version, author, GitHub and Ko-fi.
// Links open in the system browser.

import { openUrl } from "@tauri-apps/plugin-opener";
import { modal } from "./ui";
import { t } from "./i18n";

const AUTHOR = {
  name: "Elfat Amiti",
  github: "github.com/AElfat",
  kofi: "ko-fi.com/elfatamiti",
};

const VERSION = "1.3.0";

// Inline (stroke) icons in a style consistent with the app.
const ICONS = {
  person: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.5-6 8-6s8 2 8 6"/></svg>`,
  link: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1"/><path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1"/></svg>`,
  coffee: `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h12v7a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4z"/><path d="M16 10h2a3 3 0 0 1 0 6h-2"/><path d="M8 2.5c-1 1.2 1 1.8 0 3M12 2.5c-1 1.2 1 1.8 0 3"/></svg>`,
};

export async function showAbout(): Promise<void> {
  const body = document.createElement("div");
  body.className = "about-box";
  body.innerHTML = `
    <div class="about-head">
      <div class="about-logo">f</div>
      <div>
        <div class="about-name">filo</div>
        <div class="about-version">versione ${VERSION}</div>
      </div>
    </div>
    <p class="about-tag">${t("app.tagline")}</p>
    <div class="about-contacts">
      <div class="about-row"><span class="about-ic">${ICONS.person}</span>
        <span>${AUTHOR.name}</span></div>
      <button class="about-row about-link" data-url="https://${AUTHOR.github}">
        <span class="about-ic">${ICONS.link}</span>
        <span>${AUTHOR.github}</span></button>
      <button class="about-row about-link" data-url="https://${AUTHOR.kofi}">
        <span class="about-ic">${ICONS.coffee}</span>
        <span>${AUTHOR.kofi}</span></button>
    </div>
  `;

  body.querySelectorAll<HTMLButtonElement>(".about-link").forEach((btn) => {
    btn.addEventListener("click", () => {
      const url = btn.dataset.url;
      if (url) void openUrl(url);
    });
  });

  await modal(t("about.title"), body, [
    { id: "ok", label: t("btn.close"), primary: true },
  ]);
}
