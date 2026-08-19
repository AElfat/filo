// Tests for filo's most delicate module: hashing, context and re-anchoring.
import { describe, expect, it } from "vitest";
import {
  ctxAround,
  emptyMeta,
  hashText,
  reanchor,
  serializeMeta,
  type DocMeta,
} from "../src/meta";

function metaWithAnchor(text: string, pos: number, id = "a1"): DocMeta {
  const meta = emptyMeta();
  meta.docHash = hashText(text);
  meta.anchors = [{ id, pos, ctx: ctxAround(text, pos) }];
  return meta;
}

describe("hashText", () => {
  it("is stable and sensitive to changes", () => {
    expect(hashText("ciao")).toBe(hashText("ciao"));
    expect(hashText("ciao")).not.toBe(hashText("ciao!"));
    expect(hashText("")).toBeTypeOf("string");
  });
});

describe("reanchor — unmodified file", () => {
  it("keeps the original positions", () => {
    const text = "prima riga\nseconda riga\nterza riga";
    const meta = metaWithAnchor(text, 11); // start of "seconda"
    const out = reanchor(meta, text);
    expect(out[0].pos).toBe(11);
    expect(out[0].broken).toBe(false);
  });
});

describe("reanchor — file modified externally", () => {
  const original = "alfa\nbeta\ngamma\ndelta\nepsilon";

  it("finds the anchor again when the text has shifted", () => {
    const pos = original.indexOf("gamma");
    const meta = metaWithAnchor(original, pos);
    // someone inserted lines at the top of the file
    const edited = "NUOVA RIGA\nALTRA RIGA\n" + original;
    const out = reanchor(meta, edited);
    expect(out[0].broken).toBe(false);
    expect(edited.slice(out[0].pos, out[0].pos + 5)).toBe("gamma");
  });

  it("finds the anchor again with only the following context", () => {
    const pos = original.indexOf("gamma");
    const meta = metaWithAnchor(original, pos);
    // the text BEFORE the anchor was rewritten
    const edited = "uno\ndue\ntre\ngamma\ndelta\nepsilon";
    const out = reanchor(meta, edited);
    expect(out[0].broken).toBe(false);
    expect(edited.slice(out[0].pos, out[0].pos + 5)).toBe("gamma");
  });

  it("picks the occurrence closest to the original position", () => {
    const text = "x\nripetuto\n" + "riempitivo\n".repeat(50) + "ripetuto\nfine";
    const posNearEnd = text.lastIndexOf("ripetuto");
    const meta = emptyMeta();
    meta.docHash = "diverso"; // forces re-anchoring
    meta.anchors = [
      { id: "a1", pos: posNearEnd, ctx: { before: "", after: "ripetuto" } },
    ];
    const out = reanchor(meta, text);
    expect(out[0].pos).toBe(posNearEnd);
  });

  it("marks as broken what no longer exists", () => {
    const pos = original.indexOf("gamma");
    const meta = metaWithAnchor(original, pos);
    const edited = "contenuto completamente diverso, niente greco qui";
    const out = reanchor(meta, edited);
    expect(out[0].broken).toBe(true);
    expect(out[0].pos).toBeLessThanOrEqual(edited.length);
  });

  it("never steps outside the bounds of the new text", () => {
    const meta = metaWithAnchor(original, original.length);
    const out = reanchor(meta, "corto");
    expect(out[0].pos).toBeLessThanOrEqual(5);
  });
});

describe("serializeMeta", () => {
  it("regenerates fresh context and hash", () => {
    const text = "uno\ndue\ntre";
    const meta = emptyMeta();
    meta.anchors = [{ id: "a1", pos: 4 }]; // start of "due"
    const out = serializeMeta(meta, text);
    expect(out.docHash).toBe(hashText(text));
    expect(out.anchors[0].ctx).toEqual({ before: "uno\n", after: "due\ntre" });
  });

  it("the serialize → re-anchor roundtrip preserves the position", () => {
    const text = "questa è una frase con un punto preciso da ricordare";
    const pos = text.indexOf("punto");
    const meta = emptyMeta();
    meta.anchors = [{ id: "a1", pos }];
    const saved = serializeMeta(meta, text);
    const restored = reanchor(saved, text);
    expect(restored[0].pos).toBe(pos);
    expect(restored[0].broken).toBe(false);
  });
});
