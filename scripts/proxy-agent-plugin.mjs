/**
 * `https-proxy-agent` is consumed through a dynamic import of a named export,
 * which esbuild cannot fold into the bundle. Rewriting the specifier to a
 * one-line module that re-exports `HttpsProxyAgent` keeps the package's own
 * module graph out of the two coding-agent builds.
 *
 * Shared by build-coding-agent-bundle.mjs and
 * build-coding-agent-single-file.mjs.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";

const NAMESPACE = "https-proxy-agent-named-export";

export function httpsProxyAgentNamedExportPlugin(repoRoot) {
	return {
		name: NAMESPACE,
		setup(build) {
			const resolveFromImporter = createRequire(import.meta.url).resolve;
			build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
				if (args.kind !== "dynamic-import") return undefined;
				// Resolve from the importing module so pnpm's isolated layout serves
				// the version the importer depends on. A bare specifier resolved from
				// the repository root cannot find the package because no root package
				// declares it, so the bundle build fails on a clean install.
				const fromDir = args.importer && args.importer !== "<stdin>" ? dirname(args.importer) : repoRoot;
				return {
					namespace: NAMESPACE,
					path: resolveFromImporter("https-proxy-agent", { paths: [fromDir] }),
				};
			});
			build.onLoad({ filter: /.*/, namespace: NAMESPACE }, (args) => ({
				contents: `export { HttpsProxyAgent } from ${JSON.stringify(args.path)};`,
				loader: "js",
				resolveDir: dirname(args.path),
			}));
		},
	};
}
