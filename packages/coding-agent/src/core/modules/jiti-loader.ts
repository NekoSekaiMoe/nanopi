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
import { createRequire } from "node:module";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBuildComponentEnabled } from "../../build-components.ts";
import { APP_NAME, CONFIG_DIR_NAME, isBundledNode } from "../../config.ts";
import { isSingleNodeFileRuntime } from "../../standalone/assets.ts";
import { resolvePath } from "../../utils/paths.ts";
import { SHARED_CONFIG_DIR_NAME } from "../agents-dirs.ts";
import type { ModuleFactory, SessionModule } from "./types.ts";

/** Environment variable naming module files or directories, `path.delimiter`-separated. */
export const ENV_MODULES = `${APP_NAME.toUpperCase()}_EXTENSIONS`;

/** Extensions a module file may use. Anything else in the directory is ignored. */
const MODULE_FILE_PATTERN = /\.[cm]?[jt]s$/;
const MODULE_INDEX_NAMES = ["index.ts", "index.mts", "index.js", "index.mjs", "index.cts", "index.cjs"];

/**
 * Whether this build can load modules from disk at all.
 *
 * Two gates, for two different questions. The component switch answers for a
 * flavor that dropped the module entirely (the stub replaces this file, so
 * this code does not even ship there), and the single-file artifact answers for
 * itself: it keeps jiti external to stay zero-dependency and is meant to load
 * no module at all, so its own marker decides.
 *
 * Everything else asks whether jiti resolves, which is what the lazy
 * `import("jiti")` below will do. A build-time guess gets this wrong in both
 * directions: `NANOPI_BUNDLED_NODE` is *not* a reason to say no — the npm
 * package's `dist/bundle/` ships jiti as a dependency and resolves it — while a
 * bundled CLI whose node is vendored, and a source checkout whose jiti is
 * linked, are exactly the cases a probe gets right.
 */
export function diskModulesIncluded(): boolean {
	if (!isBuildComponentEnabled("jiti-modules")) return false;
	if (isSingleNodeFileRuntime()) return false;
	return canResolveJiti();
}

let jitiResolvable: boolean | undefined;

/** Whether `jiti` resolves from here, cached: the answer cannot change mid-process. */
function canResolveJiti(): boolean {
	jitiResolvable ??= (() => {
		try {
			// `createRequire` matches how the lazy `import("jiti")` below resolves,
			// so a probe that succeeds means the import will too.
			createRequire(import.meta.url).resolve("jiti");
			return true;
		} catch {
			return false;
		}
	})();
	return jitiResolvable;
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
	// The tree this file runs from, found by its own contents instead of by
	// counting `..`s: a module file that imports `@nanopi/pi-coding-agent` must
	// land on the code that is actually running, or it gets a second copy of the
	// host classes and every `instanceof` across the boundary fails. Counting
	// depth broke as soon as a build moved this file (the bundle emits it into
	// `dist/bundle/chunks`, whose `../..` is `dist`, one tree too high).
	const entryDir = findHostTreeRoot(here);
	// The monorepo root above the packages, for the sibling workspace packages.
	const packagesRoot = findWorkspacePackagesDir(here) ?? resolve(entryDir, "..", "..");
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
	const aliases: Record<string, string> = {
		"@nanopi/pi-coding-agent": join(entryDir, "index.ts"),
		"@nanopi/pi-coding-agent/modules": join(entryDir, "modules-api.ts"),
		"@nanopi/pi-coding-agent/ui": join(entryDir, "ui.ts"),
	};
	if (!existsSync(aliases["@nanopi/pi-coding-agent"])) aliases["@nanopi/pi-coding-agent"] = join(entryDir, "index.js");
	for (const subpath of ["modules", "ui"]) {
		const key = `@nanopi/pi-coding-agent/${subpath}`;
		if (!existsSync(aliases[key])) aliases[key] = aliases[key].replace(/\.ts$/, ".js");
	}
	for (const [workspacePackage, specifier] of [
		["agent", "@nanopi/pi-agent-core"],
		["ai", "@nanopi/pi-ai"],
		["tui", "@nanopi/pi-tui"],
	] as const) {
		const entry = workspace(workspacePackage, specifier);
		if (entry !== undefined) aliases[specifier] = entry;
	}
	// A tool definition's schema has to come from the TypeBox instance the host
	// validates with. `typebox` is a dependency of this package, so it resolves
	// from here even though the module file lives somewhere else.
	for (const specifier of ["typebox", "typebox/compile", "typebox/value"]) {
		aliases[specifier] = fileURLToPath(import.meta.resolve(specifier));
	}
	return aliases;
}

/**
 * The directory holding the running host entry: the nearest ancestor of
 * `startDir` that carries both the package entry and the modules entry. In a
 * source checkout that is `src/`, in a compiled checkout `dist/`, and in the
 * bundled build `dist/bundle/`, which has its own copies of both.
 */
function findHostTreeRoot(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const hasEntry = ["index.ts", "index.js"].some((file) => existsSync(join(dir, file)));
		const hasModulesEntry = ["modules-api.ts", "modules-api.js"].some((file) => existsSync(join(dir, file)));
		if (hasEntry && hasModulesEntry) return dir;
		dir = dirname(dir);
	}
	return resolve(startDir, "..", "..");
}

/**
 * The directory whose children are the workspace packages (`agent`, `ai`, ...),
 * found by walking up to the repository root rather than by counting `..`s.
 * Undefined in an installed package, where there is no workspace beside the
 * module and only `import.meta.resolve` answers.
 */
function findWorkspacePackagesDir(startDir: string): string | undefined {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		const packagesDir = join(dir, "packages");
		if (existsSync(join(dir, "pnpm-workspace.yaml")) && existsSync(packagesDir)) return packagesDir;
		dir = dirname(dir);
	}
	return undefined;
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
 * Sources, in load order: `$NANOPI_EXTENSIONS`, the agent directory's
 * `extensions/`, then the project's `.agents/extensions/` and
 * `.nanopi/extensions/`. The project directories hold code the project wrote,
 * so they are scanned only when the project is trusted — the gate
 * settings.json and project skills already sit behind. `.agents/` comes first
 * so a module that lives beside the project's skills and prompts loads before
 * the legacy copy in `.nanopi/`.
 */
export function scanDiskModules(options: ScanDiskModulesOptions): DiskModuleScan {
	const explicit = (process.env[ENV_MODULES] ?? "")
		.split(delimiter)
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	const directories = [join(options.agentDir, "extensions")];
	if (options.projectTrusted) {
		directories.push(
			join(options.cwd, SHARED_CONFIG_DIR_NAME, "extensions"),
			join(options.cwd, CONFIG_DIR_NAME, "extensions"),
		);
	}

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
export function diskModuleName(file: string): string {
	const base = basename(file);
	if (MODULE_INDEX_NAMES.includes(base)) return basename(dirname(file));
	return base.replace(MODULE_FILE_PATTERN, "");
}

let virtualModulesPromise: Promise<Record<string, unknown>> | undefined;

function getVirtualModules(): Promise<Record<string, unknown>> {
	virtualModulesPromise ??= import("./virtual-modules.ts").then((module) => module.VIRTUAL_MODULES);
	return virtualModulesPromise;
}

/**
 * How a module file's bare imports resolve.
 *
 * A bundled runtime answers from the namespaces it already has. A path alias
 * there would name a *file*, and the only file left in the npm package is the
 * unbundled `dist/` tree — a second copy of the host, so a module's `Text` or
 * `CustomEditor` would fail the `instanceof` checks the process runs against
 * its own bundled classes.
 *
 * Every other runtime aliases to a path: the host and the module file then
 * import the same files, and instance identity holds either way.
 */
async function resolutionOptions(): Promise<Record<string, unknown>> {
	if (isBundledNode) return { virtualModules: await getVirtualModules(), tryNative: false };
	return { alias: jitiAliases() };
}

async function loadDiskModule(file: string, createJiti: CreateJiti): Promise<SessionModule> {
	const resolution = await resolutionOptions();
	const jiti = createJiti(import.meta.url, {
		moduleCache: false,
		...resolution,
		// A module file imports its siblings by their source spelling and may
		// name a bare package without a tsconfig; jiti resolves both.
		interopDefault: true,
	});
	// `default: true` unwraps the default export, but only when the module has
	// one; a `SessionModule` object comes back as-is, a bare factory wrapped.
	const exported = await jiti.import(file, { default: true });
	// `default: true` unwraps a default export, but a `SessionModule` object
	// comes back whole, so the factory may sit on it rather than be it.
	const exportedObject = typeof exported === "object" && exported !== null ? (exported as SessionModule) : undefined;
	const candidate =
		typeof exported === "function"
			? exported
			: ((exported as { default?: unknown } | undefined)?.default ??
				(exported as { factory?: unknown } | undefined)?.factory);
	if (typeof candidate !== "function") {
		throw new Error("does not default-export a session module or a module factory function");
	}
	const module: SessionModule = { name: diskModuleName(file), factory: candidate as ModuleFactory };
	// The file's own teardown matters as much as its factory: without it a
	// reloaded module cannot release the socket or child process it opened.
	const dispose = exportedObject?.dispose ?? (exported as { default?: SessionModule } | undefined)?.default?.dispose;
	if (typeof dispose === "function") module.dispose = dispose.bind(exportedObject ?? exported);
	return module;
}

export interface LoadDiskModulesResult {
	modules: SessionModule[];
	errors: Array<{ path: string; error: string }>;
}

/**
 * Identity of the file's current contents: inode, size, and modification time.
 *
 * The inode catches a rename over the file (editors write to a temp file and
 * rename), which keeps size and mtime unchanged often enough to matter. Two
 * writes within the same timestamp tick are indistinguishable, which is why the
 * watcher debounces instead of relying on the key alone.
 */
export function diskModuleStatKey(file: string): string | undefined {
	try {
		const stats = statSync(file);
		if (!stats.isFile()) return undefined;
		return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
	} catch {
		return undefined;
	}
}

/** Load one module file. The building block a hot reload re-runs one file with. */
export async function loadDiskModuleFile(file: string): Promise<SessionModule> {
	const createJiti = await getCreateJiti();
	return loadDiskModule(file, createJiti);
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
