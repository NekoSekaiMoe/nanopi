#!/usr/bin/env node
/**
 * Materializes the generated model catalogs when a checkout does not have them.
 *
 * `packages/ai/src/models.generated.ts`, the `*.models.ts` shards and
 * `packages/ai/src/providers/data/` are gitignored build products: every
 * `pnpm run build` regenerates them, so a checkout that never built has none,
 * and type checking then fails with unrelated-looking errors in every consumer.
 * The root scripts call this before the steps that need the catalogs instead of
 * asking every caller to remember an extra command.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
	join(packageRoot, "src", "models.generated.ts"),
	join(packageRoot, "src", "providers", "data", ".manifest.json"),
];

if (required.every((path) => existsSync(path))) process.exit(0);

console.error("Generating model catalogs (generated, gitignored, missing in this checkout)...");
const result = spawnSync(
	process.execPath,
	[
		"--import",
		join(packageRoot, "..", "..", "ts-import.mjs"),
		join(packageRoot, "scripts", "generate-models.ts"),
		"--strict",
	],
	{ cwd: packageRoot, stdio: "inherit" },
);
process.exit(result.status ?? 1);
