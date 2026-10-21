/**
 * Loads module files from disk as `SessionModule`s.
 *
 * `SessionModule = { name, factory }` stays the only contract: this produces
 * plain objects and hands them to the same `loadModules()` every other module
 * goes through. The only new part is where the factory comes from — jiti
 * transforms the file in-process, so a user module needs no build step.
 *
 * jiti is imported lazily so a session that loads no disk module never pays
 * for it, and the build keeps it out of the flavors that cannot load one
 * (see the `jiti-modules` component in buildconfig.json).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuildComponentEnabled } from "../../build-components.ts";
import { APP_NAME, CONFIG_DIR_NAME, isBundledNode } from "../../config.ts";
import { isSingleNodeFileRuntime } from "../../standalone/assets.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ModuleFactory, SessionModule } from "./types.ts";

/** Environment variable naming module files or directories, `path.delimiter`-separated. */
export const ENV_MODULES = `${APP_NAME.toUpperCase()}_EXTENSIONS`;

/** Extensions a module file may use. Anything else in the directory is ignored. */
const MODULE_FILE_PATTERN = /\.[cm]?[jt]s$/;
const MODULE_INDEX_NAMES = ["index.ts", "index.mts", "index.js", "index.mjs", "index.cts", "index.cjs"];

/**
 * Whether this build can load modules from disk at all. Two ways to get no:
 * the flavor dropped the `jiti-modules` component, or the artifact is the
 * single file, which keeps jiti external to stay zero-dependency, so a disk
 * import there would fail with MODULE_NOT_FOUND.
 */
export function diskModulesIncluded(): boolean {
	return isBuildComponentEnabled("jiti-modules") && !isBundledNode && !isSingleNodeFileRuntime();
}

/**
 * Bare specifiers a module file may import, and where they resolve to.
 *
 * Aliases point at the three forms a nanopi installation takes, in the order a
 * module file is likely to meet them:
 * - a source checkout: the sibling `src/` trees, which jiti transforms like the
 *   module file itself, so there is no build step between them;
 * - a built checkout: the sibling `dist/` trees this file was compiled into;
 * - an installed package: whatever `import.meta.resolve` answers, which is the
 *   only form left once there is no workspace beside the package.
 */
function jitiAliases(): Record<string, string> {
	const here = dirname(fileURLToPath(import.meta.url));
	// src/core/modules -> src, dist/core/modules -> dist
	const entryDir = resolve(here, "..", "..");
	// The package root (`packages/coding-agent`) is two levels above either one.
	const packagesRoot = resolve(entryDir, "..", "..");
	const workspaceEntry = (workspacePackage: string, specifier: string): string => {
		for (const tree of ["src", "dist"]) {
			for (const file of ["index.ts", "index.js"]) {
				const candidate = join(packagesRoot, workspacePackage, tree, file);
				if (existsSync(candidate)) return candidate;
			}
		}
		return fileURLToPath(import.meta.resolve(specifier));
	};
	const workspace = (workspacePackage: string, specifier: string): string | undefined => {
		const entry = workspaceEntry(workspacePackage, specifier);
		return existsSync(entry) ? entry : undefined;
	};
	const aliases: Record<string, string> = { "@nanopi/pi-coding-agent": join(entryDir, "index.ts") };
	if (!existsSync(aliases["@nanopi/pi-coding-agent"])) aliases["@nanopi/pi-coding-agent"] = join(entryDir, "index.js");
	for (const [workspacePackage, specifier] of [
		["agent", "@nanopi/pi-agent-core"],
		["ai", "@nanopi/pi-ai"],
		["tui", "@nanopi/pi-tui"],
	] as const) {
		const entry = workspace(workspacePackage, specifier);
		if (entry !== undefined) aliases[specifier] = entry;
	}
	return aliases;
}

interface JitiInstance {
	import: (specifier: string, options?: { default?: boolean }) => Promise<unknown>;
}

type CreateJiti = (file: string, options: Record<string, unknown>) => JitiInstance;

let createJitiPromise: Promise<CreateJiti> | undefined;

function getCreateJiti(): Promise<CreateJiti> {
	createJitiPromise ??= import("jiti").then((module) => module.createJiti as CreateJiti);
	return createJitiPromise;
}

function isModuleFile(name: string): boolean {
	return MODULE_FILE_PATTERN.test(name) && !name.endsWith(".d.ts");
}

/** Module files directly in `dir`: `foo.ts` and `foo/index.ts`, one level deep. */
function moduleFilesIn(dir: string): string[] {
	let entries: Array<{ name: string; isFile: () => boolean; isDirectory: () => boolean }>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		const path = join(dir, entry.name);
		if (isModuleFile(entry.name) && entry.isFile()) {
			files.push(path);
			continue;
		}
		if (!entry.isDirectory()) continue;
		const index = MODULE_INDEX_NAMES.map((name) => join(path, name)).find((candidate) => existsSync(candidate));
		if (index !== undefined) files.push(index);
	}
	return files.sort();
}

/** The module files a path names: one file, or a directory's entries. Empty when it holds none. */
export function resolveModulePaths(path: string, baseDir: string = process.cwd()): string[] {
	const resolved = resolvePath(path, baseDir, { normalizeUnicodeSpaces: true });
	try {
		const stats = statSync(resolved);
		if (stats.isFile()) return [resolved];
		if (stats.isDirectory()) return moduleFilesIn(resolved);
	} catch {
		// A path that does not exist is reported by the caller as a diagnostic.
	}
	return [];
}

export interface DiskModuleScan {
	/** Files to load, in load order. */
	files: string[];
	/** Explicit paths that named no module file. */
	missing: string[];
	/** Directories that were searched, for diagnostics. */
	directories: string[];
}

export interface ScanDiskModulesOptions {
	cwd: string;
	agentDir: string;
	/** Whether project-local modules may be scanned (they are code from the project). */
	projectTrusted: boolean;
}

/**
 * Discover module files.
 *
 * Three sources, in load order: `$NANOPI_EXTENSIONS`, the agent directory's
 * `extensions/`, then the project's `.nanopi/extensions/`. The project
 * directory holds code the project wrote, so it is scanned only when the
 * project is trusted — the gate settings.json and project skills already sit
 * behind.
 */
export function scanDiskModules(options: ScanDiskModulesOptions): DiskModuleScan {
	const explicit = (process.env[ENV_MODULES] ?? "")
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const projectDir = join(options.cwd, CONFIG_DIR_NAME, "extensions");
	const directories = [join(options.agentDir, "extensions")];
	if (options.projectTrusted) directories.push(projectDir);

	const files: string[] = [];
	const missing: string[] = [];
	const seen = new Set<string>();
	const add = (paths: string[]) => {
		for (const path of paths) {
			if (seen.has(path)) continue;
			seen.add(path);
			files.push(path);
		}
	};

	for (const entry of explicit) {
		const paths = resolveModulePaths(entry, options.cwd);
		if (paths.length === 0) missing.push(entry);
		add(paths);
	}
	for (const dir of directories) add(moduleFilesIn(dir));

	return { files, missing, directories };
}

/** `foo/index.ts` is module `foo`, everything else is its file name without the extension. */
function moduleNameFor(file: string): string {
	const base = basename(file);
	if (MODULE_INDEX_NAMES.includes(base)) return basename(dirname(file));
	return base.replace(MODULE_FILE_PATTERN, "");
}

async function loadDiskModule(file: string, createJiti: CreateJiti): Promise<SessionModule> {
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		alias: jitiAliases(),
		// A module file imports its siblings by their source spelling and may
		// name a bare package without a tsconfig; jiti resolves both.
		interopDefault: true,
	});
	// `default: true` unwraps the default export, but only when the module has
	// one; a `SessionModule` object comes back as-is, a bare factory wrapped.
	const exported = await jiti.import(file, { default: true });
	const candidate =
		typeof exported === "function"
			? exported
			: ((exported as { default?: unknown; factory?: unknown } | undefined)?.default ??
				(exported as { factory?: unknown } | undefined)?.factory);
	if (typeof candidate !== "function") {
		throw new Error("does not default-export a session module or a module factory function");
	}
	return { name: moduleNameFor(file), factory: candidate as ModuleFactory };
}

export interface LoadDiskModulesResult {
	modules: SessionModule[];
	errors: Array<{ path: string; error: string }>;
}

/**
 * Load the given module files. Errors stay per file: one broken module must
 * not keep the rest, or the whole session, from starting.
 */
export async function loadDiskModules(files: readonly string[]): Promise<LoadDiskModulesResult> {
	if (files.length === 0) return { modules: [], errors: [] };
	const createJiti = await getCreateJiti();
	const modules: SessionModule[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	for (const file of files) {
		try {
			modules.push(await loadDiskModule(file, createJiti));
		} catch (error) {
			errors.push({ path: file, error: error instanceof Error ? error.message : String(error) });
		}
	}
	return { modules, errors };
}
