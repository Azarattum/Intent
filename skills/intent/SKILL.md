---
name: intent
description: Design and maintain systems with a concise, declarative project.intent.
---

Intent is a human-readable description of the system you want. Keep it in root `project.intent` beside the code. Repeated prompts against current code scatter decisions across chats and diffs. Editing Intent keeps them in view.

Write short, plain English. Use Intent syntax where it reads better. Follow the user's emphasis and priorities as they evolve. Keep the behavior, tradeoffs, and constraints they care about. Skip routine implementation details, exhaustive inventories, and filler.

**Intent → code.** Update desired behavior from the request. Check for conflicts and discuss consequential ambiguity. Implement and verify against Intent.

**Code → intent.** Reconcile both diffs against their common base. Record approved decisions that change what matters to the user. Keep unmet requirements visible.
