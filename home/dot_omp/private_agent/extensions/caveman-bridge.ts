// Reuse the caveman Claude Code plugin in omp. omp loads the plugin's skills and
// agents but not its hooks.json, so this does what caveman's SessionStart hook does:
// read the ruleset from the installed plugin and keep it in the system prompt.
// The text comes from Claude Code's copy, so it updates whenever that plugin does.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "caveman@caveman";

function loadRuleset(): string | null {
	try {
		const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
		const registry = JSON.parse(readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8"));
		const root: string | undefined = registry.plugins?.[PLUGIN_ID]?.[0]?.installPath;
		if (!root) return null;
		const mode = process.env.CAVEMAN_DEFAULT_MODE || "caveman";
		const body = readFileSync(join(root, "skills", mode, "SKILL.md"), "utf8").replace(/^---[\s\S]*?---\s*/, "");
		return `CAVEMAN MODE ACTIVE — mode: ${mode}\n\n${body}`;
	} catch {
		return null;
	}
}

export default function cavemanBridge(pi: any) {
	let ruleset: string | null = null;

	pi.on("session_start", async (_event: unknown, ctx: any) => {
		ruleset = loadRuleset();
		if (ruleset) ctx?.ui?.setStatus?.("caveman", "CAVEMAN");
	});

	pi.on("before_agent_start", async (event: { systemPrompt?: string[] }) => {
		if (!ruleset) return undefined;
		const base = Array.isArray(event?.systemPrompt) ? event.systemPrompt : [];
		if (base.includes(ruleset)) return undefined;
		return { systemPrompt: [...base, ruleset] };
	});
}
