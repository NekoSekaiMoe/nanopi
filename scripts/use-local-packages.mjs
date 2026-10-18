#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { wireConsumer } from "./local-package-install.mjs";
import { readArtifactSet } from "./package-artifacts.mjs";

function printUsage() {
	console.log(`Usage: node scripts/use-local-packages.mjs --manifest <path> --consumer <dir> --package <name> [--package <name> ...]

Updates an external project's package configuration to use direct packages and
all transitive nanopi packages from a local package artifact set.
`);
}

const { values } = parseArgs({
	options: {
		consumer: { type: "string" },
		help: { type: "boolean", default: false },
		manifest: { type: "string" },
		package: { type: "string", multiple: true, default: [] },
	},
});
if (values.help) {
	printUsage();
	process.exit(0);
}
if (!values.manifest) throw new Error("--manifest is required");
if (!values.consumer) throw new Error("--consumer is required");
if (values.package.length === 0) throw new Error("At least one --package is required");

const artifactSet = readArtifactSet(resolve(values.manifest));
const consumerDirectory = resolve(values.consumer);
wireConsumer({ artifactSet, consumerDirectory, packageNames: values.package });

console.log(`Updated ${consumerDirectory}/package.json from ${artifactSet.manifestPath}`);
console.log(`Run pnpm install --ignore-scripts in the consumer project.`);
