/**
 * Built-in tool batching module.
 *
 * One model tool call can run several already-callable tools through
 * `ctx.executeTool()`, so N tool round trips become one: the model sends one
 * prompt with one tool declaration instead of N prompts each carrying the full
 * conversation and tool schemas. There is no script runtime or new execution
 * engine here; the batch is a fixed list of tool/arguments pairs and each call
 * goes through the same agent tool pipeline as a model-issued call.
 *
 * The module and its tool are hidden from the model's declaration: the tool is
 * a capability of this module, not something the model needs to see as a
 * separate schema on every request. `prepareLoadout` puts the current callable
 * tool names in its description, so the model knows what it can batch without
 * a second discovery round trip.
 */

import type { AgentToolCallOutcome } from "@nanopi/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ModuleToolContext, ModuleToolsSurface, ToolDefinition, ToolLoadout } from "../../core/modules/types.ts";

const MAX_CALLS = 32;
const MAX_ERROR_CHARS = 500;

const callSchema = Type.Object({
	name: Type.String({ description: "Tool name, exactly as declared to the model." }),
	arguments: Type.Record(Type.String(), Type.Unknown(), {
		description: "Arguments object, passed to the tool unchanged. Defaults to {}.",
	}),
});

const BatchParams = Type.Object({
	calls: Type.Array(callSchema, {
		minItems: 1,
		maxItems: MAX_CALLS,
		description: `Tools to run in order, at most ${MAX_CALLS}.`,
	}),
	parallel: Type.Optional(
		Type.Boolean({ description: "Run independent calls concurrently. Default: false (in order)." }),
	),
});

type BatchParams = Static<typeof BatchParams>;

function textOf(outcome: AgentToolCallOutcome): string {
	const text = (outcome.result.content ?? [])
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	return outcome.isError && text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}…` : text;
}

function formatResult(index: number, call: { name: string }, outcome: AgentToolCallOutcome): string {
	const status = outcome.isError ? "error" : "ok";
	return `[${index}] ${call.name}: ${status}\n${textOf(outcome)}`;
}

function notCallable(name: string, args: Record<string, unknown>): AgentToolCallOutcome {
	// Argument values are JSON from the model; TypeBox models them as unknown.
	const jsonArgs = args as AgentToolCallOutcome["toolCall"]["arguments"];
	return {
		toolCall: { type: "toolCall", id: "batch", name, arguments: jsonArgs },
		result: {
			content: [{ type: "text" as const, text: `Tool "${name}" is not callable.` }],
			details: {},
			isError: true,
		},
		isError: true,
	};
}

export function registerBatchTool(pi: ModuleToolsSurface): void {
	const tool: ToolDefinition<typeof BatchParams> = {
		name: "execute_many",
		label: "Execute many tools",
		description:
			"Run multiple already-available tools in one turn and return all their results, saving the prompt cost of separate tool round trips. Each call goes through the same validation, hooks, and permission checks as a direct tool call.",
		exposure: "hidden",
		parameters: BatchParams,
		annotations: { readOnlyHint: false },
		prepareLoadout(loadout: ToolLoadout) {
			const names = loadout.callable.map((item) => item.name);
			return {
				descriptions: {
					execute_many: `${tool.description}\n\nCallable tools: ${names.length > 0 ? names.join(", ") : "none"}.`,
				},
			};
		},
		async execute(_toolCallId, params: BatchParams, signal, _onUpdate, ctx: ModuleToolContext) {
			const calls = params.calls.map((call) => ({ name: call.name, arguments: call.arguments ?? {} }));
			const known = new Set(ctx.tools.map((item) => item.name));
			const outcomes: AgentToolCallOutcome[] = [];

			if (params.parallel) {
				outcomes.push(
					...(await Promise.all(
						calls.map((call) =>
							known.has(call.name)
								? ctx.executeTool(call.name, call.arguments, { signal })
								: Promise.resolve(notCallable(call.name, call.arguments)),
						),
					)),
				);
			} else {
				for (const call of calls) {
					if (signal?.aborted) throw new Error("Batch aborted.");
					if (!known.has(call.name)) {
						outcomes.push(notCallable(call.name, call.arguments));
						continue;
					}
					outcomes.push(await ctx.executeTool(call.name, call.arguments, { signal }));
				}
			}

			return {
				content: [
					{ type: "text" as const, text: calls.map((call, i) => formatResult(i, call, outcomes[i])).join("\n\n") },
				],
				details: { results: calls.map((call, i) => ({ name: call.name, isError: outcomes[i].isError })) },
			};
		},
	};
	pi.registerTool(tool);
}

export default function batchExtension(pi: ModuleToolsSurface): void {
	registerBatchTool(pi);
}
