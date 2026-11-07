import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	ASSETS_COMPLETE_MARKER,
	ASSETS_HASH_MARKER,
	extractAssetsPayload,
	syncAssetsPayload,
} from "../src/standalone/assets.ts";
import {
	type BuiltinSidecarFile,
	ensureSidecars,
	installBuiltinSidecarFiles,
	installSidecarFiles,
	resetSidecarManifestCache,
	type SidecarFile,
	type SidecarManifest,
} from "../src/utils/sidecars.ts";
import { allowNetwork } from "./test-network-env.ts";

let testRoot: string;

beforeAll(() => {
	testRoot = mkdtempSync(join(tmpdir(), "nanopi-standalone-test-"));
});

afterAll(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

function makeAssetsPayload(files: Record<string, string>): string {
	return gzipSync(Buffer.from(JSON.stringify(files))).toString("base64");
}

describe("extractAssetsPayload", () => {
	it("extracts all files and writes the completion marker", () => {
		const target = join(testRoot, "assets-ok");
		extractAssetsPayload(
			makeAssetsPayload({
				"package.json": Buffer.from('{"version":"1.2.3"}').toString("base64"),
				"dist/webui/index.html": Buffer.from("<html></html>").toString("base64"),
			}),
			target,
		);
		expect(readFileSync(join(target, "package.json"), "utf8")).toBe('{"version":"1.2.3"}');
		expect(readFileSync(join(target, "dist/webui/index.html"), "utf8")).toBe("<html></html>");
		expect(existsSync(join(target, ASSETS_COMPLETE_MARKER))).toBe(true);
	});

	it("replaces a stale incomplete target directory", () => {
		const target = join(testRoot, "assets-replace");
		mkdirSync(join(target, "leftover"), { recursive: true });
		writeFileSync(join(target, "leftover", "stale.txt"), "stale");
		extractAssetsPayload(makeAssetsPayload({ "a.txt": Buffer.from("a").toString("base64") }), target);
		expect(existsSync(join(target, "leftover", "stale.txt"))).toBe(false);
		expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("a");
	});
});

describe("syncAssetsPayload", () => {
	it("re-extracts a same-version tree whose payload content changed and keeps a current tree", () => {
		const target = join(testRoot, "assets-sync");
		const first = makeAssetsPayload({ "a.txt": Buffer.from("a").toString("base64") });
		expect(syncAssetsPayload(first, target)).toBe(true);
		expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("a");

		// Tree already current: nothing is rewritten, stray files survive.
		writeFileSync(join(target, "stray.txt"), "keep");
		expect(syncAssetsPayload(first, target)).toBe(true);
		expect(existsSync(join(target, "stray.txt"))).toBe(true);

		// Same version directory, rebuilt payload: the stale tree is replaced.
		const second = makeAssetsPayload({ "a.txt": Buffer.from("b").toString("base64") });
		expect(syncAssetsPayload(second, target)).toBe(true);
		expect(readFileSync(join(target, "a.txt"), "utf8")).toBe("b");
		expect(existsSync(join(target, "stray.txt"))).toBe(false);
		expect(existsSync(join(target, ASSETS_HASH_MARKER))).toBe(true);
	});
});

describe("installSidecarFiles", () => {
	function makeTarball(files: Record<string, Buffer>): { extractDir: string; tarballDir: string } {
		const tarballDir = mkdtempSync(join(testRoot, "src-"));
		const extractDir = mkdtempSync(join(testRoot, "extracted-"));
		for (const [path, content] of Object.entries(files)) {
			const fullPath = join(tarballDir, path);
			mkdirSync(dirname(fullPath), { recursive: true });
			writeFileSync(fullPath, content);
		}
		execFileSync("tar", ["-czf", `${tarballDir}.tgz`, "-C", tarballDir, "."]);
		execFileSync("tar", ["-xzf", `${tarballDir}.tgz`, "-C", extractDir]);
		rmSync(tarballDir, { recursive: true, force: true });
		return { extractDir, tarballDir };
	}

	function sidecarFor(content: Buffer, overrides: Partial<SidecarFile> = {}): SidecarFile {
		return {
			kind: "photon-wasm",
			tarPath: "package/photon_rs_bg.wasm",
			destPath: "photon/photon_rs_bg.wasm",
			sha256: createHash("sha256").update(content).digest("hex"),
			bytes: content.byteLength,
			...overrides,
		};
	}

	it("installs files with matching checksums", () => {
		const content = Buffer.from("wasm-bytes");
		const { extractDir } = makeTarball({ "package/photon_rs_bg.wasm": content });
		const binDir = join(testRoot, "bin-ok");
		installSidecarFiles(extractDir, [sidecarFor(content)], binDir);
		expect(readFileSync(join(binDir, "photon", "photon_rs_bg.wasm"))).toEqual(content);
	});

	it("rejects files whose checksum does not match", () => {
		const content = Buffer.from("wasm-bytes");
		const { extractDir } = makeTarball({ "package/photon_rs_bg.wasm": Buffer.from("tampered") });
		const binDir = join(testRoot, "bin-mismatch");
		expect(() => installSidecarFiles(extractDir, [sidecarFor(content)], binDir)).toThrow(/checksum mismatch/);
		expect(existsSync(join(binDir, "photon", "photon_rs_bg.wasm"))).toBe(false);
	});

	it("rejects manifests referencing files missing from the tarball", () => {
		const { extractDir } = makeTarball({ "package/other.txt": Buffer.from("x") });
		const binDir = join(testRoot, "bin-missing");
		expect(() =>
			installSidecarFiles(extractDir, [sidecarFor(Buffer.from("x"), { tarPath: "package/absent.wasm" })], binDir),
		).toThrow(/missing from tarball/);
	});
});

describe("installBuiltinSidecarFiles", () => {
	function builtinFor(content: Buffer, overrides: Partial<BuiltinSidecarFile> = {}): BuiltinSidecarFile {
		return {
			kind: "tui-native",
			destPath: "native/tui/test.node",
			sha256: createHash("sha256").update(content).digest("hex"),
			bytes: content.byteLength,
			content: content.toString("base64"),
			...overrides,
		};
	}

	it("installs embedded files with matching checksums", () => {
		const content = Buffer.from("node-bytes");
		const binDir = join(testRoot, "builtin-ok");
		installBuiltinSidecarFiles([builtinFor(content)], binDir);
		expect(readFileSync(join(binDir, "native", "tui", "test.node"))).toEqual(content);
	});

	it("skips files that are already installed", () => {
		const content = Buffer.from("node-bytes");
		const binDir = join(testRoot, "builtin-skip");
		installBuiltinSidecarFiles([builtinFor(content)], binDir);
		const target = join(binDir, "native", "tui", "test.node");
		writeFileSync(target, content);
		installBuiltinSidecarFiles([builtinFor(content)], binDir);
		expect(readFileSync(target)).toEqual(content);
	});

	it("overwrites files whose installed checksum differs", () => {
		const content = Buffer.from("node-bytes");
		const binDir = join(testRoot, "builtin-repair");
		mkdirSync(join(binDir, "native", "tui"), { recursive: true });
		writeFileSync(join(binDir, "native", "tui", "test.node"), Buffer.from("stale-bytes!"));
		installBuiltinSidecarFiles([builtinFor(content)], binDir);
		expect(readFileSync(join(binDir, "native", "tui", "test.node"))).toEqual(content);
	});

	it("skips files for other platforms", () => {
		const otherOs = process.platform === "linux" ? "darwin" : "linux";
		const binDir = join(testRoot, "builtin-platform");
		installBuiltinSidecarFiles([builtinFor(Buffer.from("x"), { os: otherOs })], binDir);
		expect(existsSync(join(binDir, "native", "tui", "test.node"))).toBe(false);
	});

	it("rejects embedded files whose checksum does not match", () => {
		const binDir = join(testRoot, "builtin-mismatch");
		const file = builtinFor(Buffer.from("node-bytes"));
		file.content = Buffer.from("node-bytez").toString("base64");
		expect(() => installBuiltinSidecarFiles([file], binDir)).toThrow(/checksum mismatch/);
		expect(existsSync(join(binDir, "native", "tui", "test.node"))).toBe(false);
	});
});

describe("ensureSidecars mirror fallback", () => {
	// The TUI prebuilds are published twice (GitHub Releases and AtomGit); the
	// bundle knows both URLs, so a host that is down for the reader costs one
	// failed request instead of a silently missing native clipboard.
	let server: Server;
	let baseUrl: string;
	const requests: string[] = [];

	// The suite runs with NANOPI_OFFLINE=1 by default, which sends ensureSidecars
	// through the host probe before it downloads anything. The fixture gives that
	// probe a real answer, so a case testing the download path (whose URLs point at
	// this server) needs no env change; the cases that set offline themselves race
	// a tag nothing listens on. A hook here would run before the file-level env is
	// applied and be overwritten.
	beforeAll(async () => {
		const content = Buffer.alloc(10, "x");
		const tree = mkdtempSync(join(testRoot, "serve-"));
		mkdirSync(join(tree, "native", "tui"), { recursive: true });
		writeFileSync(join(tree, "native", "tui", "test.node"), content);
		const archivePath = join(testRoot, "serve.tgz");
		execFileSync("tar", ["-czf", archivePath, "-C", tree, "native"]);
		const archive = readFileSync(archivePath);

		server = createServer((request, response) => {
			const url = request.url ?? "";
			requests.push(url);
			// Everything except the served archive answers 404, mirroring a host
			// that has the tag but not the file yet.
			if (!url.endsWith("/alive.tgz")) {
				response.writeHead(404);
				response.end("not found");
				return;
			}
			response.writeHead(200, { "content-length": String(archive.byteLength) });
			response.end(archive);
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const address = server.address();
		if (address === null || typeof address === "string") throw new Error("test server did not bind a port");
		baseUrl = `http://127.0.0.1:${address.port}`;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	// Two caches stand between a case and a clean install, so each case starts by
	// clearing both. The manifest is memoized for the process lifetime (one entry
	// per case keeps the next case from reusing the previous one's promise, which
	// ensureSidecars keeps while it is in flight).
	let caseNumber = 0;

	function nextCase(): void {
		caseNumber++;
		resetSidecarManifestCache();
	}

	function manifest(urls: string[], byteLength = 10): SidecarManifest {
		const content = Buffer.alloc(byteLength, "x");
		return {
			sources: [
				{
					packageName: `@nanopi/pi-tui-${caseNumber++}`,
					version: "1.0.0",
					urls,
					files: [
						{
							kind: "tui-native",
							tarPath: "native/tui/test.node",
							destPath: "native/tui/test.node",
							sha256: createHash("sha256").update(content).digest("hex"),
							bytes: content.byteLength,
							os: process.platform,
							arch: process.arch,
						},
					],
				},
			],
		};
	}

	async function withSidecars<T>(value: SidecarManifest, run: () => Promise<T>): Promise<T> {
		// NANOPI_SIDECARS is a build-time define, not something the runtime sets;
		// assigning it on globalThis is the only way to exercise the download path.
		const globals = globalThis as { NANOPI_SIDECARS?: string };
		const previous = globals.NANOPI_SIDECARS;
		globals.NANOPI_SIDECARS = JSON.stringify(value);
		try {
			return await run();
		} finally {
			if (previous === undefined) delete globals.NANOPI_SIDECARS;
			else globals.NANOPI_SIDECARS = previous;
		}
	}

	// ensureSidecars resolves the bin dir through getAgentDir() on every call, so a
	// test that wants a clean install points it somewhere new.
	function useAgentDir(name: string): string {
		const agentDir = join(testRoot, `agent-${name}`);
		process.env.NANOPI_CODING_AGENT_DIR = agentDir;
		return agentDir;
	}

	it("tries the next mirror after a failing one and installs from it", async () => {
		allowNetwork();
		nextCase();
		requests.length = 0;
		const agentDir = useAgentDir("fallback");
		await withSidecars(manifest([`${baseUrl}/dead.tgz`, `${baseUrl}/alive.tgz`]), () => ensureSidecars());
		expect(requests).toEqual(["/dead.tgz", "/alive.tgz"]);
		expect(readFileSync(join(agentDir, "bin", "native", "tui", "test.node"))).toEqual(Buffer.alloc(10, "x"));
	});

	it("installs from a host that answers while offline mode is set", async () => {
		// Offline mode is a statement about the machine's network, not a per-host
		// switch: a container that sets NANOPI_OFFLINE=1 to keep startup quiet still
		// reaches the mirror. `full` embeds no sidecar, so refusing here is what left
		// the photon wasm permanently missing (#586).
		nextCase();
		requests.length = 0;
		const agentDir = useAgentDir("offline-reachable");
		await withSidecars(manifest([`${baseUrl}/alive.tgz`]), () => ensureSidecars());
		expect(requests).toContain("/alive.tgz");
		expect(readFileSync(join(agentDir, "bin", "native", "tui", "test.node"))).toEqual(Buffer.alloc(10, "x"));
	});

	it("skips the download when offline mode is set and no host answers", async () => {
		nextCase();
		requests.length = 0;
		const agentDir = useAgentDir("offline-unreachable");
		const warnings: string[] = [];
		// Nothing listens on the reserved discard port, so the probe fails fast and
		// the download is never attempted.
		await withSidecars(manifest(["http://127.0.0.1:9/dead.tgz"]), () =>
			ensureSidecars({ onStatus: (status) => warnings.push(status.message) }),
		);
		expect(requests).toEqual([]);
		expect(warnings.at(-1)).toMatch(/offline mode and no host answered/);
		expect(existsSync(join(agentDir, "bin", "native", "tui", "test.node"))).toBe(false);
	});

	it("reports every host it tried when all of them fail", async () => {
		allowNetwork();
		nextCase();
		requests.length = 0;
		const warnings: string[] = [];
		// A different byte length: the size check skips a download whose target is
		// already installed, so the two cases would otherwise install the same file.
		useAgentDir("all-dead");
		await withSidecars(manifest([`${baseUrl}/dead.tgz`, `${baseUrl}/other-dead.tgz`], 11), () =>
			ensureSidecars({ onStatus: (status) => warnings.push(status.message) }),
		);
		expect(requests).toEqual(["/dead.tgz", "/other-dead.tgz"]);
		expect(warnings.at(-1)).toMatch(
			/dead\.tgz: download failed: HTTP 404.*other-dead\.tgz: download failed: HTTP 404/,
		);
	});
});
