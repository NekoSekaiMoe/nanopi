#!/usr/bin/env node
/**
 * Copies package assets into dist/ (replaces the former shx one-liner).
 *
 * The export-html templates and the webui build are peripheral components
 * controlled by buildconfig.json flavors; a flavor that disables them ships
 * dist/ without them and the runtime reports them as not included. The
 * Markdown export carries no asset tree of its own: its renderer reads the
 * session, not files.
 *
 * The flavor is read from `--flavor` only. NANOPI_BUILD_FLAVOR is ignored on
 * purpose: `pnpm run build` reaches this script through npm/pnpm, which put the
 * variable back into child processes, so an exported flavor would strip the
 * shared dist/ of assets a later unflavored build expects. The variable stays
 * the channel for the bundle and single-file builds, which read it themselves.
 */

import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBuildFlavor } from "../../../scripts/buildconfig.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = join(scriptDir, "..");
const repoRoot = join(packageDir, "..", "..");
const distDir = join(packageDir, "dist");

const { flavor, components } = resolveBuildFlavor(repoRoot, { env: {} });

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
