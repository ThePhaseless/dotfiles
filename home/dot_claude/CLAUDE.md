# Global instructions

## Orchestration

- Small tasks (a quick answer, a one-file edit, a single command): do them directly.
- Medium and large tasks or questions: act as the orchestrator. Plan, hand the work to subagents, then integrate and check the results yourself. Keep your own context for decisions, not raw file contents or search output.
- Side tasks (searching the codebase, reading docs, chasing a tangent, long-running checks): hand them to a subagent even during small work, and keep going on the main thread.
- Split the work into independent units at the start, and map what each unit needs first and which files it touches. A unit is one subagent or one whole pipeline (below). Dispatch every ready unit in the same turn, and each later one the moment its last dependency lands. Units running in one tree touch disjoint files; units that share a file run in order. Give each subagent a self-contained brief: goal, relevant paths, constraints, and what to report back. Have the report open with what changed as before → after, in terms the user sees.
- Check a subagent's output before acting on it.

### Pipeline for non-trivial changes

A change is non-trivial when it spans several files or components, changes behaviour that other code or people rely on, or needs a design choice. Run each one through four stages, each a fresh subagent:

1. Plan: write the plan.
2. Plan review: check the plan against the request and the code. Revise and review again until it passes; when a revision makes no progress, bring the open issues to the user.
3. Implement: carry out the approved plan.
4. Implementation review: two fresh subagents review the diff and tag every finding blocker, major or minor. One checks it against the plan. The other is a blind review: it gets the diff and the repo, never the plan, and checks every environment and project the code runs in, partial failures (one replica, consumer or tenant, not all), noise (alerts, logs, retries) and the file's own conventions. Send every finding to a fresh implementer. Done when a round has no blocker or major; minor fixes ship without another review. After a fix round that had a blocker or major, run both again on the delta since their last pass, give them the findings already settled, and have them report only new or regressed ones. Keep going until no blocker or major is open. When a fix round makes no progress (nothing changed, a finding declined, or a fixed finding keeps returning), stop and bring the open findings to the user. Open the PR only after that.

Each non-trivial change runs its own pipeline as a unit beside the others; items that need no pipeline stay out of its plan. While a change is being implemented, its working tree belongs to that change alone: any other work in the same repo gets its own branch and a git worktree under `.worktrees/` in that repo, listed in `$(git rev-parse --git-common-dir)/info/exclude`.

A subagent briefed with one stage does that stage itself and returns its result; the orchestrator starts every stage.

In Claude Code, run the pipeline through two saved workflows. The user has asked for them to run whenever this pipeline applies, with no further opt-in. `pipeline-plan` runs stages 1–2. When it returns questions or unresolved issues, bring them to the user and rerun it with the plan, the issues and the answers. When it returns `ready`, check the plan and approve it yourself; the user sees the plan only when it came with questions. Then pass it to `pipeline-implement`, which runs stages 3–4 and returns `done` or the open findings to bring to the user. Before calling the change done, run the `notRun` steps that the repo's instructions already allow (such as `chezmoi apply`) and bring the rest (deploy, push, migration) to the user. Any other status: bring it and the run log to the user. Where there is no Workflow tool (omp) or the change is outside a git repo, run the same stages with subagents.

Run it for: a new feature, script or plugin with its omp bridge; a bug whose cause is still unknown; a refactor across modules; a change to a data pipeline, schema or scraper output.

Do these directly instead: a one-file edit with an obvious fix (typo, renamed variable, a config value); a single command; answering a question; accepting or reverting a diff that is already known.

## Messages that end a turn

Write every message that ends a turn for a cold reader: the user comes back after an hour and reads only this message. Background events (task notifications, subagent hand-backs, workflow results) are your input, not the reader's; translate them into where the user's task stands.

- While any part of the task is still running, end the turn with the status block alone. Keep the full report, plans for later steps and questions for the moment the whole task finishes. Ask mid-work only when the work is stopped until the user acts (a login, a usage limit, a decision the next step needs).
- When the whole task finishes, report what changed as before → after, in terms the user sees (the page, the data, the delivery, the PR), then the status block.
- Status block, 3–5 lines: the goal in one sentence; the stages of the user's whole task marked ✅/⏳, current one named; what is running now and roughly how long it takes; what the user needs to do, or "nothing, waiting for X".
- Use the user's vocabulary. A name coined during the work (unit IDs, check names, nicknames for fixes, a subagent's terms) gets a plain description instead, or a one-line definition on first use.
- The status block is state, not a recap, and "nothing, waiting for X" is a valid next action: this overrides the i-have-adhd no-recap and next-action rules.

## Commit attribution

The git author is the only attribution. A commit message or PR body ends on its own content, with no `Co-Authored-By: Claude` or "Generated with Claude Code" lines, even where the repo history carries them. Subagent briefs that dictate a commit message follow the same rule, and a review treats a missing trailer as correct.

## Waiting in scripts

Every wait in a script, loop or monitor is event-driven: it polls the real signal every 1–2 s and exits the moment the work succeeds, a failure shows (an error line, a non-zero exit, the watched process gone), or a short deadline passes. Set the deadline to the step's usual duration plus a small margin, seconds to a few minutes, and print which of the three ended the wait. After a timeout, inspect the state and change something before you wait again.

## Examples from the user

A user example ("for example", "like", "such as") names one instance of a class. The class is the scope: fix the named instance, then find and fix the rest of the class. When you delegate, brief the subagent with the class and the goal only, so its search stays unanchored. Keep the user's examples as your own must-fix checklist, confirm each one after the subagent reports, and send any it missed as a follow-up.

## Subagent model and effort

When dispatching a subagent, choose its agent type and `effort` deliberately instead of leaving the defaults. Weigh how much reasoning it needs against cost and speed.

- **Effort**: pass `effort: "lo" | "med" | "hi"` per dispatch. You have standing permission to set `effort` this way.
- **Model routing**: omp routes subagent models by specialist agent type (`scout`, `sonic`, `reviewer`, `task`) or `modelRoles` in `~/.omp/agent/config.yml`. The `task` tool rejects inline `model` arguments (accepted only for `seance`). Do not pass `model` to `task`.
- If an active skill, mode or plugin gives its own rule for subagent models or effort, follow that rule instead.

## Skills to use without being asked

Skill descriptions alone miss these situations. Invoke the skill yourself before the step, even when the user does not name it. omp lists plugin skills without the `plugin:` prefix.

| Situation | Skill |
| --- | --- |
| Prose people read outside the chat: docs, READMEs, plans, specs, PR and issue bodies and comments, Linear issues and comments, Slack messages, Claude Docs, artifacts | `humanizer:humanizer` on the draft, before saving or sending it |
| Agent-facing text: `SKILL.md`, `CLAUDE.md`, `AGENTS.md`, prompts for agents | `mattpocock-skills:writing-for-agents`, not humanizer |
| A PR description | `mattpocock-skills:pr`, then `humanizer:humanizer` |
| Before committing, opening a PR, or saying work is done, fixed or passing | `superpowers:verification-before-completion` |
| Before opening a PR or merging a non-trivial change | `superpowers:requesting-code-review` |
| The first code edit in a session | `andrej-karpathy-skills:karpathy-guidelines` |
| A bug, an error, a failing test or a regression | `superpowers:systematic-debugging` |
| Implementing a feature or a fix in a repo that has tests | `superpowers:test-driven-development` |
| Searching Slack; sending, drafting or scheduling a Slack message | `slack:slack-search`; `slack:slack-messaging` |

Where plugins overlap, use the superpowers skill unless the user names the other one: `superpowers:test-driven-development` over `mattpocock-skills:tdd`, `superpowers:systematic-debugging` over `mattpocock-skills:diagnosing-bugs`, `superpowers:requesting-code-review` over `mattpocock-skills:code-review`, `superpowers:brainstorming` over `mattpocock-skills:grilling`. Claude Code cannot turn off a single plugin skill, so this rule is the only switch.

## Home directory: dotfiles managed by chezmoi

Many files in `~` are generated by chezmoi from the repo at `~/.local/share/chezmoi` (GitHub `ThePhaseless/dotfiles`). An edit made directly to a managed file is lost on the next apply, and `.zshrc` runs an update-and-apply in the background every hour. Files changed both in `~` and in the repo are skipped and listed at the prompt; `dotfiles-resolve` settles them.

### Before changing a file in `~`

1. Check whether chezmoi manages it: `chezmoi managed | grep <path>`; `chezmoi source-path <target>` prints its source file.
2. Managed: edit the source file instead, then follow `~/.local/share/chezmoi/AGENTS.md` (validate, `chezmoi diff`, `chezmoi apply <target>`).
3. Not managed: edit it in place. To start tracking it, copy it into the source under its chezmoi name (`dot_`, `private_`, `executable_` prefixes) and verify with `chezmoi diff <target>`. Avoid `chezmoi add` from an agent: it auto-commits and prompts for a commit message on a TTY.

### Where things live

| What | Target | Notes |
| --- | --- | --- |
| Env vars and PATH for every shell | `~/.env` | Source `home/dot_env.tmpl` |
| Machine-specific values and secrets | `~/.env.local` | Untracked; edit in place |
| Claude Code settings, plugins, marketplaces | `~/.claude/settings.json` | Claude Code rewrites it; run `chezmoi re-add ~/.claude/settings.json` to save changes back |
| Personal skills | `~/.claude/skills/` | Untracked: some are work-specific and this repo is public. Claude Code and omp both load them |
| Saved workflows | `~/.claude/workflows/` | Source `home/dot_claude/workflows/` |
| Global agent instructions, including this guide to `~` | `~/.claude/CLAUDE.md` | Claude Code and omp load it in every directory. omp never reads `~/AGENTS.md` or `~/CLAUDE.md`, so rules for all of `~` go here |
| omp settings | `~/.omp/agent/config.yml` | omp rewrites it. `modelRoles` (`/model`) stays local and untracked; other changes go into the source by hand, `re-add` cannot save a modify template |
| omp provider keys | `~/.omp/agent/models.yml` | Names env vars only; the keys sit in `~/.env.local` (`OMP_ANTHROPIC_API_KEY`). Never export `ANTHROPIC_API_KEY` there: Claude Code would offer to bill it instead of the subscription |
| omp extensions | `~/.omp/agent/extensions/` | Bridges that give omp what Claude plugin hooks do, since omp ignores Claude hooks; see "Claude Code and omp parity" |

- Never track credentials, history, sessions, caches or databases from `~/.claude` or `~/.omp`; `home/.chezmoiignore` guards against it.
- Do not create `~/.omp/agent/AGENTS.md`: omp keeps one user-level context file, and that one would hide `~/.claude/CLAUDE.md`.
- `chezmoi re-add` auto-commits like `chezmoi add` and fails without a TTY. From an agent, copy the target over its source file (`cp ~/.claude/settings.json ~/.local/share/chezmoi/home/dot_claude/settings.json`) and check `chezmoi diff <target>` is empty.

### Claude Code and omp parity

Anything installed into Claude Code (plugin, skill, agent, MCP server, hook) must also work in omp. Check omp's side before you report an install done.

- omp reads plugins from `~/.claude/plugins/installed_plugins.json` and skips one only when `enabledPlugins` in `~/.claude/settings.json` sets it to `false`. A plugin that is installed but missing from `enabledPlugins` is off in Claude Code and on in omp. When you disable or stop using a plugin, set it to `false` (or uninstall it), never just delete the key. omp does not read `~/.claude/settings.machine.json`, which reaches Claude Code only through the `claude` alias in `~/.env.local`; to turn off a plugin enabled there, uninstall it on that machine.
- omp loads plugin skills, agents (`agents/*.md`), `commands/*.md`, MCP servers (`.mcp.json` or `plugin.json` `mcpServers`) and `rules/`. It does not load Claude `hooks/hooks.json`, `commands/*.toml`, `workflows/` or output styles, and it has no Workflow tool.
- For each new plugin, list what it ships and port what omp skips. A hook that matters becomes a bridge in `~/.omp/agent/extensions/` (source `home/dot_omp/private_agent/extensions/`): read the plugin's files from its `installPath` so the bridge follows plugin updates. A plugin that needs a Claude-only tool gets hidden in omp's config (`disabledExtensions: [skill:<name>]`, `task.disabledAgents`) with a comment saying why, and gets listed below.
- omp's own agents are `task`, `scout`, `reviewer`, `security-reviewer`, `sonic` and `init`. Plugin agents load first and win on a name clash, so a plugin agent with one of those names replaces omp's.
- Verify in the omp TUI with `/skills`, `/mcp` and `/extensions`; `omp plugin list` shows only omp's own plugins, not Claude's. Headless: `OMP_MCP_REQUIRE_READY=1 omp -p --no-session hi </dev/null` exits 1 and names every MCP server that failed to connect. Without `</dev/null`, `omp -p` run from an agent waits on stdin forever.
- omp keeps its own MCP OAuth tokens, separate from Claude Code's. A plugin MCP server that needs a login gets one `/mcp reauth <plugin>:<server>` in omp per machine.
- Define each MCP server once, in its plugin. omp also reads `~/.claude.json` and `~/.omp/agent/mcp.json`: an identical entry there silently shadows the plugin's server, and one that differs only in `oauth` (omp drops that block from `~/.claude.json`) runs as a duplicate that cannot log in.
- omp reads `~/.claude/skills` (`skills.enableClaudeUser`) and skips `~/.agents/skills` and project `.agents/skills` (`enableAgentsUser`/`enableAgentsProject: false`), because Claude Code reads neither. Add a skill as a Claude Code plugin or under `~/.claude/skills`, not with `npx skills`, which installs into `~/.agents/skills` by default. A repo that keeps skills in `.agents/skills` needs a `.claude/skills -> ../.agents/skills` symlink to reach both hosts. The pre-cleanup contents of `~/.agents/skills` sit in `~/.agents/skills.retired-2026-10-19`.

Current bridges and exceptions:

| Plugin | In omp |
| --- | --- |
| superpowers | Skills via the claude provider; `superpowers-bridge.ts` loads the bootstrap with omp-native tool mapping (`task`, `todo`, `read skill://`) |
|i-have-adhd|`i-have-adhd-bridge.ts` injects the ruleset, tracks state across turns and handles `/i-have-adhd` commands and subagents|
| impeccable | `impeccable-bridge.ts` runs the plugin's hook script after edits and at session start/stop |
| context7 | MCP server `context7:context7`; needs `/mcp reauth context7:context7` once per machine |
| linear | MCP server `linear:linear`; needs `/mcp reauth linear:linear` once per machine. Enabled in `~/.claude/settings.machine.json`; omp treats it as on because it is installed |
| slack | Skills load without a prefix (`/skill:slack-search`), plus the `slack:*` commands; MCP server `slack:slack` needs `/mcp reauth slack:slack` once per machine. Enabled in `~/.claude/settings.machine.json`, like linear |
| claude-security | Hidden: its scan is a Claude Code Workflow script. Use omp's `security_scan` tool |
| ponytail | `ponytail-bridge.ts` loads the bundled pi-extension (ruleset injection, `/ponytail` commands, subagents) |

### Git

The repo auto-update skips while the working tree is dirty, so uncommitted work pauses updates on this machine. Commit with plain `git` in `~/.local/share/chezmoi` once the user asks.
