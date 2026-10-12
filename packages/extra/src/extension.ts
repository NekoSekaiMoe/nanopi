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
import { extraBridge } from "./bridge.ts";
import { resolveEnvProvider, resolveInitMd } from "./env-config.ts";
import type {
	ExtraExtensionAPI,
	ExtraExtensionContext,
	ExtraInlineExtension,
	ExtraProjectTrustResult,
	ExtraToolCallEvent,
	ExtraToolCallResult,
} from "./extension-api.ts";
import { createBadgeFooter } from "./footer.ts";
import { isMcpToolName, MCP_MAIN_AGENT_BLOCK_REASON, MCP_SUBAGENT_ONLY_GUIDELINE } from "./mcp-policy.ts";
import { modeEngine } from "./mode-engine.ts";
import type { PermissionCallInfo, PermissionDecision, PermissionPrompter } from "./permissions.ts";
import { PermissionGate } from "./permissions.ts";
import { analyzeCommandForPlan, firstShellWord } from "./plan-shell.ts";
import { loadExtraSettings } from "./settings-store.ts";
import { SUBSYSTEM_KEYS, type SubsystemKey, type SubsystemStatus } from "./types.ts";

const SHELL_TOOL_NAMES = new Set(["bash", "powershell"]);
/** Tools that prompt for permission when not in yolo or plan mode. */
const GATED_TOOL_NAMES = new Set(["edit", "write", "bash", "powershell"]);

const PLAN_GUIDELINE =
	"You are in PLAN MODE: exploration and planning only. Only the read tool and the ls, find, and pwd shell commands are available; every other call is blocked. Investigate, then produce a concrete step-by-step plan. Do not attempt modifications.";
const MINIMAL_GUIDELINE =
	"You are in MINIMAL MODE: only the shell (bash) tool is available. Accomplish the task through shell commands.";

const DECISION_LABELS: Array<{ label: string; decision: PermissionDecision }> = [
	{ label: "Allow once", decision: "allow" },
	{ label: "Allow this session", decision: "allow_session" },
	{ label: "Reject", decision: "deny" },
	{ label: "Let the AI decide", decision: "ai_decide" },
];

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

/** Ask over the TUI/RPC dialog primitives. */
function makeDialogPrompter(ctx: ExtraExtensionContext): PermissionPrompter {
	return async (info) => {
		const title = `Allow ${info.toolName}?\n${info.summary}`;
		const choice = await ctx.ui.select(
			title,
			DECISION_LABELS.map((entry) => entry.label),
		);
		return DECISION_LABELS.find((entry) => entry.label === choice)?.decision;
	};
}

export function createExtraExtension(nanopi: ExtraExtensionAPI): void {
	const engine = modeEngine;
	let sessionCtx: ExtraExtensionContext | undefined;
	let gate: PermissionGate | undefined;
	/** /plan runs settle into the exit-confirmation flow. */
	let planIntroActive = false;

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

	// --- CLI flag: --yolo ---
	nanopi.registerFlag("yolo", {
		type: "boolean",
		description: "Skip permission prompts and the folder-trust confirmation for this run",
	});

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

	// --- Session lifecycle ---
	nanopi.on("session_start", (event, ctx) => {
		sessionCtx = ctx;
		engine.setYolo(nanopi.getFlag("yolo") === true);
		if (event.reason !== "reload") {
			// New sessions pick up the configured default mode (webui switches
			// the engine explicitly and they survive until the next session).
			const settings = loadExtraSettings(ctx.cwd).settings;
			engine.setMode(settings.defaultMode, "session default");
			applyModeToolSet();
		}
		// Fresh permission memory per session.
		const prompter: PermissionPrompter | undefined =
			ctx.mode === "webui" ? extraBridge.permissions.prompter : ctx.hasUI ? makeDialogPrompter(ctx) : undefined;
		const judge = (info: PermissionCallInfo) =>
			judgeWithModel(info, ctx.model, ctx.modelRegistry as unknown as JudgeModelRegistry, { cwd: ctx.cwd });
		gate = new PermissionGate(prompter ?? (async () => undefined), judge);
		if (ctx.mode === "tui") {
			ctx.ui.setFooter(createBadgeFooter(ctx, engine));
		}
		extraBridge.bindSession(
			{
				subsystemStatus: () => subsystemStatus(),
				applySubsystem: (key, enabled) => applySubsystem(key, enabled),
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
		planIntroActive = false;
	});

	// --- /plan exit confirmation ---
	nanopi.on("agent_settled", () => {
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
		const mcpEnabled = (loadExtraSettings(process.cwd()).settings.subsystems.mcp ?? true) && all.some(isMcpToolName);
		if (mcpEnabled && all.includes("subagent")) {
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
			if (event.toolName === "read") return undefined;
			if (event.toolName === "bash" || event.toolName === "powershell") {
				const input = event.input as Record<string, unknown>;
				const command = typeof input.command === "string" ? input.command : "";
				const analysis = analyzeCommandForPlan(command);
				if (analysis.allowed) return undefined;
				return { block: true, reason: analysis.reason ?? "command not allowed in plan mode" };
			}
			return {
				block: true,
				reason: `plan mode allows only the read tool and the ls, find, and pwd commands (blocked ${event.toolName})`,
			};
		}

		if (engine.mode === "minimal" && !SHELL_TOOL_NAMES.has(event.toolName)) {
			return { block: true, reason: `minimal mode provides only the shell tools (blocked ${event.toolName})` };
		}

		if (engine.yolo || gate === undefined || !GATED_TOOL_NAMES.has(event.toolName)) return undefined;
		const { summary, firstCommand } = summarizeCall(event);
		const outcome = await gate.check({
			callId: event.toolCallId,
			toolName: event.toolName,
			summary,
			args: event.input,
			firstCommand,
		});
		if (outcome.action === "deny") return { block: true, reason: outcome.reason };
		return undefined;
	});
}

/** The inline extension record the coding-agent registers. */
export const extraInlineExtension: ExtraInlineExtension = {
	name: "extra",
	factory: createExtraExtension,
	hidden: true,
};
