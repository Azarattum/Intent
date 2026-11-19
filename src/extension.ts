import * as vscode from "vscode";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";
import { DocumentLinkRequest } from "vscode-languageclient";

export async function activate(context: vscode.ExtensionContext) {
  const watcher = vscode.workspace.createFileSystemWatcher("**/*.intent");
  const client = new LanguageClient(
    "intent",
    "Intent",
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

  const style = vscode.window.createTextEditorDecorationType({
    textDecoration: "underline",
  });
  const files = vscode.workspace.createFileSystemWatcher("**/*");
  const requests = new WeakMap<vscode.TextEditor, object>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  context.subscriptions.push(
    style,
    files,
    files.onDidCreate(updateLinks),
    files.onDidDelete(updateLinks),
    vscode.window.onDidChangeVisibleTextEditors(updateLinks),
    vscode.workspace.onDidChangeTextDocument(({ document }) => {
      if (document.languageId !== "intent") return;
      clearTimeout(timer);
      timer = setTimeout(updateLinks, 150);
    }),
    { dispose: () => clearTimeout(timer) },
  );

  updateLinks();

  function updateLinks() {
    for (const editor of vscode.window.visibleTextEditors) {
      void decorate(editor);
    }
  }

  async function decorate(editor: vscode.TextEditor) {
    const { document } = editor;
    if (document.languageId !== "intent") return;

    const { version } = document;
    const request = {};
    requests.set(editor, request);

    try {
      const links = await client.sendRequest(
        DocumentLinkRequest.type,
        client.code2ProtocolConverter.asDocumentLinkParams(document),
      );

      if (
        requests.get(editor) !== request ||
        editor.document !== document ||
        document.version !== version
      ) {
        return;
      }

      editor.setDecorations(
        style,
        (links ?? []).map((link) =>
          client.protocol2CodeConverter.asRange(link.range),
        ),
      );
    } catch (error) {
      client.outputChannel.appendLine("File links: " + String(error));
    }
  }
}
