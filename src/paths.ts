// Paths for links between files: the metadata stores the path RELATIVE
// to the document's folder, so moving the whole folder (or the project)
// keeps the links working. If the files live on different drives it
// falls back to the absolute path.
// Pure functions, tested in tests/paths.test.ts.

export function dirOf(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

function isAbsolute(p: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith("\\\\");
}

/** Path of `target` relative to the `fromDir` folder;
 *  absolute if the drives differ. */
export function makeRelative(fromDir: string, target: string): string {
  const a = fromDir.split(/[\\/]+/).filter(Boolean);
  const b = target.split(/[\\/]+/).filter(Boolean);
  if (a.length === 0 || b.length < 2) return target;
  if (a[0].toLowerCase() !== b[0].toLowerCase()) return target; // different drive

  let i = 0;
  while (
    i < a.length &&
    i < b.length - 1 &&
    a[i].toLowerCase() === b[i].toLowerCase()
  ) {
    i += 1;
  }
  const ups = a.length - i;
  return [...Array(ups).fill(".."), ...b.slice(i)].join("\\");
}

/** Resolves the path saved in the metadata against the source document. */
export function resolveTarget(
  sourceDocPath: string | null,
  targetFile: string,
): string {
  if (isAbsolute(targetFile) || !sourceDocPath) return targetFile;
  const parts = (dirOf(sourceDocPath) + "\\" + targetFile).split(/[\\/]+/);
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") out.pop();
    else if (p !== "." && p !== "") out.push(p);
  }
  return out.join("\\");
}
