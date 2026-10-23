/**
 * Module registry - runs module factories, dispatches module events,
 * and exposes the registrations (tools, commands, flags, renderers).
 */

import type { AgentMessage, AgentTool } from "@nanopi/pi-agent-core";
import type { ImageContent, Model, Provider, ProviderHeaders } from "@nanopi/pi-ai";
import type { KeyId } from "@nanopi/pi-tui";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { resolvePath } from "../../utils/paths.ts";
import type { ResourceDiagnostic } from "../diagnostics.ts";
import { createEventBus, type EventBus } from "../event-bus.ts";
import type { ExecOptions } from "../exec.ts";
import { execCommand } from "../exec.ts";
import type { KeybindingsConfig } from "../keybindings.ts";
import type { MemorySample } from "../memory-usage.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { ScopedModel } from "../model-resolver.ts";
import type { SessionManager } from "../session-manager.ts";
import { createSyntheticSourceInfo } from "../source-info.ts";
import {
	type BuildSystemPromptOptions,
	buildSystemPrompt,
	type NormalizedBuildSystemPromptOptions,
	normalizeBuildSystemPromptOptions,
} from "../system-prompt.ts";
import { time } from "../timings.ts";
import type { BashOperations } from "../tools/bash.ts";
import type { ModelRouteRequest, VirtualModelDefinition } from "../virtual-models.ts";
import type {
	BeforeAgentStartCustomEvent,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	BeforeAgentStartUserEvent,
	BeforeProviderHeadersEvent,
	BeforeProviderRequestEvent,
	BoundaryContextPreview,
	BoundaryResult,
	CompactOptions,
	ContextUsage,
	EntryRenderer,
	ExecuteToolOptions,
	HandlerFn,
	InputEvent,
	InputEventResult,
	InputSource,
	LoadedResources,
	LoadModulesResult,
	MarkdownTransformer,
	MessageEndEvent,
	MessageEndEventResult,
	MessageRenderer,
	ModuleActions,
	ModuleApi,
	ModuleCommandContext,
	ModuleCommandContextActions,
	ModuleContext,
	ModuleContextActions,
	ModuleError,
	ModuleEvent,
	ModuleFlag,
	ModuleMode,
	ModuleRuntime,
	ModuleShortcut,
	ModuleToolContext,
	ModuleUIContext,
	ModuleVirtualModel,
	ProjectTrustContext,
	ProjectTrustEvent,
	ProjectTrustEventResult,
	ProviderConfig,
	RegisteredCommand,
	RegisteredModule,
	RegisteredTool,
	ReplacedSessionContext,
	ResolvedCommand,
	SessionBeforeCompactResult,
	SessionBeforeForkResult,
	SessionBeforeTreeResult,
	SessionBoundaryDraft,
	SessionModule,
	SessionShutdownEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolDefinition,
	ToolRendererResolver,
	ToolRenderers,
	ToolResultEvent,
	ToolResultEventResult,
	TurnEndEvent,
} from "./types.ts";

// RegisteredModule shortcuts compete with canonical keybinding ids from keybindings.json.
// Only editor-global shortcuts are reserved here. Picker-specific bindings are not.
const RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS = [
	"app.interrupt",
	"app.clear",
	"app.exit",
	"app.suspend",
	"app.thinking.cycle",
	"app.model.cycleForward",
	"app.model.cycleBackward",
	"app.model.select",
	"app.tools.expand",
	"app.thinking.toggle",
	"app.editor.external",
	"app.message.copy",
	"app.message.followUp",
	"tui.input.submit",
	"tui.select.confirm",
	"tui.select.cancel",
	"tui.input.copy",
	"tui.editor.deleteToLineEnd",
] as const;

type BuiltInKeyBindings = Partial<Record<KeyId, { keybinding: string; restrictOverride: boolean }>>;

const buildBuiltinKeybindings = (resolvedKeybindings: KeybindingsConfig): BuiltInKeyBindings => {
	const builtinKeybindings = {} as BuiltInKeyBindings;
	for (const [keybinding, keys] of Object.entries(resolvedKeybindings)) {
		if (keys === undefined) continue;
		const keyList = Array.isArray(keys) ? keys : [keys];
		const restrictOverride = (RESERVED_KEYBINDINGS_FOR_EXTENSION_CONFLICTS as readonly string[]).includes(keybinding);
		for (const key of keyList) {
			const normalizedKey = key.toLowerCase() as KeyId;
			// If multiple actions bind the same key, the reserved action wins so extensions
			// remain blocked by reserved shortcuts regardless of iteration order.
			const existing = builtinKeybindings[normalizedKey];
			if (existing?.restrictOverride && !restrictOverride) continue;
			builtinKeybindings[normalizedKey] = {
				keybinding,
				restrictOverride,
			};
		}
	}
	return builtinKeybindings;
};

/** The message that starts a run: the before_agent_start event without its prompt fields. */
export type BeforeAgentStartTrigger =
	| Pick<BeforeAgentStartUserEvent, "messageType" | "prompt" | "images">
	| Pick<BeforeAgentStartCustomEvent, "messageType" | "message">;

/** Combined result from all before_agent_start handlers. */
interface BeforeAgentStartCombinedResult {
	messages: NonNullable<BeforeAgentStartEventResult["message"]>[];
	systemPromptOptions: NormalizedBuildSystemPromptOptions;
}

/**
 * Events handled by the generic emit() method.
 * Events with dedicated emitXxx() methods are excluded for stronger type safety.
 */
type RunnerEmitEvent = Exclude<
	ModuleEvent,
	| ToolCallEvent
	| ProjectTrustEvent
	| ToolResultEvent
	| BeforeProviderRequestEvent
	| BeforeProviderHeadersEvent
	| BeforeAgentStartEvent
	| MessageEndEvent
	| InputEvent
	| TurnEndEvent
>;

type SessionBeforeEvent = Extract<
	RunnerEmitEvent,
	{ type: "session_before_fork" | "session_before_compact" | "session_before_tree" }
>;

type SessionBeforeEventResult = SessionBeforeForkResult | SessionBeforeCompactResult | SessionBeforeTreeResult;

type RunnerEmitResult<TEvent extends RunnerEmitEvent> = TEvent extends { type: "session_before_fork" }
	? SessionBeforeForkResult | undefined
	: TEvent extends { type: "session_before_compact" }
		? SessionBeforeCompactResult | undefined
		: TEvent extends { type: "session_before_tree" }
			? SessionBeforeTreeResult | undefined
			: undefined;

export type ModuleErrorListener = (error: ModuleError) => void;

type BoundaryBaseEvent = Omit<TurnEndEvent, "entries" | "continue" | "context">;

interface BoundaryDispatchResult {
	entries: SessionBoundaryDraft[];
	continue: boolean;
	context: BoundaryContextPreview;
	valid: boolean;
}

export type NewSessionHandler = (options?: {
	parentSession?: string;
	setup?: (sessionManager: SessionManager) => Promise<void>;
	withSession?: (ctx: ReplacedSessionContext) => Promise<void>;
}) => Promise<{ cancelled: boolean }>;

export type ForkHandler = (
	entryId: string,
	options?: { position?: "before" | "at"; withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type NavigateTreeHandler = (
	targetId: string,
	options?: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string },
) => Promise<{ cancelled: boolean }>;

export type SwitchSessionHandler = (
	sessionPath: string,
	options?: { withSession?: (ctx: ReplacedSessionContext) => Promise<void> },
) => Promise<{ cancelled: boolean }>;

export type ShutdownHandler = () => void;

/**
 * Helper function to emit session_shutdown event to extensions.
 * Returns true if the event was emitted, false if there were no handlers.
 */
export async function emitSessionShutdownEvent(
	moduleRegistry: ModuleRegistry,
	event: SessionShutdownEvent,
): Promise<boolean> {
	if (moduleRegistry.hasHandlers("session_shutdown")) {
		await moduleRegistry.emit(event);
		return true;
	}
	return false;
}

function snapshotEventHandlers(extensions: RegisteredModule[], event: ModuleEvent["type"]) {
	return extensions.map((ext) => ({ ext, handlers: ext.handlers.get(event)?.slice() ?? [] }));
}

/**
 * Re-attach the prompt and tool state after a `context` handler. Handlers only see the
 * conversation; the system messages belong to nanopi. An unchanged conversation keeps every
 * system message in place, so models with mid-conversation support keep their cached
 * prefix. A changed one gets the replayed prompt sections and tool declarations as one
 * leading system message, so pruning, windowing, or slicing from a compaction summary
 * cannot drop them.
 */

export async function emitProjectTrustEvent(
	modules: RegisteredModule[],
	event: ProjectTrustEvent,
	ctx: ProjectTrustContext,
): Promise<{ result?: ProjectTrustEventResult; errors: ModuleError[] }> {
	const errors: ModuleError[] = [];
	for (const { ext, handlers } of snapshotEventHandlers(modules, "project_trust")) {
		// A single extension may register multiple handlers for the same event.
		// The first project_trust handler that returns yes/no wins; undecided falls through.
		for (const handler of handlers) {
			try {
				const handlerResult = (await handler(event, ctx)) as ProjectTrustEventResult;
				if (handlerResult.trusted === "undecided") {
					continue;
				}
				return { result: handlerResult, errors };
			} catch (error) {
				errors.push({
					moduleName: ext.name,
					event: event.type,
					error: error instanceof Error ? error.message : String(error),
					stack: error instanceof Error ? error.stack : undefined,
				});
			}
		}
	}
	return { errors };
}

const noOpUIContext: ModuleUIContext = {
	select: async () => undefined,
	confirm: async () => false,
	input: async () => undefined,
	notify: () => {},
	onTerminalInput: () => () => {},
	setStatus: () => {},
	setWorkingMessage: () => {},
	setWorkingVisible: () => {},
	setWorkingIndicator: () => {},
	setHiddenThinkingLabel: () => {},
	setWidget: () => {},
	setFooter: () => {},
	setHeader: () => {},
	setTitle: () => {},
	custom: async () => undefined as never,
	pasteToEditor: () => {},
	setEditorText: () => {},
	getEditorText: () => "",
	editor: async () => undefined,
	addAutocompleteProvider: () => {},
	setEditorComponent: () => {},
	getEditorComponent: () => undefined,
	get theme() {
		return theme;
	},
	getToolsExpanded: () => false,
	setToolsExpanded: () => {},
};

/** Resource snapshot used before the session binds its real loader (e.g. in SDK embedders). */
const EMPTY_LOADED_RESOURCES: LoadedResources = {
	contextFiles: [],
	skills: [],
	prompts: [],
	extensions: [],
};

export class ModuleRegistry {
	private modules: RegisteredModule[];
	private runtime: ModuleRuntime;
	private uiContext: ModuleUIContext;
	private mode: ModuleMode = "print";
	private cwd: string;
	private sessionManager: SessionManager;
	private modelRegistry: ModelRegistry;
	private errorListeners: Set<ModuleErrorListener> = new Set();
	private getModel: () => Model<any> | undefined = () => undefined;
	private getScopedModels: () => readonly ScopedModel[] = () => [];
	private isIdleFn: () => boolean = () => true;
	private isProjectTrustedFn: () => boolean = () => true;
	private getSignalFn: () => AbortSignal | undefined = () => undefined;
	private waitForIdleFn: () => Promise<void> = async () => {};
	private abortFn: () => void = () => {};
	private hasPendingMessagesFn: () => boolean = () => false;
	private getContextUsageFn: () => ContextUsage | undefined = () => undefined;
	private compactFn: (options?: CompactOptions) => void = () => {};
	private getSystemPromptFn: () => string = () => "";
	private getSystemPromptOptionsFn: () => BuildSystemPromptOptions = () =>
		normalizeBuildSystemPromptOptions({ cwd: this.cwd });
	private getLoadedResourcesFn: () => LoadedResources = () => EMPTY_LOADED_RESOURCES;
	private getMemorySampleFn: (() => MemorySample | undefined) | undefined;
	private executeToolFn: ModuleContextActions["executeTool"];
	private getCallableToolsFn: () => readonly AgentTool[] = () => [];
	private newSessionHandler: NewSessionHandler = async () => ({ cancelled: false });
	private forkHandler: ForkHandler = async () => ({ cancelled: false });
	private navigateTreeHandler: NavigateTreeHandler = async () => ({ cancelled: false });
	private switchSessionHandler: SwitchSessionHandler = async () => ({ cancelled: false });
	private requestReloadHandler: () => void = () => {};
	private operationCompleteHandler: () => Promise<void> = async () => {};
	private operationDepth = 0;
	private shutdownHandler: ShutdownHandler = () => {};
	private shortcutDiagnostics: ResourceDiagnostic[] = [];
	private commandDiagnostics: ResourceDiagnostic[] = [];

	constructor(
		extensions: RegisteredModule[],
		runtime: ModuleRuntime,
		cwd: string,
		sessionManager: SessionManager,
		modelRegistry: ModelRegistry,
	) {
		this.modules = extensions;
		this.runtime = runtime;
		this.uiContext = noOpUIContext;
		this.cwd = cwd;
		this.sessionManager = sessionManager;
		this.modelRegistry = modelRegistry;
	}

	bindCore(
		actions: ModuleActions,
		contextActions: ModuleContextActions,
		providerActions?: {
			registerProvider?: (name: string, config: ProviderConfig) => void;
			registerNativeProvider?: (provider: Provider) => void;
			unregisterProvider?: (name: string) => void;
			registerVirtualModel?: (definition: VirtualModelDefinition) => void;
			unregisterVirtualModel?: (provider: string, id: string) => void;
		},
	): void {
		// Copy actions into the shared runtime (all extension APIs reference this)
		this.runtime.sendMessage = actions.sendMessage;
		this.runtime.deliverMessage = actions.deliverMessage;
		this.runtime.sendUserMessage = actions.sendUserMessage;
		this.runtime.appendEntry = actions.appendEntry;
		this.runtime.setSessionName = actions.setSessionName;
		this.runtime.getSessionName = actions.getSessionName;
		this.runtime.setLabel = actions.setLabel;
		this.runtime.getActiveTools = actions.getActiveTools;
		this.runtime.getAllTools = actions.getAllTools;
		this.runtime.getSettings = actions.getSettings;
		this.runtime.setActiveTools = actions.setActiveTools;
		this.runtime.refreshTools = actions.refreshTools;
		this.runtime.getCommands = actions.getCommands;
		this.runtime.setModel = actions.setModel;
		this.runtime.getThinkingLevel = actions.getThinkingLevel;
		this.runtime.setThinkingLevel = actions.setThinkingLevel;
		this.runtime.registerBashOperations = actions.registerBashOperations;
		this.runtime.setActiveBashOperations = actions.setActiveBashOperations;
		this.runtime.getActiveBashOperations = actions.getActiveBashOperations;
		this.runtime.createContext = () => this.createContext();

		// Context actions (required)
		this.getModel = contextActions.getModel;
		this.getScopedModels = contextActions.getScopedModels;
		this.isIdleFn = contextActions.isIdle;
		this.isProjectTrustedFn = contextActions.isProjectTrusted;
		this.getSignalFn = contextActions.getSignal;
		this.abortFn = contextActions.abort;
		this.hasPendingMessagesFn = contextActions.hasPendingMessages;
		this.requestReloadHandler = contextActions.requestReload;
		this.operationCompleteHandler = contextActions.onOperationComplete;
		this.shutdownHandler = contextActions.shutdown;
		this.getContextUsageFn = contextActions.getContextUsage;
		this.compactFn = contextActions.compact;
		this.getSystemPromptFn = contextActions.getSystemPrompt;
		this.getSystemPromptOptionsFn =
			contextActions.getSystemPromptOptions ?? (() => normalizeBuildSystemPromptOptions({ cwd: this.cwd }));
		this.getLoadedResourcesFn = contextActions.getLoadedResources ?? this.getLoadedResourcesFn;
		this.getMemorySampleFn = contextActions.getMemorySample;
		this.executeToolFn = contextActions.executeTool;
		this.getCallableToolsFn = contextActions.getCallableTools ?? (() => []);

		// Flush provider registrations queued during extension loading
		for (const { name, config, moduleName } of this.runtime.pendingProviderRegistrations) {
			try {
				if (providerActions?.registerProvider) {
					providerActions.registerProvider(name, config);
				} else {
					this.modelRegistry.registerProvider(name, config);
				}
			} catch (err) {
				this.emitError({
					moduleName,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingProviderRegistrations = [];
		for (const { provider, moduleName } of this.runtime.pendingNativeProviderRegistrations) {
			try {
				if (providerActions?.registerNativeProvider) {
					providerActions.registerNativeProvider(provider);
				} else {
					this.modelRegistry.registerProvider(provider);
				}
			} catch (err) {
				this.emitError({
					moduleName,
					event: "register_provider",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingNativeProviderRegistrations = [];
		const registerVirtualModel = (definition: VirtualModelDefinition) => {
			if (providerActions?.registerVirtualModel) providerActions.registerVirtualModel(definition);
			else this.modelRegistry.registerVirtualModel(definition);
		};
		for (const { definition, moduleName } of this.runtime.pendingVirtualModelRegistrations) {
			try {
				registerVirtualModel(definition);
			} catch (err) {
				this.emitError({
					moduleName,
					event: "register_virtual_model",
					error: err instanceof Error ? err.message : String(err),
					stack: err instanceof Error ? err.stack : undefined,
				});
			}
		}
		this.runtime.pendingVirtualModelRegistrations = [];

		// From this point on, provider registration/unregistration takes effect immediately
		// without requiring a /reload.
		this.runtime.registerProvider = (name, config) => {
			if (providerActions?.registerProvider) {
				providerActions.registerProvider(name, config);
				return;
			}
			this.modelRegistry.registerProvider(name, config);
		};
		this.runtime.registerNativeProvider = (provider) => {
			if (providerActions?.registerNativeProvider) {
				providerActions.registerNativeProvider(provider);
				return;
			}
			this.modelRegistry.registerProvider(provider);
		};
		this.runtime.unregisterProvider = (name) => {
			if (providerActions?.unregisterProvider) {
				providerActions.unregisterProvider(name);
				return;
			}
			this.modelRegistry.unregisterProvider(name);
		};
		this.runtime.registerVirtualModel = registerVirtualModel;
		this.runtime.unregisterVirtualModel = (provider, id) => {
			if (providerActions?.unregisterVirtualModel) providerActions.unregisterVirtualModel(provider, id);
			else this.modelRegistry.unregisterVirtualModel(provider, id);
		};
	}

	bindCommandContext(actions?: ModuleCommandContextActions): void {
		if (actions) {
			this.waitForIdleFn = actions.waitForIdle;
			this.newSessionHandler = actions.newSession;
			this.forkHandler = actions.fork;
			this.navigateTreeHandler = actions.navigateTree;
			this.switchSessionHandler = actions.switchSession;
			return;
		}

		this.waitForIdleFn = async () => {};
		this.newSessionHandler = async () => ({ cancelled: false });
		this.forkHandler = async () => ({ cancelled: false });
		this.navigateTreeHandler = async () => ({ cancelled: false });
		this.switchSessionHandler = async () => ({ cancelled: false });
	}

	setUIContext(uiContext?: ModuleUIContext, mode: ModuleMode = "print"): void {
		this.uiContext = uiContext ?? noOpUIContext;
		this.mode = mode;
	}

	getUIContext(): ModuleUIContext {
		return this.uiContext;
	}

	hasUI(): boolean {
		return this.uiContext !== noOpUIContext;
	}

	getModuleNames(): string[] {
		return this.modules.map((m) => m.name);
	}

	hasActiveOperation(): boolean {
		return this.operationDepth > 0;
	}

	async runExtensionOperation<T>(callback: () => Promise<T>): Promise<T> {
		let operationResult: { value: T } | { error: unknown };
		this.operationDepth++;
		try {
			operationResult = { value: await callback() };
		} catch (error) {
			operationResult = { error };
		}

		this.operationDepth--;
		if (this.operationDepth === 0) {
			try {
				await this.operationCompleteHandler();
			} catch (completionError) {
				if ("error" in operationResult) {
					throw new AggregateError(
						[operationResult.error, completionError],
						"RegisteredModule operation and completion failed",
					);
				}
				throw completionError;
			}
		}

		if ("error" in operationResult) throw operationResult.error;
		return operationResult.value;
	}

	/** Get all registered tools from all extensions (first registration per name wins). */
	getAllRegisteredTools(): RegisteredTool[] {
		const toolsByName = new Map<string, RegisteredTool>();
		for (const ext of this.modules) {
			for (const tool of ext.tools.values()) {
				if (!toolsByName.has(tool.definition.name)) {
					toolsByName.set(tool.definition.name, tool);
				}
			}
		}
		return Array.from(toolsByName.values());
	}

	/** Get a tool definition by name. Returns undefined if not found. */
	getToolDefinition(toolName: string): RegisteredTool["definition"] | undefined {
		for (const ext of this.modules) {
			const tool = ext.tools.get(toolName);
			if (tool) {
				return tool.definition;
			}
		}
		return undefined;
	}

	getFlags(): Map<string, ModuleFlag> {
		const allFlags = new Map<string, ModuleFlag>();
		for (const ext of this.modules) {
			for (const [name, flag] of ext.flags) {
				if (!allFlags.has(name)) {
					allFlags.set(name, flag);
				}
			}
		}
		return allFlags;
	}

	setFlagValue(name: string, value: boolean | string): void {
		this.runtime.flagValues.set(name, value);
	}

	getFlagValues(): Map<string, boolean | string> {
		return new Map(this.runtime.flagValues);
	}

	getShortcuts(resolvedKeybindings: KeybindingsConfig): Map<KeyId, ModuleShortcut> {
		this.shortcutDiagnostics = [];
		const builtinKeybindings = buildBuiltinKeybindings(resolvedKeybindings);
		const extensionShortcuts = new Map<KeyId, ModuleShortcut>();

		const addDiagnostic = (message: string, moduleName: string) => {
			this.shortcutDiagnostics.push({ type: "warning", message, path: moduleName });
			if (!this.hasUI()) {
				console.warn(message);
			}
		};

		for (const ext of this.modules) {
			for (const [key, shortcut] of ext.shortcuts) {
				const normalizedKey = key.toLowerCase() as KeyId;

				const builtInKeybinding = builtinKeybindings[normalizedKey];
				if (builtInKeybinding?.restrictOverride === true) {
					addDiagnostic(
						`RegisteredModule shortcut '${key}' from ${shortcut.moduleName} conflicts with built-in shortcut. Skipping.`,
						shortcut.moduleName,
					);
					continue;
				}

				if (builtInKeybinding?.restrictOverride === false) {
					addDiagnostic(
						`RegisteredModule shortcut conflict: '${key}' is built-in shortcut for ${builtInKeybinding.keybinding} and ${shortcut.moduleName}. Using ${shortcut.moduleName}.`,
						shortcut.moduleName,
					);
				}

				const existingExtensionShortcut = extensionShortcuts.get(normalizedKey);
				if (existingExtensionShortcut) {
					addDiagnostic(
						`RegisteredModule shortcut conflict: '${key}' registered by both ${existingExtensionShortcut.moduleName} and ${shortcut.moduleName}. Using ${shortcut.moduleName}.`,
						shortcut.moduleName,
					);
				}
				extensionShortcuts.set(normalizedKey, shortcut);
			}
		}
		return extensionShortcuts;
	}

	getShortcutDiagnostics(): ResourceDiagnostic[] {
		return this.shortcutDiagnostics;
	}

	onError(listener: ModuleErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	emitError(error: ModuleError): void {
		for (const listener of this.errorListeners) {
			listener(error);
		}
	}

	hasHandlers(eventType: string): boolean {
		for (const ext of this.modules) {
			const handlers = ext.handlers.get(eventType);
			if (handlers && handlers.length > 0) {
				return true;
			}
		}
		return false;
	}

	getMessageRenderer(customType: string): MessageRenderer | undefined {
		for (const ext of this.modules) {
			const renderer = ext.messageRenderers.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	getMarkdownTransformers(): MarkdownTransformer[] {
		return this.modules.flatMap((ext) => (ext.markdownTransformer ? [ext.markdownTransformer] : []));
	}

	/** Renderers of calls to `toolName`: extension resolvers in load order, then `base`. */
	resolveToolRenderers(toolName: string, base: () => ToolRenderers | undefined): ToolRenderers | undefined {
		const resolvers = this.modules.flatMap((ext) => ext.toolRenderers ?? []);
		const resolve = (index: number): ToolRenderers | undefined =>
			index < resolvers.length ? resolvers[index](toolName, () => resolve(index + 1)) : base();
		return resolve(0);
	}

	getEntryRenderer(customType: string): EntryRenderer | undefined {
		for (const ext of this.modules) {
			const renderer = ext.entryRenderers?.get(customType);
			if (renderer) {
				return renderer;
			}
		}
		return undefined;
	}

	private resolveRegisteredCommands(): ResolvedCommand[] {
		const commands: RegisteredCommand[] = [];
		const counts = new Map<string, number>();

		for (const ext of this.modules) {
			for (const command of ext.commands.values()) {
				commands.push(command);
				counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
			}
		}

		const seen = new Map<string, number>();
		const takenInvocationNames = new Set<string>();

		return commands.map((command) => {
			const occurrence = (seen.get(command.name) ?? 0) + 1;
			seen.set(command.name, occurrence);

			let invocationName = (counts.get(command.name) ?? 0) > 1 ? `${command.name}:${occurrence}` : command.name;

			if (takenInvocationNames.has(invocationName)) {
				let suffix = occurrence;
				do {
					suffix++;
					invocationName = `${command.name}:${suffix}`;
				} while (takenInvocationNames.has(invocationName));
			}

			takenInvocationNames.add(invocationName);
			return {
				...command,
				invocationName,
			};
		});
	}

	getModelRegistry(): ModelRegistry {
		return this.modelRegistry;
	}

	getRegisteredCommands(): ResolvedCommand[] {
		this.commandDiagnostics = [];
		return this.resolveRegisteredCommands();
	}

	getCommandDiagnostics(): ResourceDiagnostic[] {
		return this.commandDiagnostics;
	}

	getCommand(name: string): ResolvedCommand | undefined {
		return this.resolveRegisteredCommands().find((command) => command.invocationName === name);
	}

	/**
	 * Request a graceful shutdown. Called by extension tools and event handlers.
	 * The actual shutdown behavior is provided by the mode via bindModules().
	 */
	shutdown(): void {
		this.shutdownHandler();
	}

	getActiveTools(): string[] {
		return this.runtime.getActiveTools();
	}

	/**
	 * Create an ModuleContext for use in event handlers and tool execution.
	 * Context values are resolved at call time, so changes via bindCore/bindUI are reflected.
	 */
	createContext(): ModuleContext {
		const runner = this;
		const getModel = this.getModel;
		const getScopedModels = this.getScopedModels;
		return {
			get ui() {
				return runner.uiContext;
			},
			get mode() {
				return runner.mode;
			},
			get hasUI() {
				return runner.hasUI();
			},
			get cwd() {
				return runner.cwd;
			},
			get sessionManager() {
				return runner.sessionManager;
			},
			get modelRegistry() {
				return runner.modelRegistry;
			},
			get model() {
				return getModel();
			},
			get scopedModels() {
				return getScopedModels();
			},
			get thinkingLevel() {
				return runner.runtime.getThinkingLevel();
			},
			isIdle: () => {
				return runner.isIdleFn();
			},
			isProjectTrusted: () => {
				return runner.isProjectTrustedFn();
			},
			get signal() {
				return runner.getSignalFn();
			},
			abort: () => {
				runner.abortFn();
			},
			hasPendingMessages: () => {
				return runner.hasPendingMessagesFn();
			},
			requestReload: () => {
				runner.requestReloadHandler();
			},
			shutdown: () => {
				runner.shutdownHandler();
			},
			getContextUsage: () => {
				return runner.getContextUsageFn();
			},
			compact: (options) => {
				runner.compactFn(options);
			},
			getSystemPrompt: () => {
				return runner.getSystemPromptFn();
			},
			getLoadedResources: () => {
				return runner.getLoadedResourcesFn();
			},
			getMemorySample: runner.getMemorySampleFn ? () => runner.getMemorySampleFn?.() : undefined,
		};
	}

	/**
	 * Create the context for executing the tool call `toolCallId`: the extension context plus
	 * `tools` and `executeTool()`. `signal` is the default signal of nested calls.
	 */
	createToolContext(toolCallId: string, signal: AbortSignal | undefined): ModuleToolContext {
		const runner = this;
		// createContext() returns a fresh object, so adding properties does not affect other contexts.
		return Object.defineProperties(this.createContext() as ModuleToolContext, {
			tools: {
				get() {
					return runner.getCallableToolsFn();
				},
			},
			executeTool: {
				value: async (name: string, args: unknown, options: ExecuteToolOptions = {}) => {
					if (!runner.executeToolFn) {
						return {
							toolCall: { type: "toolCall", id: `${toolCallId}/0`, name, arguments: {} },
							result: {
								content: [{ type: "text", text: "Nested tool calls are not available in this context" }],
								details: {},
							},
							isError: true,
						};
					}
					return runner.executeToolFn(toolCallId, name, args, { ...options, signal: options.signal ?? signal });
				},
			},
		});
	}

	createCommandContext(): ModuleCommandContext {
		// Use property descriptors instead of object spread so the guarded getters from
		// createContext() stay lazy. A spread would eagerly read them once and freeze the
		// old values into the returned object, bypassing stale-instance checks.
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this.createContext()),
		) as ModuleCommandContext;
		context.getSystemPromptOptions = () => {
			return this.getSystemPromptOptionsFn();
		};
		context.waitForIdle = () => {
			return this.waitForIdleFn();
		};
		context.newSession = (options) => {
			return this.newSessionHandler(options);
		};
		context.fork = (entryId, options) => {
			return this.forkHandler(entryId, options);
		};
		context.navigateTree = (targetId, options) => {
			return this.navigateTreeHandler(targetId, options);
		};
		context.switchSession = (sessionPath, options) => {
			return this.switchSessionHandler(sessionPath, options);
		};
		return context;
	}

	async emitBoundary(
		baseEvent: BoundaryBaseEvent,
		buildContext: (entries: SessionBoundaryDraft[]) => BoundaryContextPreview | Promise<BoundaryContextPreview>,
	): Promise<BoundaryDispatchResult> {
		const ctx = this.createContext();
		let entries: SessionBoundaryDraft[] = [];
		let shouldContinue = false;
		let context = await buildContext(entries);
		let valid = true;

		for (const { ext, handlers } of snapshotEventHandlers(this.modules, baseEvent.type)) {
			for (const handler of handlers) {
				const event = {
					...baseEvent,
					entries,
					continue: shouldContinue,
					context,
				} as TurnEndEvent;
				try {
					const handlerResult = (await handler(event, ctx)) as BoundaryResult | undefined;
					if (handlerResult?.entries !== undefined) entries = handlerResult.entries;
					if (handlerResult?.continue !== undefined) shouldContinue = handlerResult.continue;
				} catch (err) {
					this.emitError({
						moduleName: ext.name,
						event: baseEvent.type,
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}

				try {
					context = await buildContext(entries);
					valid = true;
				} catch (err) {
					valid = false;
					this.emitError({
						moduleName: ext.name,
						event: baseEvent.type,
						error: `Invalid boundary entries: ${err instanceof Error ? err.message : String(err)}`,
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}

		return valid
			? { entries, continue: shouldContinue, context, valid: true }
			: { entries: [], continue: false, context, valid: false };
	}

	private isSessionBeforeEvent(event: RunnerEmitEvent): event is SessionBeforeEvent {
		return (
			event.type === "session_before_fork" ||
			event.type === "session_before_compact" ||
			event.type === "session_before_tree"
		);
	}

	async emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		return this.runExtensionOperation(() => this._emit(event));
	}

	private async _emit<TEvent extends RunnerEmitEvent>(event: TEvent): Promise<RunnerEmitResult<TEvent>> {
		const ctx = this.createContext();
		let result: SessionBeforeEventResult | undefined;

		for (const { ext, handlers } of snapshotEventHandlers(this.modules, event.type)) {
			for (const handler of handlers) {
				try {
					const handlerResult = await handler(event, ctx);

					if (this.isSessionBeforeEvent(event) && handlerResult) {
						result = handlerResult as SessionBeforeEventResult;
						if (result.cancel) {
							return result as RunnerEmitResult<TEvent>;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						moduleName: ext.name,
						event: event.type,
						error: message,
						stack,
					});
				}
			}
		}

		return result as RunnerEmitResult<TEvent>;
	}

	async emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		return this.runExtensionOperation(() => this._emitMessageEnd(event));
	}

	private async _emitMessageEnd(event: MessageEndEvent): Promise<AgentMessage | undefined> {
		const ctx = this.createContext();
		let currentMessage = event.message;
		let modified = false;

		for (const { ext, handlers } of snapshotEventHandlers(this.modules, "message_end")) {
			for (const handler of handlers) {
				try {
					const currentEvent: MessageEndEvent = { ...event, message: currentMessage };
					const handlerResult = (await handler(currentEvent, ctx)) as MessageEndEventResult | undefined;
					if (!handlerResult?.message) continue;

					if (handlerResult.message.role !== currentMessage.role) {
						this.emitError({
							moduleName: ext.name,
							event: "message_end",
							error: "message_end handlers must return a message with the same role",
						});
						continue;
					}

					currentMessage = handlerResult.message;
					modified = true;
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						moduleName: ext.name,
						event: "message_end",
						error: message,
						stack,
					});
				}
			}
		}

		return modified ? currentMessage : undefined;
	}

	async emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		return this.runExtensionOperation(() => this._emitToolResult(event));
	}

	private async _emitToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
		const ctx = this.createContext();
		const currentEvent: ToolResultEvent = { ...event };
		let modified = false;

		for (const { ext, handlers } of snapshotEventHandlers(this.modules, "tool_result")) {
			for (const handler of handlers) {
				try {
					const handlerResult = (await handler(currentEvent, ctx)) as ToolResultEventResult | undefined;
					if (!handlerResult) continue;

					if (handlerResult.content !== undefined) {
						currentEvent.content = handlerResult.content;
						// Structured content that is not replaced along with the content may no longer match it.
						if (handlerResult.structuredContent === undefined) delete currentEvent.structuredContent;
						modified = true;
					}
					if (handlerResult.details !== undefined) {
						currentEvent.details = handlerResult.details;
						modified = true;
					}
					if (handlerResult.structuredContent !== undefined) {
						currentEvent.structuredContent = handlerResult.structuredContent;
						modified = true;
					}
					if (handlerResult.isError !== undefined) {
						currentEvent.isError = handlerResult.isError;
						modified = true;
					}
					if (handlerResult.usage !== undefined) {
						currentEvent.usage = handlerResult.usage;
						modified = true;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						moduleName: ext.name,
						event: "tool_result",
						error: message,
						stack,
					});
				}
			}
		}

		if (!modified) {
			return undefined;
		}

		return {
			content: currentEvent.content,
			details: currentEvent.details,
			structuredContent: currentEvent.structuredContent,
			isError: currentEvent.isError,
			usage: currentEvent.usage,
		};
	}

	async emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		return this.runExtensionOperation(() => this._emitToolCall(event));
	}

	private async _emitToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
		const ctx = this.createContext();
		let result: ToolCallEventResult | undefined;

		for (const { handlers } of snapshotEventHandlers(this.modules, "tool_call")) {
			for (const handler of handlers) {
				const handlerResult = await handler(event, ctx);

				if (handlerResult) {
					result = handlerResult as ToolCallEventResult;
					if (result.block) {
						return result;
					}
				}
			}
		}

		return result;
	}

	async emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		return this.runExtensionOperation(() => this._emitBeforeProviderRequest(payload));
	}

	private async _emitBeforeProviderRequest(payload: unknown): Promise<unknown> {
		const ctx = this.createContext();
		let currentPayload = payload;

		for (const { ext, handlers } of snapshotEventHandlers(this.modules, "before_provider_request")) {
			for (const handler of handlers) {
				try {
					const event: BeforeProviderRequestEvent = {
						type: "before_provider_request",
						payload: currentPayload,
					};
					const handlerResult = await handler(event, ctx);
					if (handlerResult !== undefined) {
						currentPayload = handlerResult;
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						moduleName: ext.name,
						event: "before_provider_request",
						error: message,
						stack,
					});
				}
			}
		}

		return currentPayload;
	}

	async emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		return this.runExtensionOperation(() => this._emitBeforeProviderHeaders(headers));
	}

	private async _emitBeforeProviderHeaders(headers: ProviderHeaders): Promise<ProviderHeaders> {
		const ctx = this.createContext();

		for (const { ext, handlers } of snapshotEventHandlers(this.modules, "before_provider_headers")) {
			for (const handler of handlers) {
				try {
					// Handlers mutate `headers` in place; the return value is ignored.
					const event: BeforeProviderHeadersEvent = {
						type: "before_provider_headers",
						headers,
					};
					await handler(event, ctx);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						moduleName: ext.name,
						event: "before_provider_headers",
						error: message,
						stack,
					});
				}
			}
		}

		return headers;
	}

	async emitBeforeAgentStart(
		trigger: BeforeAgentStartTrigger,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult> {
		return this.runExtensionOperation(() => this._emitBeforeAgentStart(trigger, systemPromptOptions));
	}

	private async _emitBeforeAgentStart(
		trigger: BeforeAgentStartTrigger,
		systemPromptOptions: BuildSystemPromptOptions,
	): Promise<BeforeAgentStartCombinedResult> {
		const currentOptions = normalizeBuildSystemPromptOptions(systemPromptOptions);
		const renderCurrentSystemPrompt = (): string => buildSystemPrompt(currentOptions);
		const ctx = Object.defineProperties({}, Object.getOwnPropertyDescriptors(this.createContext())) as ModuleContext;
		ctx.getSystemPrompt = () => {
			return renderCurrentSystemPrompt();
		};
		const messages: NonNullable<BeforeAgentStartEventResult["message"]>[] = [];

		for (const { ext, handlers } of snapshotEventHandlers(this.modules, "before_agent_start")) {
			for (const handler of handlers) {
				try {
					const event: BeforeAgentStartEvent = {
						...trigger,
						type: "before_agent_start",
						get systemPrompt() {
							return renderCurrentSystemPrompt();
						},
						systemPromptOptions: currentOptions,
					};
					const handlerResult = await handler(event, ctx);

					if (handlerResult) {
						const result = handlerResult as BeforeAgentStartEventResult;
						if (result.message) messages.push(result.message);
						if (result.systemPrompt !== undefined) {
							currentOptions.forceSystemPrompt = result.systemPrompt;
						}
					}
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					const stack = err instanceof Error ? err.stack : undefined;
					this.emitError({
						moduleName: ext.name,
						event: "before_agent_start",
						error: message,
						stack,
					});
				}
			}
		}

		return { messages, systemPromptOptions: currentOptions };
	}

	/** Emit input event. Transforms chain, "handled" short-circuits. */
	async emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult> {
		return this.runExtensionOperation(() => this._emitInput(text, images, source, streamingBehavior));
	}

	private async _emitInput(
		text: string,
		images: ImageContent[] | undefined,
		source: InputSource,
		streamingBehavior?: "steer" | "followUp",
	): Promise<InputEventResult> {
		const ctx = this.createContext();
		let currentText = text;
		let currentImages = images;

		for (const { ext, handlers } of snapshotEventHandlers(this.modules, "input")) {
			for (const handler of handlers) {
				try {
					const event: InputEvent = {
						type: "input",
						text: currentText,
						images: currentImages,
						source,
						streamingBehavior,
					};
					const result = (await handler(event, ctx)) as InputEventResult | undefined;
					if (result?.action === "handled") return result;
					if (result?.action === "transform") {
						currentText = result.text;
						currentImages = result.images ?? currentImages;
					}
				} catch (err) {
					this.emitError({
						moduleName: ext.name,
						event: "input",
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined,
					});
				}
			}
		}
		return currentText !== text || currentImages !== images
			? { action: "transform", text: currentText, images: currentImages }
			: { action: "continue" };
	}
}

// ============================================================================
// Module loading: run SessionModule factories and collect their registrations.
// Absorbed from the old file-based loader; modules now arrive as code.
// ============================================================================

export function createModuleRuntime(): ModuleRuntime {
	const notInitialized = () => {
		throw new Error("Module runtime not initialized. Action methods cannot be called during module loading.");
	};

	const runtime: ModuleRuntime = {
		sendMessage: notInitialized,
		deliverMessage: notInitialized,
		sendUserMessage: notInitialized,
		appendEntry: notInitialized,
		setSessionName: notInitialized,
		getSessionName: notInitialized,
		setLabel: notInitialized,
		getActiveTools: notInitialized,
		getAllTools: notInitialized,
		getSettings: notInitialized,
		setActiveTools: notInitialized,
		// registerTool() is valid during module load; refresh is only needed post-bind.
		refreshTools: () => {},
		getCommands: notInitialized,
		setModel: () => Promise.reject(new Error("Module runtime not initialized")),
		getThinkingLevel: notInitialized,
		setThinkingLevel: notInitialized,
		registerBashOperations: notInitialized,
		setActiveBashOperations: notInitialized,
		getActiveBashOperations: notInitialized,
		flagValues: new Map(),
		pendingProviderRegistrations: [],
		pendingNativeProviderRegistrations: [],
		pendingVirtualModelRegistrations: [],
		createContext: notInitialized,
		// Pre-bind: queue registrations so bindCore() can flush them once the
		// model registry is available. bindCore() replaces both with direct calls.
		registerProvider: (name, config, moduleName = "<unknown>") => {
			runtime.pendingProviderRegistrations.push({ name, config, moduleName });
		},
		registerNativeProvider: (provider, moduleName = "<unknown>") => {
			runtime.pendingNativeProviderRegistrations.push({ provider, moduleName });
		},
		unregisterProvider: (name) => {
			runtime.pendingProviderRegistrations = runtime.pendingProviderRegistrations.filter((r) => r.name !== name);
			runtime.pendingNativeProviderRegistrations = runtime.pendingNativeProviderRegistrations.filter(
				(r) => r.provider.id !== name,
			);
		},
		registerVirtualModel: (definition, moduleName = "<unknown>") => {
			runtime.pendingVirtualModelRegistrations.push({ definition, moduleName });
		},
		unregisterVirtualModel: (provider, id) => {
			runtime.pendingVirtualModelRegistrations = runtime.pendingVirtualModelRegistrations.filter(
				({ definition }) => definition.provider !== provider || definition.id !== id,
			);
		},
	};

	return runtime;
}

/**
 * Create the ModuleApi for a module.
 * Registration methods write to the module object.
 * Action methods delegate to the shared runtime.
 */
function createModuleApi(
	module: RegisteredModule,
	runtime: ModuleRuntime,
	cwd: string,
	eventBus: EventBus,
	getModuleNames: () => string[],
): { api: ModuleApi; commit: () => void; discard: () => void } {
	const pendingFlagValues = new Map<string, boolean | string>();
	const pendingRuntimeChanges: Array<() => void> = [];
	let state: "loading" | "active" | "failed" = "loading";
	const applyRuntimeChange = (change: () => void) => {
		if (state === "loading") pendingRuntimeChanges.push(change);
		else change();
	};
	const clearPending = () => {
		pendingFlagValues.clear();
		pendingRuntimeChanges.length = 0;
	};

	const api = {
		// Registration methods - write to module
		on(event: string, handler: HandlerFn): () => void {
			const registeredHandler: HandlerFn = (...args) => handler(...args);
			const list = module.handlers.get(event) ?? [];
			list.push(registeredHandler);
			module.handlers.set(event, list);

			return () => {
				const handlers = module.handlers.get(event);
				if (!handlers) return;
				const handlerIndex = handlers.indexOf(registeredHandler);
				if (handlerIndex === -1) return;
				handlers.splice(handlerIndex, 1);
				if (handlers.length === 0) module.handlers.delete(event);
			};
		},

		registerTool(tool: ToolDefinition): void {
			if (typeof tool.parameters !== "object" || tool.parameters === null || Array.isArray(tool.parameters)) {
				throw new Error(
					`Tool "${tool.name}" registered by module "${module.name}" must define an object parameter schema.`,
				);
			}
			module.tools.set(tool.name, {
				definition: tool,
				sourceInfo: module.sourceInfo,
			});
			runtime.refreshTools();
		},

		registerCommand(name: string, options: Omit<RegisteredCommand, "name" | "sourceInfo">): void {
			if (typeof name !== "string" || name.length === 0) {
				throw new Error(
					`Command registered by module "${module.name}" must have a non-empty string name. Use nanopi.registerCommand("name", { description, handler }).`,
				);
			}
			if (typeof options?.handler !== "function") {
				throw new Error(`Command "/${name}" registered by module "${module.name}" must define handler().`);
			}
			module.commands.set(name, {
				name,
				sourceInfo: module.sourceInfo,
				...options,
			});
		},

		registerShortcut(
			shortcut: KeyId,
			options: {
				description?: string;
				handler: (ctx: ModuleContext) => Promise<void> | void;
			},
		): void {
			module.shortcuts.set(shortcut, { shortcut, moduleName: module.name, ...options });
		},

		registerFlag(
			name: string,
			options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
		): void {
			if (options.default !== undefined && typeof options.default !== options.type) {
				throw new Error(
					`Invalid default for flag "${name}": expected ${options.type}, got ${typeof options.default}`,
				);
			}
			module.flags.set(name, { name, moduleName: module.name, ...options });
			if (options.default !== undefined && !runtime.flagValues.has(name)) {
				if (state === "loading") {
					if (!pendingFlagValues.has(name)) pendingFlagValues.set(name, options.default);
				} else {
					runtime.flagValues.set(name, options.default);
				}
			}
		},

		registerMessageRenderer<T>(customType: string, renderer: MessageRenderer<T>): void {
			module.messageRenderers.set(customType, renderer as MessageRenderer);
		},

		registerMarkdownTransformer(transformer: MarkdownTransformer): void {
			module.markdownTransformer = transformer;
		},

		registerEntryRenderer<T>(customType: string, renderer: EntryRenderer<T>): void {
			module.entryRenderers ??= new Map();
			module.entryRenderers.set(customType, renderer as EntryRenderer);
		},

		registerToolRenderer(resolver: ToolRendererResolver): void {
			module.toolRenderers ??= [];
			module.toolRenderers.push(resolver);
		},

		// Flag access - checks module registered it, reads from runtime
		getFlag(name: string): boolean | string | undefined {
			if (!module.flags.has(name)) return undefined;
			return runtime.flagValues.has(name) ? runtime.flagValues.get(name) : pendingFlagValues.get(name);
		},

		// Action methods - delegate to shared runtime
		sendMessage(message, options): void {
			runtime.sendMessage(message, options);
		},

		deliverMessage(message, options): Promise<"started" | "queued" | "pending"> {
			return runtime.deliverMessage(message, options);
		},

		sendUserMessage(content, options): void {
			runtime.sendUserMessage(content, options);
		},

		appendEntry(customType: string, data?: unknown): void {
			runtime.appendEntry(customType, data);
		},

		setSessionName(name: string): void {
			runtime.setSessionName(name);
		},

		getSessionName(): string | undefined {
			return runtime.getSessionName();
		},

		setLabel(entryId: string, label: string | undefined): void {
			runtime.setLabel(entryId, label);
		},

		exec(command: string, args: string[], options?: ExecOptions) {
			return execCommand(command, args, options?.cwd ?? cwd, options);
		},

		getActiveTools(): string[] {
			return runtime.getActiveTools();
		},

		getAllTools() {
			return runtime.getAllTools();
		},

		registerBashOperations(id: string, operations: BashOperations | undefined): void {
			runtime.registerBashOperations(id, operations);
		},

		setActiveBashOperations(id: string | undefined): void {
			runtime.setActiveBashOperations(id);
		},

		getActiveBashOperations(): string | undefined {
			return runtime.getActiveBashOperations();
		},

		getSettings() {
			return runtime.getSettings();
		},

		setActiveTools(toolNames: string[]): void {
			runtime.setActiveTools(toolNames);
		},

		getCommands() {
			return runtime.getCommands();
		},

		// Self-description, not a runtime action: the registry already holds the
		// module list, so it answers from itself instead of round-tripping through
		// ModuleActions.
		getModuleNames() {
			return getModuleNames();
		},

		setModel(model) {
			return runtime.setModel(model);
		},

		getThinkingLevel() {
			return runtime.getThinkingLevel();
		},

		setThinkingLevel(level) {
			runtime.setThinkingLevel(level);
		},

		registerProvider(providerOrName: Provider | string, config?: ProviderConfig) {
			if (typeof providerOrName === "string") {
				if (!config) throw new Error("Provider config is required when registering by name");
				applyRuntimeChange(() => runtime.registerProvider(providerOrName, config, module.name));
				return;
			}
			applyRuntimeChange(() => runtime.registerNativeProvider(providerOrName, module.name));
		},

		unregisterProvider(name: string) {
			applyRuntimeChange(() => runtime.unregisterProvider(name, module.name));
		},

		registerVirtualModel<TState>(model: ModuleVirtualModel<TState>) {
			// Routing runs after the registry binds, so the context is created per request. The state
			// comes from the session branch that this router wrote.
			const definition: VirtualModelDefinition = {
				...model,
				route: (request) => model.route(request as ModelRouteRequest<TState>, runtime.createContext()),
			};
			applyRuntimeChange(() => runtime.registerVirtualModel(definition, module.name));
		},

		unregisterVirtualModel(provider: string, id: string) {
			applyRuntimeChange(() => runtime.unregisterVirtualModel(provider, id));
		},

		events: {
			emit(channel, data) {
				eventBus.emit(channel, data);
			},
			on(channel, handler) {
				return eventBus.on(channel, handler);
			},
		},
	} as ModuleApi;

	return {
		api,
		commit: () => {
			if (state !== "loading") return;
			for (const [name, value] of pendingFlagValues) {
				if (!runtime.flagValues.has(name)) runtime.flagValues.set(name, value);
			}
			for (const apply of pendingRuntimeChanges) apply();
			state = "active";
			clearPending();
		},
		discard: () => {
			if (state !== "loading") return;
			state = "failed";
			clearPending();
		},
	};
}

/** Create a RegisteredModule object with empty collections. */
function createRegisteredModule(sessionModule: SessionModule): RegisteredModule {
	return {
		name: sessionModule.name,
		hidden: sessionModule.hidden,
		sourceInfo: createSyntheticSourceInfo(sessionModule.name, { source: "builtin" }),
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

async function initializeModule(
	sessionModule: SessionModule,
	cwd: string,
	eventBus: EventBus,
	runtime: ModuleRuntime,
	loadedNames: readonly string[],
): Promise<RegisteredModule> {
	const module = createRegisteredModule(sessionModule);
	// Factories run before the registry object exists, so the names come from the
	// list built so far. `loadedNames` is captured by reference to the caller's
	// array, which is appended as each module finishes loading.
	const load = createModuleApi(module, runtime, cwd, eventBus, () => [...loadedNames]);
	try {
		await sessionModule.factory(load.api);
		load.commit();
	} catch (error) {
		load.discard();
		throw error;
	}
	time(`${sessionModule.name} factory`, "extensions");
	return module;
}

/** Run module factories in order and collect their registrations. */
export async function loadModules(
	modules: SessionModule[],
	cwd: string,
	eventBus?: EventBus,
): Promise<LoadModulesResult> {
	const resolvedCwd = resolvePath(cwd);
	const resolvedEventBus = eventBus ?? createEventBus();
	const runtime = createModuleRuntime();
	const loaded: RegisteredModule[] = [];
	const errors: Array<{ path: string; error: string }> = [];
	// Names of every module in the load set (not just the ones loaded so far), so
	// a module asking mid-load sees the full list it is part of.
	const loadedNames: string[] = modules.map((sessionModule) => sessionModule.name);

	for (const sessionModule of modules) {
		try {
			loaded.push(await initializeModule(sessionModule, resolvedCwd, resolvedEventBus, runtime, loadedNames));
		} catch (error) {
			errors.push({
				path: sessionModule.name,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	return { modules: loaded, errors, warnings: [], runtime };
}
