import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { isSingleNodeFileRuntime } from "./standalone/assets.ts";
import { normalizePath } from "./utils/paths.ts";
import { stripBom } from "./utils/text.ts";

// =============================================================================
// Package Detection
// =============================================================================

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Detect the esbuild-bundled Node.js distribution. */
declare const NANOPI_BUNDLED_NODE: boolean;
export const isBundledNode = typeof NANOPI_BUNDLED_NODE !== "undefined" && NANOPI_BUNDLED_NODE;

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (package.json, README.md, CHANGELOG.md):
 * the package root containing package.json.
 */
export function findNodePackageDir(startDir: string): string {
	let dir = startDir;
	while (dir !== dirname(dir)) {
		if (existsSync(join(dir, "package.json"))) {
			return dir;
		}
		dir = dirname(dir);
	}
	return startDir;
}

/**
 * The node invocation that runs this installation's own entry point.
 *
 * The single-file distribution (nanopi.js) must run itself: `getPackageDir()`
 * points at the extracted asset cache there, whose package.json has no `bin`
 * entry for a child to run through node. Anything this process runs was started
 * by node, so `argv[1]` is the entry that is actually executing. Everywhere
 * else the package's `bin` entry is the child entry, and a path that does not
 * exist is refused: a guess that is wrong only turns into a MODULE_NOT_FOUND
 * crash inside the child, where the reason is invisible to the parent.
 *
 * Falls back to the bare command name, so a caller that is not running from a
 * nanopi installation (`npx`, a global install shadowed by PATH) still spawns
 * the binary the user has.
 */
export function resolveHostEntry(): { cmd: string; args: string[] } {
	const entryPoint = process.argv[1];
	if (isSingleNodeFileRuntime() && entryPoint) return { cmd: process.execPath, args: [entryPoint] };
	try {
		const dir = getPackageDir();
		const bin = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).bin as Record<string, string> | undefined;
		const entry = bin?.[APP_NAME] ?? Object.values(bin ?? {})[0];
		if (typeof entry === "string") {
			const candidate = join(dir, entry);
			if (existsSync(candidate)) return { cmd: process.execPath, args: [candidate] };
		}
	} catch {
		// fall through
	}
	return { cmd: APP_NAME, args: [] };
}

export function getPackageDir(): string {
	// Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
	const envDir = process.env.NANOPI_PACKAGE_DIR;
	if (envDir) {
		return normalizePath(envDir);
	}

	return findNodePackageDir(__dirname);
}

/**
 * Get path to HTML export template directory (shipped with package)
 * - For Node.js (dist/): dist/core/export-html/
 * - For source (src/): src/core/export-html/
 */
export function getExportTemplateDir(): string {
	const packageDir = getPackageDir();
	const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
	return join(packageDir, srcOrDist, "core", "export-html");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
	return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
	return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
	return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
	return resolve(join(getPackageDir(), "examples"));
}

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
	return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

export type InstallChange = { kind: "updated"; version: string } | { kind: "removed" };

/**
 * Detect that the package this process runs from changed on disk, for example after the package
 * is updated in another terminal. Code loaded on demand can then be missing or from another version.
 *
 * Checks the package.json read at startup. Resolving it again would walk up past a deleted install
 * and could find an unrelated package.json, such as one in the home directory.
 */
export function detectInstallChange(packageJsonPath = startupPackageJsonPath): InstallChange | undefined {
	if (!packageJsonPath) return undefined;
	let installed: PackageJson;
	try {
		installed = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? { kind: "removed" } : undefined;
	}
	return installed.version && installed.version !== VERSION
		? { kind: "updated", version: installed.version }
		: undefined;
}

// =============================================================================
// App Config (from package.json nanopiConfig)
// =============================================================================

interface PackageJson {
	name?: string;
	version?: string;
	nanopiConfig?: {
		name?: string;
		configDir?: string;
	};
}

let pkg: PackageJson = {};
/** The package.json this process started from, if one existed. */
let startupPackageJsonPath: string | undefined;
try {
	const packageJsonPath = getPackageJsonPath();
	pkg = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8"))) as PackageJson;
	startupPackageJsonPath = packageJsonPath;
} catch (e: unknown) {
	const err = e as NodeJS.ErrnoException;
	if (err.code !== "ENOENT") throw e;
}

const nanopiConfigName: string | undefined = pkg.nanopiConfig?.name;
export const PACKAGE_NAME: string = pkg.name || "@nanopi/pi-coding-agent";
export const APP_NAME: string = nanopiConfigName || "nanopi";
export const APP_TITLE: string = nanopiConfigName ? APP_NAME : "nanopi";
export const CONFIG_DIR_NAME: string = pkg.nanopiConfig?.configDir || ".nanopi";
/** Standalone builds without embedded assets inject the version instead. */
declare const NANOPI_SINGLE_FILE_VERSION_FALLBACK: string | undefined;

export const VERSION: string =
	pkg.version ||
	(typeof NANOPI_SINGLE_FILE_VERSION_FALLBACK === "undefined" ? undefined : NANOPI_SINGLE_FILE_VERSION_FALLBACK) ||
	"0.0.0";

// e.g., NANOPI_CODING_AGENT_DIR or TAU_CODING_AGENT_DIR
export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_CODING_AGENT_SESSION_DIR`;

export function expandTildePath(path: string): string {
	return normalizePath(path);
}

// =============================================================================
// User Config Paths (~/.nanopi/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.nanopi/agent/) */
export function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) {
		return expandTildePath(envDir);
	}
	return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to models.json */
export function getModelsPath(): string {
	return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
	return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
	return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
	return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
	return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
	return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
	return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
