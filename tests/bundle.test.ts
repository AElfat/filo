// Tests for the .filo bundle format: round-trip and validation.

import { describe, expect, it } from "vitest";
import { makeBundle, parseBundle } from "../src/bundle";
import { ctxAround, emptyMeta, hashText, type DocMeta } from "../src/meta";

function sampleMeta(text: string): DocMeta {
  const pos = text.indexOf("second");
  return {
    ...emptyMeta(),
    anchors: [{ id: "a1", pos, ctx: ctxAround(text, pos) }],
    targets: [{ anchorId: "a1", label: "second line" }],
  };
}

describe("makeBundle / parseBundle round-trip", () => {
  const text = "first line\nsecond line\nthird line";

  it("keeps text, format and metadata", () => {
    const bundle = makeBundle({
      name: "notes.txt",
      encoding: "utf-8",
      eol: "crlf",
      bom: false,
      text,
      meta: sampleMeta(text),
    });
    const parsed = parseBundle(JSON.stringify(bundle));
    expect(parsed).not.toBeNull();
    expect(parsed!.text).toBe(text);
    expect(parsed!.name).toBe("notes.txt");
    expect(parsed!.eol).toBe("crlf");
    expect(parsed!.meta!.targets).toHaveLength(1);
    expect(parsed!.meta!.anchors[0].pos).toBe(text.indexOf("second"));
    // the exported meta carries the text hash for fast re-anchoring
    expect(parsed!.meta!.docHash).toBe(hashText(text));
  });

  it("stores null meta when the document has none", () => {
    const bundle = makeBundle({
      name: "plain.txt",
      encoding: "utf-8",
      eol: "lf",
      bom: false,
      text: "just text",
      meta: emptyMeta(),
    });
    expect(bundle.meta).toBeNull();
    expect(parseBundle(JSON.stringify(bundle))!.meta).toBeNull();
  });

  it("sanitizes a tampered group color", () => {
    const meta: DocMeta = {
      ...emptyMeta(),
      groups: [
        {
          id: "g1",
          fromAnchorId: "a",
          toAnchorId: "b",
          label: "x",
          color: "red;background:url(https://evil)",
          collapsed: false,
        },
      ],
    };
    const bundle = makeBundle({
      name: "t.txt",
      encoding: "utf-8",
      eol: "lf",
      bom: false,
      text: "t",
      meta,
    });
    const parsed = parseBundle(JSON.stringify(bundle));
    expect(parsed!.meta!.groups[0].color).toMatch(/^#[0-9a-f]{3,8}$/i);
  });
});

describe("parseBundle rejects garbage", () => {
  it.each([
    ["not json", "{{{"],
    ["wrong version", JSON.stringify({ filo: 2, name: "x", text: "y" })],
    ["missing text", JSON.stringify({ filo: 1, name: "x" })],
    ["missing name", JSON.stringify({ filo: 1, text: "y" })],
    ["a plain text file", "hello world"],
    ["a JSON document", JSON.stringify({ orders: [1, 2, 3] })],
  ])("%s", (_label, raw) => {
    expect(parseBundle(raw)).toBeNull();
  });
});
