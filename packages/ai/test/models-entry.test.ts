import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceEntry = new URL("../src/models.ts", import.meta.url).href;
const typeScriptPreload = fileURLToPath(new URL("../../../ts-import.mjs", import.meta.url));
// Both cases need `dist/`: the published `./models` entry resolves there, and the
// spawned script imports the faux provider by package name (`dist/providers/faux.js`)
// because vitest's workspace source aliases do not apply to a separate Node process.
// A source-only checkout has no dist, so this is a build-artifact check and must
// skip rather than fail: `pnpm run build` creates the directory it looks for.
const distExists =
	existsSync(fileURLToPath(new URL("../dist/models.js", import.meta.url))) &&
	existsSync(fileURLToPath(new URL("../dist/providers/faux.js", import.meta.url)));

// Install before linking the static imports, so unused barrel re-exports are checked too.
const preload = `data:text/javascript,${encodeURIComponent(`
	import { registerHooks } from "node:module";
	const forbidden = [
		"/node_modules/typebox/",
		"/node_modules/@anthropic-ai/sdk/",
		"/node_modules/openai/",
		"/node_modules/@google/genai/",
		"/node_modules/@aws-sdk/",
		"/providers/data/",
		"/models.generated.",
	];
	registerHooks({
		load(url, context, nextLoad) {
			if (forbidden.some((part) => url.includes(part))) {
				throw new Error("Heavy dependency loaded by models entry: " + url);
			}
			return nextLoad(url, context);
		},
	});
`)}`;

describe("lightweight models entry", () => {
	describe.skipIf(!distExists)("built package", () => {
		it.each([sourceEntry, "@nanopi/pi-ai/models"])(
			"runs a faux completion without TypeBox, catalogs, or SDKs through %s",
			(entry) => {
				const script = `
				import assert from "node:assert/strict";
				import { createModels, createProvider } from ${JSON.stringify(entry)};
				import { fauxAssistantMessage, fauxProvider } from "@nanopi/pi-ai/providers/faux";
				assert.equal(typeof createProvider, "function");
				const models = createModels();
				assert.deepEqual(models.getModels(), []);
				assert.deepEqual(models.getProviders(), []);
				const faux = fauxProvider();
				models.setProvider(faux.provider);
				faux.setResponses([fauxAssistantMessage("OK")]);
				const response = await models.completeSimple(faux.getModel(), { messages: [] });
				assert.equal(response.stopReason, "stop");
				assert.deepEqual(response.content, [{ type: "text", text: "OK" }]);
			`;
				const result = spawnSync(
					process.execPath,
					// The ts-import preload runs first so the guard's load hook still observes every URL, including .ts.
					["--import", typeScriptPreload, "--import", preload, "--input-type=module", "--eval", script],
					{
						cwd: packageRoot,
						encoding: "utf8",
						timeout: 10_000,
					},
				);
				expect(result.error).toBeUndefined();
				expect(result.status, result.stderr).toBe(0);
			},
		);
	});
});
