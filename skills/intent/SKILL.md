---
name: intent
description: Maintain project.intent alongside code in Intent projects.
---

Repeated commands against current code scatter design decisions across prompts and diffs. Keep desired behavior, architecture, and constraints in root `project.intent` to reason about changes without reconstructing prior decisions.

Intent → code: Translate requests into desired behavior in phrase-and-flow prose. Lint for contradictions, omissions, and needless commitments. Discuss consequential ambiguity before implementing. Derive acceptance checks from intent and verify against code.

Code → intent: Reconcile both diffs against their common base. Record approved behavior, architecture, and technology changes in the same change. Keep unmet requirements visible as gaps.
