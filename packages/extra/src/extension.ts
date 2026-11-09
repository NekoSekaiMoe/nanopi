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
import { modeBadgeText, shellLabel } from "./badges.ts";
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
import type {
	PermissionCallInfo,
	PermissionDecision,
	PermissionExplanationPrompter,
	PermissionPrompter,
} from "./permissions.ts";
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
import {
	type GuardKey,
	globalGuardValue,
	loadExtraSettings,
	projectExtraSettingsPath,
	projectGuardValue,
	resolveGuardSwitch,
	type SettingsLayer,
	type SettingsSource,
	saveExtraSettings,
} from "./settings-store.ts";
import { analyzeFileInspection, shellGuardNotice } from "./shell-guard.ts";
import { type RunMode, SUBSYSTEM_KEYS, type SubsystemKey, type SubsystemStatus } from "./types.ts";

const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
/** Tools that prompt for permission when not in yolo or plan mode. */
const GATED_TOOL_NAMES = new Set(["edit", "write", "bash", "powershell"]);

const PLAN_GUIDELINE = `You are in PLAN MODE: exploration and planning only. Investigate, resolve ambiguity, and return a plan another engineer can execute without asking you anything. The repository is read-only here: edits, writes, and every shell command that is not on the read-only list are refused, and the refusal names the boundary.

Work in three phases. Do not skip a phase because the request sounds obvious.

1. Ground in the environment. Read before asking: search the files, entry points, configs, and tests the task touches until the unknowns in the request are facts. A question whose answer is in the repository wastes the user's turn, and a plan written on guessed names is worse than no plan. Ask only what the environment cannot answer, and when you do, offer the concrete candidates you found.

2. Settle intent. State the goal in one line and the success criteria you will be held to. Then finish with the user, before designing: the audience, what is in and out of scope, constraints that disqualify an approach, and the preferences that pick between approaches. If a high-impact choice is still open, ask - do not plan past it.

3. Design the implementation. Bring the plan to decision complete: which files change and how, the interfaces it introduces or changes, the data flow, the edge cases and failure modes that shaped the design, how it will be verified, and the assumptions you had to fill in. Tests are part of the design, not a footnote.

You cannot run the build or the tests here, and the plan may not claim that they pass. Say what verifies the change and what you already know holds; the execution turn runs the checks.

The plan ends as prose in your reply, in the user's language, with the structure below. It is a message, not a file: do not write it to disk.

## <title>

Goal and success criteria in a short paragraph.

## Changes - grouped by subsystem or behaviour; name a file only to disambiguate. No file-by-file inventory.

## Interfaces - public API, types, config, or wire shapes that change, and why. Omit when nothing outside the code changes.

## Tests - what proves it works, and how each item is checked.

## Assumptions - every default you picked, so the user can reject it in one line.

Finish with the plan itself. Do not ask whether to proceed and do not restate this instruction: the user is offered a choice between executing the plan and revising it, so a question about proceeding turns one decision into two.`;
/**
 * Tools plan mode allows besides `read`, in addition to the read-only shell commands.
 *
 * `enter_plan_mode` is here so a session that starts outside plan mode has the same
 * way in as the user typing `/plan`. It changes no files; it only makes this phase
 * reachable from the model side, where a non-mutating request (`write a plan for X`)
 * otherwise has no answer but "blocked".
 *
 * `todo` is here because a plan is a list of steps: the model drafts it with the tool
 * whose results the user already sees, and the entries stay in the session for
 * execution. Holding todos is not a claim about the repository.
 *
 * Everything else is blocked, including tools that build or run code: a plan that
 * says "the tests pass" is a claim the plan cannot make, and `pnpm run check` writes
 * as much as it reads. The plan says what the verification will be; it does not run it.
 */
const PLAN_ALLOWED_TOOLS = new Set(["ask_user_question", "enter_plan_mode", "todo"]);
/**
 * LSP tools that only read. They belong in plan mode: hover/definition/references
 * answer questions that grepping cannot, and blocking them left the model with
 * `read` as its only way to look at code.
 *
 * `lsp_edit` is deliberately absent — it rewrites files.
 */
const PLAN_ALLOWED_LSP_TOOLS = new Set(["lsp_diagnostics", "lsp_hover", "lsp_definition", "lsp_query"]);

/**
 * Shell tools whose `command` string the plan-mode allowlist vets.
 *
 * `powershell` is checked by the same analyzer, so it is refused rather than
 * allowed through: its syntax does not tokenize the way bash's does, and a
 * "read-only" verdict on a string the analyzer did not understand would be a
 * hole. It stays listed so the refusal names the mode, not a missing tool.
 */
const PLAN_SHELL_TOOL_NAMES = new Set(["bash", "shell", "powershell", "pwsh"]);

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
	if (PLAN_SHELL_TOOL_NAMES.has(toolName)) {
		const command =
			typeof (input as Record<string, unknown>)?.command === "string"
				? ((input as Record<string, unknown>).command as string)
				: "";
		const analysis = analyzeCommandForPlan(command);
		if (analysis.allowed) return undefined;
		return analysis.reason ?? "command not allowed in plan mode";
	}
	return `plan mode is read-only (blocked ${toolName}). Explore with read, the read-only lsp tools, and the reading shell commands; ask with ask_user_question; keep the draft in todo. Then answer with the plan: the user approves it before anything is modified.`;
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
function makeDialogPrompter(ctx: ExtraExtensionContext): PermissionPrompter {
	return async (info) => {
		const title = `Allow ${info.toolName}? ${info.summary}`;
		const choice = await ctx.ui.select(
			title,
			DECISION_LABELS.map((entry) => entry.label),
			{ description: PROMPT_CAPTION },
		);
		// `explain` is handed back as an answer, not acted on here: the gate pauses
		// the call on it and settles the pause afterwards. Driving the explanation
		// from this closure instead settled the call as dismissed, so picking
		// Explain rejected the very call the user asked about.
		return DECISION_LABELS.find((entry) => entry.label === choice)?.decision;
	};
}

/**
 * Gather the answer to a paused call over the dialog.
 *
 * The explanation is a full turn, and the dialog cannot be up while the model
 * writes, so the prompt comes back after it: the call runs on the user's next
 * answer (or on 继续, through `approveOnce()`), never on the Explain itself.
 */
function makeDialogExplanationPrompter(ctx: ExtraExtensionContext): PermissionExplanationPrompter {
	const labels = DECISION_LABELS.filter((entry) => entry.decision !== "explain");
	return async (info) => {
		const choice = await ctx.ui.select(
			`Allow ${info.toolName}? ${info.summary}`,
			labels.map((entry) => entry.label),
			{
				description: PROMPT_CAPTION,
			},
		);
		// No Explain this time: the explanation already happened, and a second
		// pause on the same call would leave it blocked with nothing left to ask.
		// A dismissal is a dismissal, which `settle()` turns into a deny.
		return labels.find((entry) => entry.label === choice)?.decision;
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

/**
 * One guard switch as this session currently has it.
 *
 * `source` travels with the value everywhere it is shown: the bare `/gitguard`
 * output, the session-start notice, and the confirm dialog. A switch that reads
 * "off" must say which file said so, or the user cannot tell a deliberate
 * project setting from one that silently overruled their global "on".
 */
interface GuardSwitchState {
	readonly value: boolean;
	readonly source: SettingsSource;
	/** Answer given for this session: memory only, nothing written. */
	readonly session: boolean | undefined;
	/** False until a session start read the files, which is when the other fields mean anything. */
	readonly read: boolean;
}

/** The word the confirm dialog and the bare command use for "not saved anywhere yet". */
const DEFAULT_SOURCE_LABEL = "default (on)";

function sourceLabel(source: SettingsSource): string {
	return source === "default" ? DEFAULT_SOURCE_LABEL : source;
}

function describeGuard(state: GuardSwitchState): string {
	const value = state.session ?? state.value;
	if (state.session !== undefined) {
		return `${value ? "on" : "off"} (this session; saved value is ${state.value ? "on" : "off"})`;
	}
	return `${value ? "on" : "off"} (${sourceLabel(state.source)})`;
}

/**
 * Every guarded switch reads through `resolveGuardSwitch`, so the value and its
 * source are one thing rather than two lookups that can disagree.
 */
function readGuardState(cwd: string, key: GuardKey): GuardSwitchState {
	const resolved = resolveGuardSwitch(cwd, key);
	return { value: resolved.value, source: resolved.source, session: undefined, read: true };
}

/** The three targets `/gitguard off` can name, widest first. */
const GUARD_SCOPES = ["global", "project", "session"] as const;
type GuardScope = (typeof GUARD_SCOPES)[number];

function isGuardScope(value: string): value is GuardScope {
	return (GUARD_SCOPES as readonly string[]).includes(value);
}

const GUARD_SCOPE_HINTS: Record<GuardScope, string> = {
	global: "write the global settings file",
	project: "write .nanopi/extra/settings.json in this directory",
	session: "this session only, not saved",
};

/** Answers to the session-start question; each one is a different reach. */
const GUARD_CONFIRM_ACCEPT = "Keep it off for this session";
const GUARD_CONFIRM_REPAIR = "Use the global value and fix the project file";
const GUARD_CONFIRM_DENY = "Block shell and git calls until I change it";

/**
 * What to do when a project file silently overrules the global guard value.
 *
 * The three answers are the whole point of asking instead of just reading: a
 * session that opens with a guard quietly off, against a global "on", is a
 * downgrade nobody chose. Nothing here is silent — a session that cannot show a
 * dialog takes the conservative answer and says so in its log.
 *
 * Resolves `undefined` in the common case, where the project file has no say:
 * it carries no key for this switch, or carries the same answer the global file
 * gives. A project layer with *no* global value underneath is the user turning
 * the guard off in a fresh setup, not a downgrade to challenge.
 */
async function confirmGuardDowngrade(
	ctx: ExtraExtensionContext,
	key: GuardKey,
	cwd: string,
): Promise<GuardSwitchState | undefined> {
	const project = projectGuardValue(cwd, key);
	if (project === undefined) return undefined;
	const global = globalGuardValue(key);
	// `false` in one layer under `true` (or nothing) in the other is the silent
	// downgrade. Anything else is either agreement or a deliberate global `off`.
	if (project !== false || global === false) return undefined;
	const title = key === "gitGuard" ? "Git guard" : "Shell guard";
	const file = projectExtraSettingsPath(cwd);
	const message = `${title} is off because ${file} says so, while the global settings do not say off. Keep it off?`;
	if (!ctx.hasUI) {
		ctx.ui.notify(`${message} No prompt to answer it, so it stays on.`, "warning");
		return { value: true, source: "global", session: true, read: true };
	}
	const choice = await ctx.ui.select(message, [GUARD_CONFIRM_ACCEPT, GUARD_CONFIRM_REPAIR, GUARD_CONFIRM_DENY]);
	// `session` is the answer in effect for this session, which is the guard's own
	// value: accepting means it stays off, denying means it stays on.
	if (choice === GUARD_CONFIRM_ACCEPT) return { value: false, source: "project", session: false, read: true };
	if (choice === GUARD_CONFIRM_DENY) {
		ctx.ui.notify(`${title} off by ${file}: shell and git calls are blocked until it changes.`, "warning");
		return { value: true, source: "project", session: true, read: true };
	}
	// Repaired, or dismissed: the project file is the thing that lied, so the key
	// comes out of it instead of the session overriding a value that stays behind.
	saveExtraSettings({ [key]: null }, "project", cwd);
	return { value: true, source: "global", session: true, read: true };
}

/**
 * The refusal for a shell call whose line only reads files through commands the
 * read/grep tools do better, or undefined.
 *
 * The refusal is only true when the substitute exists in this session: without a
 * `read` tool, `cat file` has no replacement to point at.
 */
export function shellGuardHazard(
	event: ExtraToolCallEvent,
	cwd: string,
	activeTools: readonly string[],
): string | undefined {
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

/**
 * Whether `/minimal` would narrow the loadout to itself, which is what a
 * shell-only build does (buildconfig.json `toolset: "bash"`, the minimal SKU):
 * the set it narrows to is the set it starts from, so entering the mode changes
 * nothing and leaving it restores a snapshot equal to the current loadout.
 *
 * `/plan` and the permission gate still mean something there, so the module and
 * its commands stay; only the mode that has nothing to narrow says so.
 */
export function narrowsToItself(toolNames: readonly string[]): boolean {
	return toolNames.length > 0 && toolNames.every((name) => SHELL_TOOL_NAMES.has(name));
}

const NOTHING_TO_NARROW = "This build ships only the shell tools, so minimal mode has nothing to narrow";

/**
 * Answer for plan mode entered while already in plan mode.
 *
 * Plan is the one run mode that does not toggle: it ends in "execute this", so
 * a second `/plan` is a fresh request for a plan, not a request to leave. The
 * other two are switches, and a switch typed while on is a request to turn it
 * off (see `modeCommand`).
 */
const ALREADY_IN_PLAN =
	"Already in plan mode (read-only): type what to change to revise the plan, or answer the exit prompt when it appears";

/**
 * What the approved plan is sent with.
 *
 * The plan is in the transcript, one message above, so the instruction only has
 * to name it and say what execution means: entries of the draft become todos, and
 * the plan's own verification steps are how the work is checked.
 */
const PLAN_APPROVED_MESSAGE =
	"Plan approved. Execute the plan above. Track its steps with todo (the draft you made is the starting point), follow it unless you find a reason not to, and say so when you deviate. Verify with the plan's test steps before reporting done.";

/**
 * How many plan-mode turns may end in a question before the exit prompt appears
 * anyway. A model that keeps asking is not converging, and the exit prompt is the
 * only way out of plan mode besides `/minimal`; without a bound, a question-shaped
 * loop would keep the user in a read-only mode with nothing to approve.
 */
const MAX_QUESTION_TURNS = 3;

/**
 * Whether the turn's last assistant message asked the user something, which
 * makes the turn unfinished.
 *
 * The adapter records the call because the questionnaire returns a result whether
 * the user answered or cancelled; only the call itself says a question was put.
 */
function lastTurnAskedUser(messages: readonly unknown[]): boolean {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index] as { role?: string; content?: unknown } | undefined;
		if (message?.role !== "assistant") continue;
		return assistantMessageAskedUser(message.content);
	}
	return false;
}

function assistantMessageAskedUser(content: unknown): boolean {
	if (!Array.isArray(content)) return false;
	return content.some(
		(part) =>
			typeof part === "object" &&
			part !== null &&
			(part as { type?: unknown; name?: unknown }).type === "toolCall" &&
			(part as { name?: unknown }).name === "ask_user_question",
	);
}

export function createExtraExtension(nanopi: ExtraExtensionAPI): void {
	const engine = modeEngine;
	let sessionCtx: ExtraExtensionContext | undefined;
	let gate: PermissionGate | undefined;
	/** /plan runs settle into the exit-confirmation flow. */
	let planIntroActive = false;
	/** Plan-mode turns that ended in a question; bounds the exit prompt's wait. */
	let questionTurns = 0;
	/** Value plus the layer it came from; rebuilt on every session start, `/gitguard` rewrites it. */
	let gitGuardState: GuardSwitchState = { value: true, source: "default", session: undefined, read: false };
	/** Value plus the layer it came from; rebuilt on every session start, `/shellguard` rewrites it. */
	let shellGuardState: GuardSwitchState = { value: true, source: "default", session: undefined, read: false };
	/** Calls the user asked to have explained, waiting for that explanation to land. */
	const explainedCalls = new Map<string, PermissionCallInfo>();
	/**
	 * Whether this session can answer a prompt. A session that cannot (print,
	 * json, subagents) runs its gated calls instead of denying them all.
	 */
	let gated = true;

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
	/**
	 * Push the footer status through the status channel.
	 *
	 * The producer decides the whole slot instead of leaving it to the footer:
	 * shell mode shows the yellow `shell` label alone (it says what the next
	 * command does, and the mode badge right behind it was the same yellow), and
	 * the mode badges return as soon as the composer leaves shell mode. Every
	 * path that emits a status also refreshes this — a mode change, a session
	 * start, a turn end — because the composer's text only reaches the extension
	 * here, and a stale line would keep claiming shell mode.
	 */
	function applyModeStatus(): void {
		if (sessionCtx?.mode !== "tui") return;
		const theme = sessionCtx.ui.theme;
		const shellMode = sessionCtx.ui.getEditorText().trimStart().startsWith("!");
		sessionCtx.ui.setStatus("mode", shellMode ? shellLabel(theme) : modeBadgeText(engine, theme));
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
			// Leave shell execution local instead of failing every command, and say
			// so: without the notice the only trace of a configured sandbox was a
			// `/sandbox` the user had no reason to type, so commands they believed
			// were contained ran unsandboxed. Notifying throws nowhere, so a session
			// without a UI (`notify` is a no-op there) still ends up local.
			nanopi.registerBashOperations?.(SANDBOX_BACKEND_ID, undefined);
			nanopi.setActiveBashOperations?.(undefined);
			sessionCtx?.ui.notify(
				`Sandbox configured but not applied: ${sandboxAvailability.reason}. Shell commands run unsandboxed.`,
				"warning",
			);
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

	// --- CLI flags: --yolo, --plan, --minimal ---
	nanopi.registerFlag("yolo", {
		type: "boolean",
		description: "Skip permission prompts and the folder-trust confirmation for this run",
	});
	// Run modes are settable for one run as well: typing `/minimal` after launch
	// is a worse answer to `nanopi --minimal` than a flag.
	//
	// There is deliberately no `--mode <run-mode>`: the CLI spells the output
	// interface `--output` (text | json | rpc), and run modes get one flag per
	// mode, `--plan` / `--minimal`, so no word carries two meanings.
	nanopi.registerFlag("plan", {
		type: "boolean",
		description: "Start in plan mode (read-only exploration, then a plan)",
	});
	nanopi.registerFlag("minimal", {
		type: "boolean",
		description: "Start in minimal mode (shell tool only)",
	});

	// --- Mode switches: /plan, /minimal ---
	//
	// One command per run mode, so `/p` + Tab reaches /plan and `/mi` reaches
	// /minimal. The modes replace each other (each is a different tool set), so
	// exactly one is in effect, and `standard` — the full tool set every session
	// starts in — has no command: a restriction is turned off by the command that
	// turned it on. `/minimal` typed in minimal mode leaves it; the same keystroke
	// is the way in and the way out, which is what users typed anyway.
	//
	// `/plan` is the exception. It ends in "execute this" rather than in a
	// restricted tool set, so a second `/plan` asks for a plan again (with an
	// optional task argument) instead of leaving the mode, and the way out is the
	// exit prompt the plan itself ends with.
	function modeCommand(mode: RunMode): (args: string, ctx: ExtraExtensionContext) => Promise<void> {
		return async (args, ctx) => {
			if (engine.mode === mode) {
				if (mode !== "minimal") {
					ctx.ui.notify(ALREADY_IN_PLAN, "info");
					return;
				}
				// Leaving minimal restores the loadout captured on entry.
				leaveMinimalMode("/minimal");
				ctx.ui.notify("Left minimal mode", "info");
				return;
			}
			if (mode === "minimal" && minimalModeNarrowsNothing()) {
				ctx.ui.notify(NOTHING_TO_NARROW, "info");
				return;
			}
			const previous = engine.mode;
			engine.setMode(mode, `/${mode}`);
			// Only /plan opens the exit-confirmation flow: it is the mode that ends
			// in "execute this", and the reason /plan also sends a first turn.
			if (mode !== "plan") {
				// Minimal drops plan's whitelist, so the notice names the mode that
				// was left.
				const hint = previous === "standard" ? "" : ` (left ${previous} mode)`;
				ctx.ui.notify(`Switched to ${mode} mode${hint}`, "info");
				return;
			}
			// A second `/plan` with text is a revision, not a restart: it keeps the
			// exit prompt that is already waiting instead of resetting the counter.
			if (previous !== "plan") questionTurns = 0;
			planIntroActive = true;
			const task = args.trim();
			// The rules arrive in the system prompt as the plan-mode paragraph, so the
			// message carries the task and nothing else: restating the rules here made
			// the model answer the parenthesis instead of the request.
			nanopi.sendUserMessage(task.length > 0 ? task : "Draft a plan for the task at hand.");
		};
	}

	nanopi.registerCommand("plan", {
		description: "Enter plan mode, draft an execution plan, then offer to execute it",
		handler: modeCommand("plan"),
	});

	nanopi.registerCommand("minimal", {
		description: "Enter minimal mode (shell tool only); type it again to leave",
		handler: modeCommand("minimal"),
	});

	// --- Tool: enter_plan_mode ---
	//
	// `/plan` is a user command, so a request that is itself a plan request
	// ("write a plan for X") had no model-side answer: the agent either started
	// editing or had to ask the user to type a slash command. This tool is the
	// same entry, minus the user: it switches the mode and returns, and the caller's
	// next request carries the plan-mode paragraph.
	//
	// `defaultActive: false` is deliberately not available through this slice, so
	// it is activated like every other extra tool; plan mode's whitelist is what
	// keeps it from appearing as an option while planning.
	nanopi.registerTool?.({
		name: "enter_plan_mode",
		label: "Enter plan mode",
		description:
			"Switch this session to plan mode: read-only exploration and a decision-complete plan handed back to the user for approval. Use it when the user asks for a plan, a design, or an approach instead of an edit.",
		promptSnippet: "Enter plan mode to explore and return a plan instead of editing",
		promptGuidelines: [
			"When the user asks for a plan, a design, or an approach rather than an edit, call enter_plan_mode first and plan there; do not write the file the request was apparently about.",
		],
		parameters: { type: "object", properties: {}, additionalProperties: false },
		async execute() {
			const previous = engine.mode;
			engine.setMode("plan", "enter_plan_mode");
			questionTurns = 0;
			// No exit prompt: the user asked for a plan in prose, and the request is
			// already the plan-mode turn. A prompt here would offer to execute a plan
			// the model has not written yet.
			planIntroActive = false;
			applyModeStatus();
			return {
				content: [
					{
						type: "text",
						text: `Switched to plan mode${previous === "standard" ? "" : ` (left ${previous} mode)`}. Explore read-only, resolve ambiguity, and answer with the plan; the user approves it before anything is modified.`,
					},
				],
				details: undefined,
			};
		},
	});

	// --- CLI command: /yolo [on|off] ---
	// Same shape as /gitguard and /shellguard, minus persistence: yolo is a
	// property of the run (and of the folder-trust answer it implies), not a
	// setting a later session should inherit.
	nanopi.registerCommand("yolo", {
		description: "Toggle yolo mode, or set it (on | off): skip permission prompts. /yolo again leaves it",
		getArgumentCompletions: (prefix) =>
			["on", "off"]
				.filter((value) => value.startsWith(prefix))
				.map((value) => ({
					value,
					label: value,
					description: value === "on" ? "skip permission prompts" : "prompt for gated calls again",
				})),
		handler: async (args, ctx) => {
			const requested = args.trim().toLowerCase();
			// A bare `/yolo` toggles: it is the switch users type after looking at
			// the footer, and answering with the current state made them type the
			// same command twice to flip it. The same keystroke turns it off, so
			// leaving needs no second command either.
			if (requested === "") {
				engine.setYolo(!engine.yolo);
				ctx.ui.notify(engine.yolo ? "Yolo mode on" : "Left yolo mode", "info");
				return;
			}
			if (requested !== "on" && requested !== "off") {
				ctx.ui.notify("Usage: /yolo [on|off]", "error");
				return;
			}
			// Set explicitly: unlike a toggle, this answers the state that was asked for.
			engine.setYolo(requested === "on");
			ctx.ui.notify(requested === "on" ? "Yolo mode on" : "Left yolo mode", "info");
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
			// Capture only when entering: the narrowed set below must never become
			// the restore point.
			if (!engine.preMinimalTools) engine.setPreMinimalTools(nanopi.getActiveTools());
			nanopi.setActiveTools(
				nanopi.getActiveTools().filter((name) => all.includes(name) && SHELL_TOOL_NAMES.has(name)),
			);
		}
		// Restoring is not done here: `setMode` drops the snapshot before it emits,
		// so by the time this listener runs the restore point is gone. Leaving
		// minimal goes through `leaveMinimalMode()` instead.
	}

	/**
	 * Leave minimal mode, restoring the loadout captured on entry.
	 *
	 * The restore point cannot be read from `setMode`'s listener: that call drops
	 * the snapshot before it emits, so the listener sees `undefined` for every
	 * frontend switch. Restoring here also covers the case the snapshot was never
	 * taken (a mode switched through the webui bridge before any session start):
	 * the full tool set is what minimal narrowed away from.
	 */
	function leaveMinimalMode(reason: string): void {
		const all = nanopi.getAllTools().map((tool) => tool.name);
		const restore = (engine.preMinimalTools ?? all).filter((name) => all.includes(name));
		engine.setMode("standard", reason);
		engine.setPreMinimalTools(undefined);
		nanopi.setActiveTools(restore);
	}

	function minimalModeNarrowsNothing(): boolean {
		return narrowsToItself(nanopi.getAllTools().map((tool) => tool.name));
	}

	/**
	 * Run mode requested on the command line, or undefined to use the settings
	 * default. `--plan` and `--minimal` are independent flags rather than one
	 * `--mode <name>`: `--mode` is the CLI's output mode (see the flag comment).
	 * A session that runs `--plan` never opens /plan's exit confirmation — the
	 * user asked for a mode, not for a turn — and minimal's restore point is the
	 * full tool set, since the session never ran with anything else.
	 */
	function requestedMode(): { mode: RunMode; reason: string } | undefined {
		if (nanopi.getFlag("plan") === true) return { mode: "plan", reason: "--plan" };
		if (nanopi.getFlag("minimal") === true && !minimalModeNarrowsNothing()) {
			return { mode: "minimal", reason: "--minimal" };
		}
		return undefined;
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

	/** The switch a slash command is talking about. */
	function guardStateOf(key: GuardKey): GuardSwitchState {
		return key === "gitGuard" ? gitGuardState : shellGuardState;
	}

	/** The session copy, falling back to the files while no session has started. */
	function guardStateFor(key: GuardKey, cwd: string): GuardSwitchState {
		return guardStateOf(key).read ? guardStateOf(key) : readGuardState(cwd, key);
	}

	function setGuardState(key: GuardKey, state: GuardSwitchState): void {
		if (key === "gitGuard") gitGuardState = state;
		else shellGuardState = state;
	}

	function guardOnOf(key: GuardKey): boolean {
		const state = guardStateOf(key);
		return state.session ?? state.value;
	}

	/**
	 * `/gitguard on|off [global|project|session]`.
	 *
	 * A bare call is a snapshot, never a switch: turning a safety guard off has to
	 * be typed out with its scope. The scope decides which file is written, and
	 * omitting it writes the layer the switch is already reading, which is the
	 * layer the bare output just named.
	 */
	function guardCommand(key: GuardKey, title: string, description: string): void {
		const name = key === "gitGuard" ? "gitguard" : "shellguard";
		const usage = `Usage: /${name} [on|off] [global|project|session]`;
		nanopi.registerCommand(name, {
			description,
			getArgumentCompletions: (prefix) =>
				["on", "off", "global", "project", "session"]
					.filter((value) => value.startsWith(prefix))
					.map((value) => ({
						value,
						label: value,
						description: isGuardScope(value) ? GUARD_SCOPE_HINTS[value] : undefined,
					})),
			handler: async (args, ctx) => {
				const words = args
					.trim()
					.toLowerCase()
					.split(/\s+/)
					.filter((word) => word !== "");
				if (words.length === 0) {
					ctx.ui.notify(`${title}: ${describeGuard(guardStateFor(key, ctx.cwd))}`, "info");
					return;
				}
				const [requested, scope, ...rest] = words;
				if ((requested !== "on" && requested !== "off") || scope === "" || rest.length > 0) {
					ctx.ui.notify(usage, "error");
					return;
				}
				if (scope !== undefined && !isGuardScope(scope)) {
					ctx.ui.notify(usage, "error");
					return;
				}
				changeGuard(key, ctx, requested === "on", scope);
			},
		});
	}

	/**
	 * Apply one `/xxx on|off [scope]`.
	 *
	 * `session` never reaches the disk: memory only, and it outlives an extension
	 * reload (see `session_start`). `global`/`project` write that file and make it
	 * the value in effect, which is why the notice below reports the source it
	 * just wrote.
	 */
	function changeGuard(key: GuardKey, ctx: ExtraExtensionContext, on: boolean, scope: GuardScope | undefined): void {
		const title = key === "gitGuard" ? "Git guard" : "Shell guard";
		// Read the files again rather than the session copy: the session copy can
		// already be an answer to a question, and an unsaved answer must not decide
		// which file an explicit write lands in.
		const current = readGuardState(ctx.cwd, key);
		if (scope === "session") {
			setGuardState(key, { ...current, session: on });
			ctx.ui.notify(`${title}: ${describeGuard(guardStateOf(key))}`, "info");
			return;
		}
		const layer: SettingsLayer = scope ?? guardLayerOf(current);
		saveExtraSettings({ [key]: on }, layer, ctx.cwd);
		const written = readGuardState(ctx.cwd, key);
		setGuardState(key, written);
		// The notice reports the value in effect right now. An answer this session
		// already gave stays in front of it, but the write is not hidden: the
		// layer it went to is named either way.
		ctx.ui.notify(`${title}: ${describeGuard(written)}`, "info");
	}

	/**
	 * The layer `/xxx off` writes when no scope is typed: the one already in
	 * effect, so what the bare output just said is what the write replaces.
	 *
	 * With nothing saved anywhere, that layer is `global` — the default is not a
	 * project setting, and inventing one would make a bare `/gitguard off` in a
	 * fresh directory write a file the user never asked for.
	 */
	function guardLayerOf(state: GuardSwitchState): SettingsLayer {
		return state.source === "project" ? "project" : "global";
	}

	// --- CLI commands: /gitguard, /shellguard [on|off] [global|project|session] ---
	guardCommand(
		"gitGuard",
		"Git guard",
		"Show the destructive git guard, or set it: on | off [global|project|session]",
	);
	guardCommand(
		"shellGuard",
		"Shell guard",
		"Show the file-inspection guard, or set it: on | off [global|project|session]",
	);

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
				const requested = requestedMode();
				if (requested) engine.setMode(requested.mode, requested.reason);
				else engine.setMode(settings.defaultMode, "session default");
			}
			// The planning counters belong to the plan run, not to the process: a
			// resumed session starts its exit prompt fresh rather than inheriting the
			// prompt budget of the run that was resumed.
			questionTurns = 0;
			planIntroActive = false;
			applyModeToolSet();
			// Persisted subsystem switches apply to fresh sessions too, not just
			// when toggled live from the webui settings page.
			for (const key of SUBSYSTEM_KEYS) {
				if (settings.subsystems[key] === false) applySubsystem(key, false);
			}
		}
		// Rebuilt on every start so a reloaded settings file (and /sandbox) applies.
		applySandbox(ctx.cwd);
		// A reload keeps what this session already answered: the question below is
		// about the files, and re-asking on every extension reload would turn a
		// one-time confirmation into a nag. A fresh session re-reads both layers.
		const previousGit = gitGuardState.session === undefined ? undefined : gitGuardState;
		const previousShell = shellGuardState.session === undefined ? undefined : shellGuardState;
		gitGuardState = previousGit ?? readGuardState(ctx.cwd, "gitGuard");
		shellGuardState = previousShell ?? readGuardState(ctx.cwd, "shellGuard");
		if (event.reason !== "reload") {
			// The question is asked here rather than at the point of use: it is about
			// the files this session starts from, and a guard that opens off without
			// anyone choosing it is the defect. Both switches are asked together so a
			// project file carrying both gets one round trip, not two dialogs.
			void (async () => {
				for (const key of ["gitGuard", "shellGuard"] as const) {
					const state = await confirmGuardDowngrade(ctx, key, ctx.cwd);
					if (state) setGuardState(key, state);
				}
			})();
		}
		// Fresh permission memory per session.
		//
		// A session with no prompt cannot answer one, so the fake prompter below
		// used to settle every gated call as dismissed: print mode, `--output json`
		// and every subagent (its own `-p` child) could not edit or write a single
		// file. `gated` carries that fact to the tool_call handler, which is where
		// the decision belongs; the gate keeps prompting an interactive session.
		gated = ctx.mode === "webui" || ctx.hasUI;
		const prompter: PermissionPrompter | undefined =
			ctx.mode === "webui"
				? makeWebuiPrompter((info) => explainCall(info, nanopi))
				: ctx.hasUI
					? makeDialogPrompter(ctx)
					: undefined;
		// The pause needs a second prompt to settle it: without one the gate would
		// re-ask with the same dialog, and Explain would never resolve.
		const explanationPrompter: PermissionExplanationPrompter | undefined =
			ctx.mode === "webui"
				? extraBridge.permissions.explanationPrompter
				: ctx.hasUI
					? makeDialogExplanationPrompter(ctx)
					: undefined;
		const judge = (info: PermissionCallInfo) =>
			judgeWithModel(info, ctx.model, ctx.modelRegistry as unknown as JudgeModelRegistry, { cwd: ctx.cwd });
		gate = new PermissionGate(
			prompter ?? (async () => undefined),
			judge,
			explanationPrompter,
			// The pause is the gate's own state; starting the explanation turn is the
			// extension's, so the callback is handed over rather than the API.
			(info) => explainCall(info, nanopi),
		);
		if (ctx.mode === "tui") {
			applyModeStatus();
		}
		extraBridge.bindSession(
			{
				subsystemStatus: () => subsystemStatus(),
				applySubsystem: (key, enabled) => applySubsystem(key, enabled),
				applyModeToolSet: () => applyModeToolSet(),
				leaveMinimalMode: (reason) => leaveMinimalMode(reason),
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
		// The composer was emptied by the send, so a `shell` label left over from
		// `!cmd` would keep claiming shell mode: this is the refresh point for a
		// status that only the footer's own polling would otherwise correct.
		applyModeStatus();
		if (!planIntroActive || engine.mode !== "plan") return;
		planIntroActive = false;
		// A turn that ends in a question is not a finished plan. The user was asked
		// something the repository could not answer, so the next turn continues the
		// same planning run and the exit prompt waits for the plan itself. The
		// counter is the loop breaker: a plan-mode turn that ends in another
		// question each time would otherwise hold the exit prompt forever.
		if (questionTurns < MAX_QUESTION_TURNS && lastTurnAskedUser(event.messages ?? [])) {
			questionTurns += 1;
			planIntroActive = true;
			return;
		}
		questionTurns = 0;
		const ctx = sessionCtx;
		if (!ctx?.hasUI) return;
		void (async () => {
			// Naming the alternative is what makes the second answer usable: a plan
			// that is close but wrong is the common case, and "keep planning" used to
			// drop the user back into a mode with no sentence to type.
			const choice = await ctx.ui.select("Plan ready. Execute it, or keep refining?", [
				"Exit plan mode and execute",
				"Keep planning (type what to change)",
			]);
			if (choice === "Exit plan mode and execute") {
				engine.setMode("standard", "plan approved");
				nanopi.sendUserMessage(PLAN_APPROVED_MESSAGE);
			} else {
				ctx.ui.notify(
					"Still in plan mode (read-only). Type what to change and the next turn revises the plan.",
					"info",
				);
			}
		})();
	});

	// --- System prompt injection (only while active) ---
	nanopi.on("before_agent_start", (event) => {
		if (initMd !== undefined && event.systemPromptOptions.customPrompt === undefined) {
			event.systemPromptOptions.customPrompt = initMd;
		}
		const guidelines = event.systemPromptOptions.promptGuidelines ?? [];
		// The mode paragraph is a section of its own rather than one more bullet: a
		// three-phase instruction set is prose, and a session that leaves plan mode
		// drops one section instead of rewriting every rule in the prompt.
		const sections = event.systemPromptOptions.guidelineSections ?? [];
		if (engine.mode === "plan") sections.push(PLAN_GUIDELINE);
		else if (engine.mode === "minimal") guidelines.push(MINIMAL_GUIDELINE);
		event.systemPromptOptions.guidelineSections = sections;
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
		if (guardOnOf("shellGuard") && SHELL_TOOL_NAMES.has(event.toolName)) {
			const refusal = shellGuardHazard(event, sessionCtx?.cwd ?? process.cwd(), nanopi.getActiveTools());
			if (refusal !== undefined) return { block: true, reason: refusal };
		}

		const sandboxNote = sandboxConfig ? describeSandboxCall(sandboxConfig, event.toolName) : undefined;
		if (engine.yolo || gate === undefined || !gated || !GATED_TOOL_NAMES.has(event.toolName)) {
			if (sandboxNote) sessionCtx?.ui.notify(sandboxNote, "info");
			return undefined;
		}
		const { summary, firstCommand } = summarizeCall(event);
		const hazard =
			guardOnOf("gitGuard") && SHELL_TOOL_NAMES.has(event.toolName)
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
