import { strictEqual } from "node:assert";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readApiModuleIds } from "./build-apis.mjs";
import { loadBuildConfig, resolveFlavorApis } from "./buildconfig.mjs";

const repoRoot = join(import.meta.dirname, "..");
const config = loadBuildConfig(repoRoot);
const baseApis = resolveFlavorApis(config, "base");
const apiModules = readApiModuleIds(join(repoRoot, "packages", "ai"));

/**
 * `base` ships the `amazon-bedrock` catalog (`providerSets.core`) and drops the
 * Bedrock endpoint implementations (`apiSets.endpoint`): the AWS SDK is ~1.2 MiB
 * of the artifact for a host a terminal-first SKU does not serve. The two halves
 * have to stay in sync, because the catalog registers models whose `api` the
 * built artifact cannot serve (packages/coding-agent/src/core/provider-composer.ts
 * skips such a model).
 */
describe("base and the Bedrock APIs", () => {
	it("drops every bedrock api from the base API set", () => {
		strictEqual(
			baseApis.some((api) => api.startsWith("bedrock-")),
			false,
			`base still carries ${baseApis.filter((api) => api.startsWith("bedrock-")).join(", ")}`,
		);
		// The Mantle shapes reuse `openai-responses` / `anthropic-messages`, which
		// other providers need, so only the three bedrock-* ids can be dropped.
		strictEqual(baseApis.includes("openai-completions"), true);
		strictEqual(baseApis.includes("anthropic-messages"), true);
	});

	it("keeps the bedrock implementation modules out of the base build", () => {
		const apis = new Set(baseApis);
		const bedrockModules = apiModules.filter((id) => id.startsWith("bedrock-"));
		strictEqual(bedrockModules.length > 0, true);
		for (const id of bedrockModules) strictEqual(apis.has(id), false, `${id} is still in the base API set`);
	});

	it("still ships the amazon-bedrock catalog in base", () => {
		// The direction B half: `base` reads AWS credentials from the environment,
		// so the catalog has to be there for the provider to be selectable.
		strictEqual(config.flavors.base.components.providers, "core");
		strictEqual(config.providerSets.core.providers.includes("amazon-bedrock"), true);
	});

	it("names only API ids that have an implementation module", () => {
		// A typo in a concrete id would stub nothing and silently leave that
		// implementation in the bundle, which is the failure this set prevents.
		const modules = new Set(apiModules);
		for (const api of baseApis) strictEqual(modules.has(api), true, `${api} has no implementation module`);
	});

	it("keeps full on every implementation", () => {
		strictEqual(resolveFlavorApis(config, "full").join(","), "__ALL__");
	});
});
