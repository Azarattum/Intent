---
name: intent
description: Design and maintain systems with a concise, declarative project.intent.
---

Intent is a human-readable description of the system you want. Keep it in root `project.intent` beside the code. Repeated prompts against current code scatter decisions across chats and diffs. Editing Intent keeps them in view.

Write plain English phrases, usually fragments. Define a recurring term once. Use that exact phrase in rules and flows, including when editing an existing spec. Group rules in braces. Use short labels before `:` and put shared terms in the rule text. Indent exceptions under their rule. Use arrows for transitions. Use sentences when they make a rule clearer.

```intent
pickup code - trimmed, uppercase order label
pickup board {
  check in: add order by pickup code
    - blank input: reject blank pickup code
  check in -> waiting -> collect
  collect: remove waiting order by pickup code
}
```

Follow the user's emphasis as it evolves. Keep the behavior, tradeoffs, and constraints they care about. Skip routine implementation details, exhaustive inventories, and filler.

**Intent → code.** Update desired behavior from the request. Check for conflicts and discuss consequential ambiguity. Implement and verify against Intent.

**Code → intent.** Reconcile both diffs against their common base. Record approved decisions that change what matters to the user. Keep unmet requirements visible.
