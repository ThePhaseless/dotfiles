// Reuse the i-have-adhd Claude Code plugin in omp.
// omp loads the plugin's skills but not its hooks.json, so this bridge provides
// parity: loading the ruleset from the installed plugin, supporting the always-on
// flag, toggling with /i-have-adhd, and carrying the mode to subagents.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "i-have-adhd@i-have-adhd";
const STATE_TYPE = "i-have-adhd-bridge.state";
const STOP_PHRASES: Record<string, true> = {
	"stop adhd mode": true,
	"normal mode": true,
};

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const OMP_AGENT_DIR = join(homedir(), ".omp", "agent");

interface PluginRegistry {
	plugins?: Record<string, Array<{ installPath?: string }>>;
}

interface ClaudeSettings {
	enabledPlugins?: Record<string, boolean>;
}

interface AdhdConfig {
	alwaysOn?: boolean;
	hideStatus?: boolean;
}

interface SessionEntry {
	type?: string;
	customType?: string;
	data?: {
		enabled?: boolean;
	};
}

interface ExtensionContext {
	agent?: {
		id?: string;
		parentId?: string;
		kind?: string;
		name?: string;
	};
	sessionManager?: {
		getBranch?: () => SessionEntry[];
	};
	ui?: {
		setStatus?: (key: string, status?: string) => void;
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
	};
}

interface AgentStartEvent {
	systemPrompt?: string[];
}

interface InputEvent {
	text?: string;
}

interface ExtensionAPI {
	on: (
		event: string,
		handler: (event: unknown, ctx: ExtensionContext) => Promise<unknown> | unknown,
	) => void;
	appendEntry?: (type: string, data: { enabled: boolean }) => void;
}

const sessionStates = new Map<string, boolean>();

function loadPluginRoot(): string | null {
	try {
		const settingsPath = join(CLAUDE_DIR, "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettings;
			if (settings.enabledPlugins?.[PLUGIN_ID] === false) return null;
		}

		const registryPath = join(CLAUDE_DIR, "plugins", "installed_plugins.json");
		if (!existsSync(registryPath)) return null;
		const registry = JSON.parse(readFileSync(registryPath, "utf8")) as PluginRegistry;
		return registry.plugins?.[PLUGIN_ID]?.[0]?.installPath ?? null;
	} catch {
		return null;
	}
}

function isAlwaysOn(): boolean {
	const claudeFlag = join(CLAUDE_DIR, ".i-have-adhd-always");
	const ompFlag = join(OMP_AGENT_DIR, ".i-have-adhd-always");
	if (existsSync(claudeFlag) || existsSync(ompFlag)) return true;

	try {
		const configPath = join(OMP_AGENT_DIR, "i-have-adhd.json");
		if (existsSync(configPath)) {
			const cfg = JSON.parse(readFileSync(configPath, "utf8")) as AdhdConfig;
			if (cfg.alwaysOn === true) return true;
		}
	} catch {
		// Ignore parse errors
	}
	return false;
}

function loadRuleset(root: string): string | null {
	try {
		const skillPath = join(root, "skills", "i-have-adhd", "SKILL.md");
		if (!existsSync(skillPath)) return null;
		const raw = readFileSync(skillPath, "utf8");
		const stripped = raw
			.replace(/^---[^\S\r\n]*\r?\n[\s\S]*?\r?\n---[^\S\r\n]*(?:\r?\n|$)/, "")
			.trim();
		if (!stripped) return null;
		return `ADHD MODE ACTIVE (always-on). The ruleset below applies to every response.\n"stop adhd mode" turns it off for this session.\n\n${stripped}`;
	} catch {
		return null;
	}
}

export default function iHaveAdhdBridge(pi: ExtensionAPI): void {
	let pluginRoot: string | null = null;
	let ruleset: string | null = null;
	let enabled = false;
	let agentId = "";

	function setStatus(ctx: ExtensionContext): void {
		ctx.ui?.setStatus?.("i-have-adhd", enabled ? "● ADHD ON" : undefined);
	}

	function setEnabled(next: boolean, ctx: ExtensionContext): void {
		enabled = next;
		sessionStates.set(agentId, enabled);
		setStatus(ctx);
	}

	function restore(ctx: ExtensionContext): void {
		pluginRoot = loadPluginRoot();
		ruleset = pluginRoot ? loadRuleset(pluginRoot) : null;
		const agent = ctx.agent;
		agentId = typeof agent?.id === "string" ? agent.id : "";
		if (!pluginRoot || !ruleset) {
			setEnabled(false, ctx);
			return;
		}

		if (agent?.kind === "sub") {
			const parent = agent.parentId ?? "";
			const inherited = sessionStates.has(parent) ? (sessionStates.get(parent) ?? isAlwaysOn()) : isAlwaysOn();
			setEnabled(inherited, ctx);
			return;
		}

		let saved: boolean | undefined;
		for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
			if (entry.type === "custom" && entry.customType === STATE_TYPE && typeof entry.data?.enabled === "boolean") {
				saved = entry.data.enabled;
			}
		}

		setEnabled(saved !== undefined ? saved : isAlwaysOn(), ctx);
	}

	for (const event of ["session_start", "session_switch", "session_branch", "session_tree"]) {
		pi.on(event, async (_event: unknown, ctx: ExtensionContext) => restore(ctx));
	}

	pi.on("session_shutdown", async () => {
		sessionStates.delete(agentId);
	});

	pi.on("input", async (event: unknown, ctx: ExtensionContext) => {
		if (!ruleset || ctx.agent?.kind === "sub") return undefined;
		const inputEvt = event as InputEvent | undefined;
		const rawText = typeof inputEvt?.text === "string" ? inputEvt.text.trim() : "";
		const text = rawText.toLowerCase();

		if (text === "/i-have-adhd" || text === "/i-have-adhd on" || text === "/skill:i-have-adhd") {
			const next = text === "/i-have-adhd" ? !enabled : true;
			setEnabled(next, ctx);
			pi.appendEntry?.(STATE_TYPE, { enabled: next });
			ctx.ui?.notify?.(`ADHD mode ${next ? "enabled" : "disabled"}`);
			return rawText.startsWith("/") ? { handled: true } : undefined;
		}

		if (text === "/i-have-adhd off" || text === "/i-have-adhd stop" || (enabled && STOP_PHRASES[text])) {
			setEnabled(false, ctx);
			pi.appendEntry?.(STATE_TYPE, { enabled: false });
			ctx.ui?.notify?.("ADHD mode disabled");
			return rawText.startsWith("/") ? { handled: true } : undefined;
		}

		return undefined;
	});

	pi.on("before_agent_start", async (event: unknown) => {
		if (!enabled || !ruleset) return undefined;
		const startEvent = event as AgentStartEvent | undefined;
		const base = Array.isArray(startEvent?.systemPrompt) ? startEvent.systemPrompt : [];
		if (base.includes(ruleset)) return undefined;
		return { systemPrompt: [...base, ruleset] };
	});
}
