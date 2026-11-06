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

function tempAiDist({ withClient = true } = {}) {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-narrow-openai-test-"));
	tempDirs.push(dir);
	if (withClient) {
		mkdirSync(join(dir, "api"), { recursive: true });
		writeFileSync(join(dir, "api", "openai-chat-completions-client.js"), "export default class {}\n");
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
	it("resolves the bare specifier to the compiled client", () => {
		const aiDistDir = tempAiDist();
		const plugin = createNarrowOpenAIClientPlugin({ aiDistDir, enabled: true });

		const resolved = resolveWith(plugin, { path: "openai", importer: "", kind: "import-statement" });
		strictEqual(resolved.path, join(aiDistDir, "api", "openai-chat-completions-client.js"));
		// Only the barrel: subpath imports name one module already, and the filter
		// is anchored so `openai/...` never matches.
		strictEqual(resolveWith(plugin, { path: "openai/resources/chat/completions.js" }), undefined);
	});

	it("registers nothing when the flavor keeps the full SDK", () => {
		const aiDistDir = tempAiDist({ withClient: false });
		const plugin = createNarrowOpenAIClientPlugin({ aiDistDir, enabled: false });
		// An empty setup never calls onResolve, and a missing client must not throw.
		plugin.setup({ onResolve: () => throws(new Error("hook registered")) });
	});

	it("fails the build when the compiled client is missing", () => {
		const aiDistDir = tempAiDist({ withClient: false });
		throws(() => createNarrowOpenAIClientPlugin({ aiDistDir, enabled: true }), /Build the workspace packages first/);
	});
});
