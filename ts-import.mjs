// Preload module that lets Node execute TypeScript sources through esbuild,
// for environments whose Node build lacks built-in type stripping
// (process.features.typescript === false, e.g. Debian's node package).
//
// Usage: node --import ./ts-import.mjs [node flags] <script.ts> [args...]
// Composes with other flags, e.g.:
//   node --import ./ts-import.mjs --test test/*.test.ts
//   node --import ./ts-import.mjs --import ./other-preload.mjs script.ts
// Put this --import first so later TypeScript preloads also get stripped.
import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import * as esbuild from "esbuild";

const typeScriptLoaders = {
	".ts": { loader: "ts", format: "module" },
	".tsx": { loader: "tsx", format: "module" },
	".mts": { loader: "ts", format: "module" },
	".cts": { loader: "ts", format: "commonjs" },
};

registerHooks({
	load(url, context, nextLoad) {
		const entry = Object.entries(typeScriptLoaders).find(([extension]) => url.endsWith(extension));
		if (entry !== undefined) {
			const code = readFileSync(new URL(url), "utf8");
			const result = esbuild.transformSync(code, {
				loader: entry[1].loader,
				format: entry[1].format === "commonjs" ? "cjs" : "esm",
				target: "node24",
				sourcemap: "inline",
			});
			return { format: entry[1].format, shortCircuit: true, source: result.code };
		}
		return nextLoad(url, context);
	},
});
