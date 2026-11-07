import { strictEqual, throws } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	createNarrowOpenAIClientPlugin,
	NARROW_CLIENT_API_SET,
	usesNarrowOpenAIClient,
} from "./build-openai-client.mjs";

let tempDirs = [];

/**
 * A stand-in package root with the narrow client under `tree`, named with the
 * extension that tree holds (`dist` is compiled `.js`, `src` is `.ts`).
 */
function tempAiDir({ tree = "dist", withClient = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-narrow-openai-test-"));
	tempDirs.push(dir);
	if (withClient) {
		const extension = tree === "dist" ? ".js" : ".ts";
		mkdirSync(join(dir, tree, "api"), { recursive: true });
		writeFileSync(join(dir, tree, "api", `openai-chat-completions-client${extension}`), "export default class {}\n");
	}
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
	tempDirs = [];
});

/**
 * Runs the plugin's resolve hook the way esbuild would for one import: esbuild
 * only calls the hook when its filter matches, so the filter is applied here.
 */
function resolveWith(plugin, args) {
	let handler;
	let filter;
	plugin.setup({
		onResolve: (options, callback) => {
			filter = options.filter;
			handler = callback;
		},
	});
	if (!filter.test(args.path)) return undefined;
	return handler(args);
}

describe("narrow openai client scope", () => {
	it("swaps the client only for the openai-completions API set alone", () => {
		strictEqual(usesNarrowOpenAIClient(["openai-completions"]), true);
		strictEqual(usesNarrowOpenAIClient([...NARROW_CLIENT_API_SET]), true);
	});

	it("keeps the full SDK for an API set that uses another resource", () => {
		// base ships these; each one uses a part of the SDK the narrow client omits.
		strictEqual(usesNarrowOpenAIClient(["openai-completions", "openai-responses"]), false);
		strictEqual(usesNarrowOpenAIClient(["openai-completions", "azure-openai-responses"]), false);
		strictEqual(usesNarrowOpenAIClient(["openai-completions", "openrouter-images"]), false);
		strictEqual(usesNarrowOpenAIClient(["__ALL__"]), false);
		strictEqual(usesNarrowOpenAIClient([]), false);
	});
});

describe("narrow openai client plugin", () => {
	it("resolves the bare specifier to the client of the tree being bundled", () => {
		const distDir = tempAiDir({ tree: "dist" });
		// A build reads `dist`, so the stand-in is the compiled sibling.
		const distPlugin = createNarrowOpenAIClientPlugin({ aiDir: distDir, mode: "dist", enabled: true });
		const distResolved = resolveWith(distPlugin, { path: "openai", importer: "", kind: "import-statement" });
		strictEqual(distResolved.path, join(distDir, "dist", "api", "openai-chat-completions-client.js"));

		// The size check has no build to read, so it bundles `src` instead.
		const srcDir = tempAiDir({ tree: "src" });
		const srcPlugin = createNarrowOpenAIClientPlugin({ aiDir: srcDir, mode: "src", enabled: true });
		const srcResolved = resolveWith(srcPlugin, { path: "openai", importer: "", kind: "import-statement" });
		strictEqual(srcResolved.path, join(srcDir, "src", "api", "openai-chat-completions-client.ts"));
	});

	it("resolves subpaths and other specifiers unchanged", () => {
		const aiDir = tempAiDir();
		const plugin = createNarrowOpenAIClientPlugin({ aiDir, mode: "dist", enabled: true });

		// Only the barrel: subpath imports name one module already, and the filter
		// is anchored so `openai/...` never matches.
		strictEqual(resolveWith(plugin, { path: "openai/resources/chat/completions.js" }), undefined);
	});

	it("registers nothing when the flavor keeps the full SDK", () => {
		const aiDir = tempAiDir({ withClient: false });
		const plugin = createNarrowOpenAIClientPlugin({ aiDir, mode: "dist", enabled: false });
		// An empty setup never calls onResolve, and a missing client must not throw.
		plugin.setup({ onResolve: () => throws(new Error("hook registered")) });
	});

	it("fails the build when the compiled client is missing", () => {
		const aiDir = tempAiDir({ tree: "dist", withClient: false });
		throws(
			() => createNarrowOpenAIClientPlugin({ aiDir, mode: "dist", enabled: true }),
			/Build the workspace packages first/,
		);
	});

	it("fails the check when the unconverted client is missing", () => {
		const aiDir = tempAiDir({ tree: "src", withClient: false });
		throws(
			() => createNarrowOpenAIClientPlugin({ aiDir, mode: "src", enabled: true }),
			/tracked in git; restore it/,
		);
	});

	it("rejects an unknown tree instead of guessing an extension", () => {
		const aiDir = tempAiDir();
		throws(() => createNarrowOpenAIClientPlugin({ aiDir, mode: "build", enabled: true }), /Unknown narrow openai client mode/);
	});
});
