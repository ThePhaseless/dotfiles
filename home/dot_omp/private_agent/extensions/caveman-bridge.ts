// Reuse the caveman Claude Code plugin in omp. omp loads the plugin's skills and
// agents but not its hooks.json, so this does what caveman's SessionStart hook does:
// read the ruleset from the installed plugin and keep it in the system prompt.
// The text comes from Claude Code's copy, so it updates whenever that plugin does.
//
// It also stands in for two more hooks omp ignores. UserPromptSubmit: prompts go
// through the plugin's own parser (src/hooks/caveman-parse.js), so /caveman <mode>,
// /ultracave, /megacave, "stop caveman" and "normal mode" swap or drop the ruleset
// as they do in Claude Code. SubagentStart: omp rebinds this factory in every
// subagent session, so a subagent copies its parent's mode and gets nothing once
// caveman is off. The mode is kept in the omp session (appendEntry), never in
// ~/.claude, so Claude Code's own per-session flag files are left alone.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "caveman@caveman";
const STATE_TYPE = "caveman-bridge.mode";
const SKILL_MODES = new Set(["caveman", "ultracave", "megacave"]);
// One-shot modes run as their own omp skills; Claude Code keeps the prose ruleset through them.
const INDEPENDENT_MODES = new Set(["commit", "review", "compress"]);
// Same footer caveman-activate.js puts under the ruleset.
const SWITCH_LINE = 'Switch: /caveman, /ultracave, /megacave. Off: "stop caveman" or "normal mode".';

type ModeChange = { action: string; mode?: string; independentMode?: string } | null;

interface Plugin {
	root: string;
	defaultMode: (cwd?: string) => string;
	parse?: (prompt: string, options: { getDefaultMode: () => string }) => ModeChange;
}

// Mode each live session holds, by omp agent id, so a subagent can read its parent's.
// Shared because subagents rebind the same imported factory without re-evaluating this module.
const sessionModes = new Map<string, string | null>();

function loadPlugin(): Plugin | null {
	try {
		const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
		// Same rule omp uses for plugins: an explicit `false` in enabledPlugins turns it off.
		const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
		if (settings.enabledPlugins?.[PLUGIN_ID] === false) return null;
		const registry = JSON.parse(readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8"));
		const root: string | undefined = registry.plugins?.[PLUGIN_ID]?.[0]?.installPath;
		if (!root) return null;
		const plugin: Plugin = { root, defaultMode: () => process.env.CAVEMAN_DEFAULT_MODE || "caveman" };
		try {
			// Both files use only fs/path/os, which is why caveman's opencode plugin loads them too.
			const load = createRequire(join(root, "src", "hooks", "caveman-bridge.js"));
			const config = load("./caveman-config");
			if (typeof config?.getDefaultMode === "function") plugin.defaultMode = cwd => config.getDefaultMode(cwd);
			const parser = load("./caveman-parse");
			if (typeof parser?.parseModeChange === "function") plugin.parse = parser.parseModeChange;
		} catch {
			// Older or partial plugin: keep the startup ruleset, skip prompt switching.
		}
		return plugin;
	} catch {
		return null;
	}
}

function loadRuleset(root: string, mode: string): string | null {
	if (!SKILL_MODES.has(mode)) return null;
	try {
		const body = readFileSync(join(root, "skills", mode, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
		return `CAVEMAN MODE ACTIVE — mode: ${mode}\n\n${body.trimEnd()}\n\n${SWITCH_LINE}`;
	} catch {
		return null;
	}
}

// "manual" starts inactive until the user asks; "off" opts out entirely.
function startMode(plugin: Plugin, cwd?: string): string | null {
	const mode = plugin.defaultMode(cwd);
	return mode === "off" || mode === "manual" ? null : mode;
}

export default function cavemanBridge(pi: any) {
	let plugin: Plugin | null = null;
	let mode: string | null = null;
	let ruleset: string | null = null;
	let agentId = "";

	// A repo-local .caveman.json with defaultMode "off" silences caveman there, as in Claude Code.
	const optedOut = (ctx: any) => plugin?.defaultMode(ctx?.cwd) === "off";

	function setMode(next: string | null, ctx: any, inject = true) {
		mode = next;
		ruleset = plugin && next && inject ? loadRuleset(plugin.root, next) : null;
		sessionModes.set(agentId, mode);
		const shown = ruleset && mode && !optedOut(ctx);
		ctx?.ui?.setStatus?.("caveman", shown ? (mode === "caveman" ? "CAVEMAN" : `CAVEMAN:${mode.toUpperCase()}`) : undefined);
	}

	function restore(ctx: any) {
		plugin = loadPlugin();
		const agent = ctx?.agent;
		agentId = typeof agent?.id === "string" ? agent.id : "";
		if (!plugin) return setMode(null, ctx);
		if (agent?.kind === "sub") {
			// SubagentStart: read-only copy of the parent's mode. cavecrew agents carry their own voice.
			const parent = agent.parentId;
			const inherited = sessionModes.has(parent) ? (sessionModes.get(parent) ?? null) : startMode(plugin, ctx?.cwd);
			return setMode(inherited, ctx, !/(^|:)cavecrew-/.test(String(agent.name ?? "")));
		}
		// Last saved switch on this branch wins; none saved means the configured default, as in SessionStart.
		let saved: string | null | undefined;
		for (const entry of ctx?.sessionManager?.getBranch?.() ?? []) {
			if (entry?.type === "custom" && entry.customType === STATE_TYPE) saved = entry.data?.mode ?? null;
		}
		setMode(saved !== undefined ? saved : startMode(plugin, ctx?.cwd), ctx);
	}

	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
		pi.on(event, async (_event: unknown, ctx: any) => restore(ctx));
	}
	pi.on("session_shutdown", async () => {
		sessionModes.delete(agentId);
	});

	// UserPromptSubmit: switch mode from the prompt. Ordinary prompts pass through
	// unchanged; bare /caveman commands are consumed, since omp has no such command.
	pi.on("input", async (event: { text?: string }, ctx: any) => {
		const current = plugin;
		if (!current?.parse || ctx?.agent?.kind === "sub") return undefined;
		const text = typeof event?.text === "string" ? event.text : "";
		let change: ModeChange;
		try {
			change = current.parse(text, { getDefaultMode: () => current.defaultMode(ctx?.cwd) });
		} catch {
			return undefined;
		}
		if (!change) return undefined;
		if (change.action === "set" && INDEPENDENT_MODES.has(change.mode ?? "")) return undefined;

		const notify = (message: string, type: "info" | "warning" = "info") => ctx?.ui?.notify?.(message, type);
		if (change.action === "set" || change.action === "clear") {
			const next = change.action === "set" ? (change.mode ?? null) : null;
			if (next !== mode) {
				setMode(next, ctx);
				pi.appendEntry?.(STATE_TYPE, { mode: next });
			}
			notify(`Caveman mode: ${mode ?? "off"}`);
		} else if (change.action === "status") {
			notify(`Caveman mode: ${mode ?? "off"}`);
		} else if (change.action === "unresolved") {
			notify(
				change.independentMode
					? `${change.independentMode} mode has its own skill, /skill:caveman-${change.independentMode}. Mode unchanged.`
					: "Unrecognized /caveman argument. Modes: /caveman, /ultracave, /megacave; /caveman off to stop.",
				"warning",
			);
		}
		return text.trim().startsWith("/") ? { handled: true } : undefined;
	});

	pi.on("before_agent_start", async (event: { systemPrompt?: string[] }, ctx: any) => {
		if (!ruleset || optedOut(ctx)) return undefined;
		const base = Array.isArray(event?.systemPrompt) ? event.systemPrompt : [];
		if (base.includes(ruleset)) return undefined;
		return { systemPrompt: [...base, ruleset] };
	});
}
