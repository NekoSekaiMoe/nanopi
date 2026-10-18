/**
 * @nanopi/pi-extra: run modes, permission gating, subsystem toggles, ENV
 * overrides, and the webui bridge for nanopi.
 *
 * The coding-agent consumes two things from here: `extraInlineExtension`
 * (registered as a hidden built-in) and `extraBridge` (read by the webui
 * server). Build flavors that exclude the `modes` component alias this module
 * to an inert stub.
 */

export type { JudgeModelRegistry } from "./ai-judge.ts";
export { judgeWithModel } from "./ai-judge.ts";
export type { AskBrokerAnswer, AskBrokerEvent, AskBrokerQuestion, AskBrokerResolution } from "./ask-broker.ts";
export { AskBroker } from "./ask-broker.ts";
export { type BadgeThemeSlice, badgeLabels, modeBadgeText } from "./badges.ts";
export type { BridgeExtensionHooks, BridgeJudgeContext } from "./bridge.ts";
export { ExtraBridge, extraBridge } from "./bridge.ts";
export { resolveEnvProvider, resolveInitMd } from "./env-config.ts";
export { execInLocalShell, findExecutable } from "./executables.ts";
export { createExtraExtension, extraInlineExtension, planModeVerdict } from "./extension.ts";
export {
	isMcpToolName,
	MCP_MAIN_AGENT_BLOCK_REASON,
	MCP_SUBAGENT_ONLY_GUIDELINE,
	MCP_TOOL_PREFIX,
} from "./mcp-policy.ts";
export type { ModeListener, ModeSnapshot } from "./mode-engine.ts";
export { ModeEngine, modeEngine } from "./mode-engine.ts";
export type { PermissionCallInfo, PermissionOutcome } from "./permission-types.ts";
export type { PermissionBrokerEvent, PermissionPrompter } from "./permissions.ts";
export { PermissionBroker, PermissionGate } from "./permissions.ts";
export { analyzeCommandForPlan, firstShellWord, tokenizeSimpleCommand } from "./plan-shell.ts";
export type { SandboxAvailability, SandboxCommand, SandboxKind } from "./sandbox.ts";
export {
	buildSandboxCommand,
	createSandboxedBashOperations,
	DEFAULT_SANDBOX_CONFIG,
	describeSandboxCall,
	detectSandbox,
	normalizeSandboxConfig,
	resolveSandboxHome,
	shellQuote,
} from "./sandbox.ts";
export type { ExtraSettingsPatch, ResolvedExtraSettings } from "./settings-store.ts";
export {
	globalExtraSettingsPath,
	loadExtraSettings,
	projectExtraSettingsPath,
	saveExtraSettings,
} from "./settings-store.ts";
export type {
	ExtraSettings,
	ExtraStatePayload,
	PermissionDecision,
	PermissionPromptPayload,
	RunMode,
	SubsystemKey,
	SubsystemStatus,
} from "./types.ts";
export {
	DEFAULT_EXTRA_SETTINGS,
	isPermissionDecision,
	isRunMode,
	PERMISSION_DECISIONS,
	RUN_MODES,
	SUBSYSTEM_KEYS,
} from "./types.ts";
