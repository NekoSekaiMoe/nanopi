import { describe, expect, it } from "vitest";
import type { DisabledModelCatalog } from "../src/model-catalog.ts";

/**
 * The provider stand-ins under src/providers/disabled keep the catalog export
 * names and swap the value type for `DisabledModelCatalog`. A build whose
 * provider set drops a catalog (buildconfig.json `providerSets`, applied by
 * scripts/build-apis.mjs) therefore keeps provider keys literal-typed: reading a
 * model off a dropped provider is a type error instead of a runtime undefined.
 */
describe("DisabledModelCatalog", () => {
	it("accepts any model id key and types the value as never", () => {
		const catalog: DisabledModelCatalog = {};
		expect(catalog["gpt-4o"]).toBeUndefined();
		expect(Object.keys(catalog)).toEqual([]);
	});

	it("keeps a provider map readable as an unknown object", () => {
		const models: Record<string, DisabledModelCatalog | undefined> = { openai: {} };
		expect(Object.keys(models.openai ?? {})).toEqual([]);
	});
});
