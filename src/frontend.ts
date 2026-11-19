import type { Diagnostic, Position, Range } from "vscode-languageserver";

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
  const blocks: Refinement[] = [],
    indentation: Node[] = [],
    delimiters: Delimiter[] = [];
  let base = 0;
  let continued: number | null = null;

  for (const line of text.split(/(?<=\n)/)) {
    const body = line.replace(/\r?\n$/, ""),
      first = body.search(/\S/);
    if (first < 0 || /^\s*#(?:\s|$)/.test(body)) {
      base += line.length;
      continue;
    }

    let segment = base + first,
      bullet = /^-\s/.test(body.slice(first));
    if (bullet) segment += 2;
    const indent = body.slice(0, first).replace(/\t/g, "  ").length;

    let quote: { start: number; escaped: boolean } | undefined;

    for (let i = first; i < body.length; i++) {
      const ch = body[i],
        at = base + i;

      if (quote) {
        if (quote.escaped) {
          quote.escaped = false;
          continue;
        }
        if (ch === "\\") {
          quote.escaped = true;
          continue;
        }
        if (ch === '"') {
          doc.literals.push({
            start: quote.start,
            end: at + 1,
            value: text.slice(quote.start + 1, at),
          });
          quote = undefined;
        }
        continue;
      }

      if (ch === '"') {
        quote = { start: at, escaped: false };
        continue;
      }

      const top = delimiters.at(-1);
      if (ch === "(" || ch === "[") {
        if (!top) {
          doc.tokens.push({
            kind: ch === "(" ? "open-clarification" : "open-list",
            start: at,
            end: at + 1,
          });
        }
        delimiters.push({ ch, start: at, commas: [] });
        continue;
      }

      if (ch === ")" || ch === "]") {
        if (!top || top.ch !== (ch === ")" ? "(" : "[")) {
          diagnostic("mismatched-delimiter", at, at + 1, `Unexpected ${ch}.`);
        } else {
          delimiters.pop();
          recordGroup(top, at + 1, true);
          if (ch === "]") {
            const points = [top.start, ...top.commas, at];
            if (
              top.commas.length &&
              points
                .slice(0, -1)
                .some((p, i) => !text.slice(p + 1, points[i + 1]).trim())
            ) {
              diagnostic(
                "malformed-list",
                top.start,
                at + 1,
                "List contains an empty value.",
              );
            }
          }
        }
        continue;
      }

      if (ch === "," && top?.ch === "[") top.commas.push(at);
      if (top) continue;

      if (ch === "{") {
        if (!statement(segment, at, indent, bullet, at)) {
          diagnostic(
            "mismatched-delimiter",
            at,
            at + 1,
            "Refinement needs a phrase.",
          );
        }
        segment = at + 1;
        bullet = false;
        continue;
      }

      if (ch === "}") {
        statement(segment, at, indent, bullet);
        const block = blocks.pop();
        if (!block) {
          diagnostic(
            "mismatched-delimiter",
            at,
            at + 1,
            "Unexpected closing brace.",
          );
        } else {
          block.blockEnd = at + 1;
          while ((indentation.at(-1)?.start ?? -1) >= block.start) {
            indentation.pop();
          }
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
      ) {
        kind = "definition";
      } else if (ch === "=") kind = "assignment";
      else if (ch === ":") kind = "action";
      if (kind) {
        doc.tokens.push({ kind, start: at, end: at + width });
        i += width - 1;
      }
    }

    if (quote) {
      diagnostic(
        "unclosed-quote",
        quote.start,
        base + body.length,
        "Unclosed single-line quoted literal.",
      );
      doc.literals.push({
        start: quote.start,
        end: base + body.length,
        value: text.slice(quote.start + 1, base + body.length),
        incomplete: true,
      });
    }

    // Recover at a declaration so an unclosed group cannot swallow later statements.
    if (continued !== null) segment = continued;
    if (delimiters.length) continued = segment;
    else {
      statement(segment, base + body.length, indent, bullet);
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
        statement(segment, base - line.length + body.length, indent, bullet);
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

  for (const b of blocks) {
    diagnostic(
      "mismatched-delimiter",
      b.openBrace,
      b.openBrace + 1,
      "Unclosed refinement brace.",
    );
  }

  for (const list of doc.lists) {
    const node = doc.nodes.find(
      (n) => n.start <= list.start && n.end >= list.end,
    );
    if (
      !node ||
      node.kind === "definition" ||
      doc.clarifications.some((c) => c.start < list.start && c.end >= list.end)
    ) {
      continue;
    }
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
        declared: false,
        origin: "list",
      });
    }
  }

  return doc;

  function diagnostic(
    code: string,
    start: number,
    end: number,
    message: string,
  ) {
    doc.diagnostics.push({
      code,
      source: "intent-structure",
      severity: 1,
      range: range(text, start, end),
      message,
    });
  }

  function trimSpan(a: number, b: number): [number, number] {
    while (/\s/.test(text[a] || "") && a < b) a++;
    while (/\s/.test(text[b - 1] || "") && b > a) b--;
    return [a, b];
  }

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
    openBrace?: number,
  ) {
    [a, b] = trimSpan(a, b);
    if (a === b) return null;

    const scope = blocks.at(-1)?.id ?? null;
    while ((indentation.at(-1)?.indent ?? -1) >= indent) indentation.pop();
    const parent = indentation.at(-1)?.id ?? scope;
    if (bullet && parent === null) {
      diagnostic("orphan-bullet", a - 2, a, "Bullet has no preceding parent.");
    }

    const tokens = doc.tokens.filter((t) => t.start >= a && t.end <= b);
    const separator = tokens.find((t) =>
      ["definition", "assignment", "action"].includes(t.kind),
    );
    const flow =
      separator?.kind === "definition"
        ? []
        : tokens.filter((t) => t.kind === "sequence" || t.kind === "stream");

    const stages: Span[] = [];
    if (flow.length) {
      let start = a;
      for (const t of [...flow, { start: b, end: b }]) {
        const [s, e] = trimSpan(start, t.start);
        if (s === e) {
          diagnostic(
            "dangling-arrow",
            Math.max(a, start - 2),
            Math.max(start, t.end),
            "Flow requires a stage on each side.",
          );
        } else stages.push({ start: s, end: e });
        start = t.end;
      }
    }

    const common = {
      id: doc.nodes.length,
      start: a,
      end: b,
      range: range(text, a, b),
      raw: text.slice(a, b),
      indent,
      bullet,
      scope,
      parent,
      stages,
    };
    const n: Node =
      openBrace === undefined
        ? {
            ...common,
            kind: flow.length ? "flow" : (separator?.kind ?? "phrase"),
          }
        : { ...common, kind: "refinement", openBrace };

    const firstSpecial = tokens.find((t) =>
      ["definition", "assignment", "action", "open-clarification"].includes(
        t.kind,
      ),
    );
    const [ts, te] = trimSpan(
      a,
      Math.min(firstSpecial?.start ?? b, flow[0]?.start ?? b),
    );
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
        declared: ["definition", "assignment", "refinement"].includes(n.kind),
      };
      n.term = term;
      doc.terms.push(term);
    }

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
      ) {
        doc.terms.push({
          name: text.slice(s, e),
          start: s,
          end: e,
          scope,
          node: n.id,
          declared: false,
        });
      }
    }

    doc.nodes.push(n);
    indentation.push(n);
    if (n.kind === "refinement") blocks.push(n);
    return n;
  }
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
export interface Span {
  start: number;
  end: number;
}
export interface Term extends Span {
  name: string;
  scope: number | null;
  node: number;
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
}
interface Statement extends Span {
  id: number;
  range: Range;
  raw: string;
  indent: number;
  bullet: boolean;
  scope: number | null;
  parent: number | null;
  stages: Span[];
  term?: Term;
}
interface Refinement extends Statement {
  kind: "refinement";
  openBrace: number;
  blockEnd?: number;
}
type Node =
  | Refinement
  | (Statement & {
      kind: Separator | "phrase" | "flow";
      openBrace?: never;
      blockEnd?: never;
    });

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
