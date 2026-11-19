import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse, type IntentDocument } from "./frontend.ts";

export async function readWorkspace(roots: Iterable<string>) {
  const documents = new Map<string, IntentDocument>();

  for (const root of [...roots]) await visit(root);

  return documents;

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    )) {
      const path = join(directory, entry.name);
      if (entry.isDirectory() && !ignored.has(entry.name)) await visit(path);

      if (!entry.isFile() || !entry.name.endsWith(".intent")) continue;
      const uri = pathToFileURL(path).href;
      if (documents.has(uri)) continue;

      const text = await readFile(path, "utf8").catch(() => undefined);
      if (text !== undefined) documents.set(uri, parse(text, uri));
    }
  }
}

const ignored = new Set([".git", "node_modules", "dist"]);
