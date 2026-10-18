/**
 * Executable lookup shared by the extra's optional subsystems (sandbox
 * launchers, sandboxed ssh). Paths come from PATH plus the agent bin
 * directory, which is where nanopi installs managed sidecars.
 */

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const ENV_AGENT_DIR = "NANOPI_CODING_AGENT_DIR";

function getAgentBinDir(): string {
	const agentDir = process.env[ENV_AGENT_DIR] ?? join(homedir(), ".nanopi", "agent");
	return join(agentDir, "bin");
}

function isExecutableFile(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Absolute path of `name` when it is an executable file, else undefined.
 * `env.PATH` takes precedence over the process PATH so a command that runs
 * with a modified environment decides with the same PATH it will run with.
 */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	if (isAbsolute(name)) return isExecutableFile(name) ? name : undefined;
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const dirs = [...(env[pathKey] ?? "").split(delimiter), getAgentBinDir()].filter(Boolean);
	for (const dir of dirs) {
		const candidate = join(dir, name);
		if (isExecutableFile(candidate)) return candidate;
	}
	return undefined;
}

/**
 * Run `command` through `/bin/sh`. A fallback local shell for callers without a
 * coding-agent session (tests, standalone use); inside a session the
 * coding-agent's own backend is used, so `shellPath`, timeout and process-tree
 * kills stay consistent with the built-in tool.
 */
export function execInLocalShell(
	command: string,
	cwd: string,
	onData: (data: Buffer) => void,
	signal?: AbortSignal,
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve, reject) => {
		const child = spawn("/bin/sh", ["-c", command], { cwd, stdio: ["ignore", "pipe", "pipe"] });
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);
		child.on("error", reject);
		const onAbort = () => child.kill("SIGKILL");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.on("close", (code) => {
			signal?.removeEventListener("abort", onAbort);
			resolve({ exitCode: code });
		});
	});
}
