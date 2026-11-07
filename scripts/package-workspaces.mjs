import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Build output, not workspace packages. `next build` writes package.json files
// under .next that carry no name or version, and the release scripts read those
// fields, so a checkout that has built the webui must not discover them.
const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules", ".next"]);

// Vendored bundled extras directories (packages/coding-agent/src/extras/<name>)
// are jiti-loaded at runtime via loader aliases, not workspace packages: they
// must never be discovered as publishable packages or dependency-checked as
// public source. Any directory named "extras" is that mount point.
const SKIPPED_NESTED_DIRECTORIES = new Set(["extras"]);

export function findPackageDirectories(root = "packages") {
	const packageDirectories = [];

	function visit(directory) {
		if (existsSync(join(directory, "package.json"))) {
			packageDirectories.push(directory);
		}

		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			if (SKIPPED_NESTED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			visit(join(directory, entry.name));
		}
	}

	visit(root);
	return packageDirectories.sort();
}
