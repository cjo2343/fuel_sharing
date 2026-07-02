---
name: context-reset
description: >
  Compact conversation context when switching between major work phases.
  Use proactively when finishing an epic or task group, before starting a
  different area of the codebase, or when the conversation has accumulated
  exploration/debugging context that is no longer needed. Also use when
  the user says "reset context", "clear context", "fresh start", or
  "switch focus".
user-invocable: true
---

# Context Reset

Reduce conversation bloat between work phases so the next task starts lean.

## When to trigger proactively

- After completing a group of related tickets (e.g., finishing all DS component work before starting screen builds)
- Before switching from exploration/planning to implementation
- After a debugging session resolves — the debug trace is no longer needed
- When conversation context exceeds ~60% of capacity

## Steps

1. Summarize what was accomplished in the current phase (1-3 bullet points)
2. Note any decisions, open questions, or blockers that carry forward
3. Run `/compact` to compress the conversation history
4. State what the next phase/focus area is

## Output format

```
## Phase complete: {phase name}
- {what was done}
- {what was done}

## Carrying forward
- {decision or open item that matters for next work}

## Next: {upcoming focus}
```

Keep it short. The point is to shed context weight, not create documentation.
