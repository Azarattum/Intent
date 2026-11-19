import * as vscode from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";
import type { DocumentLink } from "vscode-languageclient";
export async function activate(context: vscode.ExtensionContext) {
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.intent");
  const client = new LanguageClient(
    "intent-v2",
    "Intent V2",
    {
      module: context.asAbsolutePath("dist/server.cjs"),
      transport: TransportKind.stdio,
    },
    {
      documentSelector: [
        { scheme: "file", language: "intent" },
        { scheme: "untitled", language: "intent" },
      ],
      synchronize: { fileEvents: watcher },
    },
  );
  context.subscriptions.push(watcher, client);
  await client.start();
  // Document links supply click navigation; decorations keep links underlined at rest.
  const linkStyle = vscode.window.createTextEditorDecorationType({
    textDecoration: "underline",
  });
  context.subscriptions.push(linkStyle);
  const linkRevisions = new WeakMap();
  async function decorateLinks(editor: vscode.TextEditor) {
    if (editor.document.languageId !== "intent") return;
    const document = editor.document,
      version = document.version,
      revision = {};
    linkRevisions.set(editor, revision);
    try {
      const links = await client.sendRequest<DocumentLink[]>(
        "textDocument/documentLink",
        { textDocument: { uri: document.uri.toString() } },
      );
      if (
        linkRevisions.get(editor) !== revision ||
        editor.document !== document ||
        document.version !== version
      )
        return;
      editor.setDecorations(
        linkStyle,
        (links ?? []).map(
          (link) =>
            new vscode.Range(
              link.range.start.line,
              link.range.start.character,
              link.range.end.line,
              link.range.end.character,
            ),
        ),
      );
    } catch (error) {
      client.outputChannel.appendLine("File links: " + String(error));
    }
  }
  const updateLinks = () => {
    for (const editor of vscode.window.visibleTextEditors)
      void decorateLinks(editor);
  };
  let linkTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(updateLinks),
  );
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((event) => {
      if (event.document.languageId === "intent") {
        clearTimeout(linkTimer);
        linkTimer = setTimeout(updateLinks, 150);
      }
    }),
  );
  const linkWatcher = vscode.workspace.createFileSystemWatcher("**/*");
  context.subscriptions.push(
    linkWatcher,
    linkWatcher.onDidCreate(updateLinks),
    linkWatcher.onDidDelete(updateLinks),
    {
      dispose() {
        clearTimeout(linkTimer);
      },
    },
  );
  updateLinks();
}
