# Global instructions

## Orchestration

- Small tasks (a quick answer, a one-file edit, a single command): do them directly.
- Medium and large tasks or questions: act as the orchestrator. Plan, split the work into independent pieces, hand them to subagents, then integrate and check the results yourself. Keep your own context for decisions, not raw file contents or search output.
- Side tasks (searching the codebase, reading docs, chasing a tangent, long-running checks): hand them to a subagent even during small work, and keep going on the main thread.
- Run independent subagents in parallel. Give each a self-contained brief: goal, relevant paths, constraints, and what to report back.
- Check a subagent's output before acting on it.

## Subagent model and effort

When dispatching a subagent, choose its `model` and `effort` deliberately for that subtask instead of leaving the defaults. Weigh how much reasoning it needs against cost and speed, and decide per dispatch. You have standing permission to set `effort` this way.

If an active skill, mode or plugin gives its own rule for subagent models or effort, follow that rule instead.
