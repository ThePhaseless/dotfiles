// Reuse the impeccable Claude Code plugin's design hook in omp. omp loads the plugin's
// skills and agents but not its hooks.json, so this runs the same `impeccable hook`
// command on the same three moments and feeds its answers back through omp's own events:
//   SessionStart -> session_start / session_switch (exports land in process.env, notes go to the next turn)
//   PostToolUse (Edit|Write) -> tool_result on omp's edit/write tools (findings become additionalContext)
//   Stop -> session_stop (the deep pass's findings ask for one continuation turn)
// The command comes from Claude Code's copy of the plugin, so it updates whenever that plugin does.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGIN_ID = "impeccable@impeccable";
// Claude Code's matcher is "Edit|Write"; these are omp's tools for the same jobs.
const TOOLS: Record<string, string> = { edit: "Edit", write: "Write" };
// hooks.json allows 5s, 5s and 30s. omp cancels any handler after 30s, so Stop gets a bit less.
const START_TIMEOUT_MS = 5_000;
const EDIT_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 25_000;
const EDIT_BUDGET_MS = 25_000;

interface Plugin {
	root: string;
	launcher: string;
}

interface RunResult {
	code: number;
	stdout: string;
	stderr: string;
}

interface Reply {
	context?: string;
	block?: string;
	message?: string;
}

let mainSessionId: string | undefined;

function findPlugin(): Plugin | null {
	try {
		const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
		// Same rule omp uses for plugins: an explicit `false` in enabledPlugins turns it off.
		const settings = JSON.parse(readFileSync(join(claudeDir, "settings.json"), "utf8"));
		if (settings.enabledPlugins?.[PLUGIN_ID] === false) return null;
		const registry = JSON.parse(readFileSync(join(claudeDir, "plugins", "installed_plugins.json"), "utf8"));
		const entries = registry.plugins?.[PLUGIN_ID];
		const root: string | undefined = Array.isArray(entries)
			? entries.find((e: any) => e?.scope === "user")?.installPath
			: undefined;
		if (!root) return null;
		const launcher = join(root, "skills", "impeccable", "scripts", "impeccable");
		return statSync(launcher).isFile() ? { root, launcher } : null;
	} catch {
		return null;
	}
}

// Feed one Claude hook payload to `impeccable hook` on stdin. Resolves null on spawn
// failure, timeout or abort; the whole process group is killed so a hung launcher
// (it can fall back to downloading its engine) never outlives its budget.
function runHook(
	plugin: Plugin,
	payload: Record<string, unknown>,
	cwd: string,
	timeoutMs: number,
	extraEnv: Record<string, string> = {},
	signal?: AbortSignal,
): Promise<RunResult | null> {
	return new Promise(done => {
		if (signal?.aborted) return done(null);
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(plugin.launcher, ["hook"], {
				cwd,
				env: { ...process.env, CLAUDE_PLUGIN_ROOT: plugin.root, CLAUDE_PROJECT_DIR: cwd, ...extraEnv },
				stdio: ["pipe", "pipe", "pipe"],
				detached: true,
			});
		} catch {
			return done(null);
		}
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: RunResult | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", kill);
			done(result);
		};
		const kill = () => {
			try {
				if (child.pid) process.kill(-child.pid, "SIGKILL");
			} catch {
				child.kill("SIGKILL");
			}
			finish(null);
		};
		const timer = setTimeout(kill, timeoutMs);
		signal?.addEventListener("abort", kill, { once: true });
		child.stdout?.on("data", chunk => (stdout += chunk));
		child.stderr?.on("data", chunk => (stderr += chunk));
		child.on("error", () => finish(null));
		child.on("close", code => finish({ code: code ?? -1, stdout, stderr }));
		child.stdin?.on("error", () => {});
		child.stdin?.end(JSON.stringify(payload));
	});
}

// Claude's hook output contract: exit 2 sends stderr to the model; exit 0 may print JSON
// with hookSpecificOutput.additionalContext, decision/reason and systemMessage. Plain
// stdout only reaches the model on SessionStart.
function parseReply(result: RunResult | null, event: string): Reply {
	if (!result) return {};
	if (result.code === 2) return { block: result.stderr.trim() };
	if (result.code !== 0) return {};
	const text = result.stdout.trim();
	if (!text) return {};
	let json: any;
	try {
		json = JSON.parse(text);
	} catch {
		return event === "SessionStart" ? { context: text } : {};
	}
	const context = json?.hookSpecificOutput?.additionalContext;
	return {
		context: typeof context === "string" && context.trim() ? context.trim() : undefined,
		block: json?.decision === "block" ? (typeof json.reason === "string" ? json.reason.trim() : "") : undefined,
		message: typeof json?.systemMessage === "string" && json.systemMessage.trim() ? json.systemMessage : undefined,
	};
}

// Claude Code sources CLAUDE_ENV_FILE before each Bash command. omp re-snapshots
// process.env for its shells after session_start/session_switch handlers run.
function applyEnvFile(file: string) {
	let text = "";
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return;
	}
	for (const line of text.split("\n")) {
		const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*?)\s*$/.exec(line);
		if (!match) continue;
		let value = match[2];
		if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
			value = value.slice(1, -1).replace(/'\\''/g, "'");
		} else if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
			value = value.slice(1, -1).replace(/\\(["\\$`])/g, "$1");
		}
		process.env[match[1]] = value;
	}
}

function sessionIdFor(ctx: any): string {
	if (ctx?.agent?.kind === "sub" && mainSessionId) return mainSessionId;
	return ctx?.sessionManager?.getSessionId?.() ?? mainSessionId ?? "omp";
}

function toPath(raw: unknown, cwd: string): string | null {
	if (typeof raw !== "string" || !raw || raw.includes("://")) return null;
	if (raw === "~" || raw.startsWith("~/")) return join(homedir(), raw.slice(1));
	return resolve(cwd, raw);
}

export default function impeccableBridge(pi: any) {
	const notify = (ctx: any, text: string | undefined) => {
		if (text) ctx?.ui?.notify?.(text, "warning");
	};

	const sessionStart = async (ctx: any, source: string) => {
		if (ctx?.agent?.kind === "sub") return;
		const plugin = findPlugin();
		if (!plugin || !ctx?.cwd) return;
		const sessionId = sessionIdFor(ctx);
		mainSessionId = sessionId;
		let dir: string | undefined;
		let reply: Reply = {};
		try {
			dir = mkdtempSync(join(tmpdir(), "impeccable-omp-"));
			const envFile = join(dir, "env");
			writeFileSync(envFile, "");
			const payload = { session_id: sessionId, hook_event_name: "SessionStart", source, cwd: ctx.cwd };
			const result = await runHook(plugin, payload, ctx.cwd, START_TIMEOUT_MS, { CLAUDE_ENV_FILE: envFile });
			applyEnvFile(envFile);
			reply = parseReply(result, "SessionStart");
		} catch {
			// Treat a broken temp dir like a missing plugin.
		} finally {
			if (dir) rmSync(dir, { recursive: true, force: true });
		}
		// A blocking SessionStart only shows stderr to the user in Claude Code.
		notify(ctx, reply.message ?? reply.block);
		if (reply.context) {
			try {
				pi.sendMessage(
					{ customType: "impeccable-session-start", content: reply.context, display: false },
					{ deliverAs: "nextTurn" },
				);
			} catch {
				// Session not ready for messages; drop the note as a missing plugin would.
			}
		}
	};

	pi.on("session_start", async (_event: unknown, ctx: any) => sessionStart(ctx, "startup"));
	pi.on("session_switch", async (event: { reason?: string }, ctx: any) =>
		sessionStart(ctx, event?.reason === "new" ? "clear" : "resume"),
	);

	// PostToolUse fires only for calls that succeeded, once per file the tool touched.
	pi.on("tool_result", async (event: any, ctx: any) => {
		const toolName = TOOLS[event?.toolName];
		if (!toolName || event.isError || !ctx?.cwd) return undefined;
		const plugin = findPlugin();
		if (!plugin) return undefined;
		const input = event.input ?? {};
		const raw = Array.isArray(input.paths) && input.paths.length ? input.paths : [input.path];
		const files = [...new Set(raw.map((p: unknown) => toPath(p, ctx.cwd)).filter(Boolean))] as string[];
		const deadline = Date.now() + EDIT_BUDGET_MS;
		const contexts: string[] = [];
		for (const file of files) {
			const left = deadline - Date.now();
			if (left <= 0) break;
			const toolInput: Record<string, unknown> = { file_path: file };
			if (toolName === "Write" && typeof input.content === "string") toolInput.content = input.content;
			const payload = {
				session_id: sessionIdFor(ctx),
				hook_event_name: "PostToolUse",
				tool_name: toolName,
				tool_input: toolInput,
				tool_response: {},
				cwd: ctx.cwd,
			};
			const reply = parseReply(await runHook(plugin, payload, ctx.cwd, Math.min(EDIT_TIMEOUT_MS, left)), "PostToolUse");
			for (const text of [reply.block, reply.context]) if (text) contexts.push(text);
			notify(ctx, reply.message);
		}
		return contexts.length ? { additionalContext: contexts.join("\n\n") } : undefined;
	});

	// Stop findings go back to the model in Claude Code, so here they request a continuation.
	// stop_hook_active comes from omp and keeps the script's own loop guard working.
	pi.on("session_stop", async (event: any, ctx: any) => {
		const plugin = findPlugin();
		if (!plugin || !ctx?.cwd) return undefined;
		const payload = {
			session_id: event?.session_id ?? sessionIdFor(ctx),
			hook_event_name: "Stop",
			stop_hook_active: event?.stop_hook_active === true,
			cwd: ctx.cwd,
		};
		const result = await runHook(plugin, payload, ctx.cwd, STOP_TIMEOUT_MS, {}, event?.signal);
		const reply = parseReply(result, "Stop");
		notify(ctx, reply.message);
		if (reply.block !== undefined) return { decision: "block", reason: reply.block || reply.context || "" };
		if (reply.context) return { continue: true, additionalContext: reply.context };
		return undefined;
	});
}
