// Tests for the relative paths used by links between files.
import { describe, expect, it } from "vitest";
import { dirOf, makeRelative, resolveTarget } from "../src/paths";

describe("makeRelative", () => {
  it("same folder → name only", () => {
    expect(makeRelative("C:\\docs", "C:\\docs\\note.txt")).toBe("note.txt");
  });

  it("subfolder", () => {
    expect(makeRelative("C:\\docs", "C:\\docs\\sub\\note.txt")).toBe(
      "sub\\note.txt",
    );
  });

  it("sibling folder → ..", () => {
    expect(makeRelative("C:\\docs\\a", "C:\\docs\\b\\note.txt")).toBe(
      "..\\b\\note.txt",
    );
  });

  it("different drive → stays absolute", () => {
    expect(makeRelative("C:\\docs", "D:\\altro\\note.txt")).toBe(
      "D:\\altro\\note.txt",
    );
  });

  it("ignores case in the common folders", () => {
    expect(makeRelative("c:\\Docs", "C:\\docs\\note.txt")).toBe("note.txt");
  });
});

describe("resolveTarget", () => {
  it("simple relative", () => {
    expect(resolveTarget("C:\\docs\\a.txt", "note.txt")).toBe(
      "C:\\docs\\note.txt",
    );
  });

  it("relative with ..", () => {
    expect(resolveTarget("C:\\docs\\a\\x.txt", "..\\b\\y.txt")).toBe(
      "C:\\docs\\b\\y.txt",
    );
  });

  it("absolute stays as it is", () => {
    expect(resolveTarget("C:\\docs\\a.txt", "D:\\z\\y.txt")).toBe(
      "D:\\z\\y.txt",
    );
  });

  it("roundtrip: makeRelative → resolveTarget returns the original", () => {
    const source = "C:\\progetti\\filo\\appunti.txt";
    const target = "C:\\progetti\\contratti\\2026\\rossi.txt";
    const rel = makeRelative(dirOf(source), target);
    expect(resolveTarget(source, rel)).toBe(target);
  });
});
