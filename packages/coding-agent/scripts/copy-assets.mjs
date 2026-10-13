#!/usr/bin/env node
/**
 * Copies package assets into dist/ (replaces the former shx one-liner).
 *
 * The export-html templates and the webui build are peripheral components
 * controlled by buildconfig.json flavors (--flavor / NANOPI_BUILD_FLAVOR); a
 * flavor that disables them ships dist/ without them and the runtime reports
 * them as not included.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildFlavor } from "../../../scripts/buildconfig.mjs";
import { resolveBundledExtras } from "../../../scripts/extras.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(scriptDir, "..");
const repoRoot = join(packageDir, "..", "..");
const distDir = join(packageDir, "dist");

const { flavor, components } = resolveBuildFlavor(repoRoot, {
	argv: process.argv,
	env: process.env,
});

function copyTree(sourceDir, targetDir) {
	mkdirSync(targetDir, { recursive: true });
	cpSync(sourceDir, targetDir, { recursive: true });
}

if (components["export-html"] !== false) {
	const source = join(packageDir, "src", "core", "export-html");
	const target = join(distDir, "core", "export-html");
	mkdirSync(target, { recursive: true });
	for (const file of ["template.html", "template.css", "template.js"]) {
		copyFileSync(join(source, file), join(target, file));
	}
	copyTree(join(source, "vendor"), join(target, "vendor"));
} else {
	console.log("export-html templates skipped (flavor: %s)", flavor);
}

if (components["webui"] !== false) {
	const webuiDist = join(packageDir, "..", "webui", "dist");
	mkdirSync(join(distDir, "webui"), { recursive: true });
	if (existsSync(webuiDist)) {
		copyTree(webuiDist, join(distDir, "webui"));
	} else {
		// Matched the previous shx behavior: tolerate a missing webui build so
		// partial checkouts can still build the CLI.
		console.warn("webui dist missing, skipped");
	}
} else {
	console.log("webui assets skipped (flavor: %s)", flavor);
}

// Bundled extras: one directory per enabled extra/<name> component. The
// published tarball does not carry the extras source, so tolerate its absence
// (nothing to copy) instead of failing partial checkouts.
const extras = resolveBundledExtras({ repoRoot, components });
for (const extra of extras) {
	copyTree(extra.sourceDir, join(distDir, "extras", extra.name));
}
if (extras.length > 0) {
	console.log("extras: %s (flavor: %s)", extras.map((extra) => extra.name).join(", "), flavor);
}
