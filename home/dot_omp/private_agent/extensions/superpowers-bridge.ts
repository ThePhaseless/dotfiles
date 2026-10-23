// Bridge for superpowers Claude Code plugin in omp.
// Injects the using-superpowers bootstrap into session context with omp-native
// tool mappings (task for subagents, todo for task tracking).
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const EXTREMELY_IMPORTANT_MARKER = "<EXTREMELY_IMPORTANT>";
const BOOTSTRAP_MARKER = "superpowers:using-superpowers bootstrap for omp";
const PLUGIN_ID = "superpowers@superpowers-dev";

interface PluginRegistry {
	plugins?: Record<string, Array<{ installPath?: string }>>;
}

interface ClaudeSettings {
	enabledPlugins?: Record<string, boolean>;
}

interface ExtensionMessage {
	role?: string;
	content?: unknown;
	timestamp?: number;
}

interface ExtensionContextEvent {
	messages: ExtensionMessage[];
}

interface ExtensionAPI {
	on(event: "resources_discover", handler: () => Promise<{ skillPaths: string[] }>): void;
	on(event: "session_start", handler: () => Promise<void> | void): void;
	on(event: "session_compact", handler: () => Promise<void> | void): void;
	on(event: "agent_end", handler: () => Promise<void> | void): void;
	on(
		event: "context",
		handler: (event: ExtensionContextEvent) => Promise<{ messages: ExtensionMessage[] } | void>,
	): void;
}

let cachedBootstrap: string | null | undefined;

function resolveSuperpowersSkillsDir(): string | null {
	const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
	try {
		const settingsPath = join(claudeDir, "settings.json");
		if (existsSync(settingsPath)) {
			const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as ClaudeSettings;
			if (settings.enabledPlugins?.[PLUGIN_ID] === false) return null;
		}
		const registryPath = join(claudeDir, "plugins", "installed_plugins.json");
		if (existsSync(registryPath)) {
			const registry = JSON.parse(readFileSync(registryPath, "utf8")) as PluginRegistry;
			const installPath = registry.plugins?.[PLUGIN_ID]?.[0]?.installPath;
			if (installPath && existsSync(join(installPath, "skills"))) {
				return join(installPath, "skills");
			}
		}
	} catch {
		// fall through to fallback paths
	}

	const fallbackRepo = join(claudeDir, "plugins", "marketplaces", "superpowers-dev", "skills");
	if (existsSync(fallbackRepo)) return fallbackRepo;

	return null;
}

function stripFrontmatter(content: string): string {
	const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
	return (match ? match[1] : content).trim();
}

function ompToolMapping(): string {
	return `## omp tool mapping

omp has native skills but does not expose Claude Code's \`Skill\` tool. When a Superpowers instruction says to invoke a skill, load the relevant \`SKILL.md\` via \`read skill://<name>\` (or let a human invoke \`/skill:<name>\` explicitly).

omp's built-in coding tools are lowercase: \`read\`, \`write\`, \`edit\`, \`bash\`, \`glob\`, and \`grep\`.

omp ships a first-class subagent tool: \`task\`. When Superpowers instructions say to dispatch a subagent (including Subagent general-purpose templates, background workers, or parallel research agents), use \`task\`.
- \`task\` supports concurrent batch spawns via \`tasks: [{ task, solutionSpace, agent?, effort? }]\` and shared \`context\`.
- Specialist agents available: \`scout\` (read-only search, code analysis, fast exploration), \`reviewer\` (diff/change review), \`security-reviewer\` (security audits), \`sonic\` (fast mechanical updates), and generic \`task\` (default).
- Never pass a \`model\` argument to \`task\` (omp routes subagent models via agent frontmatter and \`modelRoles\`).
- When adjusting subagent reasoning depth, use \`effort\` (\`"lo" | "med" | "hi"\`).
- To inspect or coordinate with subagents, use \`read agent://<id>\`, \`read history://<id>\`, or \`write agent://<id>\`.

omp ships a first-class task-list tool: \`todo\`. Use \`todo\` for task tracking whenever Superpowers instructions reference todos or task lists. Treat older \`TodoWrite\` references as the \`todo\` tool.`;
}

function getBootstrapContent(skillsDir: string): string | null {
	if (cachedBootstrap !== undefined) return cachedBootstrap;

	try {
		const bootstrapSkillPath = resolve(skillsDir, "using-superpowers", "SKILL.md");
		const skillContent = readFileSync(bootstrapSkillPath, "utf8");
		const body = stripFrontmatter(skillContent);
		cachedBootstrap = `${EXTREMELY_IMPORTANT_MARKER}
${BOOTSTRAP_MARKER}

You have superpowers.

The using-superpowers skill content is included below and is already loaded for this omp session. Follow it now. Do not try to load using-superpowers again.

${body}

${ompToolMapping()}
</EXTREMELY_IMPORTANT>`;
		return cachedBootstrap;
	} catch {
		cachedBootstrap = null;
		return null;
	}
}

function messageContainsBootstrap(message: ExtensionMessage): boolean {
	const content = message.content;
	if (typeof content === "string") {
		return (
			content.includes(BOOTSTRAP_MARKER) ||
			content.includes("superpowers:using-superpowers bootstrap")
		);
	}
	if (!Array.isArray(content)) return false;
	return content.some((part) => {
		if (!part || typeof part !== "object") return false;
		if ("type" in part && part.type === "text" && "text" in part && typeof part.text === "string") {
			return (
				part.text.includes(BOOTSTRAP_MARKER) ||
				part.text.includes("superpowers:using-superpowers bootstrap")
			);
		}
		return false;
	});
}

function firstNonCompactionSummaryIndex(messages: ExtensionMessage[]): number {
	let index = 0;
	while (messages[index]?.role === "compactionSummary") {
		index += 1;
	}
	return index;
}

export default function superpowersBridge(pi: ExtensionAPI): void {
	const skillsDir = resolveSuperpowersSkillsDir();
	if (!skillsDir) return;

	let injectBootstrap = true;

	pi.on("resources_discover", async () => ({
		skillPaths: [skillsDir],
	}));
	pi.on("session_start", () => {
		injectBootstrap = true;
	});

	pi.on("session_compact", () => {
		injectBootstrap = true;
	});

	pi.on("agent_end", () => {
		injectBootstrap = false;
	});

	pi.on("context", async (event) => {
		if (!injectBootstrap) return;
		if (event.messages.some(messageContainsBootstrap)) return;

		const bootstrap = getBootstrapContent(skillsDir);
		if (!bootstrap) return;

		const bootstrapMessage: ExtensionMessage = {
			role: "user",
			content: [{ type: "text", text: bootstrap }],
			timestamp: Date.now(),
		};

		const insertAt = firstNonCompactionSummaryIndex(event.messages);
		return {
			messages: [
				...event.messages.slice(0, insertAt),
				bootstrapMessage,
				...event.messages.slice(insertAt),
			],
		};
	});
}
