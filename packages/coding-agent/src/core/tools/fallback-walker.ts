/**
 * In-process file walking for the grep and find tools when their native helpers
 * (ripgrep, fd) are unavailable, which is the normal case with `NANOPI_OFFLINE=1`,
 * a locked-down network, or a container without them preinstalled.
 *
 * The walk keeps the same contract the external binaries give the tools:
 * `.gitignore` / `.ignore` / `.fdignore` are honored per directory (including
 * nested files and negations), dotfiles are included, and symlinks are never
 * followed. Patterns come from `ignore`, so a walk started inside a subdirectory
 * of a repository does not honor the parent's rules: neither does fd, and reading
 * parents would make results depend on files outside the search root.
 */

import type { Dirent } from "node:fs";
import { lstat as fsLstat, readdir as fsReaddir, readFile as fsReadFile } from "node:fs/promises";
import ignore from "ignore";
import { join, relative, sep } from "path";

/** Same order as `skills.ts` and fd: later files add rules, none of them replaces another. */
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

function toPosixPath(filePath: string): string {
	return sep === "/" ? filePath : filePath.split(sep).join("/");
}

/** Keeps an ignore file's negation pointing at the same path once the rules are re-rooted. */
function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;

	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);

	const prefixed = `${prefix}${pattern}`;
	return negated ? `!${prefixed}` : prefixed;
}

export type WalkVisit = (filePath: string) => boolean | Promise<boolean>;

export interface WalkOptions {
	/** Called for every file that survives the ignore rules. Returning false stops the walk. */
	visit: WalkVisit;
	signal?: AbortSignal;
}

interface DirFrame {
	dir: string;
	/** Path relative to the walk root, "" for the root itself; the prefix ignore rules are re-rooted under. */
	relativeDir: string;
	matcher: ReturnType<typeof ignore>;
}

async function readIgnoreFile(dir: string): Promise<string[]> {
	const lines: string[] = [];
	for (const fileName of IGNORE_FILE_NAMES) {
		try {
			const content = await fsReadFile(join(dir, fileName), "utf-8");
			for (const line of content.split(/\r?\n/)) {
				if (line.trim()) lines.push(line);
			}
		} catch {
			// Missing or unreadable ignore files contribute nothing.
		}
	}
	return lines;
}

/**
 * Walks `root` depth-first, visiting each file once. Directories the ignore rules
 * exclude are never opened, so `.git` and `node_modules` cost one `readdir` each.
 * Returns false when `visit` asked to stop, true when the walk finished.
 */
export async function walkFiles(root: string, options: WalkOptions): Promise<boolean> {
	const rootMatcher = ignore();
	const rootPatterns = (await readIgnoreFile(root))
		.map((line) => prefixIgnorePattern(line, ""))
		.filter((line): line is string => Boolean(line));
	if (rootPatterns.length > 0) rootMatcher.add(rootPatterns);

	const stack: DirFrame[] = [{ dir: root, relativeDir: "", matcher: rootMatcher }];
	while (stack.length > 0) {
		if (options.signal?.aborted) return false;
		const frame = stack.pop() as DirFrame;

		let entries: Dirent[];
		try {
			entries = await fsReaddir(frame.dir, { withFileTypes: true });
		} catch {
			// Unreadable directories are skipped, like an rg/fd permission warning.
			continue;
		}

		const directories: DirFrame[] = [];
		for (const entry of entries) {
			const fullPath = join(frame.dir, entry.name);
			const relativePath = toPosixPath(join(frame.relativeDir, entry.name));
			if (frame.matcher.ignores(relativePath)) continue;

			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = await fsLstat(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			if (isDirectory) {
				// Rules accumulate down the tree: a nested ignore file re-roots its own
				// patterns under itself and inherits everything its parents matched,
				// which is what lets a root rule still exclude a file three levels down.
				const filePatterns = (await readIgnoreFile(fullPath))
					.map((line) => prefixIgnorePattern(line, `${toPosixPath(relativePath)}/`))
					.filter((line): line is string => Boolean(line));
				if (filePatterns.length > 0) frame.matcher.add(filePatterns);
				directories.push({ dir: fullPath, relativeDir: toPosixPath(relativePath), matcher: frame.matcher });
			} else if (isFile) {
				if (await options.visit(fullPath)) continue;
				return false;
			}
		}

		// Reversed so the depth-first order visits the first directory readdir returned first.
		for (let index = directories.length - 1; index >= 0; index--) stack.push(directories[index]);
	}
	return true;
}

/** Relative, posix-separated path of `filePath` under `root`. */
export function relativeToRoot(root: string, filePath: string): string {
	return toPosixPath(relative(root, filePath));
}
