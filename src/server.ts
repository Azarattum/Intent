import { fileLinks } from "./file-links.ts";
import { semanticLegend, semanticTokens } from "./highlighting.ts";
import { fileURLToPath } from "node:url";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  ResponseError,
  ErrorCodes,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  type IntentDocument,
  type TermIndex,
  parse,
  index,
  format,
  position,
  offset,
  range,
  completion,
  occurrenceAt,
  references,
  semanticDiagnostics,
} from "./frontend.ts";
import { readWorkspace } from "./workspace.ts";
function serve() {
  const connection = createConnection(ProposedFeatures.all),
    documents = new TextDocuments(TextDocument),
    cache = new Map<string, IntentDocument>();
  const live = new Map<string, IntentDocument>();
  let roots: string[] = [],
    shutdown = false,
    revision = 0,
    folderChanges = false;
  async function refresh() {
    const current = ++revision;
    const workspace = await readWorkspace(roots);
    if (current !== revision) return;
    cache.clear();
    for (const doc of workspace) cache.set(doc.uri, doc);
  }
  function publish(document: TextDocument) {
    const doc = parse(document.getText(), document.uri, document.version);
    live.set(doc.uri, doc);
    connection.sendDiagnostics({
      uri: doc.uri,
      version: doc.version,
      diagnostics: [
        ...doc.diagnostics,
        ...semanticDiagnostics(doc, index([doc])),
      ],
    });
  }
  function openDocuments(): IntentDocument[] {
    return documents
      .all()
      .map(
        (document) =>
          live.get(document.uri) ??
          parse(document.getText(), document.uri, document.version),
      );
  }
  function workspaceDocuments(): IntentDocument[] {
    const merged = new Map(cache);
    for (const doc of openDocuments()) merged.set(doc.uri, doc);
    return [...merged.values()];
  }
  function state(uri: string) {
    const doc = live.get(uri) ?? cache.get(uri);
    return { doc, idx: index(doc ? [doc] : []) };
  }
  const location = (
    t: { uri: string; start: number; end: number },
    idx: TermIndex,
  ) => ({
    uri: t.uri,
    range: range(
      idx.documents.find((d) => d.uri === t.uri)!.text,
      t.start,
      t.end,
    ),
  });
  connection.onInitialize((params) => {
    folderChanges = !!params.capabilities?.workspace?.workspaceFolders;
    roots = (
      params.workspaceFolders?.map((folder) => folder.uri) ??
      (params.rootUri ? [params.rootUri] : [])
    )
      .filter((uri) => uri.startsWith("file:"))
      .map((uri) => fileURLToPath(uri));
    return {
      capabilities: {
        positionEncoding: "utf-16",
        textDocumentSync: {
          openClose: true,
          change: TextDocumentSyncKind.Incremental,
          save: { includeText: false },
        },
        completionProvider: { triggerCharacters: [" ", ":", ">", "("] },
        documentLinkProvider: { resolveProvider: false },
        definitionProvider: true,
        referencesProvider: true,
        renameProvider: { prepareProvider: true },
        documentSymbolProvider: true,
        workspaceSymbolProvider: true,
        documentFormattingProvider: true,
        codeActionProvider: { codeActionKinds: ["quickfix"] },
        foldingRangeProvider: true,
        semanticTokensProvider: { legend: semanticLegend, full: true },
        workspace: {
          workspaceFolders: { supported: true, changeNotifications: true },
        },
      },
      serverInfo: { name: "Intent", version: "2.0.0" },
    };
  });
  connection.onInitialized(() => {
    if (folderChanges)
      connection.workspace.onDidChangeWorkspaceFolders((event) => {
        const removed = new Set(
          event.removed
            .filter((f) => f.uri.startsWith("file:"))
            .map((f) => fileURLToPath(f.uri)),
        );
        roots = roots.filter((root) => !removed.has(root));
        roots.push(
          ...event.added
            .filter((f) => f.uri.startsWith("file:"))
            .map((f) => fileURLToPath(f.uri)),
        );
        refresh().catch((e) => connection.console.error(e.message));
      });
    refresh().catch((e) => connection.console.error(e.message));
  });
  connection.onShutdown(() => {
    shutdown = true;
  });
  connection.onExit(() => process.exit(shutdown ? 0 : 1));
  documents.onDidChangeContent(({ document }) => publish(document));
  documents.onDidClose(({ document }) => {
    live.delete(document.uri);
    connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });
    refresh().catch((e) => connection.console.error(e.message));
  });
  connection.onDidChangeWatchedFiles(() => {
    refresh().catch((e) => connection.console.error(e.message));
  });
  connection.onCompletion((params, token) => {
    if (token.isCancellationRequested) return [];
    const { doc, idx } = state(params.textDocument.uri);
    if (!doc) return [];
    const at = offset(doc.text, params.position),
      items = completion(idx, doc, at, workspaceDocuments());
    const snippets = {
      definition: "${1:term} - ${2:description}",
      assignment: "${1:term} = ${2:value}",
      action: "${1:term}: ${2:behavior}",
      refinement: "${1:term} {\n  $0\n}",
      clarification: "${1:term} (${2:clarification})",
      stream: "${1:source} ~> ${2:destination}",
      sequence: "${1:source} -> ${2:destination}",
      "nested options": "${1:action}:\n  - ${2:option}\n    - $0",
    };
    if (!doc.text.slice(doc.text.lastIndexOf("\n", at - 1) + 1, at).trim())
      for (const [label, insertText] of Object.entries(snippets))
        items.push({ label, kind: 15, insertText, insertTextFormat: 2 });
    if (!doc.literals.some((l) => at > l.start && at <= l.end))
      for (const operator of ["->", "~>"])
        items.push({
          label: operator,
          kind: 24,
          insertText: operator + " ",
          detail: "Intent flow operator",
        });
    return items;
  });
  connection.onDocumentLinks((params) => {
    const { doc } = state(params.textDocument.uri);
    return doc ? fileLinks(doc) : [];
  });
  connection.onDefinition((params) => {
    const { doc, idx } = state(params.textDocument.uri);
    if (!doc) return [];
    const o = occurrenceAt(idx, doc.uri, offset(doc.text, params.position));
    return o?.candidates.map((t) => location(t, idx)) ?? [];
  });
  connection.onReferences((params) => {
    const { doc, idx } = state(params.textDocument.uri);
    if (!doc) return [];
    return references(
      idx,
      occurrenceAt(idx, doc.uri, offset(doc.text, params.position)),
    )
      .filter((o) => params.context.includeDeclaration || !o.declaration)
      .map((o) => location(o, idx));
  });
  connection.onPrepareRename((params) => {
    const { doc, idx } = state(params.textDocument.uri);
    if (!doc) return null;
    const o = occurrenceAt(idx, doc.uri, offset(doc.text, params.position));
    return o && !o.ambiguous
      ? { range: range(doc.text, o.start, o.end), placeholder: o.name }
      : null;
  });
  connection.onRenameRequest((params) => {
    if (
      !params.newName.trim() ||
      /[\n\r{}()[\]"=:]|->|~>| - /.test(params.newName)
    )
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        "Rename requires a plain phrase.",
      );
    const { doc, idx } = state(params.textDocument.uri);
    if (!doc) return null;
    const o = occurrenceAt(idx, doc.uri, offset(doc.text, params.position));
    if (!o || o.ambiguous)
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        "Choose an unambiguous phrase.",
      );
    if (
      idx.terms.some(
        (t) =>
          t.name === params.newName &&
          o.candidates.some(
            (c) => c.uri === t.uri && c.scope === t.scope && c.name !== t.name,
          ),
      )
    )
      throw new ResponseError(
        ErrorCodes.InvalidParams,
        "A different phrase already uses this name in the same scope.",
      );
    const refs = references(idx, o),
      edits = new Map();
    for (const ref of refs) {
      const d = idx.documents.find((document) => document.uri === ref.uri)!;
      const group = edits.get(ref.uri) ?? {
        textDocument: {
          uri: ref.uri,
          version: documents.get(ref.uri)?.version ?? null,
        },
        edits: [],
      };
      group.edits.push({
        range: range(d.text, ref.start, ref.end),
        newText: params.newName,
      });
      edits.set(ref.uri, group);
    }
    return { documentChanges: [...edits.values()] };
  });
  connection.onDocumentSymbol((params) => {
    const { doc } = state(params.textDocument.uri);
    return (
      doc?.terms
        .filter((t) => t.declared)
        .map((t) => {
          const n = doc.nodes[t.node];
          return {
            name: t.name,
            kind: n.kind === "refinement" ? 5 : 13,
            range: range(doc.text, n.start, n.blockEnd ?? n.end),
            selectionRange: range(doc.text, t.start, t.end),
          };
        }) ?? []
    );
  });
  connection.onWorkspaceSymbol((params) => {
    const idx = index(workspaceDocuments());
    return idx.terms
      .filter(
        (t) =>
          t.declared &&
          t.name.toLowerCase().includes(params.query.toLowerCase()),
      )
      .map((t) => ({ name: t.name, kind: 13, location: location(t, idx) }));
  });
  connection.onFoldingRanges((params) => {
    const { doc } = state(params.textDocument.uri);
    if (!doc) return [];
    return doc.nodes.flatMap((n) => {
      const children = doc.nodes.filter((c) => {
        let p = c.parent;
        while (p !== null) {
          if (p === n.id) return true;
          p = doc.nodes[p]?.parent ?? null;
        }
        return false;
      });
      const end = n.blockEnd
        ? position(doc.text, n.blockEnd).line
        : children.at(-1)?.range.end.line;
      return end !== undefined && end > n.range.start.line
        ? [{ startLine: n.range.start.line, endLine: end, kind: "region" }]
        : [];
    });
  });
  connection.onCodeAction((params) => {
    const { doc, idx } = state(params.textDocument.uri);
    if (!doc) return [];
    return semanticDiagnostics(doc, idx)
      .filter(
        (d) =>
          d.code === "possible-typo" &&
          d.data?.replacement &&
          offset(doc.text, d.range.start) <=
            offset(doc.text, params.range.end) &&
          offset(doc.text, d.range.end) >= offset(doc.text, params.range.start),
      )
      .map((d) => ({
        title: `Replace with “${d.data.replacement}”`,
        kind: "quickfix",
        diagnostics: [d],
        edit: {
          documentChanges: [
            {
              textDocument: {
                uri: doc.uri,
                version: documents.get(doc.uri)?.version ?? null,
              },
              edits: [{ range: d.range, newText: d.data.replacement }],
            },
          ],
        },
      }));
  });
  connection.onDocumentFormatting((params) => {
    const { doc } = state(params.textDocument.uri);
    if (!doc) return [];
    const text = format(doc);
    return text === doc.text
      ? []
      : [{ range: range(doc.text, 0, doc.text.length), newText: text }];
  });
  connection.languages.semanticTokens.on((params) => {
    const { doc, idx } = state(params.textDocument.uri);
    return doc ? semanticTokens(doc, idx) : { data: [] };
  });
  documents.listen(connection);
  connection.listen();
  return connection;
}

serve();
