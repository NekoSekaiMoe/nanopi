/**
 * The model catalog Qoder answers with, turned into nanopi model entries.
 *
 * `GET /algo/api/v2/model/list` is the account's own list: which models the
 * plan may use, what the upstream calls them, their context sizes. Hardcoding
 * a handful of model ids would both miss new ones and offer ones the account
 * cannot run, so the provider asks this endpoint and maps whatever answers.
 *
 * The catalog is read from the first non-empty bucket among `assistant`,
 * `developer` and `chat`; entries with `enable: false` are dropped.
 */

import type { Model, ModelCost } from "../types.ts";
import { asNumber, asString, type QoderJson, qoderErrorDetail, qoderRequestSignal, readQoderJson } from "./client.ts";
import { qoderFingerprint, qoderSignedHeaders, qoderSigningPath } from "./cosy.ts";
import { QODER_API, type QoderApi, type QoderRegion, qoderEndpoints } from "./endpoints.ts";

const CATALOG_BUCKETS = ["assistant", "developer", "chat"];
/** Subscription access bills no per-token price, so every entry is free. */
const SUBSCRIPTION_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** One upstream model, as the list endpoint describes it. */
export interface QoderListedModel {
	/** Upstream model key, e.g. `qmodel_38max`. */
	key: string;
	displayName: string;
	isDefault: boolean;
	isReasoning: boolean;
	maxInputTokens?: number;
	/** Context window: the tier marked default, else the largest, else `max_input_tokens`. */
	contextWindow: number;
}

/** Login facts the signed calls need; `name` and the rest come from the account lookup. */
export interface QoderAccountSession {
	uid: string;
	name?: string;
	organizationId?: string;
	organizationName?: string;
	userType?: string;
	token: string;
	refreshToken?: string;
}

function readContextConfig(record: QoderJson): { tokens: number; isDefault: boolean }[] {
	const raw = record.context_config;
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
	const tiers: { tokens: number; isDefault: boolean }[] = [];
	for (const value of Object.values(raw as Record<string, unknown>)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const tokens = asNumber((value as QoderJson).token_count);
		if (!tokens || tokens <= 0) continue;
		tiers.push({ tokens, isDefault: (value as QoderJson).is_default === true });
	}
	return tiers.sort((left, right) => left.tokens - right.tokens);
}

function toListedModel(record: QoderJson): QoderListedModel | undefined {
	const key = asString(record.key);
	if (!key || record.enable === false) return undefined;
	const isDefault = record.is_default === true;
	const isReasoning = record.is_reasoning === true;
	const maxInputTokens = asNumber(record.max_input_tokens);
	const tiers = readContextConfig(record);
	const contextWindow = tiers.find((tier) => tier.isDefault)?.tokens ?? tiers.at(-1)?.tokens ?? maxInputTokens ?? 0;
	return {
		key,
		displayName: asString(record.display_name) ?? key,
		isDefault,
		isReasoning,
		maxInputTokens,
		contextWindow,
	};
}

/** Models the account may call, in the list endpoint's order. */
export function parseQoderModelList(body: QoderJson | null): QoderListedModel[] {
	for (const bucket of CATALOG_BUCKETS) {
		const raw = body?.[bucket];
		if (!Array.isArray(raw)) continue;
		const models = raw
			.filter((entry): entry is QoderJson => typeof entry === "object" && entry !== null && !Array.isArray(entry))
			.map(toListedModel)
			.filter((model): model is QoderListedModel => model !== undefined);
		if (models.length > 0) return models;
	}
	return [];
}

export function qoderModelEntry(values: { provider: "qoder" | "qoder-cn"; listed: QoderListedModel }): Model<QoderApi> {
	const { listed } = values;
	// A reasoning model needs room for its thinking output; the rest keep the
	// list endpoint's own input budget as their output cap.
	const maxTokens = listed.isReasoning ? 32768 : 16384;
	return {
		id: listed.key,
		name: listed.displayName,
		api: QODER_API,
		provider: values.provider,
		baseUrl: qoderEndpoints(values.provider === "qoder-cn" ? "cn" : "global").chatUrl,
		reasoning: listed.isReasoning,
		input: ["text"],
		cost: SUBSCRIPTION_COST,
		contextWindow: listed.contextWindow || listed.maxInputTokens || 200000,
		maxTokens,
	};
}

/** Ask the region's list endpoint what this account may use. Signed call, GET with an empty body. */
export async function fetchQoderModelList(
	region: QoderRegion,
	account: QoderAccountSession,
	signal: AbortSignal,
): Promise<QoderListedModel[]> {
	const url = qoderEndpoints(region).modelListUrl;
	const response = await fetch(url, {
		method: "GET",
		headers: qoderSignedHeaders({
			identity: {
				uid: account.uid,
				name: account.name,
				organizationId: account.organizationId,
				organizationName: account.organizationName,
				userType: account.userType,
				token: account.token,
				refreshToken: account.refreshToken,
			},
			fingerprint: qoderFingerprint(account.uid),
			path: qoderSigningPath(url),
			body: "",
		}),
		signal: qoderRequestSignal(signal),
	});
	const body = await readQoderJson(response);
	if (!response.ok) {
		throw new Error(`Qoder model list failed (HTTP ${response.status})${qoderErrorDetail(body)}`);
	}
	const models = parseQoderModelList(body);
	if (models.length === 0) throw new Error("Qoder model list returned no models");
	return models;
}
