import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

// Vendored snapshots under src/modules keep their own test configs; the
// workspace suite must not discover them.
const vendoredModulePaths = [
	"ask-lite",
	"mcp-lite",
	"pi-btw",
	"pi-fake-codex",
	"pi-fake-opencode",
	"pi-git-tools",
	"pi-image",
	"pi-lsp-mini",
	"pi-meat",
	"pi-memory",
	"pi-output-compact",
	"pi-rewind",
	"pi-simplify",
	"pi-smart-flow",
	"pi-subagent-mini",
	"pi-token-usage",
	"pi-ui",
	"todo-lite",
	"tool-result-store",
	"websearch",
] as const;

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { NANOPI_OFFLINE: "1", NANOPI_BUNDLED_EXTRAS: "0" },
			// Vendored bundled extras (and their dist copies) are not first-party
			// test suites; bundled-extras-registration.test.ts covers registration.
			exclude: [
				"**/node_modules/**",
				"**/dist/**",
				...vendoredModulePaths.map((name) => `**/modules/${name}/**`),
			],
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			server: {
				deps: {
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@nanopi\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@nanopi\/pi-ai\/qoder$/, replacement: workspaceSourcePaths.aiQoder },
				{ find: /^@nanopi\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
