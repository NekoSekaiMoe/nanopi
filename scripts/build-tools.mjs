/**
 * esbuild wiring for the `tools` entry of buildconfig.json `toolsetComponents`.
 *
 * `toolset: "bash"` used to narrow the tool set at runtime only: every tool
 * definition in `createAllToolDefinitions` stayed in the bundle and the session
 * filtered the declarations afterwards. A tool set that names its tools (the
 * `tools` entry) lets the build drop the rest of them, which is what the
 * minimal flavor needs: the shell tool is the only tool it ships, so the read,
 * edit, write, grep, find and ls definitions must not be compiled in.
 *
 * - `toolStubPlugin` aliases the implementation module of every tool the set
 *   leaves out to a generated stub that exports the same names with an inert
 *   body. Exports are stubbed rather than the whole module removed because
 *   `core/tools/index.ts` re-exports every tool for SDK users; the names stay
 *   resolvable and only the implementations drop out.
 * - `validateToolSet` cross-checks the tool set against the tool names the
 *   session knows, so a renamed tool fails the build instead of leaving the
 *   previous module bundled.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { ALL_TOOL_NAMES } from "./buildconfig.mjs";

/**
 * Export surface of each built-in tool, in the two modules the barrel imports:
 * the implementation (`../read.js`) and its presentation
 * (`../renderers/read.js`, which `core/tools/renderers/index.ts` imports as
 * `./read.js` under a different namespace). Values a stub has to satisfy are
 * listed; types are erased and need no stub.
 */
const TOOL_MODULES = {
	read: { exports: ["createReadTool", "createReadToolDefinition"], renderExports: ["readRenderers"] },
	edit: { exports: ["createEditTool", "createEditToolDefinition"], renderExports: ["editRenderers"] },
	write: { exports: ["createWriteTool", "createWriteToolDefinition"], renderExports: ["writeRenderers"] },
	grep: { exports: ["createGrepTool", "createGrepToolDefinition"], renderExports: ["grepRenderers"] },
	find: { exports: ["createFindTool", "createFindToolDefinition"], renderExports: ["findRenderers"] },
	ls: { exports: ["createLsTool", "createLsToolDefinition"], renderExports: ["lsRenderers"] },
	bash: {
		exports: ["createBashTool", "createBashToolDefinition", "createLocalBashOperations", "resolveShellOperations"],
		renderExports: ["createShellRenderers"],
	},
	powershell: {
		exports: ["createPowerShellTool", "createPowerShellToolDefinition", "createLocalPowerShellOperations"],
		renderExports: ["createShellRenderers"],
	},
};

/** Namespaces the stub plugin rewrites: tool implementations, then renderers. */
const IMPLEMENTATION_NAMESPACE = "builtin-tool-stub";
const RENDERER_NAMESPACE = "builtin-tool-renderer-stub";

/** Throws when a tool set names a tool the build does not know. */
export function validateToolSet(toolNames) {
	if (toolNames === undefined) return;
	const unknown = toolNames.filter((name) => !ALL_TOOL_NAMES.includes(name));
	if (unknown.length > 0) {
		throw new Error(
			`buildconfig.json tool set names tools without an implementation: ${unknown.join(", ")} ` +
				`(known: ${ALL_TOOL_NAMES.join(", ")}; see scripts/build-tools.mjs)`,
		);
	}
}

/**
 * Builds the plugin that stubs the tool definitions outside `toolNames`.
 *
 * @param {{ stubDir: string, toolsSrcDir: string, toolNames: readonly string[] | undefined }} options
 * @returns {{ plugin: import("esbuild").Plugin, excluded: string[] }}
 */
export function createToolStubPlugin({ stubDir, toolsSrcDir, toolNames }) {
	const disabledToolNames =
		toolNames === undefined ? [] : Object.keys(TOOL_MODULES).filter((name) => !toolNames.includes(name));
	if (disabledToolNames.length === 0) return { plugin: inertPlugin(), excluded: [] };

	// The barrel writes `./read.js`; the renderer barrel writes the same specifier
	// under a different directory, so the two namespaces keep them apart.
	const toolModulePath = (name) => join(toolsSrcDir, `${name}.js`);
	const rendererModulePath = (name) => join(toolsSrcDir, "renderers", `${name}.js`);
	mkdirSync(stubDir, { recursive: true });
	const stubs = new Map();
	disabledToolNames.forEach((name, index) => {
		const file = join(stubDir, `tool-${index}.mjs`);
		const { exports, renderExports } = TOOL_MODULES[name];
		const body = [
			`// Inert stub for the "${name}" tool: this build flavor's tool set does not`,
			`// ship it (buildconfig.json "toolsetComponents"). The barrels still export`,
			`// the names so SDK imports resolve; the implementations are gone.`,
			`const excluded = () => { throw new Error("the ${name} tool is not included in this build"); };`,
			...exports.map((exportName) => `export const ${exportName} = excluded;`),
			`export const ${renderExports[0]} = {};`,
		];
		writeFileSync(file, `${body.join("\n")}\n`);
		stubs.set(name, file);
	});

	return {
		plugin: {
			name: "builtin-tool-stubs",
			setup(build) {
				// One hook for both barrels: the tool barrel and the renderer barrel
				// write the same `./<tool>.js` specifier from different directories,
				// so the importer decides which namespace the stub lands in.
				build.onResolve({ filter: /^\.\/(bash|edit|find|grep|ls|powershell|read|write)\.js$/ }, (args) => {
					const name = args.path.slice(2, -3);
					const stub = stubs.get(name);
					if (stub === undefined) return undefined;
					// A tool module never imports its own specifier, so an importer equal
					// to the target module is a stub resolving itself: leave it to the
					// default resolver instead of looping back into the stub.
					const ownModulePath = args.importer.includes(`${sep}renderers${sep}`) ? rendererModulePath : toolModulePath;
					if (args.importer === ownModulePath(name)) return { path: args.path, namespace: "file" };
					const namespace = ownModulePath === rendererModulePath ? RENDERER_NAMESPACE : IMPLEMENTATION_NAMESPACE;
					return { path: stub, namespace };
				});
				build.onLoad({ filter: /.*/, namespace: IMPLEMENTATION_NAMESPACE }, (args) => ({
					contents: readFileSync(args.path, "utf8"),
					loader: "js",
				}));
				build.onLoad({ filter: /.*/, namespace: RENDERER_NAMESPACE }, (args) => ({
					contents: readFileSync(args.path, "utf8"),
					loader: "js",
				}));
			},
		},
		excluded: disabledToolNames,
	};
}

function inertPlugin() {
	return { name: "builtin-tool-stubs", setup() {} };
}
