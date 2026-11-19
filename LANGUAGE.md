# Intent syntax

Write `project.intent` in short English phrases. Use the forms below to group rules, reuse terms, and show flows. Use a full sentence when it makes a rule clearer. Names can contain multiple words, and unfamiliar names are inferred. There are no reserved keywords.

| Form | Meaning |
| --- | --- |
| `term - prose` | Define a term |
| `term = value` | State a value or named choice |
| `term: prose` | Describe behavior |
| `term {` … `}` | Refine a term in a nested scope |
| `term (clarification)` | Attach explanatory prose |
| `source -> destination` | Describe sequence or causality |
| `source ~> destination` | Describe a stream |
| `- expression` | Attach a child to the preceding less-indented statement or enclosing block |
| `[first, second]` | Group values. Adjacent groups can be comma-separated |
| `"exact name"` | Preserve a specific name |
| `# comment` | Comment when followed by whitespace or end of line |

Newlines separate statements outside lists and clarifications. Indentation preserves parentage and braces delimit refinements. Bullets can express choices, combined requirements, or concurrent paths according to their parent. A bullet list alone implies no execution order.

A spaced dash introduces definition prose, where arrows are literal text. Elsewhere, arrows split stages outside quotes, lists, and parentheses. A colon can introduce action prose within a stage. An internal hyphen stays part of its word. Double quotes support escaped quotes and backslashes. Parentheses can nest, and their operators remain prose.

Definitions, assignments, and refinements describe the same term within a scope. References prefer the longest visible phrase at word boundaries and the nearest scope. Forward references are valid. Files have separate term scopes. Existing file mentions can be opened as links.

The formatter preserves malformed documents and retains prose, literals, and parentage. Structural diagnostics and typo hints are editor features. The agent skill handles design review and agreement between intent and implementation.
