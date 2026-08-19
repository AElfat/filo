// Markdown preview: renders the text as formatted HTML.
//
// Security: markdown-it is configured with html:false, so any raw HTML
// in the document is shown as text (never executed) — no <script> can
// run inside the app. Links open in the system browser, not inside
// the webview.

import MarkdownIt from "markdown-it";
import { openUrl } from "@tauri-apps/plugin-opener";
import { activeDoc, getView, type Doc } from "./docs";

const md = new MarkdownIt({
  html: false, // no raw HTML: security
  linkify: true, // URLs typed as text become links
  breaks: true, // single newline = <br>, handy for notes
  typographer: true,
});

const editorEl = () => document.querySelector<HTMLElement>("#editor")!;
const previewEl = () => document.querySelector<HTMLElement>("#preview")!;

/** Is a document in preview? (only Markdown can be) */
export function isPreview(doc: Doc | null): boolean {
  return !!doc && doc.lang === "markdown" && doc.preview === true;
}

/** Renders the current content into the preview panel. */
function render(doc: Doc) {
  const text =
    doc.id === activeDoc()?.id
      ? getView().state.doc.toString()
      : doc.state.doc.toString();
  previewEl().innerHTML = md.render(text);
}

/** Shows the editor or the preview based on the active document's state. */
export function applyPreviewState() {
  const doc = activeDoc();
  const preview = isPreview(doc);
  editorEl().hidden = preview;
  previewEl().hidden = !preview;
  if (preview && doc) render(doc);
}

/** Toggles editor ⇄ preview for the active document (Markdown only). */
export function togglePreview() {
  const doc = activeDoc();
  if (!doc || doc.lang !== "markdown") return;
  doc.preview = !doc.preview;
  applyPreviewState();
  if (!doc.preview) getView().focus();
}

// Links inside the preview open in the system browser.
// Only http/https/mailto: markdown-it already blocks javascript: and
// file:, but custom schemes (Windows protocol handlers) must not reach
// the system from a document received from third parties.
const SAFE_URL = /^(https?:|mailto:)/i;

function wirePreviewLinks() {
  previewEl().addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest("a");
    const href = a?.getAttribute("href");
    if (href) {
      e.preventDefault();
      if (SAFE_URL.test(href)) void openUrl(href);
    }
  });
}

// One-time initialization.
export function initPreview() {
  wirePreviewLinks();
}
