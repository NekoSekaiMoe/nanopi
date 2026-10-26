import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRequire = createRequire(import.meta.url);
const TUI_PACKAGE_NAME = "@nanopi/pi-tui";
// Every prebuild carries the same name: platforms differ in which unit was
// compiled (`-DNANOPI_PLATFORM_*`), not in the file the loader opens.
const NATIVE_FILE_NAME = "tui-platform.node";

export interface NativeModuleCandidateOptions {
	moduleUrl?: string;
	execPath?: string;
	resolvePackage?: (specifier: string) => string;
}

/** Prebuild path relative to the TUI package root, the sidecar root, or the agent bin dir. */
export function getNativeModulePath(platform: string, arch: string): string {
	return join("native", platform, "prebuilds", `${platform}-${arch}`, NATIVE_FILE_NAME);
}

export function getNativeModuleCandidates(nativePath: string, options: NativeModuleCandidateOptions = {}): string[] {
	const moduleDir = options.moduleUrl
		? dirname(fileURLToPath(options.moduleUrl))
		: dirname(fileURLToPath(import.meta.url));
	const candidates: string[] = [];

	// Sidecar root for single-file distributions: the coding-agent entrypoint
	// sets this to the agent bin directory where downloaded prebuilds live.
	const sidecarRoot = process.env.NANOPI_TUI_NATIVE_ROOT;
	if (sidecarRoot) {
		candidates.push(join(sidecarRoot, nativePath));
	}

	try {
		const packageEntry = (options.resolvePackage ?? moduleRequire.resolve)(TUI_PACKAGE_NAME);
		candidates.push(join(dirname(packageEntry), "..", nativePath));
	} catch {
		// Standalone binaries do not have an installed TUI package.
	}

	candidates.push(
		join(moduleDir, "..", nativePath),
		join(moduleDir, nativePath),
		join(dirname(options.execPath ?? process.execPath), nativePath),
	);
	return Array.from(new Set(candidates));
}
