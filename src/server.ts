import { fileLinks } from "./file-links.ts";
import { semanticLegend, semanticTokens } from "./highlighting.ts";
import { fileURLToPath } from "node:url";
import {
  createConnection,
  ProposedFeatures,
  TextDocuments,
  TextDocumentSyncKind,
  type TextDocumentIdentifier,
  type TextEdit,
  ResponseError,
  ErrorCodes,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
  type IntentDocument,
  type Span,
  parse,
  position,
  offset,
  range,
} from "./frontend.ts";
import { format } from "./formatter.ts";
import { completion, occurrenceAt, references, termHints } from "./terms.ts";
import { readWorkspace } from "./workspace.ts";

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
const open = new Map<string, IntentDocument>();
let disk = new Map<string, IntentDocument>();
const roots = new Set<string>();
let scan = 0;

connection.onInitialize((params) => {
  const uris =
    params.workspaceFolders?.map((folder) => folder.uri) ??
    (params.rootUri ? [params.rootUri] : []);
  for (const path of paths(uris)) roots.add(path);

  connection.onInitialized(() => {
    if (params.capabilities.workspace?.workspaceFolders) {
      connection.workspace.onDidChangeWorkspaceFolders(({ added, removed }) => {
        for (const path of paths(removed.map((folder) => folder.uri))) {
          roots.delete(path);
        }
        for (const path of paths(added.map((folder) => folder.uri))) {
          roots.add(path);
        }
        refresh();
      });
    }
    refresh();
  });
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
    serverInfo: { name: "Intent" },
  };
});

documents.onDidChangeContent(({ document }) => {
  const doc = parse(document.getText(), document.uri, document.version);

  open.set(doc.uri, doc);

  connection.sendDiagnostics({
    uri: doc.uri,
    version: doc.version,
    diagnostics: [...doc.diagnostics, ...termHints(doc)],
  });
});
documents.onDidClose(({ document }) => {
  open.delete(document.uri);
  connection.sendDiagnostics({ uri: document.uri, diagnostics: [] });

  refresh();
});
connection.onDidChangeWatchedFiles(refresh);

connection.onCompletion((params, token) => {
  if (token.isCancellationRequested) return [];
  const doc = document(params);
  if (!doc) return [];

  const at = offset(doc.text, params.position),
    items = completion(doc, at, workspace);

  if (!doc.text.slice(doc.text.lastIndexOf("\n", at - 1) + 1, at).trim()) {
    for (const [label, insertText] of Object.entries(snippets)) {
      items.push({ label, kind: 15, insertText, insertTextFormat: 2 });
    }
  }

  if (!doc.literals.some((l) => at > l.start && at <= l.end)) {
    for (const operator of ["->", "~>"]) {
      items.push({
        label: operator,
        kind: 24,
        insertText: operator + " ",
        detail: "Intent flow operator",
      });
    }
  }

  return items;
});

connection.onDocumentLinks((params) => {
  const doc = document(params);
  return doc ? fileLinks(doc) : [];
});

connection.onDefinition((params) => {
  const doc = document(params);
  if (!doc) return [];

  const occurrence = occurrenceAt(doc, offset(doc.text, params.position));

  return occurrence?.candidates.map((term) => location(doc, term)) ?? [];
});

connection.onReferences((params) => {
  const doc = document(params);
  if (!doc) return [];

  return references(doc, occurrenceAt(doc, offset(doc.text, params.position)))
    .filter((o) => params.context.includeDeclaration || !o.declaration)
    .map((ref) => location(doc, ref));
});

connection.onPrepareRename((params) => {
  const doc = document(params);
  if (!doc) return null;

  const occurrence = occurrenceAt(doc, offset(doc.text, params.position));

  return occurrence
    ? {
        range: range(doc.text, occurrence.start, occurrence.end),
        placeholder: occurrence.name,
      }
    : null;
});
connection.onRenameRequest((params) => {
  if (
    !params.newName.trim() ||
    /[\n\r{}()[\]"=:]|->|~>| - /.test(params.newName)
  ) {
    throw new ResponseError(
      ErrorCodes.InvalidParams,
      "Rename requires a plain phrase.",
    );
  }
  const doc = document(params);
  if (!doc) return null;

  const occurrence = occurrenceAt(doc, offset(doc.text, params.position));

  if (!occurrence) {
    throw new ResponseError(
      ErrorCodes.InvalidParams,
      "Choose a phrase to rename.",
    );
  }

  if (
    doc.terms.some(
      (t) =>
        t.name === params.newName &&
        occurrence.candidates.some(
          (c) => c.scope === t.scope && c.name !== t.name,
        ),
    )
  ) {
    throw new ResponseError(
      ErrorCodes.InvalidParams,
      "A different phrase already uses this name in the same scope.",
    );
  }

  const edits = references(doc, occurrence).map((ref) => ({
    range: range(doc.text, ref.start, ref.end),
    newText: params.newName,
  }));

  return workspaceEdit(doc, edits);
});

connection.onDocumentSymbol((params) => {
  const doc = document(params);
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

connection.onWorkspaceSymbol(({ query }) => {
  const search = query.toLowerCase();
  return workspace().flatMap((doc) =>
    doc.terms
      .filter(
        (term) => term.declared && term.name.toLowerCase().includes(search),
      )
      .map((term) => ({
        name: term.name,
        kind: 13,
        location: location(doc, term),
      })),
  );
});
connection.onFoldingRanges((params) => {
  const doc = document(params);
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
  const doc = document(params);
  if (!doc) return [];

  return termHints(doc)
    .filter(
      (d) =>
        offset(doc.text, d.range.start) <= offset(doc.text, params.range.end) &&
        offset(doc.text, d.range.end) >= offset(doc.text, params.range.start),
    )
    .map((d) => ({
      title: `Replace with “${d.data.replacement}”`,
      kind: "quickfix",
      diagnostics: [d],
      edit: workspaceEdit(doc, [
        { range: d.range, newText: d.data.replacement },
      ]),
    }));
});

connection.onDocumentFormatting((params) => {
  const doc = document(params);
  if (!doc) return [];

  const text = format(doc);
  return text === doc.text
    ? []
    : [{ range: range(doc.text, 0, doc.text.length), newText: text }];
});

connection.languages.semanticTokens.on((params) => {
  const doc = document(params);
  return doc ? semanticTokens(doc) : { data: [] };
});

function document({ textDocument }: { textDocument: TextDocumentIdentifier }) {
  return open.get(textDocument.uri) ?? disk.get(textDocument.uri);
}

function workspace() {
  return [...new Map([...disk, ...open]).values()];
}

function paths(uris: string[]) {
  return uris
    .filter((uri) => uri.startsWith("file:"))
    .map((uri) => fileURLToPath(uri));
}

function refresh() {
  const current = ++scan;
  void readWorkspace(roots)
    .then((next) => {
      if (current === scan) disk = next;
    })
    .catch((error) => connection.console.error(String(error)));
}

function location(doc: IntentDocument, span: Span) {
  return { uri: doc.uri, range: range(doc.text, span.start, span.end) };
}

function workspaceEdit(doc: IntentDocument, edits: TextEdit[]) {
  const textDocument = {
    uri: doc.uri,
    version: open.get(doc.uri)?.version ?? null,
  };
  return { documentChanges: edits.length ? [{ textDocument, edits }] : [] };
}

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

documents.listen(connection);
connection.listen();
