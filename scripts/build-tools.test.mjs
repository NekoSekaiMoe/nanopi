import assert, { deepStrictEqual, strictEqual, throws } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createToolStubPlugin, validateToolSet } from "./build-tools.mjs";

const toolsSrcDir = "/repo/packages/coding-agent/src/core/tools";
let tempDirs = [];

function stubDir() {
	const dir = mkdtempSync(join(tmpdir(), "nanopi-tool-stubs-test-"));
	tempDirs.push(dir);
	return dir;
}

/**
 * Runs the plugin's resolve hooks the way esbuild would for one import: every
 * hook whose filter matches, first non-undefined result wins.
 */
function resolveWith(plugin, args) {
	const hooks = [];
	const build = {
		onResolve: (_options, callback) => hooks.push(callback),
		onLoad: () => {},
	};
	plugin.setup(build);
	for (const hook of hooks) {
		const result = hook(args);
		if (result !== undefined) return result;
	}
	return undefined;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("validateToolSet", () => {
	it("accepts a set that lists known tools or none at all", () => {
		assert.doesNotThrow(() => validateToolSet(undefined));
		assert.doesNotThrow(() => validateToolSet(["bash", "powershell"]));
	});

	it("rejects a tool without an implementation", () => {
		throws(() => validateToolSet(["bash", "sandbox"]), /tools without an implementation: sandbox/);
	});
});

describe("createToolStubPlugin", () => {
	it("stubs nothing when the tool set is absent", () => {
		const { plugin, excluded } = createToolStubPlugin({ stubDir: stubDir(), toolsSrcDir, toolNames: undefined });
		deepStrictEqual(excluded, []);
		strictEqual(resolveWith(plugin, { path: "./read.js", importer: join(toolsSrcDir, "index.js") }), undefined);
	});

	it("reports the tools the set leaves out", () => {
		const { excluded } = createToolStubPlugin({ stubDir: stubDir(), toolsSrcDir, toolNames: ["bash"] });
		deepStrictEqual(excluded.sort(), ["edit", "find", "grep", "ls", "powershell", "read", "write"]);
	});

	it("keeps a tool the set names", () => {
		const { plugin } = createToolStubPlugin({ stubDir: stubDir(), toolsSrcDir, toolNames: ["bash"] });
		strictEqual(
			resolveWith(plugin, { path: "./bash.js", importer: join(toolsSrcDir, "index.js") }),
			undefined,
		);
	});

	it("rewrites the barrel import of an excluded tool", () => {
		const { plugin } = createToolStubPlugin({ stubDir: stubDir(), toolsSrcDir, toolNames: ["bash"] });
		const result = resolveWith(plugin, { path: "./read.js", importer: join(toolsSrcDir, "index.js") });
		assert.ok(result?.path.endsWith("tool-3.mjs") || result?.path.includes("tool-"));
		strictEqual(result?.namespace, "builtin-tool-stub");
	});

	it("rewrites the renderer barrel import into the renderer namespace", () => {
		const { plugin } = createToolStubPlugin({ stubDir: stubDir(), toolsSrcDir, toolNames: ["bash"] });
		const result = resolveWith(plugin, { path: "./read.js", importer: join(toolsSrcDir, "renderers", "index.js") });
		strictEqual(result?.namespace, "builtin-tool-renderer-stub");
	});

	it("stubs another excluded tool imported from a tool module", () => {
		const { plugin } = createToolStubPlugin({ stubDir: stubDir(), toolsSrcDir, toolNames: ["bash"] });
		// `read.ts` imports `./truncate.js`, and a tool may import another tool's
		// module; only its own specifier has to stay out of the stub.
		strictEqual(resolveWith(plugin, { path: "./find.js", importer: join(toolsSrcDir, "read.js") })?.namespace, "builtin-tool-stub");
	});

	it("does not loop a stub back into itself", () => {
		const { plugin } = createToolStubPlugin({ stubDir: stubDir(), toolsSrcDir, toolNames: ["bash"] });
		strictEqual(resolveWith(plugin, { path: "./read.js", importer: join(toolsSrcDir, "read.js") })?.namespace, "file");
	});

	it("writes stubs that export the barrel's names", () => {
		const dir = stubDir();
		const { plugin } = createToolStubPlugin({ stubDir: dir, toolsSrcDir, toolNames: ["bash"] });
		const result = resolveWith(plugin, { path: "./read.js", importer: join(toolsSrcDir, "index.js") });
		const stub = readFileSync(result.path, "utf8");
		assert.match(stub, /export const createReadTool = excluded;/);
		assert.match(stub, /export const createReadToolDefinition = excluded;/);
		assert.match(stub, /export const readRenderers = \{\};/);
	});
});
