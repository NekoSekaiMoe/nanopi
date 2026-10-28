/**
 * Structural slices of the coding-agent extension API.
 *
 * pi-extra deliberately keeps no type-level dependency on
 * @nanopi/pi-coding-agent: the coding-agent's build typechecks against
 * pi-extra sources while pi-extra builds standalone, so importing its types
 * here would create a build-order cycle. Every slice below is satisfied by
 * the real API (the assignment is checked where `extraInlineExtension` is
 * registered in packages/coding-agent/src/extensions/index.ts).
 */

import type { BadgeThemeSlice } from "./badges.ts";

/** One slash-argument suggestion, in the shape the host autocomplete wants. */
export interface ExtraArgumentCompletion {
	value: string;
	label: string;
	description?: string;
}

export interface ExtraUIDialogOptions {
	signal?: AbortSignal;
	timeout?: number;
	/** Caption shown under the title. */
	description?: string;
}

export interface ExtraUIContext {
	select(title: string, options: string[], opts?: ExtraUIDialogOptions): Promise<string | undefined>;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	/** Footer status channel: badge text under "mode", rendered by the installed footer. */
	setStatus(key: string, text: string | undefined): void;
	/** Current composer text; used to tell shell mode (`!`) from a prompt. */
	getEditorText(): string;
	/** Terminal title; `undefined` restores the app's own title. */
	setTitle(title: string | undefined): void;
	readonly theme: BadgeThemeSlice;
}

export interface ExtraExtensionContext {
	ui: ExtraUIContext;
	/** Run mode of the hosting frontend ("tui" | "rpc" | "json" | "print" | "webui"). */
	mode: string;
	hasUI: boolean;
	cwd: string;
	model: { contextWindow?: number } | undefined;
	modelRegistry: unknown;
	getContextUsage(): { tokens: number | null; percent: number | null; contextWindow: number } | undefined;
}

export interface ExtraToolCallEvent {
	type: "tool_call";
	toolCallId: string;
	toolName: string;
	input: unknown;
}

export interface ExtraToolCallResult {
	block?: boolean;
	reason?: string;
	terminate?: boolean;
}

export interface ExtraSessionStartEvent {
	type: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface ExtraBeforeAgentStartEvent {
	type: "before_agent_start";
	systemPromptOptions: {
		customPrompt?: string;
		promptGuidelines?: string[];
	};
}

export interface ExtraProjectTrustResult {
	trusted: "yes" | "no" | "undecided";
	remember?: boolean;
}

/** Structural subset of the ExtensionAPI used by the extra extension. */
export interface ExtraExtensionAPI {
	registerFlag(
		name: string,
		options:
			| { description?: string; type: "boolean"; default?: boolean }
			| { description?: string; type: "string"; default?: string },
	): void;
	registerCommand(
		name: string,
		options: {
			description?: string;
			/** Slash-argument suggestions; the host offers them after `/name `. */
			getArgumentCompletions?: (
				argumentPrefix: string,
			) => ExtraArgumentCompletion[] | null | Promise<ExtraArgumentCompletion[] | null>;
			handler: (args: string, ctx: ExtraExtensionContext) => Promise<void>;
		},
	): void;
	on(event: "project_trust", handler: () => ExtraProjectTrustResult): void;
	on(
		event: "session_start",
		handler: (event: ExtraSessionStartEvent, ctx: ExtraExtensionContext) => Promise<void> | void,
	): void;
	on(
		event: "session_shutdown",
		handler: (event: { type: "session_shutdown" }, ctx: ExtraExtensionContext) => Promise<void> | void,
	): void;
	on(
		event: "agent_settled",
		handler: (event: { type: "agent_settled"; aborted: boolean }, ctx: ExtraExtensionContext) => Promise<void> | void,
	): void;
	on(
		event: "before_agent_start",
		handler: (event: ExtraBeforeAgentStartEvent, ctx: ExtraExtensionContext) => Promise<void> | void,
	): void;
	on(
		event: "tool_call",
		handler: (
			event: ExtraToolCallEvent,
			ctx: ExtraExtensionContext,
		) => Promise<ExtraToolCallResult | undefined> | ExtraToolCallResult | undefined,
	): void;
	registerProvider(
		nameOrProvider: string | unknown,
		config?: {
			name?: string;
			baseUrl?: string;
			apiKey?: string;
			api?: string;
			models: unknown[];
		},
	): void;
	sendUserMessage(content: string): void;
	/** Slash commands the host offers, used to name an exit that actually exists. */
	getCommands?(): Array<{ name: string }>;
	getAllTools(): Array<{ name: string }>;
	getActiveTools(): string[];
	setActiveTools(toolNames: string[]): void;
	/**
	 * Register a backend the built-in shell tools can route `exec()` through.
	 * Undefined removes the registration.
	 */
	registerBashOperations?(
		id: string,
		operations:
			| {
					exec: (
						command: string,
						cwd: string,
						options: {
							onData: (data: Buffer) => void;
							signal?: AbortSignal;
							timeout?: number;
							env?: NodeJS.ProcessEnv;
						},
					) => Promise<{ exitCode: number | null }>;
			  }
			| undefined,
	): void;
	/** Select the backend that runs shell commands, or undefined for local execution. */
	setActiveBashOperations?(id: string | undefined): void;
	/** Id of the backend selected with `setActiveBashOperations()`. */
	getActiveBashOperations?(): string | undefined;
	getFlag(name: string): boolean | string | undefined;
}

/** Structural InlineExtension record for registration in the coding-agent. */
export interface ExtraInlineExtension {
	name: string;
	hidden: boolean;
	factory: (nanopi: ExtraExtensionAPI) => void | Promise<void>;
}
