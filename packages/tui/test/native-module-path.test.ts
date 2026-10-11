import assert from "node:assert/strict";
import { test } from "node:test";
import { getNativeModuleCandidates } from "../src/native-module-path.ts";

test("sidecar root env var adds a candidate path", () => {
	const previous = process.env.NANOPI_TUI_NATIVE_ROOT;
	try {
		const nativePath = "native/darwin/prebuilds/darwin-arm64/darwin-platform.node";
		const without = getNativeModuleCandidates(nativePath);
		process.env.NANOPI_TUI_NATIVE_ROOT = "/tmp/sidecar-root";
		const withRoot = getNativeModuleCandidates(nativePath);
		assert.ok(withRoot.includes(`/tmp/sidecar-root/${nativePath.replaceAll("\\", "/")}`));
		assert.equal(withRoot.length, without.length + 1);
	} finally {
		if (previous === undefined) {
			delete process.env.NANOPI_TUI_NATIVE_ROOT;
		} else {
			process.env.NANOPI_TUI_NATIVE_ROOT = previous;
		}
	}
});
