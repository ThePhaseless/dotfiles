// Bridge for the ponytail Claude Code plugin in omp.
// Ponytail bundles an extension for pi/omp in pi-extension/index.js.
// This bridge resolves ponytail's installPath from installed_plugins.json,
// checks enabledPlugins in ~/.claude/settings.json, and delegates to the bundled extension.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN_ID = "ponytail@ponytail";

interface PluginRegistry {
	plugins?: Record<string, Array<{ installPath?: string }>>;
}

interface ClaudeSettings {
	enabledPlugins?: Record<string, boolean>;
}

export default async function ponytailBridge(pi: unknown): Promise<void> {
	let root: string | undefined;
	try {
		const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
		const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8")) as ClaudeSettings;
		if (settings.enabledPlugins?.[PLUGIN_ID] === false) return;
		const registry = JSON.parse(
			readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8"),
		) as PluginRegistry;
		root = registry.plugins?.[PLUGIN_ID]?.[0]?.installPath;
	} catch {
		return;
	}

	if (!root) return;

	try {
		const extPath = join(root, "pi-extension", "index.js");
		// Dynamic import required: plugin install path is resolved from runtime registry.
		const mod: unknown = await import(extPath);
		if (mod && typeof mod === "object") {
			const candidate = "default" in mod ? mod.default : mod;
			if (typeof candidate === "function") {
				await candidate(pi);
			}
		}
	} catch {
		// Fail open: plugin issues must not prevent session startup.
	}
}
