/**
 * Configuration for the web search module.
 *
 * Two layers, same as the other extras: a JSON file next to settings.json and
 * the environment. The file wins when both name the same engine, because it is
 * the one the user edited on purpose.
 *
 * Engines are addressed by fixed ids (firecrawl, keenable, tavily, exa). A
 * comma-separated value names several keys for one engine; see engines.ts for
 * how they rotate.
 */

import fs from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "../../../config.ts";
import { resolveConfigValue } from "../../../core/resolve-config-value.ts";

export type EngineName = "firecrawl" | "keenable" | "tavily" | "exa";
export type EngineRole = "search" | "fetch";

export interface EngineConfig {
	enabled?: boolean;
	/** One key, or several comma-separated keys tried in order. */
	apiKey?: string;
	/** Compatible third-party or self-hosted endpoint; the official one stays the default. */
	baseUrl?: string;
}

export interface WebsearchConfig {
	/** Engine chain, most preferred first. Unset means DEFAULT_ENGINE_CHAIN. */
	engines?: EngineName[];
	/** Per-engine settings keyed by engine id. */
	firecrawl?: EngineConfig;
	keenable?: EngineConfig;
	tavily?: EngineConfig;
	exa?: EngineConfig;
	/** Millisecond budget for one engine attempt. */
	timeoutMs?: number;
	/** Millisecond budget for a whole call, failovers included. */
	deadlineMs?: number;
}

/** Firecrawl and Keenable run keyless, so they answer on a fresh install. */
export const DEFAULT_ENGINE_CHAIN: readonly EngineName[] = ["firecrawl", "keenable", "tavily", "exa"];

export const ENGINE_NAMES: readonly EngineName[] = ["firecrawl", "keenable", "tavily", "exa"];

/** Env var per engine. Each accepts a comma-separated key list. */
const KEY_ENV: Record<EngineName, string> = {
	firecrawl: "FIRECRAWL_API_KEY",
	keenable: "KEENABLE_API_KEY",
	tavily: "TAVILY_API_KEY",
	exa: "EXA_API_KEY",
};

export const WEBSEARCH_CONFIG_FILE = "websearch.json";

export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_DEADLINE_MS = 60_000;

export function getWebsearchConfigPath(): string {
	return join(getAgentDir(), WEBSEARCH_CONFIG_FILE);
}

function isEngineName(value: unknown): value is EngineName {
	return typeof value === "string" && (ENGINE_NAMES as readonly string[]).includes(value);
}

function normalizeEngineConfig(value: unknown): EngineConfig | undefined {
	if (value === false) return { enabled: false };
	if (typeof value === "string") return { apiKey: value };
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	const config: EngineConfig = {};
	if (typeof record.enabled === "boolean") config.enabled = record.enabled;
	if (typeof record.apiKey === "string") config.apiKey = record.apiKey;
	if (typeof record.baseUrl === "string") config.baseUrl = record.baseUrl;
	return config;
}

/**
 * Read the config file. A missing, unreadable, or malformed file reads as an
 * empty config: search then runs on the keyless defaults instead of failing,
 * and a typo cannot take the tool offline.
 */
export function loadWebsearchConfig(path = getWebsearchConfigPath()): WebsearchConfig {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
	const record = raw as Record<string, unknown>;
	const config: WebsearchConfig = {};
	if (Array.isArray(record.engines)) {
		const engines = record.engines.filter(isEngineName);
		if (engines.length > 0) config.engines = engines;
	}
	for (const name of ENGINE_NAMES) {
		const engine = normalizeEngineConfig(record[name]);
		if (engine) config[name] = engine;
	}
	if (typeof record.timeoutMs === "number" && record.timeoutMs > 0) config.timeoutMs = record.timeoutMs;
	if (typeof record.deadlineMs === "number" && record.deadlineMs > 0) config.deadlineMs = record.deadlineMs;
	return config;
}

export function engineConfig(config: WebsearchConfig, name: EngineName): EngineConfig {
	return config[name] ?? {};
}

/**
 * The engine's keys, in the order to try them. The file's value wins; the env
 * var is the fallback. Either may hold a comma-separated list.
 */
export function engineKeyValue(config: WebsearchConfig, name: EngineName, env?: Record<string, string>): string {
	const configured = engineConfig(config, name).apiKey;
	const raw =
		configured !== undefined && configured.trim() !== ""
			? configured
			: (env?.[KEY_ENV[name]] ?? process.env[KEY_ENV[name]] ?? "");
	return resolveConfigValue(raw, env) ?? "";
}

export function engineBaseUrl(config: WebsearchConfig, name: EngineName): string | undefined {
	const value = engineConfig(config, name).baseUrl?.trim();
	return value ? value : undefined;
}

/** The engine chain to try, minus engines switched off in the file. */
export function engineChain(config: WebsearchConfig): EngineName[] {
	const chain = config.engines ?? DEFAULT_ENGINE_CHAIN;
	return chain.filter((name) => engineConfig(config, name).enabled !== false);
}

export function configTimeoutMs(config: WebsearchConfig): number {
	return config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
}

export function configDeadlineMs(config: WebsearchConfig): number {
	return config.deadlineMs ?? DEFAULT_DEADLINE_MS;
}

export { KEY_ENV };
