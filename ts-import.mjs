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

registerHooks({
	load(url, context, nextLoad) {
		if (url.endsWith(".ts")) {
			const code = readFileSync(new URL(url), "utf8");
			const result = esbuild.transformSync(code, {
				loader: "ts",
				format: "esm",
				target: "node24",
				sourcemap: "inline",
			});
			return { format: "module", shortCircuit: true, source: result.code };
		}
		return nextLoad(url, context);
	},
});
