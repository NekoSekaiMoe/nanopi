import fsSync from "node:fs";
import path from "node:path";
import { isWSL } from "../../../utils/wsl.ts";

/**
 * PATH lookup for MCP stdio commands, correct on Windows too.
 *
 * `mcp-lite` used to hand the configured command straight to `spawn`, which the
 * docs then apologized for: on Windows the `npx` a user configures is
 * `npx.cmd`, and `spawn("npx", …)` without a shell is `ENOENT`. Resolving the
 * full path here fixes the common case; `wrapForShell` handles the rest (a
 * `.cmd`/`.bat` shim still cannot be executed directly on some Node versions
 * and needs `cmd.exe /c`).
 */

const WINDOWS_DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

function isWindows(): boolean {
	return process.platform === "win32" || isWSL();
}

function windowsExtensions(): string[] {
	const raw = process.env.PATHEXT;
	const entries = raw
		? raw.split(";").map((entry) => entry.trim()).filter(Boolean)
		: WINDOWS_DEFAULT_PATHEXT;
	return [...new Set(entries.map((entry) => (entry.startsWith(".") ? entry : `.${entry}`).toLowerCase()))];
}

function readable(file: string): boolean {
	try {
		fsSync.accessSync(file, fsSync.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function probe(dir: string, name: string): string | undefined {
	const explicit = path.extname(name) !== "";
	const extensions = explicit ? [""] : process.platform === "win32" ? windowsExtensions() : isWindows() ? ["", ...windowsExtensions()] : [""];
	for (const extension of extensions) {
		const candidate = path.join(dir, `${name}${extension}`);
		if (!readable(candidate)) continue;
		if (!isWindows()) {
			try {
				fsSync.accessSync(candidate, fsSync.constants.X_OK);
			} catch {
				continue;
			}
		}
		return candidate;
	}
	return undefined;
}

/**
 * Absolute path of the executable a stdio config names, or undefined.
 *
 * Absolute and relative-with-separator commands are returned unchanged (the
 * caller decided where they live); everything else is looked up on PATH.
 */
export function resolveCommand(command: string): string | undefined {
	if (!command) return undefined;
	if (path.isAbsolute(command) || command.includes("/") || command.includes("\\")) {
		return readable(command) ? command : undefined;
	}
	for (const dir of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
		const found = probe(dir, command);
		if (found) return found;
	}
	return undefined;
}

export interface LaunchSpec {
	command: string;
	args: string[];
	/** Set when the resolved executable needs `cmd.exe /c` to run (`.cmd`/`.bat` shim). */
	shellWrapper?: boolean;
}

/**
 * The command line to actually spawn.
 *
 * Resolving first keeps non-shim executables spawnable everywhere. A `.cmd` /
 * `.bat` shim is routed through `cmd.exe /d /c` on native Windows, which is what
 * `cross-spawn` does: without it Node refuses to execute the file. WSL is left
 * alone — a Windows shim started from a Linux process takes different arguments
 * and the call would reach the wrong side of the boundary.
 */
export function launchSpec(command: string, args: string[]): LaunchSpec {
	const resolved = resolveCommand(command) ?? command;
	if (process.platform !== "win32") return { command: resolved, args };
	if (!/\.(cmd|bat)$/i.test(resolved)) return { command: resolved, args };
	const comspec = process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
	// `/d` skips AutoRun registry commands, `/c` runs the rest of the line.
	return { command: comspec, args: ["/d", "/s", "/c", resolved, ...args], shellWrapper: true };
}

/** Whether `command` can be found at all, for status reporting before a spawn. */
export function commandAvailable(command: string): boolean {
	return resolveCommand(command) !== undefined;
}
