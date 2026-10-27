import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import type {
	ModuleApi,
	ModuleContext,
	ModuleUIContext,
	SessionStartEvent,
	ToolLoadout,
} from "../../../core/modules/types.ts";
import { SUBAGENT_CHANNEL } from "../../shared-channels.ts";
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
/**
 * `interrupted`: a job restored from the archive as still running. Its process is
 * gone with the parent, so it is neither a success nor a failure the model caused.
 * `killed`: the process ended on a signal (kill -9, OOM, or this tool's own kill),
 * so its result is never arriving — settled, but not failed by the model.
 */
type JobStatus = "queued" | "blocked" | "running" | "completed" | "failed" | "killed" | "timeout" | "interrupted";
/** Settled statuses that must not satisfy a dependent: its work never arrived. */
const DEPENDENCY_STATUSES = new Set<string>(["failed", "killed", "timeout", "blocked", "interrupted"]);
/**
 * Statuses a restore still has to act on: `queued`/`blocked` can run, and `running`
 * lost its process with the parent, so it becomes `interrupted`.
 */
const RESUMABLE_STATUSES = new Set<string>(["queued", "blocked", "running"]);
/**
 * Settled statuses a retry must not re-run: a killed child was killed by something
 * outside its own work, so a second attempt mostly buys the same ending again.
 */
const UNRETRYABLE_STATUSES = new Set<string>(["killed"]);
/** Signals that mean "the process was ended from outside", not "it exited badly". */
const EXTERNAL_SIGNALS = new Set<string>(["SIGKILL", "SIGTERM", "SIGINT", "SIGHUP"]);
const ARCHIVE_VERSION = 2;
const ARCHIVE_TYPE = "subagent-job";
/** Status-bar key for the subagent summary line; see `setStatus` in session_start. */
const STATUS_KEY = "subagent-async";
const WRITE_TOOLS = /^(write|edit)$/;
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
	"`dependsOn` holds a job until the jobs it names settle and pastes their reports into its brief, " +
	"`isolated: true` gives it its own git worktree, " +
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

/** One attempt's ending, kept after a retry replaces the job's `status`. */
export interface AttemptOutcome {
	attempt: number;
	status: JobStatus;
	error?: string;
}

export interface Job {
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
	/** Seconds to wait for the dependencies before blocking; unset waits indefinitely. */
	dependsOnTimeoutSec?: number;
	/** When the dependencies started being waited on, for `dependsOnTimeoutSec`. */
	waitingSince?: number;
	/** `sa-3/attempt-2` for a retry; equal to `id` for a first attempt. */
	currentJobId: string;
	attempts: number;
	/**
	 * How each attempt ended. `status` only describes the latest attempt, so without
	 * this the previous attempts' outcomes were simply overwritten by the retry.
	 */
	attemptLog: AttemptOutcome[];
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
	/** True once the archive has recorded a settled job; a restore must not re-queue it. */
	settledRecorded?: boolean;
	status: JobStatus;
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
	/** Edges of the graph: what this job waited for when it was archived. */
	dependsOn?: string[];
	dependsOnTimeoutSec?: number;
	/** Attempts that already ended, so a restored job still shows how it got here. */
	attemptLog?: AttemptOutcome[];
	/** A pending job's own tool/model/timeout, so a re-queued job keeps its shape. */
	tools?: string;
	model?: string;
	timeoutSec?: number;
	onFailure?: Job["onFailure"];
	cwd?: string;
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

function textOf(message: { content?: Array<{ type: string; text?: string }> }): string {
	return (message.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

/**
 * Whether the extra module's mcp subsystem switch is on. Mirrors packages/extra
 * settings (<agentDir>/extra/settings.json with a .nanopi/extra/settings.json
 * project override); default enabled.
 */
function isMcpSubsystemEnabled(agentDir: string): boolean {
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
function childModuleNames(registered: readonly string[], agentDir: string): string[] {
	const names = registered.filter((name) => !CHILD_MODULE_SKIP.has(name));
	// MCP tools are subagent-only: mcp-lite has to come along or a `tools` list
	// naming `mcp__*` cannot resolve in the child.
	return names.filter((name) => name !== "mcp-lite" || isMcpSubsystemEnabled(agentDir));
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

/**
 * The context a job starts with: the settled reports of the jobs it depends on,
 * then its own brief.
 *
 * This is the same assembly `continue` already did for the previous round, moved
 * to where the dependency edges are known. Without it the only way to hand B's
 * output to C was for the main agent to copy B's report into C's brief by hand,
 * one report per hop, and a clipped report silently lost the tail.
 */
export function dependentBrief(job: Job, jobs: Map<string, Job>): string {
	const sections = job.dependsOn.map((id) => {
		const dependency = jobs.get(id);
		if (!dependency) return undefined;
		const report = dependency.finalOutput || dependency.errorMessage || "";
		if (!report.trim()) return `### ${id} (${dependency.status})
(no report)`;
		return `### ${id} (${dependency.status})
${report.slice(-MAX_ARCHIVE_CHARS)}`;
	});
	const context = sections.filter((section) => section !== undefined);
	if (context.length === 0) return job.task;
	return `Context from the jobs this one depends on (verbatim reports):\n${context.join("\n\n")}\n\n${job.task}`;
}

/** Report arrives as a notification; the archive is also what survives /compact and restarts. */
function archive(job: Job, scope: string): RestoredJob {
	return {
		id: job.id,
		status: job.status,
		task: job.task.slice(0, 2000),
		dependsOn: job.dependsOn,
		dependsOnTimeoutSec: job.dependsOnTimeoutSec,
		attemptLog: job.attemptLog,
		tools: job.tools,
		model: job.model,
		timeoutSec: job.timeoutSec,
		onFailure: job.onFailure,
		cwd: job.cwd,
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

/**
 * Whether the child's process still exists. Used to tell "never started" from
 * "ran and crashed": `close` fires in both cases, and only the first is worth
 * skipping a retry for. POSIX only — elsewhere the answer is "assume it ran".
 */
function childAlive(proc: ChildProcess): boolean {
	const pid = proc.pid;
	if (pid === undefined) return false;
	if (process.platform === "win32") return true;
	return existsSync(`/proc/${pid}`);
}

/** `sa-3` -> `3`; a retry id solves to the job it belongs to. */
function rootOf(id: string): string {
	return /^(sa-\d+)(?:\/attempt-\d+)?$/.exec(id)?.[1] ?? id;
}

function isPending(status: Job["status"]): boolean {
	return status === "queued" || status === "blocked" || status === "running";
}

/**
 * Start a new run on an existing job: the previous attempt's outcome no longer
 * describes the job. `attemptLog` is deliberately not cleared — it is the only
 * record of how the earlier attempts ended.
 */
function resetForRun(job: Job): void {
	job.attempts = 0;
	job.currentJobId = job.id;
	job.startedAt = Date.now();
	job.errorMessage = undefined;
	job.finalOutput = "";
	job.durationMs = undefined;
	job.done = new Promise<void>((resolve) => {
		job.resolveDone = resolve;
	});
}

export default function subagentMini(pi: ModuleApi): void {
	const jobs = new Map<string, Job>();
	let counter = 0;
	let uiRef: ModuleUIContext | undefined;
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
		if (!uiRef) return;
		try {
			const rows = widgetLines();
			uiRef
				.channel(SUBAGENT_CHANNEL)
				.update(rows ? { label: "subagent jobs", kind: "rows", rows } : undefined, { placement: "belowEditor" });
		} catch {
			// widget is cosmetic; never break the tool flow
		}
	};

	/**
	 * Set by the tool call, which is the only place that owns a cwd and a context:
	 * a deadline that expires while nothing else happens needs both to block the
	 * dependent and report it.
	 */
	let scheduler: { baseCwd: string; ctx: ModuleContext } | undefined;

	const ensureWidgetTimer = (): void => {
		if (widgetTimer) return;
		widgetTimer = setInterval(() => {
			if (![...jobs.values()].some((j) => isPending(j.status))) {
				clearInterval(widgetTimer);
				widgetTimer = undefined;
				refreshWidget(); // clears it (undefined lines)
				return;
			}
			if (scheduler) expireWaitingDependencies(scheduler.baseCwd, scheduler.ctx);
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
		job.settledRecorded = true;
		try {
			pi.appendEntry(ARCHIVE_TYPE, { version: ARCHIVE_VERSION, ...archive(job, scope) });
		} catch {
			// archive is best-effort; the notification already went out
		}
	};

	/**
	 * A settled job that the archive already holds, written again with a status the
	 * session shutdown changed (`kill` is the single one that does this).
	 *
	 * Only a status change is worth an entry: the archive is append-only, and this
	 * job's report was not delivered again, so re-persisting it would be noise.
	 */
	const rerecord = (job: Job, scope: string): void => {
		if (!job.settledRecorded) return;
		try {
			pi.appendEntry(ARCHIVE_TYPE, { version: ARCHIVE_VERSION, ...archive(job, scope) });
		} catch {
			// same as record
		}
	};

	/** Launch one child process for `job` (a first attempt or a retry) and wire its report. */
	const launch = (job: Job, prompt: string, baseCwd: string, ctx: ModuleContext): void => {
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
		// The child must be this same installation: `resolveHostEntry()` answers
		// "the entry the parent is running", which no path guessed from the
		// package layout can (the single-file build runs from an asset cache).
		const child = ctx.resolveHostEntry();
		const args = [...child.args, "--mode", "json", "-p", "--no-skills", "--no-prompt-templates"];
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

		const proc = spawn(child.cmd, args, {
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
			// A killed attempt may still have printed a message, but it was not the
			// answer: the payload is why it died, or the report would say "completed"
			// in the notification while the status says `killed`.
			job.finalOutput = status === "killed" ? "" : (lastAssistant?.text ?? "");
			job.usage = lastAssistant?.usage;
			job.durationMs = Date.now() - job.startedAt;
			// Record the attempt before the retry replaces the job's status: a killed or
			// timed-out attempt is otherwise invisible once attempt 2 starts.
			job.attemptLog = [...job.attemptLog, { attempt: job.attempts, status, error: errorMessage }];
			if (
				status !== "completed" &&
				!UNRETRYABLE_STATUSES.has(status) &&
				job.onFailure === "retry" &&
				job.attempts < MAX_ATTEMPTS
			) {
				// The retry brief says what went wrong; without that the child re-runs
				// the same failing path and the second attempt is just the first one's cost.
				const context = errorMessage ? `Previous attempt failed: ${errorMessage}\n\n` : "";
				launch(job, `${context}${prompt}`, baseCwd, ctx);
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
			releaseDependents(job.cwd ?? baseCwd, ctx);
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
		proc.on("close", (code, signal) => {
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
				return;
			}
			// `code === null` means the process did not exit by itself: it was ended by
			// `signal` (kill -9, OOM, a container restart). Counting that as success was
			// the worst case — a report was published for a child that never finished.
			if (signal && code === null) {
				const killed = EXTERNAL_SIGNALS.has(signal);
				const why = `terminated by ${signal}`;
				finish(killed ? "killed" : "failed", killed ? `${why} (external kill: no result)` : why);
				return;
			}
			if (lastAssistant) {
				if (code === 0) finish("completed");
				else finish("failed", `exit ${code}${lastAssistant.errorMessage ? `: ${lastAssistant.errorMessage}` : ""}`);
				return;
			}
			// Name the command: a child that died before producing any event
			// (missing entry point, wrong resolution) is otherwise reported as a
			// bare exit code with a Node stack the parent cannot attribute.
			const launched = [child.cmd, ...child.args].join(" ");
			const why = stderrTail ? `: ${stderrTail.trim()}` : "";
			if (!childAlive(proc)) {
				// Nothing was ever printed and the process is gone: the child never got
				// started, which is not the same failure as one that ran and crashed.
				finish("failed", `child never ran (launched: ${launched})${why}`);
				return;
			}
			finish("failed", `exit ${code}, no assistant output (launched: ${launched})${why}`);
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

	/**
	 * Jobs whose dependencies have all settled; a failed dependency blocks its dependents.
	 *
	 * A job already marked `blocked` is skipped: it is a settled outcome, and treating
	 * it as work-in-progress again is what makes the loop below not terminate once a
	 * dependency is settled-but-failed (its `pendingDependencies` is empty, so nothing
	 * else would stop it from being re-blocked and re-notified on every pass).
	 */
	const releaseDependents = (baseCwd: string, ctx: ModuleContext): void => {
		let changed = true;
		while (changed) {
			changed = false;
			for (const job of jobs.values()) {
				if (job.status !== "queued") continue;
				job.pendingDependencies = job.pendingDependencies.filter((id) => {
					const dependency = jobs.get(id);
					return dependency !== undefined && isPending(dependency.status);
				});
				if (job.pendingDependencies.length > 0) {
					// Waiting is bounded by a timeout, not by a status: a dependency that is
					// still pending has produced nothing to wait for a conclusion on.
					const waited = job.dependsOnTimeoutSec;
					if (waited === undefined) continue;
					job.waitingSince ??= Date.now();
					if (Date.now() - job.waitingSince < waited * 1000) continue;
					job.status = "blocked";
					job.errorMessage = `dependency ${job.pendingDependencies.join(", ")} did not settle in ${waited}s`;
					job.durationMs = Date.now() - job.startedAt;
					notify(job, scopeOf(job.task));
					job.resolveDone();
					changed = true;
					continue;
				}
				const failed = job.dependsOn
					.map((id) => jobs.get(id))
					.find((dependency) => dependency && DEPENDENCY_STATUSES.has(dependency.status));
				if (failed) {
					job.status = "blocked";
					job.errorMessage = `dependency ${failed.id} ${failed.status}`;
					job.durationMs = Date.now() - job.startedAt;
					// `notify` archives it; a second `record` would duplicate the entry.
					notify(job, scopeOf(job.task));
					job.resolveDone();
				} else {
					// The edges are resolved here, so this is the one place where a
					// dependent's brief can be assembled from reports instead of prose.
					launch(job, dependentBrief(job, jobs), baseCwd, ctx);
				}
				changed = true;
			}
		}
		refreshWidget();
	};

	/**
	 * Enforce `dependsOnTimeoutSec` for jobs still waiting.
	 *
	 * `releaseDependents` only runs when something settles, so a dependency that
	 * never settles would leave its dependents waiting with nobody to notice the
	 * deadline. This is the same check driven by the widget tick instead.
	 */
	const expireWaitingDependencies = (baseCwd: string, ctx: ModuleContext): void => {
		let expired = false;
		for (const job of jobs.values()) {
			if (job.status !== "queued" || job.pendingDependencies.length === 0) continue;
			const waited = job.dependsOnTimeoutSec;
			if (waited === undefined) continue;
			job.waitingSince ??= Date.now();
			if (Date.now() - job.waitingSince < waited * 1000) continue;
			expired = true;
		}
		if (expired) releaseDependents(baseCwd, ctx);
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
			dependsOnTimeoutSec?: number;
			isolated?: boolean;
			cwd?: string;
		},
		baseCwd: string,
		ctx: ModuleContext,
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
			dependsOnTimeoutSec: params.dependsOnTimeoutSec,
			currentJobId: id,
			attempts: 0,
			attemptLog: [],
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
		scheduler = { baseCwd, ctx };
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
		if (job.pendingDependencies.length === 0) launch(job, job.task, cwd, ctx);
		else job.waitingSince = Date.now();
		refreshWidget();
		ensureWidgetTimer();
		return { ok: true, job };
	};

	/**
	 * Rebuild the job table from the session archive so /compact or a restart does not
	 * orphan past jobs.
	 *
	 * The edges come back with the nodes: a dependency id that is archived but was
	 * never restored would otherwise look like a job that can never settle, so the
	 * pass below resolves every id against the table it just built.
	 */
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
				tools: data.tools ?? DEFAULT_TOOLS,
				model: data.model,
				modules: [],
				timeoutSec: data.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
				onFailure: data.onFailure ?? "report",
				dependsOn: data.dependsOn ?? [],
				pendingDependencies: [],
				dependsOnTimeoutSec: data.dependsOnTimeoutSec,
				currentJobId: data.id,
				// A restored job at least ran once; the archive decides how it ended.
				attempts: data.attemptLog?.length ?? 1,
				attemptLog: data.attemptLog ?? [],
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
				settledRecorded: !RESUMABLE_STATUSES.has(data.status),
				done: Promise.resolve(),
				resolveDone: () => undefined,
			});
		}
		if (restored === 0) return;
		// Only the archive knows who was still waiting: recompute it against the table.
		for (const job of jobs.values()) {
			job.pendingDependencies = job.dependsOn.filter((id) => {
				const dependency = jobs.get(id);
				return dependency !== undefined && isPending(dependency.status);
			});
			if (job.pendingDependencies.length > 0) job.waitingSince = Date.now();
		}
		refreshWidget();
	};

	/**
	 * Hand a restored job that was still waiting back to the scheduler.
	 *
	 * The parent process died, so a job archived as `running` loses its `done`
	 * promise and nothing will ever settle it: it becomes `interrupted`, which counts
	 * as settled-but-not-succeeded for its dependents. A job archived as `queued` or
	 * `blocked` never got that far, so it can run now with its brief intact. Nothing
	 * here touches a settled job, so a restore never re-runs work that already ran.
	 */
	const resumeRestored = (baseCwd: string, ctx: ModuleContext): void => {
		const interrupted = [...jobs.values()].filter((job) => job.status === "running");
		for (const job of interrupted) {
			// The process is gone with the parent, so the report will never arrive: write
			// the outcome down (the notification was never sent) and let its dependents
			// see a settled failure instead of waiting on a `done` that cannot resolve.
			job.attemptLog = [...job.attemptLog, { attempt: job.attempts, status: "interrupted", error: "parent session ended" }];
			job.status = "interrupted";
			job.errorMessage = "interrupted: the parent session ended before this job settled";
			job.durationMs = job.durationMs ?? Date.now() - job.startedAt;
			// `notify` already archives the job once its report is delivered; a second
			// `record` here would leave two entries for the same outcome.
			notify(job, scopeOf(job.task));
		}
		// `queued` and `blocked` never started, so they can still run. `releaseDependents`
		// decides which: it resolves the edges once against the table the restore built,
		// so a job whose dependency was interrupted is blocked here rather than waiting.
		const runnable = [...jobs.values()].filter((job) => job.status === "queued" || job.status === "blocked");
		if (runnable.length === 0) return;
		for (const job of runnable) resetForRun(job);
		releaseDependents(baseCwd, ctx);
		refreshWidget();
		ensureWidgetTimer();
	};

	pi.on("session_start", async (event: SessionStartEvent, ctx) => {
		uiRef = ctx.ui;
		ctxSetStatus = (text) => ctx.ui.setStatus(STATUS_KEY, text);
		if (event.reason === "new") {
			jobs.clear();
			return;
		}
		restoreArchive(ctx);
		resumeRestored(ctx.cwd, ctx);
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
			job.attemptLog = [...job.attemptLog, { attempt: job.attempts, status: "killed", error: "parent session shut down" }];
			job.status = "killed";
			job.errorMessage = "parent session shut down";
			job.durationMs = Date.now() - job.startedAt;
			job.resolveDone();
			// The next session restores this job from its archive entry and reads the
			// edges from there; without this write the graph would come back as nodes
			// with no edges, which is the whole point of recording them.
			try {
				pi.appendEntry(ARCHIVE_TYPE, { version: ARCHIVE_VERSION, ...archive(job, scopeOf(job.task)) });
			} catch {
				// best-effort, as everywhere else in the archive path
			}
		}
		// A dependent of a job killed by the shutdown is settled-but-unsucceeded: without
		// this pass it stays `queued` with an empty pending list and nobody to wake it.
		for (const job of jobs.values()) {
			if (job.status !== "queued") continue;
			const killed = job.dependsOn
				.map((id) => jobs.get(id))
				.find((dependency) => dependency !== undefined && DEPENDENCY_STATUSES.has(dependency.status));
			if (!killed) continue;
			job.status = "blocked";
			job.errorMessage = `dependency ${killed.id} ${killed.status}`;
			job.durationMs = Date.now() - job.startedAt;
			job.resolveDone();
			try {
				pi.appendEntry(ARCHIVE_TYPE, { version: ARCHIVE_VERSION, ...archive(job, scopeOf(job.task)) });
			} catch {
				// same best-effort archive as above
			}
		}
		for (const job of jobs.values()) {
			if (job.worktree) removeWorktree(job, job.cwd || process.cwd(), false);
		}
	});

	const jobCwdLabel = (job: Job): string => (job.worktree ? job.worktree.path : job.cwd || "(session cwd)");

	/**
	 * Earlier attempts, on one line. `status` describes the latest attempt only, so
	 * without this a retried job looks like it never failed at all.
	 */
	const attemptHistory = (job: Job): string => {
		const settled = job.attemptLog.filter((attempt) => attempt.attempt < job.attempts || job.attempts === 0);
		if (settled.length === 0) return "";
		const parts = settled.map((attempt) => {
			const error = attempt.error ? `: ${attempt.error}` : "";
			return `attempt ${attempt.attempt} ${attempt.status}${error}`;
		});
		return `\nattempts: ${parts.join("; ")}`;
	};

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
			"Chain jobs with `dependsOn` instead of polling: the dependent starts when the jobs it names settle with their reports already in its brief, so do not copy them into it. A failed dependency blocks it. Set `onFailure: \"retry\"` for flaky work; the retry limit is fixed at 3 attempts and not something to enforce in the brief.",
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
						"spawn: job ids that must settle first. The job starts when all of them settle, with their reports pasted into its brief (do not copy them in by hand); a failed dependency blocks it instead of running it on missing work.",
				}),
			),
			dependsOnTimeoutSec: Type.Optional(
				Type.Number({
					description:
						"spawn: stop waiting for `dependsOn` after this many seconds and report the job as blocked with the dependencies that never settled. Default: wait indefinitely.",
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
			if (!uiRef) uiRef = ctx.ui;

			const inheritedModules = (): string[] =>
				params.modules !== undefined
					? params.modules.split(",").map((s) => s.trim()).filter(Boolean)
					: childModuleNames(pi.getModuleNames(), ctx.getAgentDir());
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
						dependsOnTimeoutSec: params.dependsOnTimeoutSec,
						isolated: params.isolated === true,
						cwd: params.cwd,
					},
					ctx.cwd,
					ctx,
				);
				if (!spawned.ok) return textResult(spawned.error);
				const job = spawned.job;
				return textResult(
					`${jobSummary(job)}.\n` +
						(job.status === "running"
							? "A subagent-complete notification with its report arrives when done — continue other work meanwhile."
							: `It starts once ${job.pendingDependencies.join(", ")} settles, with their reports in its brief; the report arrives then.`) +
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
				return textResult(
					`${jobSummary(job)} (${elapsed}s)\nscope: ${scopeOf(job.task)}${attemptHistory(job)}${session}\n\n${tail}`,
				);
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
				resetForRun(job);
				job.cwd = job.cwd || ctx.cwd;
				launch(job, `${previous}${job.task}`, job.cwd, ctx);
				scheduler = { baseCwd: ctx.cwd, ctx };
				refreshWidget();
				ensureWidgetTimer();
				return textResult(`${jobSummary(job)}\nIts report arrives as a subagent-complete notification.`);
			}

			// kill
			if (!isPending(job.status)) return textResult(`subagent ${job.id} already ${job.status}; nothing to kill`);
			// Mark the job dead before signalling: killing the tree makes the child exit,
			// and its `close` handler must not rewrite the status to "failed".
			job.cancelTimeout?.();
			job.attemptLog = [...job.attemptLog, { attempt: job.attempts, status: "killed", error: "killed by the main agent" }];
			job.status = "killed";
			job.errorMessage = "killed by the main agent";
			job.durationMs = Date.now() - job.startedAt;
			if (job.worktree) removeWorktree(job, ctx.cwd, false);
			rerecord(job, scopeOf(job.task));
			const pid = job.proc?.pid;
			if (pid !== undefined) killProcessTree(pid);
			else job.proc?.kill("SIGTERM");
			job.resolveDone();
			releaseDependents(ctx.cwd, ctx);
			refreshWidget();
			return textResult(`subagent ${job.id} killed`);
		},
	});
}
