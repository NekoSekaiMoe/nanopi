/**
 * Build identity: the version shown in the welcome box and `--version`.
 *
 * The date comes from the package.json version (`<YYYYMMDD>.<n>.0`, see
 * .agents/notes/implemented/feature/2026-10-15-build-version-date-and-commit.md)
 * and the seven-character commit from the build that produced this process:
 *
 * - bundled builds inject `NANOPI_BUILD_COMMIT` (git HEAD at build time);
 * - everything else (source checkouts, npm installs) reads the repository the
 *   process runs in, so a dev checkout still reports its own HEAD.
 *
 * The commit is resolved once at module init: spawning git is not free, and the
 * identity of a running process must not change mid-session.
 */
import { spawnSync } from "node:child_process";
import { VERSION } from "../config.ts";

/** Full HEAD sha, injected by the bundle and single-file build scripts. */
declare const NANOPI_BUILD_COMMIT: string | undefined;

/** Length of the short commit id shown to users. */
const COMMIT_LENGTH = 7;

const DATE_VERSION_RE = /^(\d{8})(?:\.\d+)*$/;

/** `20261013.1.0` -> `20261013`. Non-date versions pass through unchanged. */
export function dateFromVersion(version: string): string {
	const match = DATE_VERSION_RE.exec(version);
	return match ? match[1] : version;
}

/** Lowercase hex, or undefined when git has nothing usable to say. */
export function resolveBuildCommit(cwd: string | undefined = process.cwd()): string | undefined {
	try {
		const result = spawnSync("git", ["rev-parse", `--short=${COMMIT_LENGTH}`, "HEAD"], {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 1000,
		});
		if (result.error !== undefined || result.status !== 0) return undefined;
		const commit = result.stdout.trim().toLowerCase();
		return /^[0-9a-f]{7,40}$/.test(commit) ? commit : undefined;
	} catch {
		return undefined;
	}
}

/** `v20261013.718adde`, or just the date when no commit is known. */
export function formatBuildVersion(version: string, commit: string | undefined): string {
	const date = dateFromVersion(version);
	// Both sources are accepted: build scripts inject the full sha, runtime git
	// lookups already ask for the short form.
	const short = commit ? commit.slice(0, COMMIT_LENGTH) : undefined;
	return short ? `v${date}.${short}` : `v${date}`;
}

const buildCommit = typeof NANOPI_BUILD_COMMIT === "string" ? NANOPI_BUILD_COMMIT.trim() : resolveBuildCommit();

export const BUILD_VERSION: string = formatBuildVersion(VERSION, buildCommit);
