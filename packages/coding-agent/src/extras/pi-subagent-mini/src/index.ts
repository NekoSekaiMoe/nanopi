import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ModuleApi, ModuleContext, SessionStartEvent, ToolLoadout } from "../../../core/modules/types.ts";
import { APP_NAME, getPackageDir } from "../../../config.ts";
import { killProcessTree } from "../../../utils/shell.ts";

/**
 * pi-subagent-mini — one tool, four actions.
 * Children run `nanopi --mode json -p --no-session` and their final output is
 * delivered back via a steering message on completion (a new turn).
 *
 * Children see this build's compiled-in modules minus the interactive-only ones
 * (`CHILD_MODULE_SKIP`). The flag below keeps that choice in one place so a new
 * built-in module reaches children automatically instead of being missed by a
 * hand-maintained path list.
 */

const MAX_CONCURRENT = 4;
const DEFAULT_TOOLS = "read,bash,grep,find,ls";
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_WAIT_SEC = 120;
const MAX_REPORT_CHARS = 6000;
/** Characters of an archived (persisted) report we are willing to re-read. */
const MAX_ARCHIVE_CHARS = 16_000;
const ARCHIVE_VERSION = 1;
const ARCHIVE_TYPE = "subagent-job";
/** Same widget key pi-subagents uses, so pi-ui's flat skin picks this up too. */
const WIDGET_KEY = "subagent-async";
const WRITE_TOOLS = /^(write|edit|apply_patch)$/;
/** `write,edit` etc. — anything that can mutate the working tree. */
const canWrite = (tools: string): boolean => tools.split(",").some((name) => WRITE_TOOLS.test(name.trim()));

const DESCRIPTION_PREAMBLE =
	"You are a subagent, not the main agent: execute the task yourself, do not delegate or spawn subagents. " +
	"Your final message is relayed verbatim and is the only thing the main agent reads; nothing else you write reaches it.";

const DESCRIPTION_CONTRACT =
	"The `task` field carries the whole brief, in these four sections:\n" +
	"GOAL: one sentence, the outcome.\n" +
	"CONTEXT: file paths, facts already established, constraints.\n" +
	"EXPECTED OUTPUT: report shape, or the files the subagent must change.\n" +
	"STOP RULES: when to stop and report or ask instead of guessing.";

const DESCRIPTION_RESULT =
	"Report back with `Scope:` (what you were asked), then Result, Key files, Files changed, Issues. " +
	"No progress narration, no tool-call commentary, under 500 words unless the brief asks for more.";

const DESCRIPTION_TAIL =
	"spawn returns a jobId immediately; keep working meanwhile and the report arrives as a subagent-complete notification. " +
	"wait blocks (default 120s), status shows state, kill stops it. Follow-ups are a new spawn briefed with the previous report. " +
	"MCP tools (mcp__server__tool) exist only inside subagents — delegate MCP work here; the main agent cannot call them.";

/**
 * Built-in modules a child must not load: `pi-ui` renders a TUI footer and
 * `pi-rewind` keeps interactive checkpoints — both are inert but pointless in a
 * `-p` child, and `ask-lite`/`todo-lite` would only burn tokens on tools the
 * child's default tool list does not enable. Everything else (notably
 * `pi-fake-opencode`, whose OpenCode Zen header spoofing children need for
 * `opencode` models) is inherited from the parent build.
 */
const CHILD_MODULE_SKIP = new Set(["pi-ui", "pi-rewind", "ask-lite", "todo-lite"]);

interface Job {
	id: string;
	task: string;
	tools: string;
	status: "running" | "completed" | "failed" | "killed" | "timeout";
	finalOutput: string;
	errorMessage?: string;
	usage?: { input: number; output: number };
	truncated: boolean;
	startedAt: number;
	durationMs?: number;
	/** Absent for jobs recovered from the session archive. */
	proc?: ChildProcess;
	done: Promise<void>;
}

/** What `session_start` gives us for recovering jobs whose process is long gone. */
type RestoredJob = {
	id: string;
	status: Job["status"];
	task: string;
	scope: string;
	report: string;
	usage?: { input: number; output: number };
	startedAt: number;
	durationMs?: number;
};

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {} };
}

/**
 * The command that launches a child session.
 *
 * Reads the running package's own `bin` map rather than assuming a name: the
 * manifest exposes `nanopi` (this fork) where upstream pi exposed `pi`, and the
 * old `bin.pi` lookup silently returned undefined, so every spawn fell through
 * to a bare `pi` on PATH and died with "spawn pi ENOENT" wherever that command
 * does not exist — which is everywhere in a nanopi-only install.
 */
function resolveChildCommand(): { cmd: string; args: string[] } {
	try {
		const dir = getPackageDir();
		const bin = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).bin as
			| Record<string, string>
			| undefined;
		const entry = bin?.[APP_NAME] ?? Object.values(bin ?? {})[0];
		if (typeof entry === "string") return { cmd: process.execPath, args: [path.join(dir, entry)] };
	} catch {
		// fall through
	}
	// Not a nanopi checkout: fall back to whatever the user has on PATH.
	return { cmd: APP_NAME, args: [] };
}

function textOf(message: { content?: Array<{ type: string; text?: string }> }): string {
	return (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

/**
 * Whether the extra module's mcp subsystem switch is on. Mirrors packages/extra
 * settings (<agentDir>/extra/settings.json with a .nanopi/extra/settings.json
 * project override); default enabled.
 */
function isMcpSubsystemEnabled(): boolean {
	const read = (file: string): boolean | undefined => {
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			const value =
				parsed && typeof parsed === "object"
					? (parsed as { subsystems?: { mcp?: unknown } }).subsystems?.mcp
					: undefined;
			return typeof value === "boolean" ? value : undefined;
		} catch {
			return undefined;
		}
	};
	const agentDir = process.env.NANOPI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? ".", ".nanopi", "agent");
	return (
		read(path.join(process.cwd(), ".nanopi", "extra", "settings.json")) ??
		read(path.join(agentDir, "extra", "settings.json")) ??
		true
	);
}

/**
 * Built-in modules a child should load, derived from the modules this process
 * actually registered — not from a hand-written path list. The previous
 * `src/<pkg>/index.ts` guesses only existed in a source checkout, so bundled and
 * installed builds silently fell back to no modules at all.
 */
function childModuleNames(registered: readonly string[]): string[] {
	const names = registered.filter((name) => !CHILD_MODULE_SKIP.has(name));
	// MCP tools are subagent-only: mcp-lite has to come along or the `mcp__*`
	// tools added to the child's default tool list cannot resolve.
	return names.filter((name) => name !== "mcp-lite" || isMcpSubsystemEnabled());
}

/** The first line of a brief, which is the only honest one-line "what was asked". */
function scopeOf(task: string): string {
	const lines = task.split("\n").map((line) => line.trim());
	const goal = lines.find((line) => /^goal\s*:/i.test(line)) ?? lines.find((line) => line.length > 0) ?? task;
	const text = goal.replace(/^goal\s*:\s*/i, "").replace(/\s+/g, " ").trim();
	return text.length > 160 ? `${text.slice(0, 160)}…` : text || "(unnamed)";
}

/**
 * A report is the only thing that crosses back, so clipping must not drop the
 * conclusion: keep the head and the tail and say where the full text lives.
 */
function clipReport(report: string): { text: string; truncated: boolean } {
	if (report.length <= MAX_REPORT_CHARS) return { text: report, truncated: false };
	const head = report.slice(0, Math.floor(MAX_REPORT_CHARS * 0.6));
	const tail = report.slice(-Math.floor(MAX_REPORT_CHARS * 0.4));
	return { text: `${head}\n…(clipped)…\n${tail}`, truncated: true };
}

/** Report arrives as a notification; the archive is also what survives /compact and restarts. */
function archive(job: Job, scope: string): RestoredJob {
	return {
		id: job.id,
		status: job.status,
		task: job.task.slice(0, 2000),
		scope,
		report: job.finalOutput || job.errorMessage || "",
		usage: job.usage,
		startedAt: job.startedAt,
		durationMs: job.durationMs,
	};
}

export default function subagentMini(pi: ModuleApi): void {
	const jobs = new Map<string, Job>();
	let counter = 0;
	const childCommand = resolveChildCommand();
	let uiRef: { setWidget(key: string, content: unknown, options?: unknown): void } | undefined;
	let widgetTimer: NodeJS.Timeout | undefined;

	const widgetLines = (): string[] | undefined => {
		const running = [...jobs.values()].filter((j) => j.status === "running");
		if (running.length === 0) return undefined;
		const lines = [`● ${running.length} subagent${running.length > 1 ? "s" : ""} running`];
		for (const j of running) {
			const elapsed = Math.round((Date.now() - j.startedAt) / 1000);
			const task = j.task.length > 60 ? `${j.task.slice(0, 60)}…` : j.task.replace(/\s+/g, " ");
			lines.push(`  └ ${j.id} · ${elapsed}s · ${task}`);
		}
		return lines;
	};

	const refreshWidget = (): void => {
		if (!uiRef?.setWidget) return;
		try {
			uiRef.setWidget(WIDGET_KEY, widgetLines(), { placement: "belowEditor" });
		} catch {
			// widget is cosmetic; never break the tool flow
		}
	};

	const ensureWidgetTimer = (): void => {
		if (widgetTimer) return;
		widgetTimer = setInterval(() => {
			if (![...jobs.values()].some((j) => j.status === "running")) {
				clearInterval(widgetTimer);
				widgetTimer = undefined;
				refreshWidget(); // clears it (undefined lines)
				return;
			}
			refreshWidget();
		}, 1000);
		widgetTimer.unref?.();
	};

	let ctxSetStatus: (text: string | undefined) => void = () => undefined;

	const notify = (job: Job, scope: string): void => {
		const { text, truncated } = clipReport(job.finalOutput || job.errorMessage || "(no output)");
		try {
			pi.sendMessage(
				{
					customType: "subagent-complete",
					content: text,
					display: true,
					details: { jobId: job.id, status: job.status, scope, usage: job.usage, truncated },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		} catch (error) {
			// The notification is the only result channel: if it cannot be delivered,
			// the child's work is invisible, so leave a visible trace instead of
			// swallowing the failure.
			const message = error instanceof Error ? error.message : String(error);
			try {
				pi.appendEntry("subagent-complete-undelivered", { jobId: job.id, status: job.status, scope, message, text });
				ctxSetStatus(`subagent ${job.id} finished but its report could not be delivered: ${message}`);
			} catch {
				// nothing left to do; the report is still reachable through action=status
			}
		}
	};

	const spawnJob = (
		params: {
			task: string;
			scope: string;
			tools?: string;
			cwd?: string;
			model?: string;
			modules: string[];
			timeoutSec?: number;
		},
		ctxCwd: string,
	): Job => {
		const id = `sa-${++counter}`;
		const tools = params.tools || DEFAULT_TOOLS;
		// AGENTS.md stays on: the child has bash and can commit, so the repository
		// rules (no `git add -A`, `pnpm run check`, no emoji) are the cheapest thing
		// to keep. Skills and prompt templates are on-demand, so turning them off
		// saves startup scanning rather than tokens.
		const args = [
			...(childCommand.args ?? []),
			"--mode", "json", "-p", "--no-session",
			"--no-skills", "--no-prompt-templates",
			"-t", tools,
		];
		if (params.model) args.push("--model", params.model); // no -m short flag exists
		// Pin the child's module set explicitly instead of relying on discovery:
		// this is the only way a bundled install can hand the child `pi-fake-opencode`.
		args.push("--modules", params.modules.join(","));
		// The task must be the last argument: otherwise a following `--flag value`
		// pair would swallow it, and `parseArgs` would then take the orphaned
		// extension path as `parsed.messages[0]` — i.e. as the child's prompt.
		args.push(`Task: ${params.task}`);

		const proc = spawn(childCommand.cmd, args, {
			cwd: params.cwd || ctxCwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group on POSIX so kill/timeout can take the child's
			// grandchildren (dev servers it started) down with it.
			detached: process.platform !== "win32",
		});

		let lastAssistant:
			| { text: string; usage?: { input: number; output: number }; stopReason?: string; errorMessage?: string }
			| undefined;
		let stderrTail = "";
		let settled = false;

		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const job: Job = {
			id,
			task: params.task,
			tools,
			status: "running",
			finalOutput: "",
			truncated: false,
			startedAt: Date.now(),
			proc,
			done,
		};

		/** Archive the settled job so /compact or a restart does not orphan it. */
		const record = (): void => {
			try {
				pi.appendEntry(ARCHIVE_TYPE, { version: ARCHIVE_VERSION, ...archive(job, params.scope) });
			} catch {
				// archive is best-effort; the notification already went out
			}
		};

		const finish = (status: Job["status"], errorMessage?: string): void => {
			if (settled) return;
			settled = true;
			// `kill` and session shutdown mark the job first; the SIGKILL they send
			// must not be reported back as a child failure.
			if (job.status !== "running") {
				job.durationMs ??= Date.now() - job.startedAt;
				resolveDone();
				refreshWidget();
				return;
			}
			job.status = status;
			job.errorMessage = errorMessage;
			job.finalOutput = lastAssistant?.text ?? "";
			job.usage = lastAssistant?.usage;
			job.truncated = job.finalOutput.length > MAX_REPORT_CHARS;
			job.durationMs = Date.now() - job.startedAt;
			jobs.set(id, job); // keep for status/wait queries
			notify(job, params.scope);
			// Persist the full report: a restart or /compact otherwise forgets which
			// subagents ran, and the notification carries the clipped text only.
			record();
			resolveDone();
			refreshWidget();
		};

		// SIGTERM first so the child can flush, then SIGKILL the whole group it leads.
		const terminate = (graceful: boolean): void => {
			const pid = proc.pid;
			if (pid === undefined) {
				proc.kill(graceful ? "SIGTERM" : "SIGKILL");
				return;
			}
			if (graceful) {
				killProcessTree(pid, "SIGTERM");
				setTimeout(() => killProcessTree(pid), 3000).unref?.();
			} else {
				killProcessTree(pid);
			}
		};

		let buffer = "";
		proc.stdout?.on("data", (chunk: Buffer) => {
			buffer += chunk.toString("utf8");
			let nl: number;
			while ((nl = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, nl).trim();
				buffer = buffer.slice(nl + 1);
				if (!line) continue;
				try {
					const event = JSON.parse(line) as {
						type: string;
						message?: { role: string; content?: Array<{ type: string; text?: string }>; usage?: { input: number; output: number }; stopReason?: string; errorMessage?: string };
					};
					if (event.type === "message_end" && event.message?.role === "assistant" && event.message.stopReason && event.message.stopReason !== "pending") {
						lastAssistant = {
							text: textOf(event.message),
							usage: event.message.usage ? { input: event.message.usage.input ?? 0, output: event.message.usage.output ?? 0 } : undefined,
							stopReason: event.message.stopReason,
							errorMessage: event.message.errorMessage,
						};
					}
				} catch {
					// skip malformed line
				}
			}
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderrTail = `${stderrTail}${chunk.toString()}`.slice(-1500);
		});
		proc.on("error", (error: Error) => finish("failed", `spawn failed: ${error.message}`));
		// `close` (not `exit`) so the stdout pipe is drained before the report is read.
		proc.on("close", (code) => {
			if (settled) return;
			// A zero exit code does not mean the child succeeded: in `--mode json` an
			// API/auth failure arrives as an assistant message with stopReason "error"
			// and no content, and print mode only maps that to a nonzero exit in
			// text mode. Check the message itself instead of trusting the code.
			if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
				finish("failed", `model error${lastAssistant.errorMessage ? `: ${lastAssistant.errorMessage}` : ` (stopReason: ${lastAssistant.stopReason})`}`);
			} else if (lastAssistant) {
				if (code === 0 || code === null) finish("completed");
				else finish("failed", `exit ${code}${lastAssistant.errorMessage ? `: ${lastAssistant.errorMessage}` : ""}`);
			} else {
				finish("failed", `exit ${code}, no assistant output${stderrTail ? `: ${stderrTail.trim()}` : ""}`);
			}
		});

		const timeoutSec = params.timeoutSec ?? DEFAULT_TIMEOUT_SEC;
		const timer = setTimeout(() => {
			if (settled) return;
			terminate(true);
			finish("timeout", `timed out after ${timeoutSec}s`);
		}, timeoutSec * 1000);
		timer.unref?.();
		done.then(() => clearTimeout(timer));

		jobs.set(id, job);
		refreshWidget();
		ensureWidgetTimer();
		return job;
	};

	/** Rebuild the job table from the session archive so /compact or a restart does not orphan past jobs. */
	const restoreArchive = (ctx: Pick<ModuleContext, "sessionManager">): void => {
		if (jobs.size > 0) return;
		let restored = 0;
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type !== "custom" || entry.customType !== ARCHIVE_TYPE) continue;
			const data = entry.data as (RestoredJob & { version?: number }) | undefined;
			if (!data?.id || jobs.has(data.id)) continue;
			if (data.version !== ARCHIVE_VERSION) continue;
			restored++;
			const match = /^sa-(\d+)$/.exec(data.id);
			if (match) counter = Math.max(counter, Number(match[1]));
			jobs.set(data.id, {
				id: data.id,
				task: data.task,
				tools: DEFAULT_TOOLS,
				status: data.status,
				finalOutput: data.report,
				usage: data.usage,
				truncated: data.report.length > MAX_REPORT_CHARS,
				startedAt: data.startedAt,
				durationMs: data.durationMs,
				done: Promise.resolve(),
			});
		}
		if (restored > 0) refreshWidget();
	};

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		uiRef = ctx.ui as typeof uiRef;
		ctxSetStatus = (text) => ctx.ui.setStatus(WIDGET_KEY, text);
		if (event.reason === "new") jobs.clear();
		restoreArchive(ctx);
	});

	pi.on("session_shutdown", async () => {
		clearInterval(widgetTimer);
		widgetTimer = undefined;
		for (const job of jobs.values()) {
			if (job.status === "running") {
				const pid = job.proc?.pid;
				if (pid !== undefined) killProcessTree(pid);
				else job.proc?.kill("SIGKILL");
				job.status = "killed";
				job.errorMessage = "parent session shut down";
			}
		}
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `${DESCRIPTION_PREAMBLE}\n\n${DESCRIPTION_CONTRACT}\n\n${DESCRIPTION_RESULT}\n\n${DESCRIPTION_TAIL}`,
		promptSnippet: "Delegate self-contained tasks to an isolated subagent; result arrives via completion notification",
		promptGuidelines: [
			"Delegate context-heavy but self-contained work (multi-file reconnaissance, code review, long test/build runs) to subagent spawn with read-only tools; keep only the final report in this conversation. Add write/edit to tools only when the subagent should modify files.",
			"Write every spawn brief as GOAL / CONTEXT / EXPECTED OUTPUT / STOP RULES; a brief without paths and stop rules comes back as a question or a wrong guess.",
		],
		// The tool list is a contract, not a free-form string: a listed tool that
		// does not exist in this loadout is dropped instead of silently failing in
		// the child, and the child's order is pinned to the parent's so both sides
		// build the same `<rules>` block — tool order is the tail of the cached
		// prefix on Anthropic models, so a different order means zero cache hits.
		prepareLoadout(loadout: ToolLoadout) {
			const callable = new Set(loadout.callable.map((tool) => tool.name));
			const hidden = loadout.declared.filter((tool) => !WRITE_TOOLS.test(tool.name));
			const writable = [...new Set([...callable].filter((name) => WRITE_TOOLS.test(name)))];
			const defaults = [
				...loadout.declared.map((tool) => tool.name).filter((name) => callable.has(name)),
				...writable.filter((name) => !loadout.declared.some((tool) => tool.name === name)),
			];
			const notes = [
				defaults.length > 0 ? `default tools (parent's order, cache-friendly): ${defaults.join(",")}` : undefined,
				hidden.length > 0 ? `declare an equivalent: ${hidden.map((tool) => tool.name).join(",")}` : undefined,
			].filter(Boolean);
			if (notes.length === 0) return undefined;
			return { descriptions: { subagent: `${DESCRIPTION_PREAMBLE}\n\n${DESCRIPTION_CONTRACT}\n\n${notes.join(". ")}.\n\n${DESCRIPTION_RESULT}\n\n${DESCRIPTION_TAIL}` } };
		},
		parameters: Type.Object({
			action: Type.Union([Type.Literal("spawn"), Type.Literal("wait"), Type.Literal("status"), Type.Literal("kill")], { description: "default flow: spawn, then wait for the notification" }),
			task: Type.Optional(Type.String({ description: "spawn: the brief, as GOAL / CONTEXT / EXPECTED OUTPUT / STOP RULES" })),
			description: Type.Optional(Type.String({ description: "spawn: one-line scope shown in status and the notification (defaults to the brief's GOAL line)" })),
			tools: Type.Optional(Type.String({ description: `spawn: comma list, default ${DEFAULT_TOOLS}${" (plus mcp__* when MCP is enabled)"}` })),
			cwd: Type.Optional(Type.String({ description: "spawn: working directory" })),
			model: Type.Optional(Type.String({ description: "spawn: model id (provider/model); defaults to the current session model" })),
			modules: Type.Optional(Type.String({ description: "spawn: comma-separated built-in module names for the child, replacing the inherited set; default: this session's modules minus interactive-only ones" })),
			timeoutSec: Type.Optional(Type.Number({ description: `spawn: max seconds, default ${DEFAULT_TIMEOUT_SEC}` })),
			jobId: Type.Optional(Type.String({ description: "wait/status/kill: job id" })),
			waitSec: Type.Optional(Type.Number({ description: `wait: max seconds to block, default ${DEFAULT_WAIT_SEC}` })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!uiRef) uiRef = ctx.ui as unknown as typeof uiRef;
			if (params.action === "spawn") {
				if (!params.task?.trim()) return textResult("spawn requires 'task'");
				const running = [...jobs.values()].filter((j) => j.status === "running").length;
				if (running >= MAX_CONCURRENT) return textResult(`concurrency limit: ${running}/${MAX_CONCURRENT} subagents running; wait or kill one first`);
				// Two writers cannot be told apart file by file, and bash makes any child
				// writable in practice. Serialize writers instead of pretending a comment
				// in pi-smart-flow is enforcement; real isolation would need a worktree.
				const tools = params.tools || DEFAULT_TOOLS;
				const writer = [...jobs.values()].find((j) => j.status === "running" && canWrite(j.tools));
				if (canWrite(tools) && writer) {
					return textResult(`subagent ${writer.id} is already writing files; wait for it or spawn this one read-only`);
				}
				// Children inherit the session's current model by default; without this they
				// fall back to settings.json defaults, which may be stale or unusable.
				const model = params.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
				const modules = params.modules !== undefined
					? params.modules.split(",").map((s) => s.trim()).filter(Boolean)
					: childModuleNames(pi.getModuleNames());
				const scope = params.description?.trim() || scopeOf(params.task);
				const job = spawnJob({ task: params.task, scope, tools, cwd: params.cwd, model, modules, timeoutSec: params.timeoutSec }, ctx.cwd);
				return textResult(
					`subagent ${job.id} spawned (cwd: ${params.cwd || ctx.cwd}, tools: ${tools}, model: ${model || "default"}, modules: ${modules.length}).\n` +
					"A subagent-complete notification with its report arrives when done — continue other work meanwhile. action=status peeks, action=wait blocks, action=kill stops it.",
				);
			}

			const job = params.jobId ? jobs.get(params.jobId) : [...jobs.values()].filter((j) => j.status === "running").pop();
			if (!job) return textResult(`no subagent found (jobId: ${params.jobId ?? "?"}); known: ${[...jobs.keys()].slice(-10).join(", ") || "none"}`);

			if (params.action === "status") {
				const elapsed = Math.round((job.durationMs ?? Date.now() - job.startedAt) / 1000);
				const tail = (job.finalOutput || job.errorMessage || "(still running, no final output yet)").slice(-1500);
				return textResult(`subagent ${job.id}: ${job.status} (${elapsed}s, ${job.tools})\nscope: ${scopeOf(job.task)}\n\n${tail}`);
			}
			if (params.action === "wait") {
				const waitSec = params.waitSec ?? DEFAULT_WAIT_SEC;
				const timedOut = await Promise.race([
					job.done.then(() => false),
					new Promise<boolean>((resolve) => {
						// unref: a finished prompt must not keep the process alive for the wait.
						setTimeout(() => resolve(true), waitSec * 1000).unref?.();
					}),
				]);
				const report = job.finalOutput || job.errorMessage || "(no output)";
				// A waiting caller gets more than the notification's clipped text, but not
				// an unbounded report: MAX_REPORT_CHARS is a floor, MAX_ARCHIVE_CHARS the cap.
				const keep = Math.min(report.length, Math.max(MAX_REPORT_CHARS, MAX_ARCHIVE_CHARS));
				return textResult(
					`subagent ${job.id}: ${job.status}${timedOut ? " (wait timed out; still running)" : ""}\n\n${report.slice(-keep)}`,
				);
			}
			// kill
			if (job.status !== "running") return textResult(`subagent ${job.id} already ${job.status}; nothing to kill`);
			// Mark the job dead before signalling: killing the tree makes the child exit,
			// and its `close` handler must not rewrite the status to "failed".
			job.status = "killed";
			job.errorMessage = "killed by the main agent";
			job.durationMs = Date.now() - job.startedAt;
			try {
				pi.appendEntry(ARCHIVE_TYPE, { version: ARCHIVE_VERSION, ...archive(job, scopeOf(job.task)) });
			} catch {
				// archive is best-effort
			}
			const pid = job.proc?.pid;
			if (pid !== undefined) killProcessTree(pid);
			else job.proc?.kill("SIGTERM");
			refreshWidget();
			return textResult(`subagent ${job.id} killed`);
		},
	});
}
