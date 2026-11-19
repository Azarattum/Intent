import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { range, type IntentDocument } from "./frontend.ts";

export async function fileLinks(doc: IntentDocument) {
  if (!doc.uri.startsWith("file:")) return [];
  const candidates = [];
  for (const literal of doc.literals)
    if (!literal.incomplete && !literal.value.includes("\\"))
      candidates.push({
        start: literal.start + 1,
        end: literal.end - 1,
        path: literal.value,
      });
  const pattern =
    /(?<![\w./:@-])(?:\.{1,2}\/|\/)?[.\w@-]+(?:\/[\w@.-]+)*\.[a-zA-Z][\w-]*(?![\w/])/g;
  for (const match of doc.text.matchAll(pattern)) {
    if (doc.literals.some((l) => match.index >= l.start && match.index < l.end))
      continue;
    candidates.push({
      start: match.index,
      end: match.index + match[0].length,
      path: match[0],
    });
  }
  const results = await Promise.all(
    candidates.map(async (c) => {
      if (!c.path || /[\n\r]/.test(c.path)) return null;
      const target = path.resolve(path.dirname(fileURLToPath(doc.uri)), c.path);
      try {
        if (!(await fs.stat(target)).isFile()) return null;
      } catch {
        return null;
      }
      return {
        range: range(doc.text, c.start, c.end),
        target: pathToFileURL(target).href,
        tooltip: "Open " + c.path,
      };
    }),
  );
  return results.filter((link) => link !== null);
}
