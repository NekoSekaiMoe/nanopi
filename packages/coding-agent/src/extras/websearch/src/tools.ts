/**
 * The two tools the module declares: `web_search` and `read_page`.
 *
 * Both return the same thing: a one-line summary, the evidence (ranked items,
 * or the page text), and an explicit uncertainty list. Nothing here invents an
 * answer, because every engine in the chain returns ranked pages without one;
 * the exception is Tavily's `answer` field, passed through when it arrives.
 */

import { Text } from "@nanopi/pi-tui";
import type { ModuleApi, Theme } from "@nanopi/pi-coding-agent";
import { type Static, Type } from "typebox";
import { getWebsearchConfigPath, loadWebsearchConfig } from "./config.ts";
import type { SearchAttempt, SearchItem } from "./engines.ts";
import { MAX_LIMIT, runFetch, runSearch } from "./search.ts";

const searchParams = Type.Object({
	query: Type.String({ description: "What to look for, in plain words" }),
	max_results: Type.Optional(
		Type.Number({ description: `How many results to return (1-${MAX_LIMIT}, default 8)` }),
	),
});

const fetchParams = Type.Object({
	url: Type.String({ description: "The http(s) URL to read" }),
});

export interface SearchDetails {
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

export function registerWebsearchTools(pi: ModuleApi): void {
	pi.registerTool({
		name: "web_search",
		label: "Web search",
		description:
			"Search the web. Runs on a failover chain that needs no account: Firecrawl's keyless allowance first, then Keenable, then any keyed engine you configured (Tavily, Exa). Multi-key engines rotate keys on auth, rate-limit, or quota failures before the chain moves on. Returns ranked results with URLs and snippets; read the items, they are the evidence. Do not answer from memory when the question is about something current.",
		promptSnippet: "Search the web (keyless failover chain)",
		promptGuidelines: [
			"Use web_search for anything current: releases, prices, news, API changes. Cite the URL you used.",
		],
		annotations: { readOnlyHint: true, openWorldHint: true },
		parameters: searchParams,

		async execute(_toolCallId, params: Static<typeof searchParams>, signal, _onUpdate, ctx) {
			const agentDir = ctx.getAgentDir();
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
			const details: SearchDetails = {
				engine: outcome.engine,
				keyIndex: outcome.keyIndex,
				attempts: outcome.attempts,
				items: outcome.items,
				uncertainty,
			};
			return {
				content: [{ type: "text" as const, text: renderSearchText(summary, outcome.items, uncertainty) }],
				details,
			};
		},

		renderCall(args: Static<typeof searchParams>, theme: Theme) {
			return new Text(
				theme.fg("toolTitle", theme.bold("web_search ")) + theme.fg("muted", args.query),
				0,
				0,
			);
		},

		renderResult(result, options, theme) {
			const details = result.details as SearchDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "(no result)"), 0, 0);
			const header = theme.fg(
				"dim",
				`${details.items.length} result(s)${details.engine ? ` via ${details.engine}` : ""}`,
			);
			if (!options.expanded) return new Text(header, 0, 0);
			const lines = [header];
			details.items.slice(0, 10).forEach((item, index) => {
				lines.push(`${index + 1}. ${item.title || item.url} ${theme.fg("dim", item.url)}`);
			});
			lines.push(theme.fg("dim", summarizeAttempts(details.attempts)));
			return new Text(lines.join("\n"), 0, 0);
		},
	});

	pi.registerTool({
		name: "read_page",
		label: "Read page",
		description:
			"Read one web page as markdown, through the same failover chain as web_search (Firecrawl keyless first). Use it when a message points at a specific http(s) URL whose content matters: docs, an article, a changelog, an issue. Returns the extracted text, truncated at 60000 characters, so read a page you actually need instead of guessing at it.",
		promptSnippet: "Read a web page as markdown",
		annotations: { readOnlyHint: true, openWorldHint: true },
		parameters: fetchParams,

		async execute(_toolCallId, params: Static<typeof fetchParams>, signal, _onUpdate, ctx) {
			const agentDir = ctx.getAgentDir();
			const config = loadWebsearchConfig(getWebsearchConfigPath(agentDir));
			const outcome = await runFetch(params.url, { config, agentDir, signal });
			const notes: string[] = [];
			if (outcome.truncated) notes.push("Content truncated at 60000 characters.");
			if (attemptsUsedFallback(outcome.attempts)) {
				notes.push(`Fetched by ${outcome.engine} after an earlier engine failed.`);
			}
			const header = `# ${outcome.title?.trim() || outcome.url}\n(${outcome.url} — ${provenanceLine(outcome.engine, outcome.keyIndex, outcome.attempts)})`;
			const text = [header, outcome.content.trim(), notes.length > 0 ? `\nNote: ${notes.join("; ")}` : ""]
				.filter((part) => part !== "")
				.join("\n\n");
			return {
				content: [{ type: "text" as const, text }],
				details: {
					engine: outcome.engine,
					url: outcome.url,
					truncated: outcome.truncated,
					attempts: outcome.attempts,
				},
			};
		},

		renderCall(args: Static<typeof fetchParams>, theme: Theme) {
			return new Text(theme.fg("toolTitle", theme.bold("read_page ")) + theme.fg("muted", args.url), 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as { engine?: string; truncated?: boolean } | undefined;
			const label = `page via ${details?.engine ?? "unknown"}${details?.truncated ? ", truncated" : ""}`;
			if (!options.expanded) return new Text(theme.fg("dim", label), 0, 0);
			const text = result.content[0];
			const body = text && text.type === "text" ? text.text : "";
			return new Text(`${theme.fg("dim", label)}\n${body}`, 0, 0);
		},
	});
}

function attemptsUsedFallback(attempts: SearchAttempt[]): boolean {
	const firstFailure = attempts.findIndex((attempt) => !attempt.ok);
	return firstFailure !== -1 && attempts.some((attempt) => attempt.ok);
}
