/**
 * One `web` tool: search and fetch through the failover engine chain.
 * Every branch returns evidence and names the source; nothing here invents
 * an answer.
 */

import { Text } from "@nanopi/pi-tui";
import type { Theme, ModuleToolContext, ModuleToolsSurface } from "@nanopi/pi-coding-agent";
import { type Static, Type } from "typebox";
import { getWebsearchConfigPath, loadWebsearchConfig } from "./config.ts";
import type { SearchAttempt, SearchItem } from "./engines.ts";
import { MAX_LIMIT, runFetch, runSearch } from "./search.ts";

const webParams = Type.Object({
	action: Type.Optional(
		Type.Union([Type.Literal("search"), Type.Literal("fetch")], {
			description: "search (default): ranked web results. fetch: one http(s) page as markdown.",
		}),
	),
	query: Type.Optional(Type.String({ description: 'search: what to look for, in plain words.' })),
	max_results: Type.Optional(
		Type.Number({ description: `search: result count (1-${MAX_LIMIT}, default 8).` }),
	),
	url: Type.Optional(Type.String({ description: "fetch: the http(s) URL to read." })),
});

export interface SearchDetails {
	action: "search" | "fetch";
	engine?: string;
	keyIndex?: number;
	attempts: SearchAttempt[];
	items: SearchItem[];
	uncertainty: string[];
}

export function renderSearchText(summary: string, items: SearchItem[], uncertainty: string[]): string {
	const lines = [summary];
	if (items.length > 0) {
		lines.push("");
		items.forEach((item, index) => {
			const dated = item.publishedAt ? ` (${item.publishedAt})` : "";
			lines.push(`${index + 1}. ${item.title || item.url}${dated}`, `   ${item.url}`);
			if (item.snippet) lines.push(`   ${item.snippet}`);
		});
	}
	if (uncertainty.length > 0) lines.push("", `Uncertain: ${uncertainty.join("; ")}`);
	return lines.join("\n");
}

/** One line naming the engine that answered; a fallback says which ones failed first. */
export function provenanceLine(engine: string, keyIndex: number | undefined, attempts: SearchAttempt[]): string {
	const key = keyIndex === undefined ? "" : ` key #${keyIndex}`;
	const failed = attempts.filter((attempt) => !attempt.ok);
	if (failed.length === 0) return `via ${engine}${key}`;
	return `via ${engine}${key} after ${failed.length} failed attempt(s)`;
}

function summarizeAttempts(attempts: SearchAttempt[]): string {
	return attempts
		.map((attempt) => {
			const key = attempt.keyIndex === undefined ? "" : ` key #${attempt.keyIndex}`;
			return `${attempt.engine}${key}: ${attempt.ok ? "ok" : (attempt.error ?? "failed")}`;
		})
		.join("\n");
}

function textResult(text: string, details: SearchDetails) {
	return { content: [{ type: "text" as const, text }], details };
}

function fail(
	action: SearchDetails["action"],
	message: string,
): { content: Array<{ type: "text"; text: string }>; details: SearchDetails } {
	return textResult(message, {
		action,
		attempts: [],
		items: [],
		uncertainty: [],
	});
}

function attemptsUsedFallback(attempts: SearchAttempt[]): boolean {
	const firstFailure = attempts.findIndex((attempt) => !attempt.ok);
	return firstFailure !== -1 && attempts.some((attempt) => attempt.ok);
}

function actionSummary(args: Static<typeof webParams>): string {
	switch (args.action) {
		case "fetch":
			return args.url ?? "";
		default:
			return args.query ?? "";
	}
}

export function registerWebTools(pi: ModuleToolsSurface): void {
	pi.registerTool({
		name: "web",
		label: "web",
		description:
			"Open-web research in one tool. action=search (default) or fetch. Search and fetch failover across engines. Cite the URLs you used.",
		promptSnippet: "Search the web or read a page",
		promptGuidelines: [
			"Use web action=search for current facts (releases, prices, news, API changes); read the returned items as evidence and cite the URL you used.",
			"Use action=fetch for a specific http(s) URL.",
		],
		annotations: { readOnlyHint: true, openWorldHint: true },
		parameters: webParams,

		async execute(_toolCallId, params: Static<typeof webParams>, signal, _onUpdate, ctx: ModuleToolContext) {
			const agentDir = ctx.getAgentDir();
			const action = params.action ?? "search";

			if (action === "search") {
				if (!params.query?.trim()) return fail(action, "web action=search needs a non-empty query");
				try {
					const outcome = await runSearch(params.query, {
						limit: params.max_results,
						config: loadWebsearchConfig(getWebsearchConfigPath(agentDir)),
						agentDir,
						signal,
					});
					const uncertainty: string[] = [];
					if (attemptsUsedFallback(outcome.attempts)) {
						uncertainty.push(`Answered by ${outcome.engine} after an earlier engine failed.`);
					}
					const summary =
						outcome.answer?.trim() ||
						(outcome.items.length > 0
							? `${outcome.items.length} result(s) for "${params.query}" (${provenanceLine(outcome.engine, outcome.keyIndex, outcome.attempts)}).`
							: `No results for "${params.query}" from ${outcome.engine}.`);
					return textResult(renderSearchText(summary, outcome.items, uncertainty), {
						action,
						engine: outcome.engine,
						keyIndex: outcome.keyIndex,
						attempts: outcome.attempts,
						items: outcome.items,
						uncertainty,
					});
				} catch (err) {
					return fail(action, err instanceof Error ? err.message : String(err));
				}
			}

			if (!params.url?.trim()) return fail(action, "web action=fetch needs a url");
			try {
				const outcome = await runFetch(params.url, {
					config: loadWebsearchConfig(getWebsearchConfigPath(agentDir)),
					agentDir,
					signal,
				});
				const notes: string[] = [];
				if (outcome.truncated) notes.push("Content truncated at 60000 characters.");
				if (attemptsUsedFallback(outcome.attempts)) {
					notes.push(`Fetched by ${outcome.engine} after an earlier engine failed.`);
				}
				const header = `# ${outcome.title?.trim() || outcome.url}\n(${outcome.url} — ${provenanceLine(outcome.engine, outcome.keyIndex, outcome.attempts)})`;
				const text = [header, outcome.content.trim(), notes.length > 0 ? `\nNote: ${notes.join("; ")}` : ""]
					.filter((part) => part !== "")
					.join("\n\n");
				return textResult(text, {
					action,
					engine: outcome.engine,
					keyIndex: outcome.keyIndex,
					attempts: outcome.attempts,
					items: [],
					uncertainty: notes,
				});
			} catch (err) {
				return fail(action, err instanceof Error ? err.message : String(err));
			}
		},

		renderCall(args: Static<typeof webParams>, theme: Theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold(`web ${args.action ?? "search"} `)) +
					theme.fg("muted", actionSummary(args)),
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as SearchDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "(no result)"), 0, 0);
			const header = theme.fg(
				"dim",
				details.action === "search"
					? `${details.items.length} result(s)${details.engine ? ` via ${details.engine}` : ""}`
					: `web ${details.action}${details.engine ? ` via ${details.engine}` : ""}`,
			);
			if (!options.expanded) return new Text(header, 0, 0);
			const lines = [header];
			if (details.action === "search") {
				details.items.slice(0, 10).forEach((item, index) => {
					lines.push(`${index + 1}. ${item.title || item.url} ${theme.fg("dim", item.url)}`);
				});
				lines.push(theme.fg("dim", summarizeAttempts(details.attempts)));
			} else {
				const text = result.content[0];
				if (text?.type === "text") lines.push(text.text);
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
