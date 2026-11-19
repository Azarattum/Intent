import {
  position,
  type Span,
  type IntentDocument,
  type TermIndex,
} from "./frontend.ts";

export const semanticLegend = {
  tokenTypes: ["intentTerm", "intentActionText", "intentClarification"],
  tokenModifiers: [
    "declaration",
    "definition",
    "binding",
    "action",
    "refinement",
    "inferred",
    "clarification",
  ],
};

export function semanticTokens(doc: IntentDocument, idx: TermIndex) {
  const spans = new Map<
    string,
    Span & { type: number; declaration: boolean; inferred: boolean }
  >();
  const roles = new Map<string, string>(),
    actionText: Span[] = [];
  const roleForKind: Partial<Record<string, string>> = {
    definition: "definition",
    assignment: "binding",
    action: "action",
    refinement: "refinement",
  };
  for (const node of doc.nodes) {
    const role = roleForKind[node.kind];
    if (node.term && role)
      roles.set(`${node.term.start}:${node.term.end}`, role);
    // An action can occur in any flow stage. Its description ends at the arrow.
    const stages =
      node.kind === "flow" ? node.stages : node.kind === "action" ? [node] : [];
    for (const stage of stages) {
      const term = doc.terms.find(
        (t) => t.node === node.id && t.start === stage.start,
      );
      if (!term) continue;
      const separator = doc.tokens.find(
        (t) =>
          t.start >= term.end &&
          t.end <= stage.end &&
          t.depth === 0 &&
          ["action", "assignment"].includes(t.kind),
      );
      if (!separator) continue;
      roles.set(`${term.start}:${term.end}`, roleForKind[separator.kind]!);
      if (separator.kind === "action")
        actionText.push({ start: separator.end, end: stage.end });
    }
  }
  const add = (
    start: number,
    end: number,
    type: number,
    declaration = false,
    inferred = false,
  ) => {
    if (
      end <= start ||
      position(doc.text, start).line !== position(doc.text, end).line
    )
      return;
    const key = `${start}:${end}`,
      previous = spans.get(key);
    spans.set(key, {
      start,
      end,
      type,
      declaration: declaration || !!previous?.declaration,
      inferred,
    });
  };
  for (const occurrence of idx.occurrences) {
    if (occurrence.uri === doc.uri && !occurrence.ambiguous) {
      add(
        occurrence.start,
        occurrence.end,
        0,
        occurrence.declaration,
        !occurrence.candidates.some((t) => t.declared),
      );
    }
  }
  for (const term of doc.terms)
    if (term.declared) add(term.start, term.end, 0, true);

  // Prose colors never cover terms, strings, structural delimiters or numbers.
  // Operators keep their lexical control scopes, with no semantic overlay.
  const protectedSpans: Span[] = [
    ...spans.values(),
    ...doc.literals,
    ...doc.tokens,
  ];
  for (const group of [...doc.lists, ...doc.clarifications]) {
    protectedSpans.push({ start: group.start, end: group.start + 1 });
    if (group.closed)
      protectedSpans.push({ start: group.end - 1, end: group.end });
  }
  for (const list of doc.lists) {
    for (const comma of list.commas)
      protectedSpans.push({ start: comma, end: comma + 1 });
  }
  for (const match of doc.text.matchAll(
    /(?<![\w.])\d+(?:\.\d+)?(?:\s*(?:tokens|ms|s|GB|MB|KB|kHz|Hz|K|B|M|%))?(?!\w)/g,
  )) {
    protectedSpans.push({
      start: match.index,
      end: match.index + match[0].length,
    });
  }
  function paint(region: Span, type: number, exclusions: Span[]) {
    let pieces = [region];
    for (const excluded of exclusions) {
      pieces = pieces.flatMap((piece) => {
        if (excluded.end <= piece.start || excluded.start >= piece.end)
          return [piece];
        const result = [];
        if (excluded.start > piece.start)
          result.push({ start: piece.start, end: excluded.start });
        if (excluded.end < piece.end)
          result.push({ start: excluded.end, end: piece.end });
        return result;
      });
    }
    for (const piece of pieces) {
      // LSP semantic tokens cannot span lines. Whitespace needs no paint.
      for (const match of doc.text
        .slice(piece.start, piece.end)
        .matchAll(/[^\r\n]+/g)) {
        if (match[0].trim())
          add(
            piece.start + match.index,
            piece.start + match.index + match[0].length,
            type,
          );
      }
    }
  }
  const clarifications: Span[] = [];
  for (const group of [...doc.clarifications].sort(
    (a, b) => a.start - b.start,
  )) {
    const last = clarifications.at(-1);
    if (last && group.contentStart <= last.end)
      last.end = Math.max(last.end, group.contentEnd);
    else
      clarifications.push({ start: group.contentStart, end: group.contentEnd });
  }
  for (const region of actionText)
    paint(region, 1, [...protectedSpans, ...doc.clarifications]);
  for (const region of clarifications) paint(region, 2, protectedSpans);

  let previousLine = 0,
    previousCharacter = 0;
  const data = [];
  for (const span of [...spans.values()].sort((a, b) => a.start - b.start)) {
    const p = position(doc.text, span.start),
      role = roles.get(`${span.start}:${span.end}`);
    const modifiers =
      (span.declaration ? 1 : 0) |
      (role ? 1 << semanticLegend.tokenModifiers.indexOf(role) : 0) |
      (span.inferred
        ? 1 << semanticLegend.tokenModifiers.indexOf("inferred")
        : 0) |
      (span.type === 0 &&
      doc.clarifications.some(
        (c) => span.start >= c.contentStart && span.end <= c.contentEnd,
      )
        ? 1 << semanticLegend.tokenModifiers.indexOf("clarification")
        : 0);
    data.push(
      p.line - previousLine,
      p.line === previousLine ? p.character - previousCharacter : p.character,
      span.end - span.start,
      span.type,
      modifiers,
    );
    previousLine = p.line;
    previousCharacter = p.character;
  }
  return { data };
}
