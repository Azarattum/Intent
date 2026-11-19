import test from "node:test";
import assert from "node:assert/strict";
import { parse, offset, position } from "../src/frontend.ts";
import { format } from "../src/formatter.ts";
import {
  completion,
  occurrences,
  references,
  occurrenceAt,
  termHints,
} from "../src/terms.ts";
import fs from "node:fs/promises";
const fixture = `received part - heard by user\nrag (optional)\ncontext: acknowledge received part\nmodel = "arrows -> { literal }"\nmain loop {\n  receptors ~> rag (optional) ~> model: make decisions\n    - reply\n      - text ~> channel\n    - switch channel\n}\n`;
test("prose, clarification, multiword references and literals", () => {
  const doc = parse(fixture);
  assert.deepEqual(doc.diagnostics, []);
  assert.equal(doc.nodes[0].kind, "definition");
  assert.equal(doc.nodes[1].term.name, "rag");
  assert.equal(
    occurrences(doc).filter((o) => o.name === "received part").length,
    2,
  );
  assert.equal(doc.nodes.find((n) => n.kind === "flow").stages.length, 3);
  assert(
    !occurrences(doc).some(
      (o) =>
        o.start > fixture.indexOf('"') &&
        o.start < fixture.indexOf('"', fixture.indexOf('"') + 1),
    ),
  );
  const text = doc.nodes.find((n) => n.raw === "text ~> channel");
  assert.equal(doc.nodes[text.parent].raw, "reply");
});
test("definition arrows remain prose and internal hyphens remain terms", () => {
  const doc = parse(
    "low-level - source -> destination\nflow -> sink: act ~> next\n",
  );
  assert.equal(doc.nodes[0].kind, "definition");
  assert.equal(doc.nodes[0].term.name, "low-level");
  assert.equal(doc.nodes[1].stages.length, 3);
});
test("formatter is idempotent and preserves parentage and prose", () => {
  const doc = parse(fixture),
    formatted = format(doc),
    again = parse(formatted);
  assert.equal(format(again), formatted);
  assert.deepEqual(
    again.nodes.map((n) => [n.raw, n.parent, n.scope]),
    doc.nodes.map((n) => [n.raw, n.parent, n.scope]),
  );
});
test("malformed delimiters recover for later declarations and preserve malformed formatting", () => {
  for (const input of [
    "bad (oops\nlater = 2\n",
    'bad = "oops\nlater = 2\n',
    "bad ]\nlater = 2\n",
  ]) {
    const doc = parse(input);
    assert(doc.diagnostics.length);
    assert(doc.terms.some((t) => t.name === "later"));
    assert.equal(format(doc), input);
  }
});
test("dangling arrows, orphan bullets and malformed lists have actual ranges", () => {
  for (const input of ["source ->", "- orphan", "items = [a,, b]"]) {
    const d = parse(input);
    assert(d.diagnostics.some((x) => x.severity === 1));
    assert(
      d.diagnostics.every(
        (x) => x.range.end.character > x.range.start.character,
      ),
    );
  }
});
test("nested clarification shields arrows and grouped lists retain text", () => {
  const d = parse(
    "rag (nested (a -> b)) ~> sink\nchannel = [input, output], [other, next]\n",
  );
  assert.deepEqual(d.diagnostics, []);
  assert.equal(d.nodes[0].stages.length, 2);
  assert.equal(d.nodes[1].kind, "assignment");
});
test("references prefer nearest scope and rename excludes literal names", () => {
  const text =
    'term = "term"\nbox {\n  term - local\n  action: term\n}\nelsewhere: term\n';
  const d = parse(text);
  const o = occurrenceAt(d, text.indexOf("action: term") + 8),
    refs = references(d, o);
  assert.equal(refs.length, 2);
  assert(refs.every((r) => r.start >= text.indexOf("box")));
  assert.equal(
    references(d, occurrenceAt(d, text.lastIndexOf("term"))).length,
    2,
  );
});
test("workspace literals complete without importing workspace terms", () => {
  const other = parse(
    'foreign term - documentation\nmodel = "exact name"',
    "file:///other",
  );
  const doc = parse('action: foreign term\nmodel = "exact', "file:///project");
  const workspace = () => [doc, other];
  assert.equal(occurrenceAt(doc, doc.text.indexOf("foreign term")), undefined);
  assert(
    !completion(doc, doc.text.indexOf("foreign term") + 8, workspace).some(
      (item) => item.label === "foreign term",
    ),
  );
  assert(
    completion(doc, doc.text.length, workspace).some(
      (item) => item.label === "exact name",
    ),
  );
});
test("completion replaces full partial phrase in action prose", () => {
  const d = parse("received part - heard\ncontext: acknowledge received pa");
  const items = completion(d, d.text.length);
  const item = items.find((i) => i.label === "received part");
  assert(item);
  assert.equal(item.textEdit.range.start.character, 21);
});
test("UTF-16 positions round-trip with astral Unicode", () => {
  const text = "😀 text\nа phrase";
  for (let at = 0; at <= text.length; at++)
    assert.equal(offset(text, position(text, at)), at);
});
test("project.intent parses and round-trips", async () => {
  const files = ["project.intent"];
  for (const file of files) {
    const text = await fs.readFile(file, "utf8"),
      doc = parse(text);
    assert.deepEqual(doc.diagnostics, [], file);
    const formatted = format(doc);
    assert.equal(format(parse(formatted)), formatted, file);
    assert.deepEqual(
      parse(formatted).nodes.map((n) => [n.raw, n.parent]),
      doc.nodes.map((n) => [n.raw, n.parent]),
      file,
    );
  }
});
test("commas inside literal, nested list and clarification are not empty values", () => {
  for (const text of [
    'items = ["a,,b", "c,"]',
    "items = [[a, b], (c,,d)]",
    "items = []",
  ])
    assert.deepEqual(parse(text).diagnostics, []);
  assert(
    parse("items = [a, ,b]").diagnostics.some(
      (d) => d.code === "malformed-list",
    ),
  );
});
test("inferred destinations are indexed and local literals complete without network", () => {
  const d = parse(
    'source -> inferred destination\nmodel = "gemma 12b"\nother = "gem',
  );
  assert(d.terms.some((t) => t.name === "inferred destination"));
  assert(completion(d, d.text.length).some((c) => c.label === "gemma 12b"));
});
test("unclosed refinement underlines the actual opening brace", () => {
  const d = parse("long phrase {\n  item - prose\n");
  assert.equal(d.diagnostics[0].range.start.character, 12);
});

test("scoped definitions and inferred phrases cannot leak into outer or sibling prose", () => {
  const text =
    "summary - implementation and intent\nworkspace layout {\n  implementation - tooling\n  detail: implementation\n}\ndevelopment {\n  intent -> compiler\n  detail: intent\n}\nsibling {\n  detail: implementation and intent\n}\n";
  const doc = parse(text);
  assert.equal(occurrenceAt(doc, text.indexOf("implementation")), undefined);
  assert.equal(occurrenceAt(doc, text.indexOf("intent")), undefined);
  assert(occurrenceAt(doc, text.indexOf("detail: implementation") + 8));
  assert(occurrenceAt(doc, text.indexOf("detail: intent") + 8));
  assert.equal(
    occurrenceAt(doc, text.lastIndexOf("implementation")),
    undefined,
  );
  assert.equal(occurrenceAt(doc, text.lastIndexOf("intent")), undefined);
});
test("an unrelated declaration does not suppress a valid inferred binding", () => {
  const text =
    "layout {\n  implementation - tooling\n}\nflow {\n  implementation -> destination\n  detail: implementation\n}\n";
  const doc = parse(text),
    reference = occurrenceAt(doc, text.lastIndexOf("implementation"));
  assert(reference);
  assert(reference.candidates.every((t) => !t.declared));
  assert.equal(references(doc, reference).length, 2);
});
test("empty and partial bullets complete visible terms without replacing the marker", () => {
  for (const closed of [true, false]) {
    const text =
      "received part - heard\nloop {\n  local option - behavior\n  action:\n    - " +
      (closed ? "\n}\n" : "");
    const doc = parse(text),
      at = text.indexOf("    - ") + 6;
    const items = completion(doc, at);
    for (const label of ["received part", "local option"]) {
      const item = items.find((i) => i.label === label);
      assert(item, label);
      assert.deepEqual(item.textEdit.range, {
        start: { line: 4, character: 6 },
        end: { line: 4, character: 6 },
      });
    }
  }
  const text =
    "received part - heard\nloop {\n  action:\n    - received pa\n}\n";
  const doc = parse(text),
    at = text.indexOf("received pa\n") + "received pa".length;
  const item = completion(doc, at).find((i) => i.label === "received part");
  assert(item);
  assert.deepEqual(item.textEdit.range, {
    start: { line: 3, character: 6 },
    end: { line: 3, character: 17 },
  });
});
test("bullet completion excludes sibling, foreign and closed-block terms", () => {
  const foreign = parse("foreign option - external", "file:///other");
  const text =
    "sibling {\n  private option - hidden\n}\nloop {\n  visible option - local\n  action:\n    - \n}\nafter:\n  - \n";
  const doc = parse(text),
    workspace = () => [doc, foreign];
  const inside = completion(doc, text.indexOf("    - ") + 6, workspace).map(
    (i) => i.label,
  );
  assert(inside.includes("visible option"));
  assert(!inside.includes("private option"));
  assert(!inside.includes("foreign option"));
  const outside = completion(doc, text.lastIndexOf("  - ") + 4, workspace).map(
    (i) => i.label,
  );
  assert(!outside.includes("visible option"));
  assert(!outside.includes("private option"));
});

test("list phrases are inferred whole terms; visible definitions still resolve normally", () => {
  const text =
    "ha - home assistant\neffectors = [write to chat, speak aloud, message telegram, ha]\n";
  const doc = parse(text);
  assert.deepEqual(doc.diagnostics, []);
  for (const name of ["write to chat", "speak aloud", "message telegram"]) {
    const at = text.indexOf(name),
      occurrence = occurrenceAt(doc, at);
    assert.equal(occurrence.name, name);
    assert(occurrence.candidates.every((t) => !t.declared));
  }
  assert(
    occurrenceAt(doc, text.lastIndexOf("ha")).candidates.some(
      (t) => t.declared,
    ),
  );
  const incomplete = parse(text + "flow {\n  - ");
  assert(
    completion(incomplete, incomplete.text.length).some(
      (item) => item.label === "write to chat",
    ),
  );
  assert(!termHints(doc).some((d) => d.severity <= 2));
});
test("nested list terms respect scope and do not invent terms from literals or clarification prose", () => {
  const text =
    'box {\n  values = [[multiword term, "named technology"], 42, optional term (some prose)]\n  annotation (use [annotation prose])\n}\nelsewhere: multiword term\n';
  const doc = parse(text);
  assert.deepEqual(doc.diagnostics, []);
  for (const name of ["multiword term", "optional term"])
    assert(doc.terms.some((t) => t.name === name && t.origin === "list"));
  for (const name of [
    "named technology",
    "42",
    "some prose",
    "annotation prose",
  ])
    assert(!doc.terms.some((t) => t.name === name));
  assert.equal(
    occurrenceAt(doc, text.lastIndexOf("multiword term")),
    undefined,
  );
});

test("formatter aligns blocks and normalizes structural spacing without rewriting prose or literals", () => {
  const text =
    'outer   {\n      value=  [ one ,two  , "a  b" ]    \n      action:   use http://example/a:b ->sink\n        -   reply\n}\n\n\n';
  const expected =
    'outer {\n  value = [one, two, "a  b"]\n  action: use http://example/a:b -> sink\n    - reply\n}\n\n';
  const result = format(parse(text));
  assert.equal(result, expected);
  assert.equal(format(parse(result)), result);
  assert.equal(
    format(parse("received  part - wording  stays\n")),
    "received  part - wording  stays\n",
  );
});

test("formatter preserves list-like prose in definitions", () => {
  const text = "notes - preserve [ example , text ] exactly\n";
  assert.equal(format(parse(text)), text);
});
