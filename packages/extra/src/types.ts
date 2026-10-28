/**
 * Shared types for the extra module: run modes, permission decisions,
 * extra-owned settings, and the webui bridge wire shapes.
 */

import { normalizeSandboxConfig, type SandboxConfig } from "./sandbox.ts";

export type { SandboxConfig };

/** Agent run modes. Tool whitelist semantics; orthogonal to permissions. */
export type RunMode = "plan" | "minimal" | "standard";

export const RUN_MODES: readonly RunMode[] = ["plan", "minimal", "standard"];

export function isRunMode(value: unknown): value is RunMode {
	return typeof value === "string" && (RUN_MODES as readonly string[]).includes(value);
}

/**
 * Permission prompt answers.
 *
 * `allow_once` skips the prompt for the call that was asked about and nothing
 * else: it follows a user who read an explanation of the call, so the next call
 * of the same kind prompts again. `ai_decide` delegates current and future
 * calls of the same class to the model.
 */
export type PermissionDecision = "allow" | "allow_session" | "allow_once" | "deny" | "ai_decide";

export const PERMISSION_DECISIONS: readonly PermissionDecision[] = [
	"allow",
	"allow_session",
	"allow_once",
	"deny",
	"ai_decide",
];

export function isPermissionDecision(value: unknown): value is PermissionDecision {
	return typeof value === "string" && (PERMISSION_DECISIONS as readonly string[]).includes(value);
}

/** Subsystems togglable through the extra settings (webui settings page). */
export type SubsystemKey = "lsp" | "mcp" | "subagent" | "askquestion" | "todo";

export const SUBSYSTEM_KEYS: readonly SubsystemKey[] = ["lsp", "mcp", "subagent", "askquestion", "todo"];

/** Extra-owned settings, stored globally with an optional project override. */
export interface ExtraSettings {
	/** Run mode applied to new sessions. Default "standard". */
	defaultMode: RunMode;
	/** Subsystem switches; missing entries default to enabled. */
	subsystems: Partial<Record<SubsystemKey, boolean>>;
	/** Shell sandbox. Absent means shell commands run unsandboxed. */
	sandbox?: SandboxConfig;
	/**
	 * Destructive git guard (`/gitguard`). Undefined means enabled: the commands
	 * AGENTS.md forbids prompt for permission instead of running unannounced.
	 */
	gitGuard?: boolean;
	/**
	 * File-inspection guard (`/shellguard`). Undefined means enabled: `cat`,
	 * `head`, `tail`, `sed -n` and recursive `grep`/`rg` on real files are refused
	 * in favour of the read/grep tools.
	 */
	shellGuard?: boolean;
}

export const DEFAULT_EXTRA_SETTINGS: ExtraSettings = {
	defaultMode: "standard",
	subsystems: {},
};

/** Validate loose (file-sourced) input into settings; invalid values fall back to defaults. */
export function normalizeExtraSettings(value: unknown): ExtraSettings {
	const record = value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
	const defaultMode = isRunMode(record?.defaultMode) ? record.defaultMode : DEFAULT_EXTRA_SETTINGS.defaultMode;
	const subsystems: Partial<Record<SubsystemKey, boolean>> = {};
	const rawSubsystems =
		record?.subsystems && typeof record.subsystems === "object"
			? (record.subsystems as Record<string, unknown>)
			: undefined;
	if (rawSubsystems) {
		for (const key of SUBSYSTEM_KEYS) {
			const entry = rawSubsystems[key];
			if (typeof entry === "boolean") subsystems[key] = entry;
		}
	}
	const sandbox = record?.sandbox === undefined ? undefined : normalizeSandboxConfig(record.sandbox);
	const gitGuard = typeof record?.gitGuard === "boolean" ? record.gitGuard : undefined;
	const shellGuard = typeof record?.shellGuard === "boolean" ? record.shellGuard : undefined;
	return {
		defaultMode,
		subsystems,
		...(sandbox ? { sandbox } : {}),
		...(gitGuard === undefined ? {} : { gitGuard }),
		...(shellGuard === undefined ? {} : { shellGuard }),
	};
}

/** Status of one subsystem switch, as reported to the webui. */
export interface SubsystemStatus {
	key: SubsystemKey;
	enabled: boolean;
	/** Whether the subsystem's package/tool is present in this build/session. */
	available: boolean;
	/** Human-readable reason when unavailable. */
	detail?: string;
}

/** A pending permission request pushed to the webui over SSE. */
export interface PermissionPromptPayload {
	callId: string;
	toolName: string;
	/** Short human-readable description of what the call does. */
	summary: string;
	arguments: unknown;
}

/** Snapshot served by the bridge for mode display and selection. */
export interface ExtraStatePayload {
	available: true;
	mode: RunMode;
	yolo: boolean;
}
