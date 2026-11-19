import { occurrences } from "../src/terms.ts";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { parse, offset } from "../src/frontend.ts";
import { semanticLegend, semanticTokens } from "../src/highlighting.ts";

function decoded(doc) {
  const { data } = semanticTokens(doc);
  let line = 0,
    character = 0;
  const spans = [];
  for (let i = 0; i < data.length; i += 5) {
    line += data[i];
    character = data[i] === 0 ? character + data[i + 1] : data[i + 1];
    const start = offset(doc.text, { line, character });
    spans.push({
      text: doc.text.slice(start, start + data[i + 2]),
      start,
      type: semanticLegend.tokenTypes[data[i + 3]],
      declaration: !!(data[i + 4] & 1),
      modifiers: semanticLegend.tokenModifiers.filter(
        (_, bit) => data[i + 4] & (1 << bit),
      ),
    });
  }
  return spans;
}
test("definition, binding and block heads keep term styling under semantic overlays", () => {
  const doc = parse(
    "hosts - portable connection\nrequest = [kind]\nT3 {\n  baseline - author-invoked agent\n}\nVS Code {\n  language support -> request\n}\n",
  );
  const spans = decoded(doc);
  for (const name of ["hosts", "request", "T3", "baseline", "VS Code"])
    assert(
      spans.some(
        (s) => s.text === name && s.type === "intentTerm" && s.declaration,
      ),
      name,
    );
  for (const operator of ["-", "=", "->"])
    assert(
      !spans.some((s) => s.text === operator),
      "operators must retain their lexical theme color",
    );
  assert(!spans.some((s) => s.text.includes("portable connection")));
});
test("known prose references are terms, but quoted names and prose operators are untouched", () => {
  const text =
    'received part - heard by user\ncontext: acknowledge received part\nexplanation - source -> destination: example\nmodel = "received part -> destination"\n';
  const spans = decoded(parse(text));
  assert.equal(spans.filter((s) => s.text === "received part").length, 2);
  assert(!spans.some((s) => s.text === "->"));
  assert(
    !spans.some((s) => s.text === ":"),
    "action separators retain lexical styling",
  );
});
test("semantic classifications have explicit theme fallbacks matching lexical scopes", async () => {
  const manifest = JSON.parse(await fs.readFile("package.json", "utf8"));
  const mappings = manifest.contributes.semanticTokenScopes.find(
    (s) => s.language === "intent",
  ).scopes;
  for (const type of semanticLegend.tokenTypes)
    assert(mappings[type]?.length, `${type} needs a theme fallback`);
  assert.equal(
    manifest.contributes.semanticTokenTypes.find((t) => t.id === "intentTerm")
      .superType,
    "type",
  );
  assert.deepEqual(mappings.intentTerm, ["entity.name.type.intent"]);
  assert(
    !manifest.contributes.semanticTokenTypes.some(
      (t) => t.id === "intentOperator",
    ),
  );
  assert(!Object.hasOwn(mappings, "intentOperator"));
});

test("ordinary prose does not become a term", () => {
  const doc = parse(
    "overview - the language server handles editing\n",
    "memory:project",
  );
  const spans = decoded(doc);
  assert.deepEqual(
    spans.map((span) => span.text),
    ["overview"],
  );
});

test("term tints follow occurrence role, with neutral references and action heads in all flow stages", () => {
  const doc = parse(
    "context - shared history\ncontext = [messages]\ncontext: acknowledge context\ncontext {\n  note - context\n}\nsource -> context: update context ~> sink\n",
  );
  const spans = decoded(doc).filter((s) => s.text === "context");
  assert.deepEqual(
    spans.map((s) => s.modifiers),
    [
      ["declaration", "definition"],
      ["declaration", "binding"],
      ["action"],
      [],
      ["declaration", "refinement"],
      [],
      ["action"],
      [],
    ],
  );
  assert(
    !decoded(doc).some((s) => ["-", ":", "=", "->", "~>"].includes(s.text)),
  );
});
test("role palette is distinct, occurrence-specific and consistent between lexical and semantic styling", async () => {
  const manifest = JSON.parse(await fs.readFile("package.json", "utf8"));
  const defaults = manifest.contributes.configurationDefaults;
  const semantic = defaults["editor.semanticTokenColorCustomizations"];
  const lexical = defaults["editor.tokenColorCustomizations"];
  for (const theme of [null, "[*Light*]"]) {
    const rawRules = (theme ? semantic[theme] : semantic).rules;
    const rules = Object.fromEntries(
      Object.entries(rawRules).map(([key, value]) => [
        key,
        typeof value === "string" ? value : value.foreground,
      ]),
    );
    const textMateRules = (theme ? lexical[theme] : lexical).textMateRules;
    assert.equal(rawRules["intentActionText:intent"].italic, true);
    assert.equal(rawRules["intentTerm.inferred:intent"].italic, false);
    assert.equal(
      rules["intentTerm.definition:intent"],
      rules["intentTerm.refinement:intent"],
    );
    assert.equal(
      rules["intentTerm:intent"],
      rules["intentTerm.binding:intent"],
    );
    const roleColors = [
      "intentTerm:intent",
      ...["definition", "refinement", "binding", "action"].map(
        (role) => `intentTerm.${role}:intent`,
      ),
    ].map((key) => rules[key]);
    assert.equal(new Set(roleColors).size, 3);
    const rgb = (color) =>
      [1, 3, 5].map((start) => parseInt(color.slice(start, start + 2), 16));
    const palette = [...new Set(roleColors)].map(rgb);
    for (let i = 0; i < palette.length; i++)
      for (let j = i + 1; j < palette.length; j++) {
        const distance = Math.hypot(
          ...palette[i].map((value, k) => value - palette[j][k]),
        );
        assert(
          distance > 50 && distance < 180,
          "related role colors need clear separation",
        );
      }
    assert(
      Object.keys(rules).every(
        (key) => key.startsWith("intent") && key.endsWith(":intent"),
      ),
    );
    for (const role of ["definition", "refinement", "binding", "action"]) {
      const scope = `entity.name.type.${role}.intent`;
      const rule = textMateRules.find((r) => [r.scope].flat().includes(scope));
      assert.equal(
        rule.settings.foreground,
        rules[`intentTerm.${role}:intent`],
      );
    }
    assert(
      textMateRules.every((rule) =>
        [rule.scope]
          .flat()
          .every(
            (scope) =>
              scope.endsWith(".intent") &&
              !/^(keyword|punctuation)\./.test(scope),
          ),
      ),
    );
  }
});

test("action prose is yellowish, clarification prose muted and known references retain term colors", () => {
  const text =
    "context - shared\nsource -> context: acknowledge context (optional (nested) -> still prose) ~> sink\n";
  const spans = decoded(parse(text));
  assert(
    spans.some(
      (s) => s.type === "intentActionText" && s.text.includes("acknowledge"),
    ),
  );
  for (const word of ["optional", "nested", "still prose"])
    assert(
      spans.some(
        (s) => s.type === "intentClarification" && s.text.includes(word),
      ),
      word,
    );
  const reference = spans.find(
    (s) => s.start === text.indexOf("context (optional"),
  );
  assert.equal(reference.type, "intentTerm");
  assert.deepEqual(reference.modifiers, []);
  for (let i = 1; i < spans.length; i++)
    assert(
      spans[i].start >= spans[i - 1].start + spans[i - 1].text.length,
      "semantic spans must not overlap",
    );
  assert(
    !spans.some(
      (s) => s.type === "intentActionText" && s.text.includes("sink"),
    ),
  );
});
test("inferred list terms get attention styling without errors; defined items retain ordinary term styling", () => {
  const doc = parse(
    "ha - home assistant\neffectors = [write to chat, speak aloud, message telegram, ha]\n",
  );
  const spans = decoded(doc);
  for (const name of ["write to chat", "speak aloud", "message telegram"]) {
    assert(
      spans.some(
        (s) =>
          s.text === name &&
          s.type === "intentTerm" &&
          s.modifiers.includes("inferred"),
      ),
      name,
    );
  }
  const ha = spans.filter((s) => s.text === "ha").at(-1);
  assert(!ha.modifiers.includes("inferred"));
  assert.deepEqual(doc.diagnostics, []);
});
test("action and clarification paint preserve strings, numbers, punctuation and multiline boundaries", () => {
  const text =
    'context - shared\ncontext: say "context -> name" in 10ms (optional\n  nested context) -> next\n';
  const doc = parse(text),
    spans = decoded(doc);
  assert(
    !spans.some(
      (s) =>
        s.text.includes('"') ||
        s.text.includes("10ms") ||
        /[()\n]/.test(s.text),
    ),
  );
  assert(
    spans.some(
      (s) => s.type === "intentClarification" && s.text.includes("nested"),
    ),
  );
  assert(
    spans.some(
      (s) => s.type === "intentTerm" && s.start === text.indexOf("context)"),
    ),
  );
  assert(
    !spans.some((s) => s.type !== "intentTerm" && s.text.includes("next")),
  );
});

test("clarification term references keep resolution but receive secondary contextual styling", () => {
  const doc = parse(
    "context - shared\nsource -> unknown term\nsource (context and unknown term)\n",
  );
  const spans = decoded(doc);
  const known = spans.find(
    (s) => s.text === "context" && s.modifiers.includes("clarification"),
  );
  const inferred = spans.find(
    (s) => s.text === "unknown term" && s.modifiers.includes("clarification"),
  );
  assert(known);
  assert(!known.modifiers.includes("inferred"));
  assert(inferred?.modifiers.includes("inferred"));
  assert(
    occurrences(doc).some(
      (o) => o.start === known.start && o.candidates.some((t) => t.declared),
    ),
  );
});
