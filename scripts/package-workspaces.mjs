import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);

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
