import { describe, expect, it } from "vitest";
import { getModels } from "../src/compat.ts";
import { mimoModelId, XIAOMI_PROVIDERS } from "./xiaomi-utils.ts";

const DEPRECATED_MODEL_IDS = ["mimo-v2-flash", "mimo-v2-omni", "mimo-v2-pro"] as const;

describe("Xiaomi MiMo models", () => {
	it.each(XIAOMI_PROVIDERS)("omits deprecated models from %s", (provider) => {
		const modelIds = getModels(provider).map((model) => model.id);
		for (const modelId of DEPRECATED_MODEL_IDS) expect(modelIds).not.toContain(modelId);
	});

	it.each(XIAOMI_PROVIDERS)("keeps a current MiMo model on %s", (provider) => {
		// Resolved from the catalog rather than pinned: models.dev retires MiMo ids
		// (mimo-v2.5* went away between 2026-10-13 and 2026-10-16) and a pinned id
		// turned a catalog refresh into failures here.
		expect(getModels(provider).map((model) => model.id)).toContain(mimoModelId(provider));
	});
});
