import { parse, position, type IntentDocument, type Span } from "./frontend.ts";

export function format(doc: IntentDocument) {
  if (doc.diagnostics.some((d) => d.severity === 1)) return doc.text;

  const spaced = parse(spacedDocument(doc), doc.uri, doc.version);
  const normalized = (value: string) =>
    value
      .replace(/"(?:\\.|[^"\\])*"|\s+/g, (match) =>
        match.startsWith('"') ? match : "",
      )
      .trim();
  const signature = (d: IntentDocument) =>
    JSON.stringify(
      d.nodes.map((n) => [
        normalized(n.raw),
        n.parent,
        n.scope,
        n.bullet,
        n.kind,
      ]),
    );

  if (spaced.diagnostics.length || signature(doc) !== signature(spaced)) {
    return doc.text;
  }

  return indentDocument(spaced).replace(/\n{3,}/g, "\n\n");
}

function spacedDocument(doc: IntentDocument) {
  const gaps = new Map<string, Span & { text: string }>();
  const gap = (at: number, before: boolean, spaces: string) => {
    let start = at,
      end = at;
    if (before) while (start > 0 && /[ \t]/.test(doc.text[start - 1])) start--;
    else while (end < doc.text.length && /[ \t]/.test(doc.text[end])) end++;
    // Indentation and line boundaries belong to the layout pass.
    if (before && (start === 0 || doc.text[start - 1] === "\n")) return;
    if (!before && (end === doc.text.length || /[\r\n]/.test(doc.text[end]))) {
      spaces = "";
    }
    gaps.set(`${start}:${end}`, { start, end, text: spaces });
  };

  for (const node of doc.nodes) {
    const tokens = doc.tokens.filter(
      (t) => t.start >= node.start && t.end <= node.end,
    );
    let selected;
    if (node.kind === "definition") {
      selected = tokens.filter((t) => t.kind === "definition").slice(0, 1);
    } else if (node.kind === "flow") {
      selected = [
        ...tokens.filter((t) => ["sequence", "stream"].includes(t.kind)),
        ...node.stages.flatMap((stage) =>
          tokens
            .filter(
              (t) =>
                t.start >= stage.start &&
                t.end <= stage.end &&
                ["action", "assignment"].includes(t.kind),
            )
            .slice(0, 1),
        ),
      ];
    } else {
      selected = tokens
        .filter((t) => ["assignment", "action"].includes(t.kind))
        .slice(0, 1);
    }
    for (const token of selected) {
      gap(token.start, true, token.kind === "action" ? "" : " ");
      gap(token.end, false, " ");
    }
    if (node.openBrace !== undefined) gap(node.openBrace, true, " ");
    if (node.bullet) {
      const lineStart = doc.text.lastIndexOf("\n", node.start - 1) + 1;
      const marker = doc.text.indexOf("-", lineStart);
      if (marker < node.start) gap(marker + 1, false, " ");
    }
  }

  for (const list of doc.lists) {
    if (
      doc.nodes.some(
        (node) =>
          node.kind === "definition" &&
          node.start <= list.start &&
          list.end <= node.end,
      )
    ) {
      continue;
    }
    gap(list.contentStart, false, "");
    if (list.closed) gap(list.contentEnd, true, "");
    for (const comma of list.commas) {
      gap(comma, true, "");
      gap(comma + 1, false, " ");
    }
  }

  let text = doc.text;
  for (const edit of [...gaps.values()].sort((a, b) => b.start - a.start)) {
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  }

  return text;
}

function indentDocument(doc: IntentDocument) {
  let depth = 0;
  const lines = doc.text.split("\n"),
    out = [];
  const widths = new Map<number, number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i],
      content = line.trimStart(),
      n = doc.nodes.find((n) => n.range.start.line === i);
    if (
      doc.nodes.some(
        (node) => node.range.start.line < i && node.range.end.line >= i,
      )
    ) {
      out.push(line);
      continue;
    }
    if (!content.trim()) {
      out.push("");
      continue;
    }

    const closes = content.startsWith("}");
    if (closes) depth = Math.max(0, depth - 1);
    let level = depth;
    if (n && n.parent !== null) level = (widths.get(n.parent) ?? depth) + 1;
    if (n) widths.set(n.id, level);
    out.push("  ".repeat(level) + content.trimEnd());

    const blocks = doc.nodes.filter(
      (n) => n.kind === "refinement" && n.range.start.line === i,
    );
    depth += blocks.length;
    for (const b of blocks) {
      if (b.blockEnd && position(doc.text, b.blockEnd).line === i) depth--;
    }
  }

  const result = out.join("\n");
  const signature = (d: IntentDocument) =>
    JSON.stringify(
      d.nodes.map((n) => [n.raw, n.parent, n.scope, n.bullet, n.kind]),
    );
  return signature(parse(result, doc.uri, doc.version)) === signature(doc)
    ? result
    : doc.text;
}
