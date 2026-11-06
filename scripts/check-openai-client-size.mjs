#!/usr/bin/env node
/**
 * Guards the narrowed `openai` surface of a trimmed build.
 *
 * The minimal single file swaps the SDK barrel for
 * `packages/ai/src/api/openai-chat-completions-client.ts`
 * (scripts/build-openai-client.mjs), which is worth ~1.3 MiB of inputs. Two
 * ways that regresses silently:
 *
 * - the swap stops happening (a flavor gains an API that needs the full SDK,
 *   or the plugin is dropped from a build script), so the barrel comes back;
 * - the narrow client starts importing more of the SDK than the
 *   chat-completions request path needs.
 *
 * A dependency bump can also grow either one without touching this repository
 * at all, which is how the 119 KiB in #540 arrived. This check bundles the API
 * implementation that the swap serves and reports the bytes the `openai`
 * package contributes, so both show up as a number rather than as a release
 * artifact nobody weighed.
 *
 * The budget is generous on purpose: it is a tripwire for an order-of-magnitude
 * regression, not a byte-for-byte lock (an SDK release legitimately moves this
 * by a few KiB). Raise it with the measurement in the commit message.
 */

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createNarrowOpenAIClientPlugin, usesNarrowOpenAIClient } from "./build-openai-client.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const aiDistDir = join(repoRoot, "packages", "ai", "dist");

/** Bytes the `openai` package may contribute to the narrowed request path. */
const OPENAI_BUDGET_BYTES = 300 * 1024;

const entry = join(aiDistDir, "api", "openai-completions.js");

if (!usesNarrowOpenAIClient(["openai-completions"])) {
	throw new Error("the openai-completions API set no longer selects the narrow openai client");
}

const result = await build({
	absWorkingDir: repoRoot,
	bundle: true,
	entryPoints: [entry],
	format: "esm",
	logLevel: "silent",
	metafile: true,
	platform: "node",
	plugins: [createNarrowOpenAIClientPlugin({ aiDistDir, enabled: true })],
	tsconfigRaw: { compilerOptions: {} },
	write: false,
});

const openaiInputs = Object.entries(result.metafile.inputs).filter(([input]) =>
	input.replaceAll("\\", "/").includes("/openai/"),
);
const bytes = openaiInputs.reduce((total, [, info]) => total + (info.bytes ?? 0), 0);
const kib = Math.round(bytes / 1024);

if (bytes > OPENAI_BUDGET_BYTES) {
	throw new Error(
		`openai contributes ${kib} KiB to the narrowed chat-completions bundle, over the ${Math.round(
			OPENAI_BUDGET_BYTES / 1024,
		)} KiB budget (${openaiInputs.length} modules). Either the narrow client imports more of the SDK than the request path needs, or the barrel is back.`,
	);
}

console.log(`openai in the narrowed chat-completions bundle: ${kib} KiB over ${openaiInputs.length} modules`);
