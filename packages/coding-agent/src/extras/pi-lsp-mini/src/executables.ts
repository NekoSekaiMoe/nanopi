import fsSync from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isWSL } from "../../../utils/wsl.ts";

/**
 * PATH lookup that works on every platform.
 *
 * The previous probe was `accessSync(dir/<name>, X_OK)`, which is only correct
 * on POSIX: Windows has no execute bit, and the executable a package manager
 * installs is usually `<name>.cmd` / `<name>.exe`, so probing the extensionless
 * name reported "not installed" for a perfectly runnable server (`npx` is
 * `npx.cmd`, `typescript-language-server` is the same). Probing now runs
 * `PATHEXT` (or the Windows defaults) and reads the result through
 * `which`/`where` before falling back to the directory walk, so Store aliases
 * and shims that only the shell can resolve are found too.
 */

const WINDOWS_DEFAULT_PATHEXT = [".COM", ".EXE", ".BAT", ".CMD"];

function isWindows(): boolean {
	// `process.platform` for a native Windows build; WSL runs Linux binaries but
	// interop puts `foo.cmd`-shaped shims on PATH, so treat it the same way.
	return process.platform === "win32" || isWSL();
}

function extensionsFor(platform: "win32" | "wsl" | "posix"): string[] {
	if (platform === "posix") return [""];
	// WSL interop: both the Windows shims and the Linux binaries they wrap.
	const raw = process.env.PATHEXT;
	const pathext = raw
		? raw.split(";").map((entry) => entry.trim()).filter(Boolean)
		: WINDOWS_DEFAULT_PATHEXT;
	const extensions = pathext.map((entry) => (entry.startsWith(".") ? entry : `.${entry}`).toLowerCase());
	const list = platform === "wsl" ? ["", ...extensions, ...WINDOWS_DEFAULT_PATHEXT.map((e) => e.toLowerCase())] : extensions;
	return [...new Set(list)];
}

function readable(file: string): boolean {
	try {
		fsSync.accessSync(file, fsSync.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function pathDirs(): string[] {
	return (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
}

/** Absolute result of one PATH entry, or undefined when nothing runnable is there. */
function probeDir(dir: string, name: string): string | undefined {
	const platform = !isWindows() ? "posix" : process.platform === "win32" ? "win32" : "wsl";
	// An explicit extension wins over PATHEXT ordering.
	const explicit = path.extname(name) !== "";
	for (const extension of explicit ? [""] : extensionsFor(platform)) {
		const candidate = path.join(dir, `${name}${extension}`);
		if (!readable(candidate)) continue;
		// POSIX keeps the execute bit check; Windows has nothing equivalent.
		if (platform === "posix") {
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

/** `which` / `where` — resolves shims and Store aliases a directory walk cannot. */
function fromSystemPathLookup(name: string): string | undefined {
	const [command, args] = process.platform === "win32" && !isWSL() ? ["where", [name]] : ["which", [name]];
	try {
		const result = spawnSync(command, args, { encoding: "utf8", timeout: 5000, windowsHide: true });
		if (result.status !== 0 || !result.stdout) return undefined;
		const first = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
		return first && readable(first) ? first : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Absolute path of an executable named on PATH, or undefined.
 *
 * Does not spawn for absolute paths: a configured `/usr/bin/clangd` is answered
 * from the filesystem alone.
 */
export function resolveExecutable(name: string): string | undefined {
	if (!name) return undefined;
	if (path.isAbsolute(name)) return readable(name) ? name : undefined;
	// `which`/`where` is authoritative where it exists; the walk covers a stripped
	// environment (no coreutils) and keeps absolute paths out of the spawn path.
	if (process.env.PATH) {
		const looked = fromSystemPathLookup(name);
		if (looked) return looked;
	}
	for (const dir of pathDirs()) {
		const found = probeDir(dir, name);
		if (found) return found;
	}
	return undefined;
}

/** Whether `name` resolves to something runnable on this machine. */
export function isExecutableAvailable(bin: string): boolean {
	return resolveExecutable(firstWord(bin)) !== undefined;
}

/** The executable part of a `command` entry ("gopls -remote=auto" -> "gopls"). */
export function firstWord(command: string): string {
	return command.trim().split(/\s+/)[0] ?? "";
}
