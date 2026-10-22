import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type { ModuleApi, ModuleContext, SessionStartEvent, ToolLoadout } from "../../../core/modules/types.ts";
import { APP_NAME, getPackageDir } from "../../../config.ts";
import { isSingleNodeFileRuntime } from "../../../standalone/assets.ts";
import { killProcessTree } from "../../../utils/shell.ts";

/**
 * pi-subagent-mini — one tool, five actions.
 *
 * Children run `nanopi --mode json -p` with their own session file, so a child is
 * resumable: `action: "continue"` runs another turn on the same transcript instead
 * of briefing a fresh agent from scratch. The final output of each round comes back
 * as a custom message that starts a turn only when nobody else is running.
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
/** A retrying job gets this many attempts in total; the limit is code, not a prompt. */
const MAX_ATTEMPTS = 3;
/** A failed dependency fails its dependents instead of letting them run on missing work. */
const DEPENDENCY_STATUSES = new Set(["failed", "killed", "timeout", "blocked"]);
const ARCHIVE_VERSION = 2;
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
	"wait blocks (default 120s), status shows state, kill stops it, continue runs another turn on the same child session. " +
	"`dependsOn` holds a job until the jobs it names settle, `isolated: true` gives it its own git worktree, " +
	"`onFailure: \"retry\"` retries up to 3 attempts. " +
	"MCP tools (mcp__server__tool) exist only inside subagents and are not in the default child tool list: name them in `tools` when a child needs one. For a single MCP call use the `mcp` tool instead, which owns that brief.";

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
	model?: string;
	modules: string[];
	timeoutSec: number;
	onFailure: "retry" | "report";
	/** Job ids this one waits for, and the ones that were not settled when it was spawned. */
	dependsOn: string[];
	pendingDependencies: string[];
	/** `sa-3/attempt-2` for a retry; equal to `id` for a first attempt. */
	currentJobId: string;
	attempts: number;
	/** Working directory the job was spawned from; a worktree overrides it. */
	cwd?: string;
	/** Child session id, so a later `continue` resumes the same transcript. */
	sessionId?: string;
	/** `git worktree add` result: the directory comes from the tool, not from the model. */
	worktree?: { path: string; branch: string; merged?: boolean };
	/** True for a continue round: it appends to an existing transcript. */
	isContinue: boolean;
	/** Tail of the previous round's report, so a continue brief has the thread. */
	lastReport?: string;
	/** Distinguishes "never reported" from "reported nothing". */
	lastReportSet?: boolean;
	/** Clears the current attempt's timeout when it settles or is retried. */
	cancelTimeout?: () => void;
	status: "queued" | "blocked" | "running" | "completed" | "failed" | "killed" | "timeout";
	finalOutput: string;
	errorMessage?: string;
	usage?: { input: number; output: number };
	truncated: boolean;
	startedAt: number;
	durationMs?: number;
	/** Absent for jobs recovered from the session archive. */
	proc?: ChildProcess;
	done: Promise<void>;
	resolveDone: () => void;
}

/** What `session_start` gives us for recovering jobs whose process is long gone. */
type RestoredJob = {
	id: string;
	status: Job["status"];
	task: string;
	scope: string;
	report: string;
	sessionId?: string;
	worktree?: { path: string; branch: string; merged?: boolean };
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
 * The single-file distribution (nanopi.js) must run itself: `getPackageDir()`
 * points at the extracted asset cache there, whose package.json has no `bin`
 * entry for a child to run through node. Anything this process runs was
 * started by node, so `argv[1]` is the entry that is actually executing.
 */
function resolveChildCommand(): { cmd: string; args: string[] } {
	const entryPoint = process.argv[1];
	if (isSingleNodeFileRuntime() && entryPoint) return { cmd: process.execPath, args: [entryPoint] };
	try {
		const dir = getPackageDir();
		const bin = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")).bin as
			| Record<string, string>
			| undefined;
		const entry = bin?.[APP_NAME] ?? Object.values(bin ?? {})[0];
		// Resolve against the package dir and refuse a path that is not there: a
		// guess that does not exist only turns into a MODULE_NOT_FOUND crash
		// inside the child, where the reason is invisible to the parent.
		if (typeof entry === "string") {
			const candidate = path.join(dir, entry);
			if (existsSync(candidate)) return { cmd: process.execPath, args: [candidate] };
		}
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
	// MCP tools are subagent-only: mcp-lite has to come along or a `tools` list
	// naming `mcp__*` cannot resolve in the child.
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
		sessionId: job.sessionId,
		worktree: job.worktree,
		usage: job.usage,
		startedAt: job.startedAt,
		durationMs: job.durationMs,
	};
}

/** The child's cwd: the job's worktree, else the directory it was spawned from. */
function jobCwd(job: Job, fallback: string): string {
	return job.worktree?.path ?? job.cwd ?? fallback;
}

/** `sa-3` -> `3`; a retry id solves to the job it belongs to. */
function rootOf(id: string): string {
	return /^(sa-\d+)(?:\/attempt-\d+)?$/.exec(id)?.[1] ?? id;
}

function isPending(status: Job["status"]): boolean {
	return status === "queued" || status === "blocked" || status === "running";
}

export default function subagentMini(pi: ModuleApi): void {
	const jobs = new Map<string, Job>();
	let counter = 0;
	const childCommand = resolveChildCommand();
	let uiRef: { setWidget(key: string, content: unknown, options?: unknown): void } | undefined;
	let widgetTimer: NodeJS.Timeout | undefined;

	const widgetLines = (): string[] | undefined => {
		const active = [...jobs.values()].filter((j) => isPending(j.status));
		if (active.length === 0) return undefined;
		const running = active.filter((j) => j.status === "running").length;
		const lines = [
			`● ${running} subagent${running === 1 ? "" : "s"} running${active.length > running ? `, ${active.length - running} waiting` : ""}`,
		];
		for (const j of active) {
			const label = j.status === "running" ? `${Math.round((Date.now() - j.startedAt) / 1000)}s` : j.status;
			const task = j.task.length > 60 ? `${j.task.slice(0, 60)}…` : j.task.replace(/\s+/g, " ");
			lines.push(`  └ ${j.id} · ${label} · ${task}`);
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
			if (![...jobs.values()].some((j) => isPending(j.status))) {
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

	/**
	 * Hand the report over as a custom message. `deliverMessage` says where it
	 * landed: a job that finishes while the parent is mid-turn is queued instead of
	 * starting a turn with no reader, which is how reports used to disappear.
	 */
	const notify = (job: Job, scope: string): void => {
		const { text, truncated } = clipReport(job.finalOutput || job.errorMessage || "(no output)");
		const message = {
			customType: "subagent-complete",
			content: text,
			display: true,
			details: {
				jobId: job.id,
				status: job.status,
				scope,
				usage: job.usage,
				truncated,
				sessionId: job.sessionId,
				worktree: job.worktree,
			},
		};
		// Deliberately not awaited end to end: a start resolves as soon as the turn is
		// running, so waiting on it here would keep `finish()` inside the agent's own
		// settle path. The archive is written after delivery so it records where the
		// report landed.
		void (async () => {
			try {
				const delivery = await pi.deliverMessage(message, { startTurn: true });
				pi.appendEntry(ARCHIVE_TYPE, {
					version: ARCHIVE_VERSION,
					...archive(job, scope),
					delivered: delivery,
				});
			} catch (error) {
				// The notification is the only result channel: if it cannot be delivered,
				// the child's work is invisible, so leave a visible trace instead of
				// swallowing the failure.
				const reason = error instanceof Error ? error.message : String(error);
				try {
					pi.appendEntry("subagent-complete-undelivered", {
						jobId: job.id,
						status: job.status,
						scope,
						message: reason,
						text,
					});
					ctxSetStatus(`subagent ${job.id} finished but its report could not be delivered: ${reason}`);
				} catch {
					// nothing left to do; the report is still reachable through action=status
				}
			}
		})();
	};

	/** Run `git` in the job's directory. Returns stdout; throws with stderr on failure. */
	const git = (cwd: string, args: string[]): string => {
		const result = spawnSync("git", args, { cwd, encoding: "utf8" });
		if (result.error) throw result.error;
		if (result.status !== 0) {
			throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
		}
		return (result.stdout ?? "").trim();
	};

	/**
	 * Give the job its own working tree. The path is derived here, never copied from
	 * a brief: a model that has to invent a directory invents a conflicting one.
	 */
	const createWorktree = (job: Job, baseCwd: string): void => {
		const top = git(baseCwd, ["rev-parse", "--show-toplevel"]);
		const dir = path.join(top, "..", `.${path.basename(top)}-subagent-${job.id}`);
		const branch = `subagent/${job.id}`;
		git(top, ["worktree", "add", "-b", branch, dir, "HEAD"]);
		job.worktree = { path: path.resolve(dir), branch };
	};

	/**
	 * Remove a finished job's worktree. `merged` keeps its commits by merging the
	 * branch; a failed or abandoned job drops the branch instead, so a half-finished
	 * tree never lands in the main checkout. The tree itself is always removed — it is
	 * scratch space, not an archive.
	 */
	const removeWorktree = (job: Job, baseCwd: string, merged: boolean): void => {
		const worktree = job.worktree;
		if (!worktree || worktree.merged !== undefined) return;
		worktree.merged = merged;
		try {
			const top = git(baseCwd, ["rev-parse", "--show-toplevel"]);
			git(top, ["worktree", "remove", "--force", worktree.path]);
			git(top, ["worktree", "prune"]);
			if (merged) git(top, ["merge", "--no-edit", worktree.branch]);
			else git(top, ["branch", "-D", worktree.branch]);
		} catch {
			// The tree is a convenience; a failed cleanup must not fail the job.
			rmSync(worktree.path, { recursive: true, force: true });
		}
	};

	/** Persist the settled job so /compact or a restart does not orphan it. */
	const record = (job: Job, scope: string): void => {
		try {
			pi.appendEntry(ARCHIVE_TYPE, { version: ARCHIVE_VERSION, ...archive(job, scope) });
		} catch {
			// archive is best-effort; the notification already went out
		}
	};

	/** Launch one child process for `job` (a first attempt or a retry) and wire its report. */
	const launch = (job: Job, prompt: string, baseCwd: string): void => {
		// A retry replaces the previous attempt's process and its timeout.
		job.cancelTimeout?.();
		const attempt = job.attempts + 1;
		job.attempts = attempt;
		job.currentJobId = attempt === 1 ? job.id : `${job.id}/attempt-${attempt}`;
		job.status = "running";
		if (attempt === 1) job.startedAt = Date.now();

		// AGENTS.md stays on: the child has bash and can commit, so the repository
		// rules (no `git add -A`, `pnpm run check`, no emoji) are the cheapest thing
		// to keep. Skills and prompt templates are on-demand, so turning them off
		// saves startup scanning rather than tokens.
		const args = [...childCommand.args, "--mode", "json", "-p", "--no-skills", "--no-prompt-templates"];
		// A child session is a file we own: `--session <id>` reuses the same id and
		// directory the tool recorded, so a later `continue` appends to the growing
		// transcript instead of meeting the id in a different project directory.
		if (job.sessionId) args.push("--session", job.sessionId);
		args.push("-t", job.tools);
		if (job.model) args.push("--model", job.model); // no -m short flag exists
		// Pin the child's module set explicitly instead of relying on discovery:
		// this is the only way a bundled install can hand the child `pi-fake-opencode`.
		args.push("--modules", job.modules.join(","));
		// The task must be the last argument: otherwise a following `--flag value`
		// pair would swallow it, and `parseArgs` would then take the orphaned
		// extension path as `parsed.messages[0]` — i.e. as the child's prompt.
		args.push(prompt);

		const proc = spawn(childCommand.cmd, args, {
			cwd: jobCwd(job, baseCwd),
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			// Own process group on POSIX so kill/timeout can take the child's
			// grandchildren (dev servers it started) down with it.
			detached: process.platform !== "win32",
		});
		job.proc = proc;

		let lastAssistant:
			| { text: string; usage?: { input: number; output: number }; stopReason?: string; errorMessage?: string }
			| undefined;
		let stderrTail = "";
		let attemptSettled = false;

		/** End this attempt: retry, or settle the job and report. */
		const finish = (status: Job["status"], errorMessage?: string): void => {
			if (attemptSettled) return;
			attemptSettled = true;
			job.cancelTimeout?.();
			job.cancelTimeout = undefined;
			if (job.status !== "running") {
				// `kill` and session shutdown mark the job first; the SIGKILL they send
				// must not be reported back as a child failure.
				job.durationMs ??= Date.now() - job.startedAt;
				job.resolveDone();
				refreshWidget();
				return;
			}
			job.finalOutput = lastAssistant?.text ?? "";
			job.usage = lastAssistant?.usage;
			job.durationMs = Date.now() - job.startedAt;
			if (status !== "completed" && job.onFailure === "retry" && job.attempts < MAX_ATTEMPTS) {
				// The retry brief says what went wrong; without that the child re-runs
				// the same failing path and the second attempt is just the first one's cost.
				const context = errorMessage ? `Previous attempt failed: ${errorMessage}\n\n` : "";
				launch(job, `${context}${prompt}`, baseCwd);
				refreshWidget();
				return;
			}
			job.status = status;
			job.errorMessage = errorMessage;
			job.truncated = job.finalOutput.length > MAX_REPORT_CHARS;
			job.lastReport = job.finalOutput || errorMessage || "";
			job.lastReportSet = true;
			if (job.worktree) removeWorktree(job, baseCwd, status === "completed");
			notify(job, scopeOf(job.task));
			// Persist the full report: a restart or /compact otherwise forgets which
			// subagents ran, and the notification carries the clipped text only.
			record(job, scopeOf(job.task));
			job.resolveDone();
			releaseDependents(job.cwd ?? baseCwd);
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
						message?: {
							role: string;
							content?: Array<{ type: string; text?: string }>;
							usage?: { input: number; output: number };
							stopReason?: string;
							errorMessage?: string;
						};
					};
					if (
						event.type === "message_end" &&
						event.message?.role === "assistant" &&
						event.message.stopReason &&
						event.message.stopReason !== "pending"
					) {
						lastAssistant = {
							text: textOf(event.message),
							usage: event.message.usage
								? { input: event.message.usage.input ?? 0, output: event.message.usage.output ?? 0 }
								: undefined,
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
			if (attemptSettled) return;
			// A zero exit code does not mean the child succeeded: in `--mode json` an
			// API/auth failure arrives as an assistant message with stopReason "error"
			// and no content, and print mode only maps that to a nonzero exit in
			// text mode. Check the message itself instead of trusting the code.
			if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
				finish(
					"failed",
					`model error${lastAssistant.errorMessage ? `: ${lastAssistant.errorMessage}` : ` (stopReason: ${lastAssistant.stopReason})`}`,
				);
			} else if (lastAssistant) {
				if (code === 0 || code === null) finish("completed");
				else finish("failed", `exit ${code}${lastAssistant.errorMessage ? `: ${lastAssistant.errorMessage}` : ""}`);
			} else {
				// Name the command: a child that died before producing any event
				// (missing entry point, wrong resolution) is otherwise reported as a
				// bare exit code with a Node stack the parent cannot attribute.
				const launched = [childCommand.cmd, ...childCommand.args].join(" ");
				const why = stderrTail ? `: ${stderrTail.trim()}` : "";
				finish("failed", `exit ${code}, no assistant output (launched: ${launched})${why}`);
			}
		});

		const timer = setTimeout(() => {
			if (attemptSettled) return;
			terminate(true);
			finish("timeout", `timed out after ${job.timeoutSec}s`);
		}, job.timeoutSec * 1000);
		timer.unref?.();
		// The attempt can also end on `error` or `close`; a retry replaces this timer.
		job.cancelTimeout = () => clearTimeout(timer);
	};

	/** Jobs whose dependencies have all settled; a failed dependency blocks its dependents. */
	const releaseDependents = (baseCwd: string): void => {
		let changed = true;
		while (changed) {
			changed = false;
			for (const job of jobs.values()) {
				if (job.status !== "queued" && job.status !== "blocked") continue;
				job.pendingDependencies = job.pendingDependencies.filter((id) => {
					const dependency = jobs.get(id);
					return dependency !== undefined && isPending(dependency.status);
				});
				if (job.pendingDependencies.length > 0) continue;
				const failed = job.dependsOn
					.map((id) => jobs.get(id))
					.find((dependency) => dependency && DEPENDENCY_STATUSES.has(dependency.status));
				if (failed) {
					job.status = "blocked";
					job.errorMessage = `dependency ${failed.id} ${failed.status}`;
					job.durationMs = Date.now() - job.startedAt;
					notify(job, scopeOf(job.task));
					record(job, scopeOf(job.task));
					job.resolveDone();
				} else {
					launch(job, job.task, baseCwd);
				}
				changed = true;
			}
		}
		refreshWidget();
	};

	const spawnJob = (
		params: {
			task: string;
			tools?: string;
			model?: string;
			modules: string[];
			timeoutSec?: number;
			onFailure?: "retry" | "report";
			dependsOn?: string[];
			isolated?: boolean;
			cwd?: string;
		},
		baseCwd: string,
	):
		| { ok: true; job: Job }
		| { ok: false; error: string } => {
		const id = `sa-${++counter}`;
		const tools = params.tools || DEFAULT_TOOLS;
		// Pin the base directory now: the job may start after the parent session has
		// moved on, and its cwd is where it was spawned from, not where we are then.
		const cwd = params.cwd || baseCwd;
		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>((resolve) => {
			resolveDone = resolve;
		});
		const job: Job = {
			id,
			task: `Task: ${params.task}`,
			tools,
			model: params.model,
			modules: params.modules,
			timeoutSec: params.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
			onFailure: params.onFailure ?? "report",
			dependsOn: params.dependsOn ?? [],
			pendingDependencies: [],
			currentJobId: id,
			attempts: 0,
			isContinue: false,
			status: "queued",
			finalOutput: "",
			truncated: false,
			startedAt: Date.now(),
			cwd,
			done,
			resolveDone,
		};
		jobs.set(id, job);
		if (params.isolated) {
			try {
				createWorktree(job, baseCwd);
			} catch (error) {
				jobs.delete(id);
				return { ok: false, error: `isolated: could not create a worktree: ${(error as Error).message}` };
			}
		}
		job.pendingDependencies = job.dependsOn.filter((dependencyId) => {
			const dependency = jobs.get(dependencyId);
			return dependency !== undefined && isPending(dependency.status);
		});
		if (job.pendingDependencies.length === 0) launch(job, job.task, cwd);
		refreshWidget();
		ensureWidgetTimer();
		return { ok: true, job };
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
				model: undefined,
				modules: [],
				timeoutSec: DEFAULT_TIMEOUT_SEC,
				onFailure: "report",
				dependsOn: [],
				pendingDependencies: [],
				currentJobId: data.id,
				attempts: 1,
				sessionId: data.sessionId,
				worktree: data.worktree,
				isContinue: false,
				lastReport: data.report,
				lastReportSet: true,
				status: data.status,
				finalOutput: data.report,
				usage: data.usage,
				truncated: data.report.length > MAX_REPORT_CHARS,
				startedAt: data.startedAt,
				durationMs: data.durationMs,
				done: Promise.resolve(),
				resolveDone: () => undefined,
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
			if (!isPending(job.status)) continue;
			job.cancelTimeout?.();
			const pid = job.proc?.pid;
			if (pid !== undefined) killProcessTree(pid);
			else job.proc?.kill("SIGKILL");
			job.status = "killed";
			job.errorMessage = "parent session shut down";
			job.durationMs = Date.now() - job.startedAt;
			job.resolveDone();
		}
		for (const job of jobs.values()) {
			if (job.worktree) removeWorktree(job, job.cwd || process.cwd(), false);
		}
	});

	const jobCwdLabel = (job: Job): string => (job.worktree ? job.worktree.path : job.cwd || "(session cwd)");

	const jobSummary = (job: Job): string => {
		const where = jobCwdLabel(job);
		const waiting =
			job.pendingDependencies.length > 0 ? `, waiting on ${job.pendingDependencies.join(", ")}` : "";
		const round = job.isContinue ? ", continuing an existing child session" : "";
		return `subagent ${job.id}: ${job.status}${waiting} (cwd: ${where}, tools: ${job.tools}, model: ${job.model || "default"}, modules: ${job.modules.length || "inherited"}, onFailure: ${job.onFailure}, attempt ${job.attempts}/${MAX_ATTEMPTS}${round})`;
	};

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: `${DESCRIPTION_PREAMBLE}\n\n${DESCRIPTION_CONTRACT}\n\n${DESCRIPTION_RESULT}\n\n${DESCRIPTION_TAIL}`,
		promptSnippet:
			"Delegate self-contained tasks to an isolated subagent; result arrives via completion notification",
		promptGuidelines: [
			"Delegate context-heavy but self-contained work (multi-file reconnaissance, code review, long test/build runs) to subagent spawn with read-only tools; keep only the final report in this conversation. Add write/edit to tools only when the subagent should modify files.",
			"Write every spawn brief as GOAL / CONTEXT / EXPECTED OUTPUT / STOP RULES; a brief without paths and stop rules comes back as a question or a wrong guess.",
			"Subagents share one working tree and `bash` makes every child a potential writer: run at most one writing subagent at a time, or pass `isolated: true` so each writer gets its own git worktree (the tool creates it, merges the branch when the job completes, and drops it when the job fails).",
			"Chain jobs with `dependsOn` instead of polling: the dependent starts when the jobs it names settle, and a failed dependency blocks it. Set `onFailure: \"retry\"` for flaky work; the retry limit is fixed at 3 attempts and not something to enforce in the brief.",
			"Use `action: \"continue\"` to keep working in a child's own session. The child keeps its transcript, so the brief only has to say what changed; the previous report is passed along automatically.",
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
			return {
				descriptions: {
					subagent: `${DESCRIPTION_PREAMBLE}\n\n${DESCRIPTION_CONTRACT}\n\n${notes.join(". ")}.\n\n${DESCRIPTION_RESULT}\n\n${DESCRIPTION_TAIL}`,
				},
			};
		},
		parameters: Type.Object({
			action: Type.Union(
				[
					Type.Literal("spawn"),
					Type.Literal("wait"),
					Type.Literal("status"),
					Type.Literal("kill"),
					Type.Literal("continue"),
				],
				{ description: "default flow: spawn, then wait for the notification" },
			),
			task: Type.Optional(
				Type.String({ description: "spawn/continue: the brief, as GOAL / CONTEXT / EXPECTED OUTPUT / STOP RULES" }),
			),
			description: Type.Optional(
				Type.String({
					description: "spawn/continue: one-line scope shown in status and the notification (defaults to the brief's GOAL line)",
				}),
			),
			tools: Type.Optional(
				Type.String({
					description: `spawn/continue: comma list, default ${DEFAULT_TOOLS}; MCP tools (mcp__*) are never added implicitly, name them here`,
				}),
			),
			model: Type.Optional(
				Type.String({ description: "spawn/continue: model id (provider/model); defaults to the current session model" }),
			),
			modules: Type.Optional(
				Type.String({
					description:
						"spawn/continue: comma-separated built-in module names for the child, replacing the inherited set; default: this session's modules minus interactive-only ones",
				}),
			),
			timeoutSec: Type.Optional(
				Type.Number({ description: `spawn/continue: max seconds per attempt, default ${DEFAULT_TIMEOUT_SEC}` }),
			),
			onFailure: Type.Optional(
				Type.Union([Type.Literal("retry"), Type.Literal("report")], {
					description: `spawn/continue: "retry" reruns a failed attempt up to ${MAX_ATTEMPTS} attempts in total, "report" (default) reports the failure as it is`,
				}),
			),
			dependsOn: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"spawn: job ids that must settle first. The job starts when all of them settle; a failed dependency blocks it instead of running it on missing work.",
				}),
			),
			isolated: Type.Optional(
				Type.Boolean({
					description:
						"spawn/continue: give the job its own git worktree (branch subagent/<jobId>). The tool creates and removes it; do not pass `cwd` with it.",
				}),
			),
			cwd: Type.Optional(
				Type.String({ description: "spawn: working directory (default: session cwd; rejected with isolated: true)" }),
			),
			jobId: Type.Optional(Type.String({ description: "wait/status/kill/continue: job id" })),
			waitSec: Type.Optional(Type.Number({ description: `wait: max seconds to block, default ${DEFAULT_WAIT_SEC}` })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!uiRef) uiRef = ctx.ui as unknown as typeof uiRef;

			const inheritedModules = (): string[] =>
				params.modules !== undefined
					? params.modules.split(",").map((s) => s.trim()).filter(Boolean)
					: childModuleNames(pi.getModuleNames());
			// Children inherit the session's current model by default; without this they
			// fall back to settings.json defaults, which may be stale or unusable.
			const inheritedModel = (): string | undefined =>
				params.model || (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);

			if (params.action === "spawn") {
				if (!params.task?.trim()) return textResult("spawn requires 'task'");
				const tools = params.tools || DEFAULT_TOOLS;
				const running = [...jobs.values()].filter((j) => isPending(j.status)).length;
				if (running >= MAX_CONCURRENT) {
					return textResult(
						`concurrency limit: ${running}/${MAX_CONCURRENT} subagents running; wait or kill one first`,
					);
				}
				// Two writers cannot be told apart file by file, and bash makes any child
				// writable in practice. Serialize writers instead of pretending a comment
				// in pi-smart-flow is enforcement; isolated writers get their own tree.
				const writer = [...jobs.values()].find((j) => isPending(j.status) && canWrite(j.tools) && !j.worktree);
				if (canWrite(tools) && writer && !params.isolated) {
					return textResult(
						`subagent ${writer.id} is already writing files; wait for it, pass isolated: true, or spawn this one read-only`,
					);
				}
				if (params.isolated && params.cwd !== undefined) {
					// The tree is derived, not supplied: a second source for cwd is exactly what
					// let models copy a path that does not exist.
					return textResult("isolated: true derives the working directory itself; drop `cwd`");
				}
				// A dependency that does not exist can never settle. Refuse the spawn instead
				// of starting a job that waits forever.
				const dependsOn = [...new Set(params.dependsOn ?? [])].map(rootOf);
				const unknown = dependsOn.filter((id) => !jobs.has(id));
				if (unknown.length > 0) {
					return textResult(
						`unknown dependency: ${unknown.join(", ")}; known: ${[...jobs.keys()].slice(-10).join(", ") || "none"}`,
					);
				}
				const spawned = spawnJob(
					{
						task: `Task: ${params.task}`,
						tools,
						model: inheritedModel(),
						modules: inheritedModules(),
						timeoutSec: params.timeoutSec,
						onFailure: params.onFailure,
						dependsOn,
						isolated: params.isolated === true,
						cwd: params.cwd,
					},
					ctx.cwd,
				);
				if (!spawned.ok) return textResult(spawned.error);
				const job = spawned.job;
				return textResult(
					`${jobSummary(job)}.\n` +
						(job.status === "running"
							? "A subagent-complete notification with its report arrives when done — continue other work meanwhile."
							: `It starts once ${job.pendingDependencies.join(", ")} settles; the report arrives then.`) +
						" action=status peeks, action=wait blocks, action=kill stops it.",
				);
			}

			const target = (): Job | undefined => {
				const id = params.jobId ? rootOf(params.jobId) : [...jobs.keys()].pop();
				return id ? jobs.get(id) : undefined;
			};
			const job = target();
			if (!job) {
				return textResult(
					`no subagent found (jobId: ${params.jobId ?? "?"}); known: ${[...jobs.keys()].slice(-10).join(", ") || "none"}`,
				);
			}

			if (params.action === "status") {
				const elapsed = Math.round((job.durationMs ?? Date.now() - job.startedAt) / 1000);
				const tail = (job.finalOutput || job.errorMessage || "(still running, no final output yet)").slice(-1500);
				const session = job.sessionId ? `\nsession: ${job.sessionId} (action=continue resumes it)` : "";
				return textResult(`${jobSummary(job)} (${elapsed}s)\nscope: ${scopeOf(job.task)}${session}\n\n${tail}`);
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

			if (params.action === "continue") {
				if (!params.task?.trim()) return textResult("continue requires 'task'");
				if (isPending(job.status)) {
					return textResult(`subagent ${job.id} is still ${job.status}; wait for it before continuing it`);
				}
				if (job.sessionId === undefined) {
					return textResult(
						`subagent ${job.id} has no child session to continue (it was created before sessions were kept); spawn a new one with the previous report as CONTEXT`,
					);
				}
				const running = [...jobs.values()].filter((j) => isPending(j.status)).length;
				if (running >= MAX_CONCURRENT) {
					return textResult(
						`concurrency limit: ${running}/${MAX_CONCURRENT} subagents running; wait or kill one first`,
					);
				}
				const tools = params.tools || job.tools;
				const writer = [...jobs.values()].find(
					(j) => j !== job && isPending(j.status) && canWrite(j.tools) && !j.worktree,
				);
				if (canWrite(tools) && writer && !params.isolated && !job.worktree) {
					return textResult(
						`subagent ${writer.id} is already writing files; wait for it or continue this one read-only`,
					);
				}
				// Same session id, same cwd: the child's transcript is what makes this a
				// continuation instead of a new agent re-reading a hand-written summary.
				const previous = job.lastReportSet && job.lastReport?.trim()
					? `Context from the previous round (verbatim report):\n${job.lastReport.slice(-MAX_ARCHIVE_CHARS)}\n\n`
					: "";
				job.task = `Task: ${params.task}`;
				job.tools = tools;
				job.model = params.model || job.model;
				if (params.modules !== undefined) job.modules = inheritedModules();
				if (params.timeoutSec !== undefined) job.timeoutSec = params.timeoutSec;
				if (params.onFailure !== undefined) job.onFailure = params.onFailure;
				if (params.cwd !== undefined && params.isolated !== true) job.cwd = params.cwd;
				if (params.isolated === true && !job.worktree) {
					try {
						createWorktree(job, ctx.cwd);
					} catch (error) {
						return textResult(`isolated: could not create a worktree: ${(error as Error).message}`);
					}
				}
				job.isContinue = true;
				job.attempts = 0;
				job.errorMessage = undefined;
				job.finalOutput = "";
				job.durationMs = undefined;
				job.done = new Promise<void>((resolve) => {
					job.resolveDone = resolve;
				});
				job.cwd = job.cwd || ctx.cwd;
				launch(job, `${previous}${job.task}`, job.cwd);
				refreshWidget();
				ensureWidgetTimer();
				return textResult(`${jobSummary(job)}\nIts report arrives as a subagent-complete notification.`);
			}

			// kill
			if (!isPending(job.status)) return textResult(`subagent ${job.id} already ${job.status}; nothing to kill`);
			// Mark the job dead before signalling: killing the tree makes the child exit,
			// and its `close` handler must not rewrite the status to "failed".
			job.cancelTimeout?.();
			job.status = "killed";
			job.errorMessage = "killed by the main agent";
			job.durationMs = Date.now() - job.startedAt;
			if (job.worktree) removeWorktree(job, ctx.cwd, false);
			record(job, scopeOf(job.task));
			const pid = job.proc?.pid;
			if (pid !== undefined) killProcessTree(pid);
			else job.proc?.kill("SIGTERM");
			job.resolveDone();
			releaseDependents(ctx.cwd);
			refreshWidget();
			return textResult(`subagent ${job.id} killed`);
		},
	});
}
