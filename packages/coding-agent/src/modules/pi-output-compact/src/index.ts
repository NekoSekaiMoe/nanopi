/**
 * pi-output-compact — loss-aware compaction of bash/read/grep tool outputs.
 *
 * Only the output-compaction half of pi-rtk-optimizer is ported: no `rtk`
 * binary, command rewriting, or TUI. It is off by default because the
 * techniques are lossy; enable `outputCompaction.enabled` in
 * `<agentDir>/output-compaction.json` when context pressure matters more than
 * verbatim output. Existing `tool-result-store` recall stays unchanged.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { BeforeAgentStartEvent, ModuleApi } from "../../../core/modules/types.ts";
import { compactToolResult } from "./output-compactor.ts";
import { getOutputMetricsSummary } from "./output-metrics.ts";
import { DEFAULT_RTK_INTEGRATION_CONFIG, type RtkIntegrationConfig } from "./types.ts";

const GUIDANCE = [
	"Tool output may be compacted to save context: build/test/lint/git noise and long grep/read output can be shortened.",
	"Compacted output is lossy. Re-run a narrower command or read the file range directly when exact text matters.",
].join(" ");

function configPath(): string {
	const agentDir = process.env.NANOPI_AGENT_DIR || path.join(process.env.HOME ?? "", ".nanopi", "agent");
	return path.join(agentDir, "output-compaction.json");
}

function loadConfig(): RtkIntegrationConfig {
	const base = DEFAULT_RTK_INTEGRATION_CONFIG;
	const p = configPath();
	if (!existsSync(p)) return { ...base, outputCompaction: { ...base.outputCompaction, enabled: false } };
	try {
		const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
		if (!raw || typeof raw !== "object") return base;
		const record = raw as Record<string, unknown>;
		const compaction = record.outputCompaction;
		if (!compaction || typeof compaction !== "object") return base;
		const c = compaction as Record<string, unknown>;
		return {
			...base,
			outputCompaction: {
				...base.outputCompaction,
				...c,
				enabled: c.enabled === true,
			} as RtkIntegrationConfig["outputCompaction"],
		};
	} catch {
		return base;
	}
}

export default function outputCompact(pi: ModuleApi): void {
	const config = loadConfig();
	if (config.outputCompaction.enabled) {
		let ready = false;
		pi.on("session_start", async () => {
			ready = true;
		});
		pi.on("tool_result", async (event) => {
			if (!ready || event.parentToolCallId) return;
			if (!["bash", "read", "grep"].includes(event.toolName)) return;
			const outcome = compactToolResult(
				{ toolName: event.toolName, input: event.input, isError: event.isError, content: event.content },
				config,
			);
			if (!outcome.changed || !outcome.content) return;
			return {
				content: outcome.content as typeof event.content,
				structuredContent: undefined,
			};
		});
	}
	pi.on("before_agent_start", async (event: BeforeAgentStartEvent) => ({
		systemPrompt: [event.systemPrompt, GUIDANCE].filter(Boolean).join("\n\n"),
	}));
	pi.registerCommand("output-compaction", {
		description: "Show whether output compaction is on and how many characters it saved.",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				`output compaction: ${config.outputCompaction.enabled ? "on" : "off"}\n${getOutputMetricsSummary()}`,
				"info",
			);
		},
	});
}

export { compactToolResult, getOutputMetricsSummary };
