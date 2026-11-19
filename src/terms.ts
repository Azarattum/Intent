import type { CompletionItem, Diagnostic } from "vscode-languageserver";
import {
  range,
  type IntentDocument,
  type Span,
  type Term,
} from "./frontend.ts";

export function occurrences(doc: IntentDocument) {
  const state = analysis(doc);
  const cached = state.occurrences;
  if (cached) return cached;

  const result: Occurrence[] = [];
  for (const node of doc.nodes) {
    const names = [...bindings(doc, node.scope)].sort(
      ([a], [b]) => b.length - a.length,
    );
    for (let at = node.start; at < node.end;) {
      const literal = doc.literals.find((l) => at >= l.start && at < l.end);
      if (literal) {
        at = literal.end;
        continue;
      }

      const match = names.find(
        ([name]) =>
          doc.text.startsWith(name, at) &&
          !word(doc.text[at - 1]) &&
          !word(doc.text[at + name.length]),
      );
      if (!match) {
        at++;
        continue;
      }

      const [name, candidates] = match;
      const end = at + name.length;
      result.push({
        start: at,
        end,
        name,
        candidates,
        declaration: doc.terms.some(
          (term) => term.start === at && term.name === name && term.declared,
        ),
      });
      at = end;
    }
  }

  state.occurrences = result;
  return result;
}

export function occurrenceAt(doc: IntentDocument, at: number) {
  return occurrences(doc).find(
    (occurrence) => occurrence.start <= at && at < occurrence.end,
  );
}

export function references(
  doc: IntentDocument,
  occurrence: Occurrence | undefined,
) {
  if (!occurrence) return [];

  const [term] = occurrence.candidates;
  return occurrences(doc).filter((other) => other.candidates[0] === term);
}

export function completion(
  doc: IntentDocument,
  at: number,
  workspace: () => IntentDocument[] = () => [doc],
): CompletionItem[] {
  const literal = doc.literals.find(
    (l) => at > l.start && (at < l.end || (l.incomplete && at === l.end)),
  );

  if (literal) {
    const prefix = doc.text.slice(literal.start + 1, at);
    return [
      ...new Set(
        workspace().flatMap((d) =>
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

  const prefix = doc.text.slice(doc.text.lastIndexOf("\n", at - 1) + 1, at);
  const names = [...bindings(doc, scopeAt(doc, at)).keys()];
  const emptyBullet = /^\s*-\s*$/.test(prefix);

  return names.flatMap((name) => {
    let length = 0;
    for (let n = 1; n <= Math.min(prefix.length, name.length); n++) {
      if (
        name.toLowerCase().startsWith(prefix.slice(-n).toLowerCase()) &&
        !word(doc.text[at - n - 1])
      ) {
        length = n;
      }
    }
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

export function termHints(doc: IntentDocument) {
  const result: Typo[] = [];

  for (const t of doc.terms.filter((t) => !t.declared)) {
    const visible = [...bindings(doc, t.scope).values()].flat();
    if (visible.some((k) => k.declared && k.name === t.name)) continue;
    const similar = visible.find(
      (k) =>
        k.declared &&
        k.name !== t.name &&
        t.name.length >= 4 &&
        distance(k.name, t.name) === 1,
    );
    if (similar) {
      result.push({
        source: "intent-terms",
        code: "possible-typo",
        severity: 4,
        range: range(doc.text, t.start, t.end),
        message: `Inferred phrase “${t.name}”; did you mean “${similar.name}”?`,
        data: { replacement: similar.name },
      });
    }
  }

  return result;
}

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

const word = (c = "") => /[\p{L}\p{N}_.]/u.test(c);
function ancestors(doc: IntentDocument, scope: number | null) {
  const result = [];
  while (scope !== null) {
    result.push(scope);
    scope = doc.nodes[scope].scope;
  }

  return result;
}

function visibleTerms(doc: IntentDocument, scope: number | null) {
  const chain = ancestors(doc, scope);
  const groups = new Map<string, Term[]>();
  for (const term of doc.terms) {
    if (term.scope !== null && !chain.includes(term.scope)) continue;
    const group = groups.get(term.name) ?? [];
    group.push(term);
    groups.set(term.name, group);
  }

  for (const [name, group] of groups) {
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
        n.openBrace < at &&
        (n.blockEnd === undefined || at < n.blockEnd),
    )
    .at(-1);
  return block?.id ?? null;
}

function bindings(doc: IntentDocument, scope: number | null) {
  const { scopes } = analysis(doc);
  const cached = scopes.get(scope);
  if (cached) return cached;

  const terms = visibleTerms(doc, scope);
  scopes.set(scope, terms);
  return terms;
}

interface Occurrence extends Span {
  name: string;
  candidates: Term[];
  declaration: boolean;
}

type Typo = Diagnostic & { data: { replacement: string } };

interface Analysis {
  scopes: Map<number | null, Map<string, Term[]>>;
  occurrences?: Occurrence[];
}

const analyses = new WeakMap<IntentDocument, Analysis>();

function analysis(doc: IntentDocument) {
  const cached = analyses.get(doc);
  if (cached) return cached;

  const state: Analysis = { scopes: new Map() };
  analyses.set(doc, state);
  return state;
}
