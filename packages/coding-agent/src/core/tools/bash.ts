import { constants } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants } from "node:os";
import type { AgentTool } from "@nanopi/pi-agent-core";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getShellConfig,
	getShellEnv,
	killProcessTree,
	type ShellConfig,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import type { ModuleContext, ToolDefinition } from "../modules/types.ts";
import { digestFailures, type FailureLine, formatFailureDigest } from "./failure-digest.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { BASH_UPDATE_THROTTLE_MS, createShellRenderers } from "./renderers/bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult } from "./truncate.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** Output limit of `structuredContent.output`, which programmatic callers such as codemode scripts receive. */
const STRUCTURED_OUTPUT_MAX_BYTES = 1024 * 1024;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;

function resolveTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) return undefined;
	if (!Number.isFinite(timeout) || timeout <= 0) {
		throw new Error("Invalid timeout: must be a finite number of seconds");
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		throw new Error(`Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`);
	}
	return timeoutMs;
}

const bashSchema = Type.Object({
	command: Type.String({ description: "Command to execute" }),
	timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (no default)" })),
});

export const bashToolSystemPromptContribution = {
	snippet: "Execute shell commands (builds, tests, git, package managers)",
	guidelines: [
		"You can inspect NANOPI_* environment variables for current model and session details.",
		"Chain shell commands instead of asking the user to run them",
		// Without this the shell reports the printer's exit code: `pnpm test | tail -50` exits 0
		// because `tail` did, and the failure disappears from both the status and the digest. No
		// pipefail countermeasure: asserting the exit status of each stage (`$?` / `PIPESTATUS`) makes
		// the shell, not the test runner, exit non-zero, and the digest then reads the failures as prose.
		"Never pipe a command whose exit status matters into `tail`/`head`/`grep`: the pipeline reports the last command's status, so a failed test looks like a pass. Output is already truncated to its tail.",
	],
} as const;

export type BashToolInput = Static<typeof bashSchema>;

/**
 * Result for programmatic callers such as codemode scripts. A non-zero exit code is an error result for the model, but scripts still resolve to this value.
 * `output` is not limited like the model-facing output: callers decide how much of it reaches the model.
 */
const bashOutputSchema = Type.Object({
	output: Type.String({ description: "Combined stdout and stderr, possibly truncated" }),
	truncated: Type.Boolean(),
	full_output_path: Type.Optional(Type.String({ description: "Full output, when truncated" })),
	exit_code: Type.Number(),
	wall_time_seconds: Type.Number(),
	/** Backend that ran the command when it was not the local shell, e.g. `sandbox`. */
	executed_on: Type.Optional(Type.String()),
	/** Lines that name a failure, for callers that would otherwise re-parse `output`. Absent when no rule matched. */
	failures: Type.Optional(
		Type.Array(
			Type.Object({
				line: Type.Number({ description: "1-based line number in the full output" }),
				text: Type.String({ description: "The line as the command wrote it" }),
				source: Type.String({ description: "Framework or compiler that produced the line" }),
			}),
		),
	),
});

export type BashToolOutput = Static<typeof bashOutputSchema>;

export interface BashToolDetails {
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

/**
 * Pluggable operations for the bash tool.
 * Override these to delegate command execution to remote systems (for example SSH).
 */
export interface BashOperations {
	/**
	 * Execute a command and stream output.
	 * @param command The command to execute
	 * @param cwd Working directory
	 * @param options Execution options
	 * @returns Promise resolving to the exit code. Report signal terminations as 128 + signal number;
	 * a null exit code is treated as a failed command.
	 */
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
		},
	) => Promise<{ exitCode: number | null }>;
}

/** Shared process execution used by the built-in shell tools. */
export function createLocalShellOperations(shellName: string, resolveShellConfig: () => ShellConfig): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const timeoutMs = resolveTimeoutMs(timeout);
			if (signal?.aborted) {
				throw new Error("aborted");
			}
			const shellConfig = resolveShellConfig();
			try {
				await fsAccess(cwd, constants.F_OK);
			} catch {
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute ${shellName} commands.`);
			}

			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};

			try {
				// Set timeout if provided.
				if (timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeoutMs);
				}
				// Stream stdout and stderr.
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				// Handle abort signal by killing the entire process tree.
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				// Handle shell spawn errors and wait for the process to terminate without hanging
				// on inherited stdio handles held by detached descendants.
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) {
					throw new Error("aborted");
				}
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				// A signal-killed shell has no exit code. Use the standard shell convention so
				// callers do not mistake the termination for a successful command.
				const signalCode = child.signalCode;
				return { exitCode: exitCode ?? (signalCode ? 128 + (osConstants.signals[signalCode] ?? 0) : 1) };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}

/**
 * Create bash operations using nanopi's built-in local shell execution backend.
 *
 * This is useful for extensions that intercept user_bash and still want nanopi's
 * standard local shell behavior while wrapping or rewriting commands.
 */
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return createLocalShellOperations("bash", () => getShellConfig(options?.shellPath));
}

/**
 * Backends that wrap command execution without replacing it, keyed by id.
 * Undefined means "run locally"; any other value must be a `BashOperations`
 * that delegates to `createLocalBashOperations()`.
 */
export type BashOperationsProviders = () => Readonly<Record<string, BashOperations | undefined>>;

export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}

export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;

function resolveSpawnContext(
	command: string,
	cwd: string,
	spawnHook: BashSpawnHook | undefined,
	exposeSessionEnvironment: boolean,
	ctx: ModuleContext | undefined,
): BashSpawnContext {
	const env = { ...getShellEnv() };
	delete env.NANOPI_SESSION_ID;
	delete env.NANOPI_SESSION_FILE;
	delete env.NANOPI_PROVIDER;
	delete env.NANOPI_MODEL;
	delete env.NANOPI_REASONING_LEVEL;
	if (exposeSessionEnvironment && ctx) {
		const model = ctx.model;
		env.NANOPI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.NANOPI_SESSION_FILE = sessionFile;
		if (model) {
			env.NANOPI_PROVIDER = model.provider;
			env.NANOPI_MODEL = model.id;
		}
		if (ctx.thinkingLevel) env.NANOPI_REASONING_LEVEL = ctx.thinkingLevel;
	}
	const baseContext: BashSpawnContext = { command, cwd, env };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}

export interface BashToolOptions {
	/** Custom operations for command execution. Default: local shell */
	operations?: BashOperations;
	/**
	 * Resolve the operations of a named backend (for example a sandbox). Consulted
	 * before `operations`, so a session can select a backend after the tool was
	 * built. An id that resolves to undefined falls back to the default.
	 */
	operationsProviders?: BashOperationsProviders;
	/** Backend id consulted in `operationsProviders`. Default: none */
	operationsProvider?: () => string | undefined;
	/** Command prefix prepended to every command (for example shell setup commands) */
	commandPrefix?: string;
	/** Optional explicit shell path from settings */
	shellPath?: string;
	/** Expose current nanopi session metadata as NANOPI_* environment variables. Default: true */
	exposeSessionEnvironment?: boolean;
	/** Hook to adjust command, cwd, or env before execution */
	spawnHook?: BashSpawnHook;
}

export type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};

export interface ShellToolConfig {
	name: string;
	label: string;
	shellName: string;
	prompt: string;
	/** Highlight heredoc bodies and inline scripts, which requires POSIX shell syntax. */
	embeddedCode: boolean;
	promptSnippet: string;
	promptGuidelines?: readonly string[];
	tempFilePrefix: string;
}

/**
 * Name the reason a command was killed, so the model can tell the cases apart. A user
 * interrupt resolves itself (the run stops), but the run-level signal is also aborted when
 * the session tears down or the turn is replaced, and the model has to decide whether
 * retrying is reasonable instead of guessing whether it caused the abort.
 */
function describeAbort(signal: AbortSignal | undefined, subject: string): string {
	const reason = signal?.reason;
	const detail = typeof reason === "string" ? reason.trim() : "";
	const lines = [
		detail ? `${subject} interrupted: ${detail}` : `${subject} interrupted before it finished`,
		"Not a command failure: the run was cancelled from outside, so the same command may succeed when re-run.",
	];
	return lines.join("\n");
}

/**
 * Resolve which backend runs the commands of one shell tool: a registered
 * provider when the session selected one, otherwise the fixed `operations`
 * override, otherwise the local shell.
 */
export function resolveShellOperations(options?: BashToolOptions): BashOperations & { backend?: string } {
	const providers = options?.operationsProviders?.();
	const backend = options?.operationsProvider?.();
	if (backend !== undefined && providers?.[backend]) {
		return Object.assign(providers[backend] as BashOperations, { backend });
	}
	const local = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	return options?.operations ? local : Object.assign(local, { backend: undefined });
}

export function createShellToolDefinition(
	cwd: string,
	config: ShellToolConfig,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const commandPrefix = options?.commandPrefix;
	const exposeSessionEnvironment = options?.exposeSessionEnvironment ?? true;
	const spawnHook = options?.spawnHook;
	return {
		name: config.name,
		label: config.label,
		// The declaration is the only place the model reads the tool's contract in
		// a shell-only build, which has no tool list in the system prompt. Keep it
		// to what the call has to know: where it runs, what comes back, and how the
		// output is bounded.
		description: `Run a ${config.shellName} command in the cwd. Returns stdout and stderr, truncated to the last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; the full output is saved to a temp file.`,
		promptSnippet: config.promptSnippet,
		promptGuidelines: exposeSessionEnvironment && config.promptGuidelines ? [...config.promptGuidelines] : undefined,
		parameters: bashSchema,
		outputSchema: bashOutputSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ command, timeout }: { command: string; timeout?: number },
			signal?: AbortSignal,
			onUpdate?,
			ctx?: ModuleContext,
		) {
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${command}` : command;
			const spawnContext = resolveSpawnContext(
				resolvedCommand,
				ctx?.cwd || cwd,
				spawnHook,
				exposeSessionEnvironment,
				ctx,
			);
			const ops = resolveShellOperations(options);
			const output = new OutputAccumulator({ tempFilePrefix: config.tempFilePrefix });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;

			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};

			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};

			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};

			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}

			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};

			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true, fullText: true });
				await output.closeTempFile();
				return snapshot;
			};

			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>) => {
				const truncation = snapshot.truncation;
				const text = snapshot.content || "(no output)";
				let details: BashToolDetails | undefined;
				let notice = "";
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						notice = `[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						notice = `[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, notice, details };
			};

			/**
			 * The model-facing text of a failed command.
			 *
			 * Digest only, no log body: the status line and the digest already say what failed, and the
			 * tail of `pnpm test` is a test count, not a failure. Repeating the log doubled the tokens a
			 * failing run costs to say the same thing twice, and it pushed the digest out of the budget
			 * whenever the log filled it. The body is still in `structuredContent.output`, so a caller
			 * that wants it reads it from there.
			 *
			 * `block` is sized to the whole result budget and sits last, so head truncation cannot reach
			 * it. A command that matched no rule keeps its log tail instead: there the log is all the
			 * model has.
			 */
			const formatFailure = (snapshot: Awaited<ReturnType<typeof finishOutput>>, status: string) => {
				const { notice, details } = formatOutput(snapshot);
				const digest = digestFailures(snapshot.fullText ?? "");
				const block = digest
					? formatFailureDigest(digest, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES })
					: undefined;
				const body = block ? undefined : snapshot.content;
				return {
					text: [body, notice, status, block?.text].filter(Boolean).join("\n\n"),
					details,
					failures: block?.digest.failures,
				};
			};

			const startedAt = performance.now();

			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(spawnContext.command, spawnContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: spawnContext.env,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					if (err instanceof Error && err.message === "aborted") {
						const { text } = formatFailure(snapshot, describeAbort(signal, "Command"));
						throw new Error(text);
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						const { text } = formatFailure(snapshot, `Command timed out after ${timeoutSecs} seconds`);
						throw new Error(text);
					}
					throw err;
				}

				const snapshot = await finishOutput();
				const wallTimeSeconds = Math.round((performance.now() - startedAt) / 100) / 10;
				const executedOn = (ops as { backend?: string }).backend;
				const fullOutput = await output.readFullOutput(STRUCTURED_OUTPUT_MAX_BYTES);
				if (exitCode === null) {
					const { text } = formatFailure(snapshot, "Command terminated without an exit code");
					throw new Error(text);
				}
				if (exitCode !== 0) {
					const { text, details, failures } = formatFailure(snapshot, `Command exited with code ${exitCode}`);
					return {
						content: [{ type: "text", text }],
						details,
						structuredContent: {
							output: fullOutput.content,
							truncated: fullOutput.truncated,
							...(fullOutput.truncated && snapshot.fullOutputPath
								? { full_output_path: snapshot.fullOutputPath }
								: {}),
							exit_code: exitCode,
							wall_time_seconds: wallTimeSeconds,
							...(executedOn ? { executed_on: executedOn } : {}),
							...(failures ? { failures: failures as FailureLine[] } : {}),
						} satisfies BashToolOutput,
						isError: true,
					};
				}
				const { text, notice, details } = formatOutput(snapshot);
				const structuredContent: BashToolOutput = {
					output: fullOutput.content,
					truncated: fullOutput.truncated,
					...(fullOutput.truncated && snapshot.fullOutputPath
						? { full_output_path: snapshot.fullOutputPath }
						: {}),
					exit_code: exitCode,
					wall_time_seconds: wallTimeSeconds,
					...(executedOn ? { executed_on: executedOn } : {}),
				};
				return {
					content: [{ type: "text", text: [text, notice].filter(Boolean).join("\n\n") }],
					details,
					structuredContent,
				};
			} finally {
				clearUpdateTimer();
			}
		},
		...createShellRenderers(config.prompt, { embeddedCode: config.embeddedCode }),
	};
}

const bashToolConfig: ShellToolConfig = {
	name: "bash",
	label: "bash",
	shellName: "bash",
	prompt: "$",
	embeddedCode: true,
	promptSnippet: bashToolSystemPromptContribution.snippet,
	promptGuidelines: bashToolSystemPromptContribution.guidelines,
	tempFilePrefix: "nanopi-bash",
};

export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	return createShellToolDefinition(cwd, bashToolConfig, options);
}

export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	const definition = createBashToolDefinition(cwd, options);
	const tool = wrapToolDefinition(definition);
	Object.assign(tool, {
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines,
	});
	return tool;
}
