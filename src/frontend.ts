/** Lossless frontend. Offsets are JavaScript UTF-16 code units, as used by LSP. */
import type {
  CompletionItem,
  Diagnostic,
  Position,
  Range,
} from "vscode-languageserver";

export interface Span {
  start: number;
  end: number;
}
export interface Term extends Span {
  name: string;
  scope: number | null;
  node: number;
  uri: string;
  declared: boolean;
  origin?: "list";
}
interface Group extends Span {
  contentStart: number;
  contentEnd: number;
  closed: boolean;
}
interface List extends Group {
  commas: number[];
  items: Span[];
}
interface Delimiter {
  ch: string;
  start: number;
  commas: number[];
}
type Separator =
  | "definition"
  | "assignment"
  | "action"
  | "sequence"
  | "stream"
  | "open-clarification"
  | "open-list";
interface Token extends Span {
  kind: Separator;
  depth: number;
}
interface Node extends Span {
  id: number;
  range: Range;
  raw: string;
  indent: number;
  bullet: boolean;
  scope: number | null;
  parent: number | null;
  kind: Separator | "refinement" | "phrase" | "flow";
  stages: Span[];
  term?: Term;
  openBrace?: number;
  blockEnd?: number;
}
export interface IntentDocument {
  text: string;
  uri: string;
  version: number;
  nodes: Node[];
  terms: Term[];
  diagnostics: Diagnostic[];
  literals: (Span & { value: string; incomplete?: boolean })[];
  tokens: Token[];
  lists: List[];
  clarifications: Group[];
}
interface Occurrence extends Span {
  uri: string;
  name: string;
  candidates: Term[];
  ambiguous: boolean;
  declaration: boolean;
}
export interface TermIndex {
  documents: IntentDocument[];
  terms: Term[];
  occurrences: Occurrence[];
}

export function position(text: string, offset: number): Position {
  const prefix = text.slice(0, offset),
    line = (prefix.match(/\n/g) || []).length;
  return { line, character: offset - (prefix.lastIndexOf("\n") + 1) };
}
export function offset(text: string, pos: Position): number {
  const lines = text.split("\n");
  return (
    lines.slice(0, pos.line).reduce((n, l) => n + l.length + 1, 0) +
    Math.min(pos.character, lines[pos.line]?.length || 0)
  );
}
export const range = (text: string, start: number, end: number): Range => ({
  start: position(text, start),
  end: position(text, end),
});
const word = (c: string | undefined) => c && /[\p{L}\p{N}_.]/u.test(c);
export function parse(
  text: string,
  uri = "memory:document",
  version = 0,
): IntentDocument {
  const doc: IntentDocument = {
    text,
    uri,
    version,
    nodes: [],
    terms: [],
    diagnostics: [],
    literals: [],
    tokens: [],
    lists: [],
    clarifications: [],
  };
  const blocks: Node[] = [],
    indentation: Node[] = [],
    delimiters: Delimiter[] = [];
  let base = 0;
  let continued: number | null = null;
  const diagnostic = (
    code: string,
    start: number,
    end: number,
    message: string,
  ) =>
    doc.diagnostics.push({
      code,
      source: "intent-structure",
      severity: 1,
      range: range(text, start, end),
      message,
    });
  const trimSpan = (a: number, b: number): [number, number] => {
    while (/\s/.test(text[a] || "") && a < b) a++;
    while (/\s/.test(text[b - 1] || "") && b > a) b--;
    return [a, b];
  };
  function recordGroup(group: Delimiter, end: number, closed: boolean) {
    const contentEnd = closed ? end - 1 : end;
    const result = {
      start: group.start,
      end,
      contentStart: group.start + 1,
      contentEnd,
      closed,
    };
    if (group.ch === "[") {
      const points = [group.start, ...group.commas, contentEnd];
      const items = points.slice(0, -1).map((point, i) => {
        const [start, end] = trimSpan(point + 1, points[i + 1]);
        return { start, end };
      });
      doc.lists.push({ ...result, commas: group.commas, items });
    } else doc.clarifications.push(result);
  }
  function statement(
    a: number,
    b: number,
    indent: number,
    bullet: boolean,
  ): Node | null {
    [a, b] = trimSpan(a, b);
    if (a === b) return null;
    const scope = blocks.at(-1)?.id ?? null;
    const n: Node = {
      id: doc.nodes.length,
      start: a,
      end: b,
      range: range(text, a, b),
      raw: text.slice(a, b),
      indent,
      bullet,
      scope,
      parent: null,
      kind: "phrase",
      stages: [],
    };
    while (indentation.length && indentation.at(-1)!.indent >= indent)
      indentation.pop();
    n.parent = indentation.at(-1)?.id ?? scope;
    if (bullet && n.parent === null)
      diagnostic("orphan-bullet", a - 2, a, "Bullet has no preceding parent.");
    const tokens = doc.tokens.filter(
      (t) => t.start >= a && t.end <= b && t.depth === 0,
    );
    const separator = tokens.find((t) =>
      ["definition", "assignment", "action"].includes(t.kind),
    );
    // A definition's entire RHS is prose, even if it contains arrows.
    const flow =
      separator?.kind === "definition"
        ? []
        : tokens.filter((t) => t.kind === "sequence" || t.kind === "stream");
    if (flow.length) {
      n.kind = "flow";
      let start = a;
      for (const t of [...flow, { start: b, end: b }]) {
        const [s, e] = trimSpan(start, t.start);
        if (s === e)
          diagnostic(
            "dangling-arrow",
            Math.max(a, start - 2),
            Math.max(start, t.end),
            "Flow requires a stage on each side.",
          );
        else n.stages.push({ start: s, end: e });
        start = t.end;
      }
    } else if (separator) n.kind = separator.kind;
    const firstSpecial = tokens.find((t) =>
      ["definition", "assignment", "action", "open-clarification"].includes(
        t.kind,
      ),
    );
    let termEnd = firstSpecial?.start ?? b;
    if (flow.length) termEnd = Math.min(termEnd, flow[0].start);
    const [ts, te] = trimSpan(a, termEnd);
    if (
      te > ts &&
      !text.slice(ts, te).startsWith('"') &&
      !text.slice(ts, te).startsWith("[")
    ) {
      const term = {
        name: text.slice(ts, te),
        start: ts,
        end: te,
        scope,
        node: n.id,
        uri,
        declared: ["definition", "assignment", "refinement"].includes(n.kind),
      };
      n.term = term;
      doc.terms.push(term);
    }
    // Each flow stage contributes an inferred phrase, including destinations.
    for (const stage of n.stages.slice(1)) {
      const stop = doc.tokens.find(
        (t) =>
          t.start >= stage.start &&
          t.end <= stage.end &&
          ["action", "assignment", "open-clarification"].includes(t.kind),
      );
      const [s, e] = trimSpan(stage.start, stop?.start ?? stage.end);
      if (
        e > s &&
        !text.slice(s, e).startsWith('"') &&
        !text.slice(s, e).startsWith("[")
      )
        doc.terms.push({
          name: text.slice(s, e),
          start: s,
          end: e,
          scope,
          node: n.id,
          uri,
          declared: false,
        });
    }
    doc.nodes.push(n);
    indentation.push(n);
    return n;
  }
  for (const line of text.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, ""),
      indent = body.match(/^\s*/)![0].replace(/\t/g, "  ").length;
    const first = body.search(/\S/);
    if (first < 0 || /^\s*#(?:\s|$)/.test(body)) {
      base += line.length;
      continue;
    }
    let segment = base + first,
      bullet = /^-\s/.test(body.slice(first));
    if (bullet) segment += 2;
    const currentIndent = indent;
    let quote = false,
      quoteStart = 0,
      escaped = false;
    for (let i = first; i < body.length; i++) {
      const ch = body[i],
        at = base + i;
      if (quote) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === '"') {
          quote = false;
          doc.literals.push({
            start: quoteStart,
            end: at + 1,
            value: text.slice(quoteStart + 1, at),
          });
        }
        continue;
      }
      if (ch === '"') {
        quote = true;
        quoteStart = at;
        continue;
      }
      const top = delimiters.at(-1),
        depth = delimiters.length;
      if (ch === "(" || ch === "[") {
        if (!depth)
          doc.tokens.push({
            kind: ch === "(" ? "open-clarification" : "open-list",
            start: at,
            end: at + 1,
            depth,
          });
        delimiters.push({ ch, start: at, commas: [] });
        continue;
      }
      if (ch === ")" || ch === "]") {
        if (!top || top.ch !== (ch === ")" ? "(" : "["))
          diagnostic("mismatched-delimiter", at, at + 1, `Unexpected ${ch}.`);
        else {
          delimiters.pop();
          recordGroup(top, at + 1, true);
          if (ch === "]") {
            const points = [top.start, ...top.commas, at];
            if (
              top.commas.length &&
              points
                .slice(0, -1)
                .some((p, i) => !text.slice(p + 1, points[i + 1]).trim())
            )
              diagnostic(
                "malformed-list",
                top.start,
                at + 1,
                "List contains an empty value.",
              );
          }
        }
        continue;
      }
      if (ch === "," && top?.ch === "[") top.commas.push(at);
      if (depth) continue;
      if (ch === "{") {
        const n = statement(segment, at, currentIndent, bullet);
        if (n) {
          n.kind = "refinement";
          if (n.term) n.term.declared = true;
          n.openBrace = at;
          blocks.push(n);
        } else
          diagnostic(
            "mismatched-delimiter",
            at,
            at + 1,
            "Refinement needs a phrase.",
          );
        segment = at + 1;
        bullet = false;
        continue;
      }
      if (ch === "}") {
        statement(segment, at, currentIndent, bullet);
        const block = blocks.pop();
        if (!block)
          diagnostic(
            "mismatched-delimiter",
            at,
            at + 1,
            "Unexpected closing brace.",
          );
        else {
          block.blockEnd = at + 1;
          while (indentation.length && indentation.at(-1)!.start >= block.start)
            indentation.pop();
        }
        segment = at + 1;
        bullet = false;
        continue;
      }
      let kind: Separator | undefined;
      let width = 1;
      if (body.slice(i, i + 2) === "->" || body.slice(i, i + 2) === "~>") {
        kind = ch === "~" ? "stream" : "sequence";
        width = 2;
      } else if (
        ch === "-" &&
        /\s/.test(body[i - 1] || "") &&
        /\s/.test(body[i + 1] || "") &&
        at >= segment
      )
        kind = "definition";
      else if (ch === "=") kind = "assignment";
      else if (ch === ":") kind = "action";
      if (kind) {
        doc.tokens.push({ kind, start: at, end: at + width, depth });
        i += width - 1;
      }
    }
    if (quote) {
      diagnostic(
        "unclosed-quote",
        quoteStart,
        base + body.length,
        "Unclosed single-line quoted literal.",
      );
      doc.literals.push({
        start: quoteStart,
        end: base + body.length,
        value: text.slice(quoteStart + 1, base + body.length),
        incomplete: true,
      });
    }
    // Retain valid multiline groups, but recover at the next unindented declaration.
    if (continued !== null) segment = continued;
    if (delimiters.length) continued = segment;
    else {
      statement(segment, base + body.length, currentIndent, bullet);
      continued = null;
    }
    base += line.length;
    if (delimiters.length) {
      const next = text.slice(base).split(/\r?\n/, 1)[0];
      if (/^\s*\S.*(?:\s[-=]\s|\s\{|:)/.test(next)) {
        for (const d of delimiters) {
          diagnostic(
            "mismatched-delimiter",
            d.start,
            d.start + 1,
            `Unclosed ${d.ch}.`,
          );
          recordGroup(d, base - line.length + body.length, false);
        }
        delimiters.length = 0;
        statement(
          segment,
          base - line.length + body.length,
          currentIndent,
          bullet,
        );
        continued = null;
      }
    }
  }
  for (const d of delimiters) {
    diagnostic(
      "mismatched-delimiter",
      d.start,
      d.start + 1,
      `Unclosed ${d.ch}.`,
    );
    recordGroup(d, text.length, false);
  }
  if (continued !== null) statement(continued, text.length, 0, false);
  for (const b of blocks)
    diagnostic(
      "mismatched-delimiter",
      b.openBrace!,
      b.openBrace! + 1,
      "Unclosed refinement brace.",
    );
  // List values are term positions, not arbitrary prose. Keep their complete
  // phrases (including multiword names) available for resolution and completion.
  for (const list of doc.lists) {
    const node = doc.nodes.find(
      (n) => n.start <= list.start && n.end >= list.end,
    );
    if (
      !node ||
      node.kind === "definition" ||
      doc.clarifications.some((c) => c.start < list.start && c.end >= list.end)
    )
      continue;
    for (const item of list.items) {
      const clarification = doc.clarifications.find(
        (c) => c.start >= item.start && c.end <= item.end,
      );
      const [start, end] = trimSpan(
        item.start,
        clarification?.start ?? item.end,
      );
      const name = text.slice(start, end);
      if (!/^[\p{L}_][\p{L}\p{N}_ ./'’+-]*$/u.test(name)) continue;
      doc.terms.push({
        name,
        start,
        end,
        scope: node.scope,
        node: node.id,
        uri,
        declared: false,
        origin: "list",
      });
    }
  }
  return doc;
}
function ancestors(doc: IntentDocument, scope: number | null) {
  const result = [];
  while (scope !== null && scope !== undefined) {
    result.push(scope);
    scope = doc.nodes[scope]?.scope;
  }
  return result;
}
function bindingsInScope(
  terms: Term[],
  doc: IntentDocument,
  scope: number | null,
) {
  const chain = ancestors(doc, scope);
  const groups = new Map<string, Term[]>();
  for (const term of terms) {
    if (
      term.uri !== doc.uri ||
      (term.scope !== null && !chain.includes(term.scope))
    )
      continue;
    const group = groups.get(term.name) ?? [];
    group.push(term);
    groups.set(term.name, group);
  }
  for (const [name, group] of groups) {
    // An inferred flow occurrence resolves to an explicit visible definition.
    // A definition in an unrelated scope must not suppress local inference.
    const declared = group.filter((t) => t.declared);
    const candidates = declared.length ? declared : group;
    const rank = (t: Term) =>
      t.scope === null ? chain.length : chain.indexOf(t.scope);
    const nearest = Math.min(...candidates.map(rank));
    groups.set(
      name,
      candidates.filter((t) => rank(t) === nearest),
    );
  }
  return groups;
}
function scopeAt(doc: IntentDocument, at: number) {
  const block = doc.nodes
    .filter(
      (n) =>
        n.kind === "refinement" &&
        n.openBrace !== undefined &&
        n.openBrace < at &&
        (n.blockEnd === undefined || at < n.blockEnd),
    )
    .at(-1);
  return block?.id ?? null;
}
export function index(documents: Iterable<IntentDocument>): TermIndex {
  const docs = [...documents],
    all = docs.flatMap((d) => d.terms);
  const occurrences: Occurrence[] = [];
  for (const doc of docs) {
    for (const n of doc.nodes) {
      const bindings = bindingsInScope(all, doc, n.scope);
      const names = [...bindings.keys()].sort((a, b) => b.length - a.length);
      for (let at = n.start; at < n.end; ) {
        const literal = doc.literals.find((l) => at >= l.start && at < l.end);
        if (literal) {
          at = literal.end;
          continue;
        }
        const name = names.find(
          (name) =>
            doc.text.startsWith(name, at) &&
            !word(doc.text[at - 1]) &&
            !word(doc.text[at + name.length]),
        );
        if (!name) {
          at++;
          continue;
        }
        const own = doc.terms.find((t) => t.start === at && t.name === name);
        const candidates = bindings.get(name)!;
        const keys = new Set(
          candidates.map((t) => `${t.uri}#${t.scope}#${t.name}`),
        );
        occurrences.push({
          uri: doc.uri,
          start: at,
          end: at + name.length,
          name,
          candidates,
          ambiguous: keys.size > 1,
          declaration: !!own?.declared,
        });
        at += name.length;
      }
    }
  }
  return { documents: docs, terms: all, occurrences };
}
export function occurrenceAt(idx: TermIndex, uri: string, at: number) {
  return idx.occurrences.find(
    (o) => o.uri === uri && o.start <= at && at < o.end,
  );
}
export function references(idx: TermIndex, occurrence: Occurrence | undefined) {
  if (!occurrence || occurrence.ambiguous) return [];
  const keys = new Set(
    occurrence.candidates.map((t) => `${t.uri}#${t.scope}#${t.name}`),
  );
  return idx.occurrences.filter(
    (o) =>
      !o.ambiguous &&
      o.candidates.some((t) => keys.has(`${t.uri}#${t.scope}#${t.name}`)),
  );
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
    if (!before && (end === doc.text.length || /[\r\n]/.test(doc.text[end])))
      spaces = "";
    gaps.set(`${start}:${end}`, { start, end, text: spaces });
  };
  for (const node of doc.nodes) {
    const tokens = doc.tokens.filter(
      (t) => t.start >= node.start && t.end <= node.end && t.depth === 0,
    );
    let selected;
    if (node.kind === "definition")
      selected = tokens.filter((t) => t.kind === "definition").slice(0, 1);
    else if (node.kind === "flow")
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
    else
      selected = tokens
        .filter((t) => ["assignment", "action"].includes(t.kind))
        .slice(0, 1);
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
    )
      continue;
    gap(list.contentStart, false, "");
    if (list.closed) gap(list.contentEnd, true, "");
    for (const comma of list.commas) {
      gap(comma, true, "");
      gap(comma + 1, false, " ");
    }
  }
  let text = doc.text;
  for (const edit of [...gaps.values()].sort((a, b) => b.start - a.start))
    text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
export function format(doc: IntentDocument) {
  if (doc.diagnostics.some((d) => d.severity === 1)) return doc.text;
  const spaced = parse(spacedDocument(doc), doc.uri, doc.version);
  // Compare structure and spelling, ignoring only whitespace outside exact literals.
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
  if (spaced.diagnostics.length || signature(doc) !== signature(spaced))
    return doc.text;
  return indentDocument(spaced).replace(/\n{3,}/g, "\n\n");
}
function indentDocument(doc: IntentDocument) {
  // Invalid regions are never rewritten. Valid layout keeps every parent relation.
  if (doc.diagnostics.some((d) => d.severity === 1)) return doc.text;
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
    if (n && n.parent !== null) {
      const p = doc.nodes[n.parent];
      level = (widths.get(p.id) ?? depth) + 1;
    }
    if (n) widths.set(n.id, level);
    out.push("  ".repeat(level) + content.trimEnd());
    // Braces in quoted literals and clarifications do not affect depth.
    const blocks = doc.nodes.filter(
      (n) => n.kind === "refinement" && n.range.start.line === i,
    );
    depth += blocks.length;
    for (const b of blocks)
      if (b.blockEnd && position(doc.text, b.blockEnd).line === i) depth--;
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
export function completion(
  idx: TermIndex,
  doc: IntentDocument,
  at: number,
  workspace: IntentDocument[] = idx.documents,
): CompletionItem[] {
  const lineStart = doc.text.lastIndexOf("\n", at - 1) + 1,
    prefix = doc.text.slice(lineStart, at);
  const literal = doc.literals.find(
    (l) => at > l.start && (at < l.end || (l.incomplete && at === l.end)),
  );
  if (literal) {
    const prefix = doc.text.slice(literal.start + 1, at);
    return [
      ...new Set(
        workspace.flatMap((d) =>
          d.literals.filter((l) => !l.incomplete).map((l) => l.value),
        ),
      ),
    ]
      .filter(
        (value) =>
          !value.endsWith(".intent") &&
          value.toLowerCase().startsWith(prefix.toLowerCase()),
      )
      .map((value) => ({
        label: value,
        kind: 12,
        detail: "Cached literal (local workspace)",
        textEdit: {
          range: range(
            doc.text,
            literal.start + 1,
            literal.incomplete ? literal.end : literal.end - 1,
          ),
          newText: value,
        },
      }));
  }
  const names = [...bindingsInScope(idx.terms, doc, scopeAt(doc, at)).keys()];
  const emptyBullet = /^\s*-\s*$/.test(prefix);
  return names.flatMap((name) => {
    let length = 0;
    for (let n = 1; n <= Math.min(prefix.length, name.length); n++)
      if (
        name.toLowerCase().startsWith(prefix.slice(-n).toLowerCase()) &&
        !word(doc.text[at - n - 1])
      )
        length = n;
    if (!length && prefix.trim() && !emptyBullet) return [];
    return [
      {
        label: name,
        kind: 6,
        textEdit: {
          range: range(doc.text, at - length, at),
          newText: (emptyBullet && prefix.endsWith("-") ? " " : "") + name,
        },
        detail: "Intent phrase",
      },
    ];
  });
}
export function semanticDiagnostics(
  doc: IntentDocument,
  idx: TermIndex,
): Diagnostic[] {
  const result: Diagnostic[] = [];
  for (const o of idx.occurrences.filter(
    (o) => o.uri === doc.uri && o.ambiguous,
  ))
    result.push({
      source: "intent-terms",
      code: "ambiguous-reference",
      severity: 4,
      range: range(doc.text, o.start, o.end),
      message: `Ambiguous phrase “${o.name}”; choose a definition.`,
      relatedInformation: o.candidates.map((t) => ({
        location: {
          uri: t.uri,
          range: range(
            idx.documents.find((d) => d.uri === t.uri)!.text,
            t.start,
            t.end,
          ),
        },
        message: "Candidate",
      })),
    });
  function distance(a: string, b: string) {
    const row = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const old = row[j];
        row[j] = Math.min(
          row[j] + 1,
          row[j - 1] + 1,
          prev + (a[i - 1] === b[j - 1] ? 0 : 1),
        );
        prev = old;
      }
    }
    return row[b.length];
  }
  for (const t of doc.terms.filter((t) => !t.declared)) {
    const visible = [
      ...bindingsInScope(idx.terms, doc, t.scope).values(),
    ].flat();
    if (visible.some((k) => k.declared && k.name === t.name)) continue;
    const similar = visible.find(
      (k) =>
        k.declared &&
        k.name !== t.name &&
        t.name.length >= 4 &&
        distance(k.name, t.name) === 1,
    );
    if (similar)
      result.push({
        source: "intent-terms",
        code: "possible-typo",
        severity: 4,
        range: range(doc.text, t.start, t.end),
        message: `Inferred phrase “${t.name}”; did you mean “${similar.name}”?`,
        data: { replacement: similar.name },
      });
  }
  return result;
}
