import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// The webui compiles against the `@/*` alias in its own tsconfig; the tests
// import the same sources, so they resolve it the same way.
export default defineConfig({
	resolve: {
		alias: {
			"@": fileURLToPath(new URL("./src", import.meta.url)),
		},
	},
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
});
