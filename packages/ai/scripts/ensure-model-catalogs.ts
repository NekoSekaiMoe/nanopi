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
 *
 * "Missing" covers two states. Files that are not there at all, and a catalog a
 * narrower build flavor left behind: that one is complete and self-consistent
 * (see `findMissingShardNames`), so every catalog-shaped check passes on it
 * while `all.ts` imports shards it never wrote. The check is the checked-in
 * imports, not the catalog's own aggregator, because the aggregator records the
 * same narrow set the run wrote.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findMissingShardNames } from "./model-data.ts";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
	join(packageRoot, "src", "models.generated.ts"),
	join(packageRoot, "src", "providers", "data", ".manifest.json"),
];
const missingFiles = required.filter((path) => !existsSync(path));
const missingShards = findMissingShardNames(packageRoot);

if (missingFiles.length === 0 && missingShards.length === 0) process.exit(0);

console.error(
	missingFiles.length > 0
		? "Generating model catalogs (generated, gitignored, missing in this checkout)..."
		: `Generating model catalogs (${missingShards.length} imported provider shard(s) are missing: ${missingShards.join(", ")})...`,
);
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
