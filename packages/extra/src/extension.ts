/**
 * The extra extension: run modes, permissions, subsystem toggles, ENV
 * overrides, footer badges. Loaded as a hidden inline factory by the
 * coding-agent (pre-trust, so it can answer project_trust for --yolo).
 *
 * Nothing mode- or permission-related lives in the agent core; everything here
 * goes through the public extension API. When a build flavor excludes the
 * module, this factory never registers.
 */

import type { JudgeModelRegistry } from "./ai-judge.ts";
import { judgeWithModel } from "./ai-judge.ts";
import { modeBadgeText } from "./badges.ts";
import { extraBridge } from "./bridge.ts";
import { resolveEnvProvider, resolveInitMd } from "./env-config.ts";
import { execInLocalShell } from "./executables.ts";
import type {
	ExtraExtensionAPI,
	ExtraExtensionContext,
	ExtraInlineExtension,
	ExtraProjectTrustResult,
	ExtraToolCallEvent,
	ExtraToolCallResult,
} from "./extension-api.ts";
import { analyzeShellCommand, gitGuardNotice, listWorktrees } from "./git-guard.ts";
import { isMcpToolName, MCP_MAIN_AGENT_BLOCK_REASON, MCP_SUBAGENT_ONLY_GUIDELINE } from "./mcp-policy.ts";
import { modeEngine } from "./mode-engine.ts";
import type { PermissionCallInfo, PermissionDecision, PermissionPrompter } from "./permissions.ts";
import { PermissionGate } from "./permissions.ts";
import { analyzeCommandForPlan, firstShellWord } from "./plan-shell.ts";
import {
	createSandboxedBashOperations,
	DEFAULT_SANDBOX_CONFIG,
	describeSandboxCall,
	detectSandbox,
	resolveSandboxHome,
	type SandboxAvailability,
	type SandboxConfig,
} from "./sandbox.ts";
import { loadExtraSettings, saveExtraSettings } from "./settings-store.ts";
import { analyzeFileInspection, shellGuardNotice } from "./shell-guard.ts";
import { isRunMode, type RunMode, SUBSYSTEM_KEYS, type SubsystemKey, type SubsystemStatus } from "./types.ts";

const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
/** Tools that prompt for permission when not in yolo or plan mode. */
const GATED_TOOL_NAMES = new Set(["edit", "write", "bash", "powershell"]);

const PLAN_GUIDELINE =
	"You are in PLAN MODE: exploration and planning only. The read tool, the ask_user_question tool, the read-only LSP tools (lsp_hover, lsp_definition, lsp_query, lsp_diagnostics), and the ls, find, and pwd shell commands are available; every other call is blocked. Investigate, ask about anything ambiguous, then produce a concrete step-by-step plan. Do not attempt modifications.";
/** Tools plan mode allows besides `read`, in addition to the ls/find/pwd shell commands. */
const PLAN_ALLOWED_TOOLS = new Set(["ask_user_question"]);
/**
 * LSP tools that only read. They belong in plan mode: hover/definition/references
 * answer questions that grepping cannot, and blocking them left the model with
 * `read` as its only way to look at code.
 *
 * `lsp_edit` is deliberately absent — it rewrites files.
 */
const PLAN_ALLOWED_LSP_TOOLS = new Set(["lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_query"]);

/**
 * Plan-mode verdict for one tool call, or undefined to allow it.
 *
 * Pure so the whitelist is testable on its own: it is the whole safety boundary
 * of plan mode, and the tools it does *not* list are the ones that can change
 * the repository.
 */
export function planModeVerdict(toolName: string, input: unknown): string | undefined {
	if (toolName === "read" || PLAN_ALLOWED_TOOLS.has(toolName) || PLAN_ALLOWED_LSP_TOOLS.has(toolName))
		return undefined;
	if (SHELL_TOOL_NAMES.has(toolName)) {
		const command =
			typeof (input as Record<string, unknown>)?.command === "string"
				? ((input as Record<string, unknown>).command as string)
				: "";
		const analysis = analyzeCommandForPlan(command);
		if (analysis.allowed) return undefined;
		return analysis.reason ?? "command not allowed in plan mode";
	}
	return `plan mode allows only the read, ask_user_question, and read-only lsp_ tools and the ls, find, and pwd commands (blocked ${toolName})`;
}
const MINIMAL_GUIDELINE =
	"You are in MINIMAL MODE: only the shell (bash) tool is available. Accomplish the task through shell commands.";

/**
 * Labels the prompt offers, in order. The last one does not answer: it pauses the
 * turn and hands the user to the model for an explanation of the call (see
 * `explainCall`). Every label says how far its answer reaches, because the only
 * difference between the first three is the scope: this call, this session, or
 * until the AI thinks otherwise.
 */
const DECISION_LABELS: Array<{ label: string; decision: PermissionDecision | "explain" }> = [
	{ label: "Allow once (this call only)", decision: "allow" },
	{ label: "Allow this session (every call of this tool)", decision: "allow_session" },
	{ label: "Reject (this call only)", decision: "deny" },
	{ label: "Let the AI decide (this kind, from now on)", decision: "ai_decide" },
	{ label: "Explain what this does", decision: "explain" },
];

/**
 * The dialog's caption: the selector fades the line dim, so no markdown styling
 * survives. It carries the scope note too, since the labels above stop at one
 * line each.
 */
const PROMPT_CAPTION =
	"Answer the prompt below, or pick Explain to have the call described before it runs. Rejecting a call is always single-shot; letting the AI decide covers this kind of call for the rest of the session.";

/** The word the next-prompt suggestion falls back to while an explanation is pending. */
const CONTINUE_WORD = "继续";

/**
 * What the input box shows while an explanation is pending.
 *
 * The prompt the user just read was not answered, so the word has to say which
 * of the answers it stands for: the explained call runs, and the next call of the
 * same kind asks again.
 */
const CONTINUE_SUGGESTION = `${CONTINUE_WORD}（只放行这一次，下次还会问）`;

/**
 * What the model is asked after the user picks "Explain what this does".
 *
 * The gate keeps the call pending, so the message has to tell the model not to
 * retry it: any gated call it makes now prompts again, and a retry would land the
 * user back at the dialog they just left.
 */
function explainPrompt(info: PermissionCallInfo): string {
	return [
		"The user asked for this tool call to be explained before it runs, so nothing has executed yet.",
		"Explain what it does and why: the command or edit in plain terms, what it touches, and what could go wrong.",
		"Be concise, then stop. Do not call this tool again (or any other gated tool) in this turn;",
		"the user will press continue in the input box to run it.",
		"",
		`Tool: ${info.toolName}`,
		`Call: ${info.summary}`,
		`Arguments: ${JSON.stringify(info.args)}`,
		...(info.hazard ? [`Hazard already detected: ${info.hazard}`] : []),
	].join("\n");
}

function subsystemTools(allToolNames: string[], key: SubsystemKey): string[] {
	switch (key) {
		case "subagent":
			return allToolNames.filter((name) => name === "subagent");
		case "askquestion":
			return allToolNames.filter((name) => name === "ask_user_question");
		case "todo":
			return allToolNames.filter((name) => name === "todo");
		case "mcp":
			return allToolNames.filter((name) => isMcpToolName(name));
		case "lsp":
			return allToolNames.filter((name) => name.startsWith("lsp"));
	}
}

function summarizeCall(event: ExtraToolCallEvent): { summary: string; firstCommand: string | undefined } {
	const input = event.input as Record<string, unknown>;
	if (event.toolName === "bash" || event.toolName === "powershell") {
		const command = typeof input.command === "string" ? input.command : "";
		return {
			summary: command.length > 200 ? `${command.slice(0, 200)}…` : command,
			firstCommand: firstShellWord(command),
		};
	}
	const path =
		typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
	const target = path ?? JSON.stringify(input).slice(0, 160);
	return { summary: `${event.toolName} ${target}`.trim(), firstCommand: undefined };
}

/**
 * The guard's one-line hazard for a shell call, or undefined when the command is
 * not a destructive git command reaching this checkout. Outside a permission
 * gate (headless runs, `--yolo`) nothing calls this.
 */
function destructiveGitHazard(event: ExtraToolCallEvent, cwd: string): string | undefined {
	const command =
		typeof (event.input as Record<string, unknown>)?.command === "string"
			? ((event.input as Record<string, unknown>).command as string)
			: undefined;
	if (command === undefined) return undefined;
	const verdict = analyzeShellCommand(command, cwd);
	if (!verdict.checked || !verdict.hit) return undefined;
	return gitGuardNotice(verdict.hit, listWorktrees(cwd));
}

/** Ask over the TUI/RPC dialog primitives. */
function makeDialogPrompter(
	ctx: ExtraExtensionContext,
	onExplain: (info: PermissionCallInfo) => void,
): PermissionPrompter {
	return async (info) => {
		const title = `Allow ${info.toolName}? ${info.summary}`;
		const choice = await ctx.ui.select(
			title,
			DECISION_LABELS.map((entry) => entry.label),
			{ description: PROMPT_CAPTION },
		);
		const picked = DECISION_LABELS.find((entry) => entry.label === choice)?.decision;
		// Explaining is not an answer: the gate stays blocked while the model
		// writes, and the user continues from the input box.
		if (picked === "explain") {
			onExplain(info);
			return undefined;
		}
		return picked;
	};
}

/**
 * Ask the model to explain a call in the webui, where the card has no editor to
 * type "继续" into: the explanation lands as an assistant message, and the user
 * answers the still-pending card (allow once / allow this session / reject).
 */
function makeWebuiPrompter(onExplain: (info: PermissionCallInfo) => void): PermissionPrompter {
	return async (info) => {
		const choice = await extraBridge.permissions.prompter(info);
		// The card asked for an explanation: the gate pauses the call on this
		// answer, queues the next turn, and asks again for the real one.
		if (choice === "explain") onExplain(info);
		return choice;
	};
}

/** Destructive git prompting, on unless the user turned it off with `/gitguard off`. */
function gitGuardEnabled(cwd: string): boolean {
	return loadExtraSettings(cwd).settings.gitGuard ?? true;
}

/** File-inspection refusal, on unless the user turned it off with `/shellguard off`. */
function shellGuardEnabled(cwd: string): boolean {
	return loadExtraSettings(cwd).settings.shellGuard ?? true;
}

/**
 * The refusal for a shell call whose line only reads files through commands the
 * read/grep tools do better, or undefined.
 *
 * The refusal is only true when the substitute exists in this session: without a
 * `read` tool, `cat file` has no replacement to point at.
 */
function shellGuardHazard(event: ExtraToolCallEvent, cwd: string, activeTools: readonly string[]): string | undefined {
	const command =
		typeof (event.input as Record<string, unknown>)?.command === "string"
			? ((event.input as Record<string, unknown>).command as string)
			: undefined;
	if (command === undefined) return undefined;
	const verdict = analyzeFileInspection(command, cwd);
	if (!verdict.checked || !verdict.hit) return undefined;
	// `read` replaces cat/sed/head, `grep` replaces grep/rg; either hint is a lie
	// when the tool it names is not declared.
	const needed = verdict.hit.words[0] === "grep" || verdict.hit.words[0] === "rg" ? "grep" : "read";
	if (!activeTools.includes(needed)) return undefined;
	return shellGuardNotice(verdict.hit);
}

export function createExtraExtension(nanopi: ExtraExtensionAPI): void {
	const engine = modeEngine;
	let sessionCtx: ExtraExtensionContext | undefined;
	let gate: PermissionGate | undefined;
	/** /plan runs settle into the exit-confirmation flow. */
	let planIntroActive = false;
	/** Read once per session start; `/gitguard` re-applies it. */
	let gitGuardOn = true;
	/** Read once per session start; `/shellguard` re-applies it. */
	let shellGuardOn = true;
	/** Calls the user asked to have explained, waiting for that explanation to land. */
	const explainedCalls = new Map<string, PermissionCallInfo>();

	/**
	 * Pause the turn and ask the model to explain one gated call.
	 *
	 * The gate stays blocked on that call, which makes this a simple handshake: the
	 * explanation is a normal turn, the blocked `tool_call` handler returns right
	 * after `sendUserMessage`, and the call runs only when the user continues. The
	 * turn ending settles that same call with `approveOnce()`, so a bare "继续"
	 * does not pop the dialog again. Nothing is remembered past that call: the
	 * next one asks as usual.
	 */
	function explainCall(info: PermissionCallInfo, nanopi: ExtraExtensionAPI): void {
		explainedCalls.set(info.callId, info);
		// The dialog owns the editor slot, so the title is where the instruction
		// survives: until the explanation ends, this call runs on "继续" alone.
		sessionCtx?.ui.setTitle(
			`${CONTINUE_WORD}: run the explained ${info.toolName} call once (the next one asks again)`,
		);
		nanopi.sendUserMessage(explainPrompt(info));
	}

	/** Settle explained calls whose explanation turn has ended. */
	function approveExplainedCalls(): void {
		const pending = [...explainedCalls.keys()];
		explainedCalls.clear();
		sessionCtx?.ui.setTitle(undefined);
		for (const callId of pending) gate?.approveOnce(callId);
	}

	/** Drop explained calls whose turn was interrupted: they are not waiting to continue. */
	function forgetExplainedCalls(): void {
		if (explainedCalls.size === 0) return;
		explainedCalls.clear();
		sessionCtx?.ui.setTitle(undefined);
	}

	/** The word offered in the input box while an explanation is pending, if any. */
	function continueSuggestion(): string | undefined {
		return explainedCalls.size > 0 ? CONTINUE_SUGGESTION : undefined;
	}

	/**
	 * Apply a mode switch wherever it came from: the footer badge in the TUI, the
	 * tool set everywhere else. Without the second half a switch made through the
	 * webui changed the engine while the session kept its tools, so minimal mode
	 * still ran every tool.
	 */
	function onModeChange(): void {
		applyModeToolSet();
		applyModeStatus();
	}
	/** Push the current mode badges through the footer status channel. */
	function applyModeStatus(): void {
		if (sessionCtx?.mode !== "tui") return;
		sessionCtx.ui.setStatus("mode", modeBadgeText(engine, sessionCtx.ui.theme));
	}
	engine.subscribe(() => onModeChange());

	// --- Shell sandbox (registered as a bash backend, inert until activated) ---
	const SANDBOX_BACKEND_ID = "sandbox";
	let sandboxConfig: SandboxConfig | undefined;
	let sandboxAvailability: SandboxAvailability | undefined;

	/**
	 * Build the sandbox backend from the current settings and hand it to the
	 * shell tools. Runs on every session start, after settings were reloaded, so
	 * `/sandbox` needs no separate plumbing beyond a reload.
	 */
	function applySandbox(cwd: string): void {
		const configured = loadExtraSettings(cwd).settings.sandbox;
		if (!configured) {
			sandboxConfig = undefined;
			sandboxAvailability = undefined;
			nanopi.registerBashOperations?.(SANDBOX_BACKEND_ID, undefined);
			nanopi.setActiveBashOperations?.(undefined);
			return;
		}
		sandboxConfig = { ...DEFAULT_SANDBOX_CONFIG, ...configured };
		sandboxAvailability = detectSandbox(sandboxConfig);
		if (!sandboxAvailability.available) {
			// Leave shell execution local instead of failing every command: the
			// user is told why, and the next session retries.
			nanopi.registerBashOperations?.(SANDBOX_BACKEND_ID, undefined);
			nanopi.setActiveBashOperations?.(undefined);
			return;
		}
		nanopi.registerBashOperations?.(
			SANDBOX_BACKEND_ID,
			createSandboxedBashOperations({
				config: sandboxConfig,
				availability: sandboxAvailability,
				exec: (command, execCwd, options) => execInLocalShell(command, execCwd, options.onData, options.signal),
				home: resolveSandboxHome(sandboxConfig),
			}),
		);
		nanopi.setActiveBashOperations?.(SANDBOX_BACKEND_ID);
	}

	/** One-line sandbox status for `/sandbox` and the footer. */
	function sandboxStatusLine(): string {
		if (!sandboxConfig) return "off (shell commands run unsandboxed)";
		if (!sandboxAvailability?.available) {
			return `off: ${sandboxAvailability?.reason ?? "launcher unavailable"}`;
		}
		const network = sandboxConfig.allowNetwork ? "network on" : "network off";
		return `${sandboxAvailability.kind} (${network})`;
	}

	// --- CLI command: /sandbox [on|off] [--engine bwrap|sandbox-exec] [--network] [--writable <dir>] ---
	nanopi.registerCommand("sandbox", {
		description: "Show or configure the shell sandbox (on | off | --engine, --network, --writable)",
		handler: async (args, ctx) => {
			const argv = args.trim().split(/\s+/).filter(Boolean);
			const first = argv[0];
			if (first === undefined) {
				ctx.ui.notify(`Sandbox: ${sandboxStatusLine()}`, "info");
				return;
			}
			if (first === "off") {
				saveExtraSettings({ sandbox: null });
				applySandbox(ctx.cwd);
				ctx.ui.notify("Sandbox off; shell commands run unsandboxed", "info");
				return;
			}
			if (first !== "on") {
				ctx.ui.notify(
					"Usage: /sandbox [on|off] [--engine bwrap|sandbox-exec] [--network] [--writable <dir>]",
					"error",
				);
				return;
			}
			const next: SandboxConfig = {
				...(sandboxConfig ?? DEFAULT_SANDBOX_CONFIG),
				engine: undefined,
				writable: [...(sandboxConfig?.writable ?? [])],
			};
			for (let index = 1; index < argv.length; index++) {
				const arg = argv[index];
				if (arg === "--network") next.allowNetwork = true;
				else if (arg === "--engine") {
					const engine = argv[++index];
					if (engine !== "bwrap" && engine !== "sandbox-exec") {
						ctx.ui.notify("--engine expects bwrap or sandbox-exec", "error");
						return;
					}
					next.engine = engine;
				} else if (arg === "--writable") {
					const dir = argv[++index];
					if (!dir) {
						ctx.ui.notify("--writable expects a directory", "error");
						return;
					}
					next.writable.push(dir);
				} else {
					ctx.ui.notify(`Unknown /sandbox option "${arg}"`, "error");
					return;
				}
			}
			const availability = detectSandbox(next);
			if (!availability.available) {
				ctx.ui.notify(`Cannot enable the sandbox: ${availability.reason}`, "error");
				return;
			}
			saveExtraSettings({ sandbox: next });
			applySandbox(ctx.cwd);
			ctx.ui.notify(`Sandbox enabled: ${sandboxStatusLine()}`, "info");
		},
	});

	// --- ENV provider (append-only; never changes the default model) ---
	const envProvider = resolveEnvProvider();
	if (envProvider) {
		nanopi.registerProvider(envProvider.providerId, {
			name: envProvider.name,
			baseUrl: envProvider.baseUrl,
			apiKey: envProvider.apiKey,
			api: envProvider.api,
			models: envProvider.models,
		});
	}

	const initMd = resolveInitMd(process.cwd());

	// --- CLI flags: --yolo, --plan, --minimal, --mode ---
	nanopi.registerFlag("yolo", {
		type: "boolean",
		description: "Skip permission prompts and the folder-trust confirmation for this run",
	});
	// Run modes are settable for one run as well: typing `/mode minimal` after
	// launch is a worse answer to `pi --minimal` than a flag, and the mode only
	// existed as a slash command and a webui switch.
	nanopi.registerFlag("plan", {
		type: "boolean",
		description: "Start in plan mode (read-only exploration, then a plan)",
	});
	nanopi.registerFlag("minimal", {
		type: "boolean",
		description: "Start in minimal mode (shell tool only)",
	});
	nanopi.registerFlag("mode", {
		type: "string",
		description: "Start in a run mode: plan, minimal, or standard",
	});

	/** Run mode requested on the command line, or undefined to use the settings default. */
	function requestedMode(
		getFlag: (name: string) => boolean | string | undefined,
	): { mode: RunMode; reason: string } | undefined {
		const named = getFlag("mode");
		if (named !== undefined && named !== true) {
			if (!isRunMode(named)) return undefined;
			return { mode: named, reason: "--mode" };
		}
		if (getFlag("plan") === true) return { mode: "plan", reason: "--plan" };
		if (getFlag("minimal") === true) return { mode: "minimal", reason: "--minimal" };
		return undefined;
	}

	// --- CLI command: /plan ---
	nanopi.registerCommand("plan", {
		description: "Enter plan mode, draft an execution plan, then offer to execute it",
		handler: async (args, ctx) => {
			if (engine.mode === "plan") {
				ctx.ui.notify("Already in plan mode", "info");
				return;
			}
			engine.setMode("plan", "/plan");
			planIntroActive = true;
			const task = args.trim();
			nanopi.sendUserMessage(
				task.length > 0
					? `${task}\n\n(We are in plan mode: explore read-only and produce a step-by-step plan for this task.)`
					: "Explore the repository read-only and produce a step-by-step plan for the task at hand. Do not attempt modifications.",
			);
		},
	});

	// --- CLI command: /mode [plan|minimal|standard] ---
	nanopi.registerCommand("mode", {
		description: "Show or switch the run mode (plan | minimal | standard)",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested === "") {
				const choice = await ctx.ui.select(`Run mode (current: ${engine.mode})`, ["plan", "minimal", "standard"]);
				if (choice === "plan" || choice === "minimal" || choice === "standard") {
					engine.setMode(choice, "/mode");
				}
				return;
			}
			if (requested !== "plan" && requested !== "minimal" && requested !== "standard") {
				ctx.ui.notify(`Unknown mode "${requested}" (plan | minimal | standard)`, "error");
				return;
			}
			engine.setMode(requested, "/mode");
		},
	});

	// --- Folder trust: --yolo trusts this run without prompting ---
	// (undecided falls through to the next handler / core default)
	nanopi.on("project_trust", (): ExtraProjectTrustResult => {
		if (engine.yolo) return { trusted: "yes" };
		return { trusted: "undecided" };
	});

	// --- Mode application ---
	function applyModeToolSet(): void {
		const all = nanopi.getAllTools().map((tool) => tool.name);
		if (engine.mode === "minimal") {
			// Capture only when entering: the snapshot survives a same-mode reapply,
			// and the narrowed set below must not be captured as the restore point.
			if (!engine.preMinimalTools) engine.setPreMinimalTools(nanopi.getActiveTools());
			nanopi.setActiveTools(
				nanopi.getActiveTools().filter((name) => all.includes(name) && SHELL_TOOL_NAMES.has(name)),
			);
		} else if (engine.preMinimalTools) {
			const restore = engine.preMinimalTools.filter((name) => all.includes(name));
			engine.setPreMinimalTools(undefined);
			nanopi.setActiveTools(restore);
		}
	}

	function subsystemStatus(): SubsystemStatus[] {
		const settings = loadExtraSettings(sessionCtx?.cwd ?? process.cwd()).settings;
		const all = nanopi.getAllTools().map((tool) => tool.name);
		return SUBSYSTEM_KEYS.map((key) => {
			const tools = subsystemTools(all, key);
			return {
				key,
				enabled: settings.subsystems[key] ?? true,
				available: tools.length > 0,
				detail: tools.length > 0 ? undefined : "package not installed in this session",
			};
		});
	}

	function applySubsystem(key: SubsystemKey, enabled: boolean): void {
		const all = nanopi.getAllTools().map((tool) => tool.name);
		const targets = subsystemTools(all, key);
		if (targets.length === 0) return;
		const active = new Set(nanopi.getActiveTools());
		for (const name of targets) {
			if (enabled) active.add(name);
			else active.delete(name);
		}
		nanopi.setActiveTools([...active]);
	}

	// --- CLI command: /gitguard [on|off] ---
	nanopi.registerCommand("gitguard", {
		description: "Show or configure the destructive git guard (on | off)",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested === "") {
				ctx.ui.notify(`Git guard: ${gitGuardOn ? "on" : "off"}`, "info");
				return;
			}
			if (requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /gitguard [on|off]", "error");
				return;
			}
			saveExtraSettings({ gitGuard: requested === "on" });
			gitGuardOn = requested === "on";
			ctx.ui.notify(`Git guard ${requested}`, "info");
		},
	});

	// --- CLI command: /shellguard [on|off] ---
	nanopi.registerCommand("shellguard", {
		description: "Show or configure the file-inspection guard (on | off)",
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			if (requested === "") {
				ctx.ui.notify(`Shell guard: ${shellGuardOn ? "on" : "off"}`, "info");
				return;
			}
			if (requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /shellguard [on|off]", "error");
				return;
			}
			saveExtraSettings({ shellGuard: requested === "on" });
			shellGuardOn = requested === "on";
			ctx.ui.notify(`Shell guard ${requested}`, "info");
		},
	});

	// --- Session lifecycle ---
	nanopi.on("session_start", (event, ctx) => {
		sessionCtx = ctx;
		engine.setYolo(nanopi.getFlag("yolo") === true);
		if (event.reason !== "reload") {
			// New sessions pick up the configured default mode. The webui is the
			// exception: the engine is process-wide and the settings page switches
			// it live, so resetting here wiped the mode the user had just picked
			// (the SPA creates a session on the first send, after the switch).
			const settings = loadExtraSettings(ctx.cwd).settings;
			if (ctx.mode !== "webui") {
				const requested = requestedMode((name) => nanopi.getFlag(name));
				if (requested) engine.setMode(requested.mode, requested.reason);
				else engine.setMode(settings.defaultMode, "session default");
			}
			applyModeToolSet();
			// Persisted subsystem switches apply to fresh sessions too, not just
			// when toggled live from the webui settings page.
			for (const key of SUBSYSTEM_KEYS) {
				if (settings.subsystems[key] === false) applySubsystem(key, false);
			}
		}
		// Rebuilt on every start so a reloaded settings file (and /sandbox) applies.
		applySandbox(ctx.cwd);
		gitGuardOn = gitGuardEnabled(ctx.cwd);
		shellGuardOn = shellGuardEnabled(ctx.cwd);
		// Fresh permission memory per session.
		const prompter: PermissionPrompter | undefined =
			ctx.mode === "webui"
				? makeWebuiPrompter((info) => explainCall(info, nanopi))
				: ctx.hasUI
					? makeDialogPrompter(ctx, (info) => explainCall(info, nanopi))
					: undefined;
		const judge = (info: PermissionCallInfo) =>
			judgeWithModel(info, ctx.model, ctx.modelRegistry as unknown as JudgeModelRegistry, { cwd: ctx.cwd });
		gate = new PermissionGate(
			prompter ?? (async () => undefined),
			judge,
			ctx.mode === "webui" ? extraBridge.permissions.explanationPrompter : undefined,
		);
		if (ctx.mode === "tui") {
			applyModeStatus();
		}
		extraBridge.bindSession(
			{
				subsystemStatus: () => subsystemStatus(),
				applySubsystem: (key, enabled) => applySubsystem(key, enabled),
				applyModeToolSet: () => applyModeToolSet(),
				continueSuggestion,
			},
			ctx.cwd,
			{
				model: ctx.model,
				registry: ctx.modelRegistry as unknown as JudgeModelRegistry,
				cwd: ctx.cwd,
			},
		);
	});

	nanopi.on("session_shutdown", () => {
		extraBridge.permissions.cancelAll();
		forgetExplainedCalls();
		planIntroActive = false;
	});

	// --- /plan exit confirmation ---
	nanopi.on("agent_settled", (event) => {
		// An explanation is a whole turn, so this also ends it: the call the user
		// asked about may now run on a bare "继续".
		if (event.aborted) forgetExplainedCalls();
		else approveExplainedCalls();
		if (!planIntroActive || engine.mode !== "plan") return;
		planIntroActive = false;
		const ctx = sessionCtx;
		if (!ctx?.hasUI) return;
		void (async () => {
			const choice = await ctx.ui.select("Plan ready. Exit plan mode and execute it?", [
				"Exit plan mode and execute",
				"Stay in plan mode",
			]);
			if (choice === "Exit plan mode and execute") {
				engine.setMode("standard", "plan approved");
				nanopi.sendUserMessage("The plan above is approved. Execute it now in standard mode.");
			} else {
				ctx.ui.notify("Staying in plan mode (read-only exploration).", "info");
			}
		})();
	});

	// --- System prompt injection (only while active) ---
	nanopi.on("before_agent_start", (event) => {
		if (initMd !== undefined && event.systemPromptOptions.customPrompt === undefined) {
			event.systemPromptOptions.customPrompt = initMd;
		}
		const guidelines = event.systemPromptOptions.promptGuidelines ?? [];
		if (engine.mode === "plan") guidelines.push(PLAN_GUIDELINE);
		else if (engine.mode === "minimal") guidelines.push(MINIMAL_GUIDELINE);
		const all = nanopi.getAllTools().map((tool) => tool.name);
		// Both halves have to exist for the guideline to be true: servers registered
		// (`mcp__*`) and the shell (`mcp`) that reaches them. The shell needs the
		// `subagent` tool to delegate into, so a build without it gets no guideline
		// instead of an instruction pointing at a missing tool.
		const mcpEnabled =
			(loadExtraSettings(process.cwd()).settings.subsystems.mcp ?? true) &&
			all.some(isMcpToolName) &&
			all.includes("mcp") &&
			all.includes("subagent");
		if (mcpEnabled) {
			guidelines.push(MCP_SUBAGENT_ONLY_GUIDELINE);
		}
		event.systemPromptOptions.promptGuidelines = guidelines;
	});

	// --- Tool call interception: mode whitelist + permission gate ---
	nanopi.on("tool_call", async (event: ExtraToolCallEvent): Promise<ExtraToolCallResult | undefined> => {
		// MCP is subagent-only in the main agent, in every mode.
		if (isMcpToolName(event.toolName)) {
			return { block: true, reason: MCP_MAIN_AGENT_BLOCK_REASON };
		}

		if (engine.mode === "plan") {
			// Asking a question is not a modification, and a plan built without
			// resolving ambiguity is the failure plan mode exists to prevent.
			const blocked = planModeVerdict(event.toolName, event.input);
			return blocked === undefined ? undefined : { block: true, reason: blocked };
		}

		if (engine.mode === "minimal" && !SHELL_TOOL_NAMES.has(event.toolName)) {
			return { block: true, reason: `minimal mode provides only the shell tools (blocked ${event.toolName})` };
		}

		// The shell guard is a refusal, not a prompt: the model has to see the rule
		// in the tool result, which is the only thing it reads on the next turn.
		if (shellGuardOn && SHELL_TOOL_NAMES.has(event.toolName)) {
			const refusal = shellGuardHazard(event, sessionCtx?.cwd ?? process.cwd(), nanopi.getActiveTools());
			if (refusal !== undefined) return { block: true, reason: refusal };
		}

		const sandboxNote = sandboxConfig ? describeSandboxCall(sandboxConfig, event.toolName) : undefined;
		if (engine.yolo || gate === undefined || !GATED_TOOL_NAMES.has(event.toolName)) {
			if (sandboxNote) sessionCtx?.ui.notify(sandboxNote, "info");
			return undefined;
		}
		const { summary, firstCommand } = summarizeCall(event);
		const hazard =
			gitGuardOn && SHELL_TOOL_NAMES.has(event.toolName)
				? destructiveGitHazard(event, sessionCtx?.cwd ?? process.cwd())
				: undefined;
		const info: PermissionCallInfo = {
			callId: event.toolCallId,
			toolName: event.toolName,
			summary,
			args: event.input,
			firstCommand,
			hazard,
		};
		// The prompt carries every answer, "explain" included: `check()` pauses the
		// call on that answer and asks again once the user has read the
		// explanation, so this is one `check()` from the model's point of view.
		const outcome = await gate.check(info);
		if (outcome.action === "deny") {
			// The model has to learn the rule from the refusal itself: prompt text
			// alone is what let this happen in the first place.
			return { block: true, reason: hazard ? `${outcome.reason}\n\n${hazard}` : outcome.reason };
		}
		return undefined;
	});
}

/** The inline extension record the coding-agent registers. */
export const extraInlineExtension: ExtraInlineExtension = {
	name: "extra",
	factory: createExtraExtension,
	hidden: true,
};
