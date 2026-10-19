import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `packages/ai/src/providers/data/` and the `*.models.ts` shards next to it are
// generated from upstream catalogs and gitignored, so a fresh checkout does not
// have them. Without them the shards import the JSON as `unknown`, and `tsc`
// reports about a thousand unrelated-looking errors across every consumer. Fail
// early with the command that fixes it instead.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const aggregatorPath = join(repoRoot, "packages", "ai", "src", "models.generated.ts");
const manifestPath = join(repoRoot, "packages", "ai", "src", "providers", "data", ".manifest.json");

function installHint(message, command) {
	console.error([message, "", `Run \`${command}\` from the repository root.`].join("\n"));
	process.exit(1);
}

if (!existsSync(aggregatorPath)) {
	installHint("packages/ai/src/models.generated.ts is missing.", "pnpm run generate:models");
}

// A build with no built-in provider ships a manifest-only data directory. That
// is a recorded decision, not missing data.
if (readFileSync(aggregatorPath, "utf8").includes("// no-builtin-providers")) process.exit(0);

if (!existsSync(manifestPath)) {
	installHint(
		"Generated model data is missing: `packages/ai/src/providers/data/.manifest.json`.\n" +
			"That directory is gitignored, so a fresh checkout has to materialize it.",
		"pnpm run hydrate:model-data",
	);
}
