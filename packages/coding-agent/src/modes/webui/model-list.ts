/**
 * Which chat models the webui offers, in one place so `/models` (the picker)
 * and `/chat` (the model a turn switches to) cannot disagree.
 *
 * The CLI builds its picker from `settings.enabledModels` (the `/models`
 * allowlist, also written by "set as default"); `nanopi --models a,b` scopes
 * the session the same way. The webui ignored that list and sent every
 * catalog row, so the browser showed models the CLI never prints.
 */

import type { Model } from "@nanopi/pi-ai";
import { resolveModelScopeFromModels } from "../../core/model-resolver.ts";

/**
 * Append `extra` to `models`, deduplicated by `provider/id` on the first entry
 * so the availability snapshot stays authoritative.
 */
export function mergeModelLists(models: Model<any>[], extra: readonly (Model<any> | undefined)[]): void {
	for (const model of extra) {
		if (!model) continue;
		if ("type" in model) continue;
		if (!models.some((entry) => entry.provider === model.provider && entry.id === model.id)) models.push(model);
	}
}

/**
 * The models the CLI would offer out of `models`, or `models` unchanged when
 * no allowlist is configured.
 *
 * A pattern list is resolved against `models` exactly as the CLI resolves it
 * against its availability snapshot, so a glob or a bare id selects the same
 * rows on both sides. Patterns that match nothing are dropped rather than
 * rendered as unavailable rows: the CLI prints no model for them either.
 *
 * The active session model stays, even outside the allowlist. It is what the
 * next turn runs, and the picker has no other seat to show it.
 */
export function modelsWithinAllowlist(
	models: readonly Model<any>[],
	patterns: readonly string[] | undefined,
	active: Model<any> | undefined,
): Model<any>[] {
	if (!patterns || patterns.length === 0) return [...models];
	const allowed = resolveModelScopeFromModels([...patterns], models).scopedModels.map((scoped) => scoped.model);
	if (!active || allowed.some((model) => sameModel(model, active))) return allowed;
	const current = models.find((model) => sameModel(model, active));
	return current ? [current, ...allowed] : allowed;
}

/**
 * Drop the catalog rows whose provider is not authenticated.
 *
 * A built-in provider ships its whole packaged catalog (`alibaba-cn` alone is
 * dozens of ids), so keeping every greyed-out row turns the picker into a browse
 * of models the user cannot run. Only the catalog contribution is filtered: the
 * availability snapshot and the active session model are already known-good, and
 * a credential can resolve for a provider that declares no auth method.
 */
export function dropUnauthenticated(models: readonly Model<any>[], authenticated: ReadonlySet<string>): Model<any>[] {
	return models.filter((model) => authenticated.has(model.provider));
}

function sameModel(a: Model<any>, b: Model<any>): boolean {
	return a.provider === b.provider && a.id === b.id;
}
