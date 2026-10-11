import { readFileSync } from "node:fs";
import { stripBom } from "../utils/text.ts";

export interface NanoPiManifest {
	extensions?: string[];
	skills?: string[];
	prompts?: string[];
	themes?: string[];
	changelogPath?: string;
}

const RESOURCE_FIELDS = ["extensions", "skills", "prompts", "themes"] as const;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readNanoPiManifest(packageJsonPath: string): NanoPiManifest | null {
	try {
		const pkg: unknown = JSON.parse(stripBom(readFileSync(packageJsonPath, "utf-8")));
		if (!isObject(pkg)) {
			return null;
		}
		// "nanopi" is canonical; the upstream "pi" field stays readable so
		// pi-ecosystem packages (vendored extras and user installs alike) keep
		// declaring their resources without a fork-specific manifest change.
		const manifestSource = isObject(pkg.nanopi) ? pkg.nanopi : isObject(pkg.pi) ? pkg.pi : null;
		if (!manifestSource) {
			return null;
		}

		const manifest: NanoPiManifest = {};
		for (const field of RESOURCE_FIELDS) {
			const entries = manifestSource[field];
			if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string")) {
				manifest[field] = entries;
			}
		}

		const changelogPath = manifestSource.changelogPath;
		if (typeof changelogPath === "string") {
			manifest.changelogPath = changelogPath;
		}

		return manifest;
	} catch {
		return null;
	}
}
