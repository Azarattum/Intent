import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
function client(t) {
  const child = spawn("node", ["dist/server.cjs", "--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill());
  let input = Buffer.alloc(0),
    next = 0,
    stderr = "";
  const pending = new Map(),
    notifications = [];
  child.stderr.on("data", (c) => (stderr += c));
  child.on("exit", (code) => {
    for (const { reject } of pending.values())
      reject(Error(`LSP exited ${code}: ${stderr}`));
  });
  child.stdout.on("data", (chunk) => {
    input = Buffer.concat([input, chunk]);
    while (true) {
      const boundary = input.indexOf("\r\n\r\n");
      if (boundary < 0) return;
      const length = Number(
        input
          .subarray(0, boundary)
          .toString()
          .match(/Content-Length: (\d+)/i)?.[1],
      );
      assert(Number.isFinite(length), "stdout contains protocol only");
      if (input.length < boundary + 4 + length) return;
      const msg = JSON.parse(
        input.subarray(boundary + 4, boundary + 4 + length).toString(),
      );
      input = input.subarray(boundary + 4 + length);
      if ("id" in msg) {
        const p = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error
          ? p?.reject(Error(JSON.stringify(msg.error)))
          : p?.resolve(msg.result);
      } else notifications.push(msg);
    }
  });
  function send(msg) {
    const b = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...msg }));
    child.stdin.write(`Content-Length: ${b.length}\r\n\r\n`);
    child.stdin.write(b);
  }
  return {
    notifications,
    notify: (method, params) => send({ method, params }),
    request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Error(`Timeout: ${method} ${stderr}`));
        }, 5000);
        pending.set(id, {
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        });
        send({ id, method, params });
      });
    },
  };
}
test("stdio LSP supports incremental editing, semantic features and shutdown", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-lsp-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "main.intent"),
    uri = pathToFileURL(file).href,
    text =
      "received part - heard by user\ncontext: acknowledge received part\n";
  await fs.writeFile(file, text);
  const c = client(t),
    init = await c.request("initialize", {
      rootUri: pathToFileURL(root).href,
      capabilities: { general: { positionEncodings: ["utf-16"] } },
    });
  assert.equal(init.capabilities.positionEncoding, "utf-16");
  assert.deepEqual(init.capabilities.semanticTokensProvider.legend.tokenTypes, [
    "intentTerm",
    "intentActionText",
    "intentClarification",
  ]);
  c.notify("initialized", {});
  c.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "intent", version: 1, text },
  });
  const doc = { uri };
  const defs = await c.request("textDocument/definition", {
    textDocument: doc,
    position: { line: 1, character: 24 },
  });
  assert.equal(defs[0].range.start.line, 0);
  const refs = await c.request("textDocument/references", {
    textDocument: doc,
    position: { line: 0, character: 3 },
    context: { includeDeclaration: true },
  });
  assert.equal(refs.length, 2);
  const rename = await c.request("textDocument/rename", {
    textDocument: doc,
    position: { line: 0, character: 3 },
    newName: "heard segment",
  });
  assert.equal(rename.documentChanges[0].edits.length, 2);
  assert.equal(rename.documentChanges[0].textDocument.version, 1);
  const tokens = await c.request("textDocument/semanticTokens/full", {
    textDocument: doc,
  });
  assert(tokens.data.length >= 10);
  c.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [
      {
        range: {
          start: { line: 1, character: 21 },
          end: { line: 1, character: 34 },
        },
        text: "received pa",
      },
    ],
  });
  const items = await c.request("textDocument/completion", {
    textDocument: doc,
    position: { line: 1, character: 32 },
  });
  assert(items.some((i) => i.label === "received part"));
  const symbols = await c.request("textDocument/documentSymbol", {
    textDocument: doc,
  });
  assert(symbols.some((s) => s.name === "received part"));
  await c.request("shutdown", null);
  c.notify("exit");
});

test("LSP isolates term scopes and completes empty, partial and unfinished bullets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-lsp-scopes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "main.intent")).href;
  const otherUri = pathToFileURL(path.join(root, "other.intent")).href;
  const text =
    "summary - implementation and intent\nworkspace layout {\n  implementation - tooling\n}\nmain loop {\n  intent -> compiler\n  local option - behavior\n  action:\n    - \n}\n";
  const foreign =
    "implementation - foreign\nintent - foreign\nforeign option - external\n";
  await fs.writeFile(path.join(root, "main.intent"), text);
  await fs.writeFile(path.join(root, "other.intent"), foreign);
  const c = client(t);
  await c.request("initialize", {
    rootUri: pathToFileURL(root).href,
    capabilities: {},
  });
  c.notify("initialized", {});
  c.notify("textDocument/didOpen", {
    textDocument: {
      uri: otherUri,
      languageId: "intent",
      version: 1,
      text: foreign,
    },
  });
  c.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "intent", version: 1, text },
  });
  const doc = { uri };
  for (const character of [10, 29])
    assert.deepEqual(
      await c.request("textDocument/definition", {
        textDocument: doc,
        position: { line: 0, character },
      }),
      [],
    );
  const tokens = await c.request("textDocument/semanticTokens/full", {
    textDocument: doc,
  });
  let line = 0;
  const firstLine = [];
  for (let i = 0; i < tokens.data.length; i += 5) {
    line += tokens.data[i];
    if (line === 0) firstLine.push(tokens.data.slice(i, i + 5));
  }
  assert.equal(
    firstLine.length,
    1,
    "summary only; no leaked prose terms or operator overlays",
  );
  const initial = await c.request("textDocument/completion", {
    textDocument: doc,
    position: { line: 8, character: 6 },
  });
  for (const label of ["local option", "intent", "compiler"])
    assert(
      initial.some((i) => i.label === label),
      label,
    );
  for (const label of ["implementation", "foreign option"])
    assert(!initial.some((i) => i.label === label), label);
  assert.deepEqual(
    initial.find((i) => i.label === "local option").textEdit.range,
    { start: { line: 8, character: 6 }, end: { line: 8, character: 6 } },
  );
  c.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [
      {
        range: {
          start: { line: 8, character: 6 },
          end: { line: 8, character: 6 },
        },
        text: "local op",
      },
    ],
  });
  const partial = await c.request("textDocument/completion", {
    textDocument: doc,
    position: { line: 8, character: 14 },
  });
  assert.deepEqual(
    partial.find((i) => i.label === "local option").textEdit.range,
    { start: { line: 8, character: 6 }, end: { line: 8, character: 14 } },
  );
  c.notify("textDocument/didChange", {
    textDocument: { uri, version: 3 },
    contentChanges: [
      {
        range: {
          start: { line: 9, character: 0 },
          end: { line: 9, character: 1 },
        },
        text: "",
      },
    ],
  });
  const unfinished = await c.request("textDocument/completion", {
    textDocument: doc,
    position: { line: 8, character: 14 },
  });
  assert(unfinished.some((i) => i.label === "local option"));
  await c.request("shutdown", null);
  c.notify("exit");
});

test("LSP colors inferred list phrases and prose, then resolves a newly added definition", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-lsp-list-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "main.intent")).href;
  const text =
    "ha - home assistant\neffectors = [write to chat, speak aloud, message telegram, ha]\nha: acknowledge effectors (optional)\n";
  await fs.writeFile(path.join(root, "main.intent"), text);
  const c = client(t),
    init = await c.request("initialize", {
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });
  const legend = init.capabilities.semanticTokensProvider.legend;
  c.notify("initialized", {});
  c.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "intent", version: 1, text },
  });
  const doc = { uri };
  async function decoded(source) {
    const { data } = await c.request("textDocument/semanticTokens/full", {
      textDocument: doc,
    });
    let line = 0,
      character = 0;
    const lines = source.split("\n"),
      result = [];
    for (let i = 0; i < data.length; i += 5) {
      line += data[i];
      character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
      result.push({
        line,
        text: lines[line].slice(character, character + data[i + 2]),
        type: legend.tokenTypes[data[i + 3]],
        inferred: !!(
          data[i + 4] &
          (1 << legend.tokenModifiers.indexOf("inferred"))
        ),
      });
    }
    return result;
  }
  const before = await decoded(text);
  for (const phrase of ["write to chat", "speak aloud", "message telegram"])
    assert(
      before.some((s) => s.text === phrase && s.inferred),
      phrase,
    );
  assert(before.some((s) => s.text === "ha" && s.line === 1 && !s.inferred));
  assert(
    before.some(
      (s) => s.type === "intentActionText" && s.text.includes("acknowledge"),
    ),
  );
  assert(
    before.some(
      (s) => s.type === "intentClarification" && s.text.includes("optional"),
    ),
  );
  const definition = "write to chat - send a message\n";
  c.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [
      {
        range: {
          start: { line: 3, character: 0 },
          end: { line: 3, character: 0 },
        },
        text: definition,
      },
    ],
  });
  const after = await decoded(text + definition);
  assert(
    after.some(
      (s) => s.text === "write to chat" && s.line === 1 && !s.inferred,
    ),
  );
  const locations = await c.request("textDocument/definition", {
    textDocument: doc,
    position: { line: 1, character: 13 },
  });
  assert(locations.some((location) => location.range.start.line === 3));
  await c.request("shutdown", null);
  c.notify("exit");
});

test("LSP formatting and typo quick fixes are separate, version-bound edits", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-lsp-format-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const uri = pathToFileURL(path.join(root, "main.intent")).href;
  const text =
    "context - shared\nloop   {\n      value= [ one ,two ]\n      contex:   reply\n}\n";
  await fs.writeFile(path.join(root, "main.intent"), text);
  const c = client(t);
  await c.request("initialize", {
    rootUri: pathToFileURL(root).href,
    capabilities: {},
  });
  c.notify("initialized", {});
  c.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "intent", version: 1, text },
  });
  const edits = await c.request("textDocument/formatting", {
    textDocument: { uri },
    options: { tabSize: 2, insertSpaces: true },
  });
  assert.equal(
    edits[0].newText,
    "context - shared\nloop {\n  value = [one, two]\n  contex: reply\n}\n",
  );
  const fixes = await c.request("textDocument/codeAction", {
    textDocument: { uri },
    range: {
      start: { line: 3, character: 6 },
      end: { line: 3, character: 12 },
    },
    context: { diagnostics: [] },
  });
  const fix = fixes.find((f) => f.title.includes("context"));
  assert(fix);
  assert.equal(fix.edit.documentChanges[0].textDocument.version, 1);
  assert.equal(fix.edit.documentChanges[0].edits[0].newText, "context");
  await c.request("shutdown", null);
  c.notify("exit");
});

test("file mentions link in constants, prose and clarifications without importing dependencies", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "intent-file-links-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "docs"));
  for (const name of ["grammar.intent", "docs/design.md", "docs/my notes.md"])
    await fs.writeFile(path.join(root, name), "content");
  const uri = pathToFileURL(path.join(root, "main.intent")).href;
  const text =
    'syntax = "grammar.intent"\nreview - read docs/design.md, then grammar.intent (docs/design.md)\nnotes = "docs/my notes.md"\nmissing - missing.txt and v0.4.9 and https://example.com\n';
  await fs.writeFile(path.join(root, "main.intent"), text);
  const c = client(t),
    init = await c.request("initialize", {
      rootUri: pathToFileURL(root).href,
      capabilities: {},
    });
  assert(init.capabilities.documentLinkProvider);
  c.notify("initialized", {});
  c.notify("textDocument/didOpen", {
    textDocument: { uri, languageId: "intent", version: 1, text },
  });
  const links = await c.request("textDocument/documentLink", {
    textDocument: { uri },
  });
  assert.equal(links.length, 5);
  for (const link of links) {
    const line = text.split("\n")[link.range.start.line];
    const mention = line.slice(
      link.range.start.character,
      link.range.end.character,
    );
    assert.equal(link.target, pathToFileURL(path.join(root, mention)).href);
  }
  c.notify("textDocument/didChange", {
    textDocument: { uri, version: 2 },
    contentChanges: [{ text: "updated - docs/design.md\n" }],
  });
  const changed = await c.request("textDocument/documentLink", {
    textDocument: { uri },
  });
  assert.equal(changed.length, 1);
  await fs.unlink(path.join(root, "docs/design.md"));
  assert.deepEqual(
    await c.request("textDocument/documentLink", { textDocument: { uri } }),
    [],
  );
  await c.request("shutdown", null);
  c.notify("exit");
});
