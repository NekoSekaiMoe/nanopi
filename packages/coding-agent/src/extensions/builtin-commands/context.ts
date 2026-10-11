/**
 * Built-in `/context` command: interactive context-window inspector.
 *
 * Ported from github.com/minuque/pi-cc-extensions (extensions/feature/context.ts,
 * MIT) via pi-extra-cmd.
 *
 *   /context   opens a bottom-docked dialog showing the distribution of the
 *              context window (System prompt, Memory, Skills, Tools definition,
 *              Tool results, Context, Other, Free) with a usage bar, per-part
 *              token/percent rows and Enter-driven previews of the underlying
 *              content.
 *
 * The headline number is reconciled from `ctx.getContextUsage()` (the same
 * value the footer shows) and the chars/4 estimate of what the next LLM call
 * would actually carry; part totals are capped proportionally into the used
 * total so the rows always add up (fixed parts stay stable).
 *
 * In non-TUI modes a plain text summary is emitted via `ctx.ui.notify`.
 */

import {
	type BuildSystemPromptOptions,
	type ExtensionAPI,
	type ExtensionCommandContext,
	estimateTokens,
	formatSkillsForPrompt,
	type ToolInfo,
} from "@nanopi/pi-coding-agent";
import { type ContextPart, type ContextPreview, showContextDialog } from "./context-dialog.ts";

const tokenEstimate = (value: unknown): number => {
	if (!value) return 0;
	const text = typeof value === "string" ? value : JSON.stringify(value);
	return Math.max(0, Math.ceil(text.length / 4));
};

/** Only count chunks that are actually embedded in the system prompt. */
function embeddedTokens(prompt: string, chunk: string): number {
	if (!chunk || !prompt.includes(chunk)) return 0;
	return tokenEstimate(chunk);
}

export function formatTokens(tokens: number): string {
	if (tokens < 1_000) return String(tokens);
	if (tokens < 100_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return `${Math.round(tokens / 1_000)}k`;
}

/**
 * Rescale the variable parts so their sum matches `target` (provider-reported
 * usage). Parts before `fixedPrefix` keep their exact estimates — system
 * prompt, memory, skills and tools definition are stable per request.
 */
export function capParts(parts: ContextPart[], target: number, fixedPrefix = 0): ContextPart[] {
	const fixed = parts.slice(0, fixedPrefix);
	const variable = parts.slice(fixedPrefix);
	const fixedTokens = fixed.reduce((sum, part) => sum + part.tokens, 0);
	const variableTarget = Math.max(0, target - fixedTokens);
	const estimated = variable.reduce((sum, part) => sum + part.tokens, 0);
	if (estimated <= variableTarget || estimated === 0) return parts;
	if (variableTarget === 0) {
		return [...fixed, ...variable.map((part) => ({ ...part, tokens: 0 }))];
	}

	let previous = 0;
	let cumulative = 0;
	const capped = variable.map((part, index) => {
		cumulative += part.tokens;
		const next =
			index === variable.length - 1 ? variableTarget : Math.round((cumulative / estimated) * variableTarget);
		const tokens = next - previous;
		previous = next;
		return { ...part, tokens };
	});
	return [...fixed, ...capped];
}

/** Pick the most plausible used-token number among reported / percent-derived / estimated. */
export function resolveUsedTokens(
	usage: { tokens: number | null; percent: number | null } | undefined,
	estimated: number,
	contextWindow: number,
): number {
	const reported = usage?.tokens;
	const fromPercent =
		usage?.percent !== null && usage?.percent !== undefined && contextWindow > 0
			? Math.round((usage.percent / 100) * contextWindow)
			: undefined;
	let resolved = reported ?? fromPercent ?? estimated;
	if (reported !== null && reported !== undefined && fromPercent !== undefined) {
		// Some providers report a broken totalTokens; when it disagrees with the
		// footer percentage, trust the percentage.
		const tolerance = Math.max(32, Math.round(contextWindow * 0.001));
		if (Math.abs(reported - fromPercent) > tolerance) resolved = fromPercent;
	}
	// tokens and percent can both come from a broken usage; fall back to the
	// content estimate when the number is implausibly small.
	if (estimated > 0 && resolved < estimated * 0.25) return estimated;
	return resolved;
}

type ContextBreakdown = {
	parts: ContextPart[];
	previews: Record<"systemPrompt" | "memoryFiles" | "skills" | "tools" | "toolResults" | "contextFiles", string>;
};

function previewValue(value: unknown): string {
	if (typeof value === "string") return value;
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** Assemble counts and previews from the real request's systemPrompt/tools/messages. */
export function collectContextBreakdown(ctx: ExtensionCommandContext, allTools: ToolInfo[]): ContextBreakdown {
	const options = (ctx.getSystemPromptOptions?.() ?? {}) as BuildSystemPromptOptions;
	const systemPrompt = typeof ctx.getSystemPrompt === "function" ? ctx.getSystemPrompt() : "";
	const selectedTools = new Set(options.selectedTools ?? ["read", "bash", "edit", "write"]);
	const toolDefinitionPreview: string[] = [];
	const toolResultPreview: string[] = [];
	const contextPreview: string[] = [];
	let toolDefinitionTokens = 0;
	let toolResultTokens = 0;
	let contextTokens = 0;

	const memoryPreview: string[] = [];
	let memoryTokens = 0;
	for (const file of options.contextFiles ?? []) {
		memoryTokens += embeddedTokens(systemPrompt, file.content);
		memoryPreview.push(`## ${file.path}\n\n${previewValue(file.content)}`);
	}

	const skillsText = formatSkillsForPrompt(options.skills ?? []).trim();
	const skillsTokens = embeddedTokens(systemPrompt, skillsText);

	for (const tool of allTools) {
		if (!selectedTools.has(tool.name)) continue;
		const definition = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
		};
		toolDefinitionTokens += tokenEstimate(definition);
		toolDefinitionPreview.push(`## Definition: ${tool.name}\n\n${previewValue(definition)}`);
	}

	for (const entry of ctx.sessionManager.buildContextEntries()) {
		if (entry.type === "message") {
			const message = entry.message;
			if (message.role === "assistant") {
				for (const block of message.content) {
					if (block.type === "toolCall") {
						contextTokens += tokenEstimate(block.name) + tokenEstimate(block.arguments);
						contextPreview.push(`## Assistant tool call: ${block.name}\n\n${previewValue(block.arguments)}`);
					} else if (block.type === "text") {
						contextTokens += tokenEstimate(block.text);
						contextPreview.push(`## Assistant\n\n${block.text}`);
					} else if (block.type === "thinking") {
						contextTokens += tokenEstimate(block.thinking);
						contextPreview.push(`## Assistant thinking\n\n${block.thinking}`);
					}
				}
			} else if (message.role === "toolResult") {
				toolResultTokens += estimateTokens(message);
				toolResultPreview.push(`## Result: ${message.toolName}\n\n${previewValue(message.content)}`);
			} else if (message.role === "bashExecution") {
				toolResultTokens += estimateTokens(message);
				toolResultPreview.push(
					`## Bash\n\nCommand:\n\n${previewValue(message.command)}\n\nOutput:\n\n${previewValue(message.output)}`,
				);
			} else if (message.role === "branchSummary" || message.role === "compactionSummary") {
				contextTokens += estimateTokens(message);
				contextPreview.push(`## ${message.role}\n\n${message.summary}`);
			} else {
				contextTokens += estimateTokens(message);
				contextPreview.push(`## ${message.role}\n\n${previewValue(message.content)}`);
			}
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			contextTokens += tokenEstimate(entry.summary);
			contextPreview.push(`## ${entry.type === "compaction" ? "Compaction" : "Branch summary"}\n\n${entry.summary}`);
		} else if (entry.type === "custom_message") {
			contextTokens += tokenEstimate(entry.content);
			contextPreview.push(`## Custom: ${entry.customType}\n\n${previewValue(entry.content)}`);
		}
	}

	const systemTokens = Math.max(0, tokenEstimate(systemPrompt) - memoryTokens - skillsTokens);
	return {
		parts: [
			{ label: "System prompt", tokens: systemTokens, color: "accent" },
			{ label: "Memory", tokens: memoryTokens, color: "error" },
			{ label: "Skills", tokens: skillsTokens, color: "warning" },
			{ label: "Tools definition", tokens: toolDefinitionTokens, color: "success" },
			{ label: "Tool results", tokens: toolResultTokens, color: "customMessageLabel" },
			{ label: "Context", tokens: contextTokens, color: "warning" },
		] satisfies ContextPart[],
		previews: {
			systemPrompt: systemPrompt || "No system prompt.",
			memoryFiles: memoryPreview.join("\n\n") || "No memory files in context.",
			skills: skillsText || "No skills in context.",
			tools: toolDefinitionPreview.join("\n\n") || "No active tool definitions.",
			toolResults: toolResultPreview.join("\n\n") || "No tool results in the current context.",
			contextFiles: contextPreview.join("\n\n") || "No conversation context.",
		},
	};
}

export function registerContext(pi: ExtensionAPI) {
	pi.registerCommand("context", {
		description: "Show the current context-window distribution",
		handler: async (_args, ctx) => {
			const usage = ctx.getContextUsage();
			const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
			const tools = pi.getAllTools();
			const breakdown = collectContextBreakdown(ctx, tools);
			const estimated = breakdown.parts.reduce((sum, part) => sum + part.tokens, 0);
			// System / Memory / Skills / Tools definition are fixed parts; keep
			// their estimates stable when capping into the used total.
			const fixedTokens = breakdown.parts.slice(0, 4).reduce((sum, part) => sum + part.tokens, 0);
			const used = Math.max(resolveUsedTokens(usage, estimated, contextWindow), fixedTokens);
			const parts = capParts(breakdown.parts, used, 4);
			const attributed = parts.reduce((sum, part) => sum + part.tokens, 0);
			const other = Math.max(0, used - attributed);
			const free = Math.max(0, contextWindow - used);
			const allParts: ContextPart[] = [
				...parts,
				{ label: "Other", tokens: other, color: "muted" },
				{ label: "Free space", tokens: free, color: "dim" },
			];

			if (ctx.mode !== "tui" || !ctx.hasUI) {
				const lines = allParts.map((part) => `${part.label}: ${formatTokens(part.tokens)} tokens`);
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const previews: ContextPreview[] = [
				{
					key: "systemPrompt",
					label: "System prompt",
					title: "System Prompt",
					content: breakdown.previews.systemPrompt,
				},
				{ key: "memoryFiles", label: "Memory", title: "Memory Files", content: breakdown.previews.memoryFiles },
				{ key: "skills", label: "Skills", title: "Skills", content: breakdown.previews.skills },
				{ key: "tools", label: "Tools definition", title: "Tools definition", content: breakdown.previews.tools },
				{
					key: "toolResults",
					label: "Tool results",
					title: "Tool Results",
					content: breakdown.previews.toolResults,
				},
				{ key: "contextFiles", label: "Context", title: "Context", content: breakdown.previews.contextFiles },
			].filter((preview) => allParts.some((part) => part.label === preview.label));

			await showContextDialog(ctx, { used, contextWindow, parts: allParts, previews });
		},
	});
}
