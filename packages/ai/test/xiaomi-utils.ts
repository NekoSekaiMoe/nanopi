/**
 * Shared Xiaomi MiMo model fixtures.
 *
 * `mimo-v2.5-pro` was hard-coded in ~60 places and models.dev retired it, which
 * turned a catalog refresh into a wall of unrelated test failures while the
 * assertions themselves (reasoning-replay compat, tool-call shapes) were still
 * exactly right. Tests resolve the current id from the built-in catalog instead,
 * so the next rename costs one fixture update rather than a sweep — same rule the
 * coding-agent's model-registry tests already follow.
 */

import { getModel, getModels } from "../src/compat.ts";
import type { Api, Model } from "../src/types.ts";

/** The Xiaomi MiMo provider ids `packages/ai/scripts/generate-models.ts` emits. */
export const XIAOMI_PROVIDERS = [
	"xiaomi",
	"xiaomi-token-plan-cn",
	"xiaomi-token-plan-ams",
	"xiaomi-token-plan-sgp",
] as const;

export type XiaomiProvider = (typeof XIAOMI_PROVIDERS)[number];

/** Pick the highest-numbered MiMo chat model a provider still lists. */
function newestMimoId(provider: XiaomiProvider): string | undefined {
	const ids = getModels(provider as "xiaomi")
		.map((model) => model.id)
		.filter((id) => /^mimo-v/.test(id));
	// "v2.6" > "v2.5": compare segment by segment, numerically.
	const rank = (id: string): number[] =>
		id
			.slice("mimo-v".length)
			.split(".")
			.map((part) => Number.parseInt(part, 10))
			.map((n) => (Number.isNaN(n) ? 0 : n));
	const compare = (a: string, b: string): number => {
		const left = rank(a);
		const right = rank(b);
		for (let i = 0; i < Math.max(left.length, right.length); i++) {
			const diff = (left[i] ?? 0) - (right[i] ?? 0);
			if (diff !== 0) return diff;
		}
		// Prefer the pro tier on a tie, and the non-"ultraspeed"/"flash" variant.
		return Number(/pro/.test(b)) - Number(/pro/.test(a));
	};
	return ids.sort(compare).at(-1);
}

/**
 * The current MiMo model id on `provider`, for use where an id must be spelled
 * out. The catalog types are literal unions per provider, so the id is erased to
 * `string` here: tests must not pin it.
 */
export function mimoModelId(provider: XiaomiProvider = "xiaomi"): string {
	const id = newestMimoId(provider);
	if (!id) throw new Error(`provider "${provider}" lists no MiMo chat model`);
	return id;
}

/** The current MiMo model on `provider`. Fails loudly rather than returning undefined. */
export function mimoModel(provider: XiaomiProvider = "xiaomi"): Model<Api> {
	// The catalog accessors type model ids as per-provider literal unions; going
	// through a loose view keeps this helper usable for every Xiaomi provider and
	// stops callers from pinning an id the catalog may retire.
	const catalog = getModel as unknown as (provider: string, modelId: string) => Model<Api> | undefined;
	const model = catalog(provider, mimoModelId(provider));
	if (!model) throw new Error(`provider "${provider}" lists no MiMo chat model`);
	return model;
}
