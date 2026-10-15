/**
 * Core modules shared between all run modes.
 */

export {
	AgentSession,
	type AgentSessionConfig,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type ModelCycleResult,
	type PromptOptions,
	type SessionStats,
} from "./agent-session.ts";
export {
	AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	type CreateAgentSessionRuntimeResult,
	createAgentSessionRuntime,
} from "./agent-session-runtime.ts";
export {
	type AgentSessionRuntimeDiagnostic,
	type AgentSessionServices,
	type CreateAgentSessionFromServicesOptions,
	type CreateAgentSessionServicesOptions,
	createAgentSessionFromServices,
	createAgentSessionServices,
} from "./agent-session-services.ts";
export { type BashExecutorOptions, type BashResult, executeBashWithOperations } from "./bash-executor.ts";
export { BUILD_VERSION, dateFromVersion, formatBuildVersion, resolveBuildCommit } from "./build-version.ts";
export type { CacheWarmingDecision, CacheWarmingStatus } from "./cache-warmer.ts";
export type { CompactionResult } from "./compaction/index.ts";
export { createEventBus, type EventBus, type EventBusController } from "./event-bus.ts";
// Extensions system
export {
	type AgentActivityOutcome,
	type AgentEndEvent,
	type AgentSettledEvent,
	type AgentStartEvent,
	type AgentToolResult,
	type AgentToolUpdateCallback,
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	type BoundaryContextPreview,
	type BoundaryResult,
	type BoundaryState,
	type BuildSystemPromptOptions,
	type CompactionEntryDraft,
	type ContextEditEntryDraft,
	type CustomEntryDraft,
	type CustomMessageEntryDraft,
	defineTool,
	type ExecOptions,
	type ExecResult,
	type LoadModulesResult,
	loadModules,
	type MessageRenderer,
	type ModuleApi,
	type ModuleCommandContext,
	type ModuleContext,
	type ModuleError,
	type ModuleEvent,
	type ModuleFactory,
	type ModuleFlag,
	type ModuleHandler,
	ModuleRegistry,
	type ModuleShortcut,
	type ModuleUIContext,
	type NormalizedBuildSystemPromptOptions,
	type RegisteredCommand,
	type RegisteredModule,
	type SessionBeforeCompactEvent,
	type SessionBeforeForkEvent,
	type SessionBeforeTreeEvent,
	type SessionBoundaryDraft,
	type SessionCompactEvent,
	type SessionModule,
	type SessionShutdownEvent,
	type SessionStartEvent,
	type SessionTreeEvent,
	type ToolCallEvent,
	type ToolCallEventResult,
	type ToolDefinition,
	type ToolRenderResultOptions,
	type ToolResultEvent,
	type TurnEndEvent,
	type TurnEndEventResult,
	type TurnStartEvent,
	type WorkingIndicatorOptions,
} from "./modules/index.ts";
export { createSyntheticSourceInfo } from "./source-info.ts";
