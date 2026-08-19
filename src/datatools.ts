// Working tools for data (JSON/XML) — not decoration:
// - real-time validation (margin markers)
// - pretty-print and minify on demand
// - current JSON path in the status bar (e.g. orders[3].customer.name)

import { linter, type Diagnostic } from "@codemirror/lint";
import { jsonParseLinter } from "@codemirror/lang-json";
import { syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { setExtrasProvider, type Lang } from "./editor";
import { activeDoc, getView, syncActiveState } from "./docs";
import { modal } from "./ui";
import { t } from "./i18n";

// ── Validation ────────────────────────────────────────────────────────

function xmlLinter(view: EditorView): Diagnostic[] {
  const text = view.state.doc.toString();
  if (!text.trim()) return [];
  const parsed = new DOMParser().parseFromString(text, "application/xml");
  const err = parsed.querySelector("parsererror");
  if (!err) return [];

  const msg = err.textContent ?? "XML non valido";
  // Chromium reports "error on line X at column Y: …"
  const m = msg.match(/line (\d+) at column (\d+)/);
  let from = 0;
  if (m) {
    const lineNo = Math.min(Number(m[1]), view.state.doc.lines);
    const line = view.state.doc.line(lineNo);
    from = Math.min(line.from + Number(m[2]) - 1, line.to);
  }
  const clean = msg.split("\n")[0].trim();
  return [
    {
      from,
      to: Math.min(from + 1, view.state.doc.length),
      severity: "error",
      message: clean,
    },
  ];
}

function extrasFor(lang: Lang): Extension {
  if (lang === "json") return linter(jsonParseLinter(), { delay: 400 });
  if (lang === "xml") return linter(xmlLinter, { delay: 400 });
  return [];
}

setExtrasProvider(extrasFor);

// ── Pretty-print and minify ───────────────────────────────────────────

function formatXmlNode(node: Node, indent: string, out: string[]): void {
  const pad = indent;
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent?.trim();
    if (t) out.push(pad + t);
    return;
  }
  if (node.nodeType === Node.COMMENT_NODE) {
    out.push(`${pad}<!--${node.textContent}-->`);
    return;
  }
  if (node.nodeType === Node.CDATA_SECTION_NODE) {
    out.push(`${pad}<![CDATA[${node.textContent}]]>`);
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const elem = node as Element;
  const attrs = Array.from(elem.attributes)
    .map((a) => ` ${a.name}="${a.value}"`)
    .join("");
  const children = Array.from(elem.childNodes).filter(
    (c) => c.nodeType !== Node.TEXT_NODE || c.textContent?.trim(),
  );

  if (children.length === 0) {
    out.push(`${pad}<${elem.tagName}${attrs}/>`);
  } else if (
    children.length === 1 &&
    children[0].nodeType === Node.TEXT_NODE
  ) {
    out.push(
      `${pad}<${elem.tagName}${attrs}>${children[0].textContent?.trim()}</${elem.tagName}>`,
    );
  } else {
    out.push(`${pad}<${elem.tagName}${attrs}>`);
    for (const c of children) formatXmlNode(c, indent + "  ", out);
    out.push(`${pad}</${elem.tagName}>`);
  }
}

function parseXmlOrNull(text: string): Document | null {
  const parsed = new DOMParser().parseFromString(text, "application/xml");
  return parsed.querySelector("parsererror") ? null : parsed;
}

async function transformActive(minify: boolean): Promise<void> {
  const doc = activeDoc();
  if (!doc) return;
  const view = getView();
  const text = view.state.doc.toString();
  let result: string;

  if (doc.lang === "json") {
    try {
      const value = JSON.parse(text);
      result = minify ? JSON.stringify(value) : JSON.stringify(value, null, 2);
    } catch (e) {
      await modal(t("data.invalidJson.title"), String(e), [
        { id: "ok", label: t("btn.ok"), primary: true },
      ]);
      return;
    }
  } else if (doc.lang === "xml") {
    const parsed = parseXmlOrNull(text);
    if (!parsed) {
      await modal(t("data.invalidXml.title"), t("data.invalidXml.body"), [
        { id: "ok", label: t("btn.ok"), primary: true },
      ]);
      return;
    }
    const decl = text.match(/^<\?xml[^?]*\?>/)?.[0];
    if (minify) {
      const ser = new XMLSerializer().serializeToString(parsed.documentElement);
      result = (decl ? decl : "") + ser.replace(/>\s+</g, "><");
    } else {
      const out: string[] = decl ? [decl] : [];
      formatXmlNode(parsed.documentElement, "", out);
      result = out.join("\n");
    }
  } else {
    await modal(t("data.onlyData.title"), t("data.onlyData.body"), [
      { id: "ok", label: t("btn.ok"), primary: true },
    ]);
    return;
  }

  if (result !== text) {
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: result },
    });
    syncActiveState();
  }
  view.focus();
}

/** Ctrl+Alt+F */
export function prettyPrint(): Promise<void> {
  return transformActive(false);
}

/** Ctrl+Alt+M */
export function minify(): Promise<void> {
  return transformActive(true);
}

// ── JSON path in the status bar ───────────────────────────────────────

const VALUE_NAMES = new Set([
  "Object",
  "Array",
  "String",
  "Number",
  "True",
  "False",
  "Null",
]);

export function jsonPathAt(state: EditorState, pos: number): string | null {
  let node = syntaxTree(state).resolveInner(pos, -1);
  const parts: string[] = [];

  while (node.parent) {
    const parent = node.parent;
    if (parent.name === "Property" && node.name !== "PropertyName") {
      const nameNode = parent.getChild("PropertyName");
      if (nameNode) {
        const raw = state.doc.sliceString(nameNode.from, nameNode.to);
        parts.unshift("." + raw.replace(/^"|"$/g, ""));
      }
    } else if (parent.name === "Property" && node.name === "PropertyName") {
      const raw = state.doc.sliceString(node.from, node.to);
      parts.unshift("." + raw.replace(/^"|"$/g, ""));
    } else if (parent.name === "Array") {
      let i = 0;
      for (
        let sib = node.prevSibling;
        sib;
        sib = sib.prevSibling
      ) {
        if (VALUE_NAMES.has(sib.name)) i += 1;
      }
      parts.unshift(`[${i}]`);
    }
    node = parent;
  }
  if (parts.length === 0) return null;
  return parts.join("").replace(/^\./, "");
}
