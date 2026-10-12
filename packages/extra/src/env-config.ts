/**
 * ENV-based configuration (P5):
 *
 * - `NANOPI_INIT_MD`: replaces the default system-prompt prefix (the
 *   `customPrompt` channel). AGENTS.md injection and appended prompts still
 *   apply. The value is a file path; when set to a non-path truthy value
 *   (e.g. `1` or empty), `.nanopi/agent/init.md` is used.
 * - `NANOPI_API_URL` + `NANOPI_API_TOKEN` + `NANOPI_API_MODEL`: registers one
 *   additional OpenAI-compatible provider. Append-only: the default model
 *   selection is never changed.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export const INIT_MD_DEFAULT_PATH = join(".nanopi", "agent", "init.md");

/** Resolve the NANOPI_INIT_MD override text, or undefined when not configured. */
export function resolveInitMd(cwd: string): string | undefined {
	const value = process.env.NANOPI_INIT_MD;
	if (value === undefined) return undefined;
	const candidate = value.trim();
	const file = candidate === "" || candidate === "1" || candidate === "true" ? INIT_MD_DEFAULT_PATH : candidate;
	const absolute = isAbsolute(file) ? file : resolve(cwd, file);
	if (!existsSync(absolute)) return undefined;
	try {
		const content = readFileSync(absolute, "utf8").trim();
		return content.length > 0 ? content : undefined;
	} catch {
		return undefined;
	}
}

export interface EnvProviderConfig {
	providerId: string;
	name: string;
	baseUrl: string;
	apiKey: string | undefined;
	api: "openai-completions";
	models: Array<{
		id: string;
		name: string;
		reasoning: false;
		input: ["text"];
		cost: { input: 0; output: 0; cacheRead: 0; cacheWrite: 0 };
		contextWindow: number;
		maxTokens: number;
	}>;
}

/** OpenAI-compatible provider registration from NANOPI_API_* env vars, or undefined. */
export function resolveEnvProvider(): EnvProviderConfig | undefined {
	const baseUrl = process.env.NANOPI_API_URL?.trim();
	if (!baseUrl) return undefined;
	const model = process.env.NANOPI_API_MODEL?.trim() || "default";
	return {
		providerId: "nanopi-env",
		name: "Env API (NANOPI_API_*)",
		baseUrl,
		apiKey: process.env.NANOPI_API_TOKEN?.trim() || undefined,
		api: "openai-completions",
		models: [
			{
				id: model,
				name: model,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 16_384,
			},
		],
	};
}
