import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ASSETS_COMPLETE_MARKER, extractAssetsPayload } from "../src/standalone/assets.ts";
import { installSidecarFiles, type SidecarFile } from "../src/utils/sidecars.ts";

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
