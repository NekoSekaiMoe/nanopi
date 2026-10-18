// Runs `pnpm audit --prod` and fails on advisories at or above the audit
// level, except for advisories that were reviewed and accepted below. Every
// accepted advisory must name the affected package and explain why it does not
// apply. Remove an entry once a fixed version is installed; the script warns
// about entries that no longer match.

import { spawnSync } from "node:child_process";

const auditLevel = "moderate";
const severities = ["info", "low", "moderate", "high", "critical"];

/** @type {Record<string, { package: string; reason: string }>} */
const acceptedAdvisories = {};

const result = spawnSync("pnpm", ["audit", "--prod", "--json"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) {
	throw result.error;
}

let report;
try {
	report = JSON.parse(result.stdout);
} catch {
	process.stderr.write(result.stderr);
	process.stderr.write(result.stdout);
	console.error("pnpm audit did not produce a JSON report.");
	process.exit(1);
}

if (report.error) {
	console.error(`pnpm audit failed: ${report.error.summary ?? JSON.stringify(report.error)}`);
	process.exit(1);
}

const minimumSeverity = severities.indexOf(auditLevel);
const seenAccepted = new Set();
const failures = new Map();

// pnpm keys the advisory map by advisory id; each entry names one package.
for (const advisory of Object.values(report.advisories ?? {})) {
	const id = advisory.id ?? advisory.url?.split("/").pop() ?? "unknown";
	const name = advisory.module_name ?? "unknown";
	const accepted = acceptedAdvisories[id];
	if (accepted && accepted.package === name) {
		seenAccepted.add(id);
		continue;
	}
	if (severities.indexOf(advisory.severity) >= minimumSeverity) {
		failures.set(`${id}:${name}`, advisory);
	}
}

for (const id of seenAccepted) {
	console.log(`Accepted ${id} (${acceptedAdvisories[id].package}): ${acceptedAdvisories[id].reason}`);
}

for (const id of Object.keys(acceptedAdvisories)) {
	if (!seenAccepted.has(id)) {
		console.log(`::warning::Accepted advisory ${id} no longer matches; remove it from scripts/dependency-audit.mjs.`);
	}
}

if (failures.size > 0) {
	console.error(`\nFound ${failures.size} unaccepted advisories at or above ${auditLevel}:`);
	for (const advisory of failures.values()) {
		console.error(`- ${advisory.module_name} ${advisory.vulnerable_versions} [${advisory.severity}] ${advisory.title} ${advisory.url}`);
	}
	process.exit(1);
}

console.log(`No unaccepted advisories at or above ${auditLevel}.`);
