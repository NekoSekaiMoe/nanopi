import { afterEach, describe, expect, test, vi } from "vitest";
import { estimateTextTokens } from "../../ai/src/utils/estimate.ts";

/**
 * Prompt budget of the two SKUs, measured the way a request carries it: the
 * system prompt plus the declaration JSON of every tool the run declares
 * (`name`, `description`, `parameters`). Counting the prompt alone misses the
 * larger half — the standard tool set costs more than twice what the prompt
 * with it costs. Tokens come from `estimateTextTokens`, the same
 * 3.5-characters-per-token estimate the context meter uses.
 *
 * Each SKU's components are injected as the defines its buildconfig.json flavor
 * injects, then the module is re-imported so the component reads see them.
 *
 * The pinned numbers are the reading of the day, not an aspiration: a budget
 * test that starts red says nothing about the change under review. The gap
 * to the target is recorded here so the next change either closes it or is
 * measured against a number someone chose on purpose.
 */

const CWD = "/home/user/project";
/** Estimated tokens (prompt + declarations) each SKU is aiming at. */
const TARGET = { minimal: 300, base: 900 } as const;
/** Estimated tokens each SKU spends today, pinned so a change has to be paid for. */
const PINNED = { minimal: 405, base: 1540 } as const;

interface Sku {
	defines: Record<string, unknown>;
	/** Names the flavor's tool set lists, or undefined for every built-in tool. */
	toolNames: string[] | undefined;
}

const STANDARD_TOOLS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];

const SKUS: Record<keyof typeof TARGET, Sku> = {
	// `minimal`: toolset "bash", no docs and no examples tree.
	minimal: {
		defines: {
			NANOPI_BUILD_TOOLSET: "bash",
			NANOPI_BUILD_TOOLS: ["bash", "powershell"],
			NANOPI_BUILD_COMPONENTS: { docs: false, examples: false },
		},
		toolNames: ["bash", "powershell"],
	},
	// `base`: the standard tool set, no docs and no examples tree.
	base: {
		defines: {
			NANOPI_BUILD_TOOLSET: "standard",
			NANOPI_BUILD_TOOLS: STANDARD_TOOLS,
			NANOPI_BUILD_COMPONENTS: { docs: false, examples: false },
		},
		toolNames: STANDARD_TOOLS,
	},
};

interface ToolDeclaration {
	description: string;
	parameters: unknown;
	promptSnippet?: string;
	promptGuidelines?: string[];
}

interface Measurement {
	prompt: number;
	declarations: number;
	total: number;
	byTool: Record<string, number>;
}

/**
 * Measure one SKU. `declared` narrows the tools the run declares below what the
 * build registers, which is what a session with a `--tools` list sends.
 */
async function measure(sku: Sku, declaredOverride?: string[]): Promise<Measurement> {
	vi.resetModules();
	for (const [name, value] of Object.entries(sku.defines)) vi.stubGlobal(name, value);
	const { buildSystemPrompt } = await import("../src/core/system-prompt.ts");
	const { createAllToolDefinitions } = await import("../src/core/tools/index.ts");

	const definitions = createAllToolDefinitions(CWD) as Record<string, ToolDeclaration>;
	const registered = Object.keys(definitions);
	const declared = (declaredOverride ?? sku.toolNames ?? registered).filter((name) => name in definitions);
	// The prompt's tool list and guidelines come from the active definitions,
	// which `agent-session` collects before it builds the prompt.
	const toolSnippets: Record<string, string> = {};
	const toolGuidelines: Record<string, string[]> = {};
	for (const name of declared) {
		const definition = definitions[name];
		if (definition.promptSnippet) toolSnippets[name] = definition.promptSnippet;
		if (definition.promptGuidelines) toolGuidelines[name] = definition.promptGuidelines;
	}

	const prompt = buildSystemPrompt({ cwd: CWD, selectedTools: declared, toolSnippets, toolGuidelines });
	const declarationTokens = declared.map((name) => ({
		name,
		tokens: estimateTextTokens(
			JSON.stringify({
				name,
				description: definitions[name].description,
				parameters: definitions[name].parameters,
			}),
		),
	}));
	const promptTokens = estimateTextTokens(prompt);
	const declarations = declarationTokens.reduce((sum, entry) => sum + entry.tokens, 0);
	return {
		prompt: promptTokens,
		declarations,
		total: promptTokens + declarations,
		byTool: Object.fromEntries(declarationTokens.map((entry) => [entry.name, entry.tokens])),
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("SKU prompt budget", () => {
	test("minimal is pinned to its current cost", async () => {
		const measurement = await measure(SKUS.minimal);
		expect(measurement.total).toBe(PINNED.minimal);
		expect(measurement.total).toBeGreaterThan(TARGET.minimal);
	});

	test("base is pinned to its current cost", async () => {
		const measurement = await measure(SKUS.base);
		expect(measurement.total).toBe(PINNED.base);
		expect(measurement.total).toBeGreaterThan(TARGET.base);
	});

	// The standard tool set minus the read-only extras is the shape a trimmed
	// run sends, and it is already inside the base target.
	test("base with the four core tools is inside its target", async () => {
		const measurement = await measure(SKUS.base, ["read", "bash", "edit", "write"]);
		expect(measurement.total).toBeLessThanOrEqual(TARGET.base);
	});

	// A pin that moves has to say what moved. The failure message already carries
	// the total; the per-tool split is what names the declaration behind it.
	test("breaks the declaration cost down per tool", async () => {
		const measurement = await measure(SKUS.minimal);
		expect(measurement.byTool).toEqual({ bash: 109, powershell: 112 });
	});
});
