/**
 * Extra-owned settings storage: `<agentDir>/extra/settings.json` (global) with
 * an optional `<cwd>/.nanopi/extra/settings.json` project override. Kept out of
 * the core settings schema so the extra stays self-contained; the agent-dir
 * resolution mirrors src/config.ts (env `NANOPI_CODING_AGENT_DIR`, default
 * `~/.nanopi/agent`).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { SandboxConfig } from "./sandbox.ts";
import { type ExtraSettings, normalizeExtraSettings } from "./types.ts";

const ENV_AGENT_DIR = "NANOPI_CODING_AGENT_DIR";

function getAgentDir(): string {
	const envDir = process.env[ENV_AGENT_DIR];
	if (envDir) return envDir;
	return join(homedir(), ".nanopi", "agent");
}

/** Global settings file path (`<agentDir>/extra/settings.json`). */
export function globalExtraSettingsPath(): string {
	return join(getAgentDir(), "extra", "settings.json");
}

/** Project settings file path (`<cwd>/.nanopi/extra/settings.json`). */
export function projectExtraSettingsPath(cwd: string): string {
	return join(cwd, ".nanopi", "extra", "settings.json");
}

function readJson(file: string): Record<string, unknown> | undefined {
	try {
		if (!existsSync(file)) return undefined;
		const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as Record<string, unknown>;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

function writeJsonAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	const staging = `${file}.tmp-${process.pid}`;
	writeFileSync(staging, `${JSON.stringify(value, null, "\t")}\n`);
	try {
		renameSync(staging, file);
	} catch {
		rmSync(staging, { force: true });
		throw new Error(`failed to write ${file}`);
	}
}

export interface ResolvedExtraSettings {
	settings: ExtraSettings;
	/** Paths that contributed sections, innermost last. */
	sources: string[];
}

/** Merged settings: project file deep-merges over the global one. */
export function loadExtraSettings(cwd: string): ResolvedExtraSettings {
	const sources: string[] = [];
	const globalRaw = readJson(globalExtraSettingsPath());
	if (globalRaw) sources.push(globalExtraSettingsPath());
	const projectRaw = readJson(projectExtraSettingsPath(cwd));
	if (projectRaw) sources.push(projectExtraSettingsPath(cwd));

	const merged: Record<string, unknown> = { ...(globalRaw ?? {}) };
	if (projectRaw) {
		if ("defaultMode" in projectRaw) merged.defaultMode = projectRaw.defaultMode;
		if (projectRaw.subsystems && typeof projectRaw.subsystems === "object") {
			merged.subsystems = {
				...((merged.subsystems as Record<string, unknown> | undefined) ?? {}),
				...(projectRaw.subsystems as Record<string, unknown>),
			};
		}
		if (projectRaw.sandbox !== undefined) merged.sandbox = projectRaw.sandbox;
		if (typeof projectRaw.gitGuard === "boolean") merged.gitGuard = projectRaw.gitGuard;
		if (typeof projectRaw.shellGuard === "boolean") merged.shellGuard = projectRaw.shellGuard;
	}
	return { settings: normalizeExtraSettings(merged), sources };
}

/**
 * Update the global settings file. Only the keys present in `patch` are
 * touched; a `null` subsystem entry removes the override (back to enabled).
 */
export interface ExtraSettingsPatch {
	defaultMode?: ExtraSettings["defaultMode"];
	subsystems?: Partial<Record<string, boolean | null>>;
	/** Sandbox configuration; `null` removes it (shell commands run unsandboxed). */
	sandbox?: SandboxConfig | null;
	/** Destructive git guard switch. */
	gitGuard?: boolean;
	/** File-inspection guard switch. */
	shellGuard?: boolean;
}

export function saveExtraSettings(patch: ExtraSettingsPatch): ExtraSettings {
	const file = globalExtraSettingsPath();
	const current = readJson(file) ?? {};
	const next: Record<string, unknown> = { ...current };
	if (patch.defaultMode !== undefined) next.defaultMode = patch.defaultMode;
	if (patch.subsystems !== undefined) {
		const subsystems = { ...((next.subsystems as Record<string, unknown> | undefined) ?? {}) };
		for (const [key, value] of Object.entries(patch.subsystems)) {
			if (value === null) delete subsystems[key];
			else subsystems[key] = value;
		}
		next.subsystems = subsystems;
	}
	if (patch.sandbox !== undefined) {
		if (patch.sandbox === null) delete next.sandbox;
		else next.sandbox = patch.sandbox;
	}
	if (patch.gitGuard !== undefined) next.gitGuard = patch.gitGuard;
	if (patch.shellGuard !== undefined) next.shellGuard = patch.shellGuard;
	writeJsonAtomic(file, next);
	return normalizeExtraSettings(next);
}
