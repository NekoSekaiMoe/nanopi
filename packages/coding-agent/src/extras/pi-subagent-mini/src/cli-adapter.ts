/**
 * Preferred-CLI adapter for pi-subagent-mini.
 *
 * When `subagents.preferredCli` names claude, codex, or agy, a spawn starts that
 * CLI instead of nanopi. The brief goes to the CLI the way that CLI expects it:
 * stdin for claude, a trailing positional after `--` for codex and agy. Only the
 * final answer text is relayed back; intermediate JSONL events are consumed
 * here, never shown to the parent.
 *
 * Model resolution stays with the harness: pass the current session model id
 * through where the CLI accepts `--model`, and leave the CLI's own default in
 * charge otherwise. No separate model map is invented.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { killProcessTree } from "../../../utils/shell.ts";

export type PreferredCli = "nanopi" | "claude" | "codex" | "agy";
const CLI_NAMES: readonly PreferredCli[] = ["nanopi", "claude", "codex", "agy"];

export interface CliLaunch {
	cmd: string;
	args: string[];
	/** Brief is written to stdin instead of appearing in argv. */
	stdin: boolean;
}

/** Resolve a short CLI id, tolerating `claude-code`/`antigravity` aliases. */
export function parsePreferredCli(value: unknown): PreferredCli | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase();
	if (CLI_NAMES.includes(key as PreferredCli)) return key as PreferredCli;
	if (key === "claude-code") return "claude";
	if (key === "antigravity") return "agy";
	return undefined;
}

/**
 * CLI argv for a spawn. `sessionId` is only passed when the CLI accepts a
 * resume token in a shape we can validate: a UUID for claude/codex, a plain
 * conversation id for agy. Everything else starts a fresh run.
 */
export function buildCliArgs(
	cli: PreferredCli,
	options: { brief: string; model?: string; sessionId?: string; cwd: string },
): CliLaunch {
	const uuid = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
	switch (cli) {
		case "nanopi":
			return { cmd: process.execPath, args: [], stdin: false };
		case "claude": {
			const args = ["-p", "--output-format", "stream-json", "--verbose", "--allowedTools", "Read,Grep,Glob,LS"];
			if (options.model) args.push("--model", options.model);
			if (options.sessionId && uuid.test(options.sessionId)) args.push("--resume", options.sessionId);
			return { cmd: "claude", args, stdin: true };
		}
		case "codex": {
			const args = ["exec", "--json", "--skip-git-repo-check"];
			if (options.sessionId && uuid.test(options.sessionId)) args.push("resume");
			if (options.model) args.push("-m", options.model);
			if (!options.sessionId || !uuid.test(options.sessionId)) {
				args.push("-C", options.cwd, "-s", "read-only");
			}
			if (options.sessionId && uuid.test(options.sessionId)) args.push(options.sessionId);
			args.push("--", options.brief);
			return { cmd: "codex", args, stdin: false };
		}
		case "agy": {
			const args = ["--add-dir", options.cwd];
			if (options.model) args.push("--model", options.model);
			args.push("--mode", "plan");
			if (options.sessionId && /^[A-Za-z0-9_-]+$/.test(options.sessionId)) {
				args.push("--conversation", options.sessionId);
			}
			args.push("-p", options.brief);
			return { cmd: "agy", args, stdin: false };
		}
	}
}

export interface CliOutcome {
	text: string;
	sessionId?: string;
	usage?: { input: number; output: number };
	error?: string;
	killed?: boolean;
}

/**
 * Consume a CLI's output and resolve when it closes. Claude and codex emit
 * JSONL; the answer is the result/agent_message event or the last assistant
 * text. agy emits raw text. A signal-ended process is reported as killed so
 * the caller never publishes a partial answer as a completed one.
 */
export function collectCliOutput(
	proc: ChildProcess,
	cli: PreferredCli,
	timeoutMs: number,
): Promise<CliOutcome> {
	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let finalText = "";
		let assistantText = "";
		let sessionId: string | undefined;
		let usage: { input: number; output: number } | undefined;
		let timedOut = false;

		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(proc.pid ?? -1, "SIGTERM");
		}, timeoutMs);
		timer.unref?.();

		const finish = (signal: NodeJS.Signals | null, code: number | null): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (signal && code === null) {
				resolve({ text: "", sessionId, usage, killed: true, error: `terminated by ${signal}` });
				return;
			}
			if (timedOut) {
				resolve({ text: "", sessionId, usage, error: `timed out after ${Math.round(timeoutMs / 1000)}s` });
				return;
			}
			if (cli === "agy") {
				finalText = stdout.trim();
			} else {
				for (const line of stdout.split("\n")) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line) as {
							type?: string;
							subtype?: string;
							session_id?: string;
							thread_id?: string;
							result?: string;
							is_error?: boolean;
							message?: { content?: Array<{ type?: string; text?: string }> };
							usage?: { input_tokens?: number; output_tokens?: number };
						};
						sessionId ??= event.session_id ?? event.thread_id;
						if (event.type === "result" && typeof event.result === "string") finalText = event.result;
						if (event.type === "agent_message" && typeof (event as { message?: string }).message === "string") {
							finalText = (event as { message: string }).message;
						}
						if (event.type === "assistant") {
							const text = (event.message?.content ?? [])
								.filter((b) => b.type === "text")
								.map((b) => b.text ?? "")
								.join("\n");
							if (text) assistantText = text;
						}
						if (event.usage) {
							usage = {
								input: event.usage.input_tokens ?? 0,
								output: event.usage.output_tokens ?? 0,
							};
						}
					} catch {
						// Skip non-JSON progress lines.
					}
				}
			}
			const text = (finalText || assistantText).trim();
			const error = code !== 0 ? (stderr.trim() || `exit ${code}`) : undefined;
			resolve({ text, sessionId, usage, error: error ?? (text ? undefined : "no answer from CLI") });
		};

		proc.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString("utf8");
		});
		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr = `${stderr}${chunk.toString()}`.slice(-1500);
		});
		proc.on("error", (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ text: "", error: `spawn failed: ${error.message}` });
		});
		// `close` drains the pipes; `exit` would race the last result event.
		proc.on("close", finish);
	});
}

/** Spawn a preferred CLI with stdin handled per CLI and an owned process group. */
export function spawnCli(launch: CliLaunch, cwd: string, brief: string): ChildProcess {
	const proc = spawn(launch.cmd, launch.args, {
		cwd,
		env: process.env,
		stdio: [launch.stdin ? "pipe" : "ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	if (launch.stdin) {
		proc.stdin?.on("error", () => undefined);
		proc.stdin?.write(brief);
		proc.stdin?.end();
	}
	return proc;
}
