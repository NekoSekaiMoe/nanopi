/**
 * Filesystem/network containment for the built-in shell tools, delegated to
 * an external sandbox launcher:
 *
 * - Linux: `bubblewrap` (bwrap), which bind-mounts a minimal root and only the
 *   writable directories the caller allows.
 * - macOS: `sandbox-exec`, which applies a Seatbelt profile.
 *
 * The extra owns the policy and the launcher; the coding-agent only routes
 * `BashOperations.exec()` through it (see `registerBashOperations`). Commands
 * stay single-quoted shell words so the model sees the command it asked for,
 * and a launcher that cannot start is reported as a normal non-zero exit
 * instead of silently falling back to an unsandboxed shell.
 *
 * This is containment, not a permission prompt: it does not decide whether a
 * command may run, and it does not protect credentials outside the writable
 * roots that are already visible inside them.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { findExecutable } from "./executables.ts";

export type SandboxKind = "bwrap" | "sandbox-exec";

/** Tools whose commands the sandbox wraps. */
const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);

/** Loose (file-sourced) sandbox configuration; invalid entries are dropped. */
export interface SandboxConfig {
	/** Launcher to use. Unset detects one for the platform. */
	engine?: SandboxKind;
	/** Directory that replaces the user's home inside the sandbox. Default: `<agentDir>/sandbox`. */
	home?: string;
	/** Extra writable directories (absolute, or relative to cwd). */
	writable: string[];
	/** Keep the network reachable from sandboxed commands. Default: false. */
	allowNetwork: boolean;
}

export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
	writable: [],
	allowNetwork: false,
};

export type SandboxAvailability =
	| { available: true; kind: SandboxKind; launcher: string }
	| { available: false; kind?: SandboxKind; reason: string };

function asSandboxKind(value: unknown): SandboxKind | undefined {
	return value === "bwrap" || value === "sandbox-exec" ? value : undefined;
}

export function normalizeSandboxConfig(value: unknown): SandboxConfig {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	const writable = Array.isArray(record?.writable)
		? record.writable.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
		: [];
	return {
		engine: asSandboxKind(record?.engine),
		home: typeof record?.home === "string" && record.home.trim() ? record.home.trim() : undefined,
		writable,
		allowNetwork: record?.allowNetwork === true,
	};
}

function detectKind(): SandboxKind {
	return process.platform === "darwin" ? "sandbox-exec" : "bwrap";
}

/** Whether a launcher is usable here: present, and supported by the platform. */
export function detectSandbox(config: SandboxConfig, env: NodeJS.ProcessEnv = process.env): SandboxAvailability {
	const kind = config.engine ?? detectKind();
	if (kind === "bwrap" && process.platform !== "linux") {
		return { available: false, kind, reason: "bubblewrap is Linux-only" };
	}
	if (kind === "sandbox-exec" && process.platform !== "darwin") {
		return { available: false, kind, reason: "sandbox-exec is macOS-only" };
	}
	const launcher = findExecutable(kind, env);
	if (!launcher) {
		return {
			available: false,
			kind,
			reason:
				kind === "bwrap"
					? "bubblewrap not found; install it (for example `apt install bubblewrap`)"
					: "sandbox-exec not found; it ships with macOS",
		};
	}
	return { available: true, kind, launcher };
}

/** Resolve the sandbox home directory, creating nothing. Default `<agentDir>/sandbox`. */
export function resolveSandboxHome(config: SandboxConfig, env: NodeJS.ProcessEnv = process.env): string {
	if (config.home) return isAbsolute(config.home) ? config.home : join(process.cwd(), config.home);
	const agentDir = env.NANOPI_CODING_AGENT_DIR ?? join(homedir(), ".nanopi", "agent");
	return join(agentDir, "sandbox");
}

/** Quote one shell word, so the model sees its own command inside the launcher call. */
export function shellQuote(word: string): string {
	return `'${word.replace(/'/g, `'\\''`)}'`;
}

/** An existing source directory for a mount point, following merged-/usr (`/bin` -> `/usr/bin`). */
function sandboxPath(dir: string): string | undefined {
	if (existsSync(dir)) return dir;
	const merged = `/usr${dir}`;
	return existsSync(merged) ? merged : undefined;
}

/** Paths every sandboxed command needs to run at all. */
const READ_ONLY_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc", "/opt", "/nix/store"];
const SHARED_DEVICES = ["/dev/null", "/dev/zero", "/dev/full", "/dev/random", "/dev/urandom", "/dev/tty"];

export interface SandboxCommandOptions {
	cwd: string;
	home: string;
}

export interface SandboxCommand {
	/** Launcher argv prefix; the wrapped shell command is appended quoted. */
	argv: string[];
}

function bwrapCommand(config: SandboxConfig, options: SandboxCommandOptions, launcher: string): SandboxCommand {
	const argv = [launcher, "--die-with-parent", "--unshare-pid", "--new-session", "--proc", "/proc", "--dev", "/dev"];
	if (!config.allowNetwork) argv.push("--unshare-net");
	for (const dir of READ_ONLY_DIRS) {
		const source = sandboxPath(dir);
		if (source) argv.push("--ro-bind", source, dir);
	}
	for (const device of SHARED_DEVICES) {
		if (existsSync(device)) argv.push("--dev-bind", device, device);
	}
	argv.push("--ro-bind", options.cwd, options.cwd);
	const writable = [options.cwd, options.home, ...config.writable.map((dir) => absolutize(dir, options.cwd))];
	for (const dir of new Set(writable)) {
		if (existsSync(dir)) argv.push("--bind", dir, dir);
	}
	argv.push("--chdir", options.cwd, "--setenv", "HOME", options.home);
	return { argv };
}

/** Escape a value for the literal part of a Seatbelt profile. */
function profileString(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function seatbeltProfile(config: SandboxConfig, options: SandboxCommandOptions): string {
	// No deny of relative writes: Seatbelt filters on resolved absolute paths only.
	const writable = [
		...new Set([options.cwd, options.home, ...config.writable.map((dir) => absolutize(dir, options.cwd))]),
	]
		.filter((dir) => existsSync(dir))
		.map((dir) => `(subpath "${profileString(dir)}")`)
		.join(" ");
	const network = config.allowNetwork ? "(allow network*)" : "";
	return `(version 1)
(allow default)
(deny file-write*)
(allow file-write* (subpath "/private/tmp") (subpath "/private/var/tmp") (subpath "/tmp") ${writable})
${network}`.trim();
}

function sandboxExecCommand(config: SandboxConfig, options: SandboxCommandOptions, launcher: string): SandboxCommand {
	return { argv: [launcher, "-p", seatbeltProfile(config, options)] };
}

function absolutize(dir: string, cwd: string): string {
	return isAbsolute(dir) ? dir : join(cwd, dir);
}

/** Launcher invocation for one command, or a reason it cannot be built. */
export function buildSandboxCommand(
	config: SandboxConfig,
	options: SandboxCommandOptions,
	availability: SandboxAvailability,
): SandboxCommand {
	if (!availability.available) throw new Error(availability.reason);
	return availability.kind === "bwrap"
		? bwrapCommand(config, options, availability.launcher)
		: sandboxExecCommand(config, options, availability.launcher);
}

/**
 * The one limit a sandboxed shell call hits by surprise, or undefined when the
 * call needs no warning. Writes are covered by the permission prompt (the path
 * it shows), so only a cut network is reported.
 */
export function describeSandboxCall(config: SandboxConfig, toolName: string): string | undefined {
	if (config.allowNetwork) return undefined;
	return SHELL_TOOL_NAMES.has(toolName) ? "network blocked by sandbox" : undefined;
}

export interface SandboxRunnerOptions {
	config: SandboxConfig;
	availability: SandboxAvailability;
	/** Runs the launcher call; the coding-agent passes its own local shell backend. */
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
	home: string;
}

/**
 * A `BashOperations`-shaped backend that delegates to `exec` through the
 * launcher. Structurally identical to the coding-agent's interface, which is
 * all the registry needs; pi-extra keeps no type-level dependency on it.
 *
 * The caller's shell runs the quoted launcher call, so the caller keeps timeout
 * and abort handling. The launcher path is absolute and the `HOME` override is
 * applied by the launcher itself (`--setenv` / the profile), because the caller
 * rebuilds the environment of every command it runs.
 */
export function createSandboxedBashOperations(options: SandboxRunnerOptions): {
	exec: (
		command: string,
		cwd: string,
		call: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
	) => Promise<{ exitCode: number | null }>;
} {
	const { config, availability, exec, home } = options;
	return {
		exec: async (command, cwd, call) => {
			let built: SandboxCommand;
			try {
				built = buildSandboxCommand(config, { cwd, home }, availability);
			} catch (error) {
				call.onData(
					Buffer.from(`sandbox unavailable: ${error instanceof Error ? error.message : String(error)}\n`),
				);
				return { exitCode: 1 };
			}
			// Each launcher argument is one quoted shell word; the command itself is
			// passed as a single shell-quoted string to `/bin/sh -c`.
			const wrapped = [...built.argv.map(shellQuote), "/bin/sh", "-c", shellQuote(command)].join(" ");
			return exec(wrapped, cwd, call);
		},
	};
}
