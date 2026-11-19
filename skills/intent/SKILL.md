---
name: intent
description: Design and maintain systems with a declarative project.intent.
---

Intent is a declarative notation for desired system behavior, architecture, and constraints. Keep the spec in root `project.intent` alongside code.

Repeated prompts to change current code scatter design decisions across prompts and diffs. Edit the spec to reason about the whole design without reconstructing those decisions.

Intent → code: Translate requests into desired behavior in phrase-and-flow prose. Lint for contradictions, omissions, and needless commitments. Discuss consequential ambiguity before implementing. Derive acceptance checks from intent and verify against code.

Code → intent: Reconcile both diffs against their common base. Record approved behavior, architecture, and technology changes in the same change. Keep unmet requirements visible as gaps.
