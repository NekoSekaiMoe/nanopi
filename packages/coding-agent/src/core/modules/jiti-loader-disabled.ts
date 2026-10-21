/**
 * Stand-in for `jiti-loader.ts` in builds that drop the `jiti-modules`
 * component (the `minimal` flavor, and every single-file build).
 *
 * The export set has to match the module it replaces; `validateComponentStubExports`
 * in scripts/build-components.mjs fails the build otherwise. A build without
 * disk modules reports "no", and the other two are unreachable — they exist so
 * the type surface stays identical.
 */

import type { SessionModule } from "./types.ts";

export const ENV_MODULES = "NANOPI_EXTENSIONS";

export function diskModulesIncluded(): boolean {
	return false;
}

export function resolveModulePaths(): string[] {
	return [];
}

export interface DiskModuleScan {
	files: string[];
	missing: string[];
	directories: string[];
}

export interface ScanDiskModulesOptions {
	cwd: string;
	agentDir: string;
	projectTrusted: boolean;
}

export function scanDiskModules(): DiskModuleScan {
	return { files: [], missing: [], directories: [] };
}

export interface LoadDiskModulesResult {
	modules: SessionModule[];
	errors: Array<{ path: string; error: string }>;
}

export async function loadDiskModules(): Promise<LoadDiskModulesResult> {
	return { modules: [], errors: [] };
}
