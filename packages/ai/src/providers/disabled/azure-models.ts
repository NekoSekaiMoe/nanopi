/**
 * Stand-in for `azure.models.ts` in a build whose provider set leaves
 * azure out (buildconfig.json `providerSets`).
 *
 * The build aliases the catalog shard to this file at resolve time
 * (scripts/build-apis.mjs) instead of filtering `builtinProviders()` at
 * runtime: the shards hold the model data, so a runtime filter leaves every
 * provider's catalog in the bundle.
 *
 * Both the named exports and the `value` object keep their names, so
 * `models.generated.ts` compiles unchanged. The catalogs are empty and typed
 * `DisabledModelCatalog`: the provider key stays literal, so naming a dropped
 * provider still compiles while reading one of its models is a type error
 * rather than a runtime undefined.
 */

import type { DisabledModelCatalog } from "../../model-catalog.ts";

export const AZURE_MODELS: DisabledModelCatalog = {};

export const AZURE_IMAGE_MODELS: DisabledModelCatalog = {};

export const AZURE_CLASSIFIER_MODELS: DisabledModelCatalog = {};

export const value = {
	AZURE_MODELS,
	AZURE_IMAGE_MODELS,
	AZURE_CLASSIFIER_MODELS,
};
