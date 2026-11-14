/**
 * Where a project keeps the resources every agent tool can read.
 *
 * `CONFIG_DIR_NAME` (`~/.nanopi`, `.nanopi`) holds machine-local state:
 * settings, sessions, credentials, installed packages. Skills and prompt
 * templates are authored text that belongs to the project, so they live in
 * `.agents/` beside the notes and the other tool-agnostic files. `.nanopi/` is
 * still read, after `.agents/`, so an existing checkout keeps working.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";

/** Project-wide resources: `<dir>/.agents`. */
export const SHARED_CONFIG_DIR_NAME = ".agents";

type ProjectResource = "skills" | "prompts";

/** The directories a search starts from: `dir`, then each parent up to the filesystem root. */
export function selfAndAncestorDirs(startDir: string): string[] {
	const dirs: string[] = [];
	let dir = startDir;
	while (true) {
		dirs.push(dir);
		const parent = dirname(dir);
		if (parent === dir) return dirs;
		dir = parent;
	}
}

/**
 * Project skill and prompt directories, highest precedence first.
 *
 * `.agents/` is searched in `cwd` and every ancestor, so a nested checkout
 * (`repo/packages/app`) still finds the resources at the repository root.
 * `.nanopi/` only ever means `cwd`, the directory that holds the settings and
 * the modules.
 */
export function projectResourceDirs(cwd: string, resource: ProjectResource): string[] {
	const homeSharedDir = join(homedir(), SHARED_CONFIG_DIR_NAME, resource);
	const sharedDirs = selfAndAncestorDirs(cwd)
		.map((dir) => join(dir, SHARED_CONFIG_DIR_NAME, resource))
		.filter((dir) => dir !== homeSharedDir);
	const nanopiDir = join(cwd, CONFIG_DIR_NAME, resource);
	return sharedDirs.includes(nanopiDir) ? sharedDirs : [...sharedDirs, nanopiDir];
}

/**
 * Whether the project contributes skills or prompts, which is what makes it
 * need a trust decision. The user's `~/.agents/` directory is their own and
 * never counts, even when `cwd` is `$HOME`, and the ancestor walk stops at
 * `$HOME`: directories above it (`/home`, `/`) are user territory rather than
 * project context, so a stray `.agents/` there must not put every checkout
 * below it behind a trust prompt.
 */
export function hasProjectResourceDirs(cwd: string): boolean {
	const resources: ProjectResource[] = ["skills", "prompts"];
	const homeDir = homedir();
	const dirs = projectContextDirs(cwd, homeDir);
	return resources.some((resource) => dirs.some((dir) => existsSync(join(dir, SHARED_CONFIG_DIR_NAME, resource))));
}

/**
 * `cwd` and its ancestors up to, but not including, the user's home directory.
 * Empty when `cwd` is `$HOME`: the home directory is the user's own.
 */
function projectContextDirs(cwd: string, homeDir: string): string[] {
	const dirs: string[] = [];
	for (const dir of selfAndAncestorDirs(cwd)) {
		if (dir === homeDir) break;
		dirs.push(dir);
	}
	return dirs;
}
