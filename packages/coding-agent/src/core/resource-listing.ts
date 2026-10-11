/**
 * Shared formatting for the loaded-resource listing (context files, skills, prompts,
 * extensions) shown by `/status`.
 *
 * Split out of InteractiveMode so the `/status` command (a built-in extension)
 * renders the same compact labels the startup page used to show. Pure string
 * formatting only: colors are applied by callers.
 */

import * as path from "node:path";
import { parseGitUrl } from "../utils/git.ts";
import { getCwdRelativePath } from "../utils/paths.ts";
import type { SourceInfo } from "./source-info.ts";

/** A loaded resource identified by a file path (or synthetic `builtin:` path). */
export interface ResourceItem {
	path: string;
	sourceInfo?: SourceInfo;
}

/** Replace the home directory prefix with `~`. */
export function formatDisplayPath(p: string, home: string): string {
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

/** Context-file label: relative to cwd when inside it, else `~`-abbreviated absolute. */
export function formatContextPath(p: string, cwd: string, home: string): string {
	const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
	const relativePath = getCwdRelativePath(absolutePath, cwd);
	if (relativePath !== undefined) {
		return relativePath;
	}
	return formatDisplayPath(absolutePath, home);
}

export function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

/**
 * Short path relative to the declaring package root for package resources,
 * otherwise the `~`-abbreviated path.
 */
export function getShortPath(fullPath: string, sourceInfo: SourceInfo | undefined, home: string): string {
	const normalizedFullPath = fullPath.replace(/\\/g, "/");
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
		const normalizedBaseDir = baseDir.replace(/\\/g, "/");
		const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
		// If fullPath is under the same node_modules root as baseDir, preserve that relative topology.
		if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
			return path.posix.relative(normalizedBaseDir, normalizedFullPath);
		}

		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}

	const source = sourceInfo?.source ?? "";
	const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch && source.startsWith("npm:")) {
		return npmMatch[2]!;
	}

	const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch && source.startsWith("git:")) {
		return gitMatch[1]!;
	}

	return formatDisplayPath(fullPath, home);
}

function getCompactPathLabel(resourcePath: string, sourceInfo: SourceInfo | undefined, home: string): string {
	const shortPath = getShortPath(resourcePath, sourceInfo, home);
	const normalizedPath = shortPath.replace(/\\/g, "/");
	const segments = normalizedPath.split("/").filter((segment) => segment.length > 0 && segment !== "~");
	if (segments.length > 0) {
		return segments[segments.length - 1]!;
	}
	return shortPath;
}

function getCompactPackageSourceLabel(sourceInfo: SourceInfo | undefined): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) {
		return source.slice("npm:".length) || source;
	}

	const gitSource = parseGitUrl(source);
	if (gitSource) {
		return gitSource.path || source;
	}

	return source;
}

function getCompactExtensionLabel(resourcePath: string, sourceInfo: SourceInfo | undefined, home: string): string {
	if (!isPackageSource(sourceInfo)) {
		return getCompactPathLabel(resourcePath, sourceInfo, home);
	}

	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) {
		return getCompactPathLabel(resourcePath, sourceInfo, home);
	}

	const shortPath = getShortPath(resourcePath, sourceInfo, home).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const parsedPath = path.posix.parse(packagePath);

	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}

	return `${sourceLabel}:${packagePath}`;
}

function getCompactDisplayPathSegments(resourcePath: string, home: string): string[] {
	return formatDisplayPath(resourcePath, home)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

function getCompactNonPackageExtensionLabel(
	resourcePath: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
	home: string,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) {
		return getCompactPathLabel(resourcePath, undefined, home);
	}

	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		const isUnique = allPaths.every((item, itemIndex) => {
			if (itemIndex === index) {
				return true;
			}
			return item.segments.slice(-segmentCount).join("/") !== candidate;
		});

		if (isUnique) {
			return candidate;
		}
	}

	return segments.join("/");
}

/**
 * Compact one-line labels for loaded extensions: package sources render as
 * `pkg:subdir`, local paths as their shortest unique trailing segments with
 * `index.ts`/`index.js` stripped.
 */
export function getCompactExtensionLabels(extensions: ResourceItem[], home: string): string[] {
	const nonPackageExtensions = extensions
		.map((extension) => {
			const segments = getCompactDisplayPathSegments(extension.path, home);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) {
				segments.pop();
			}
			return {
				path: extension.path,
				sourceInfo: extension.sourceInfo,
				segments,
			};
		})
		.filter((extension) => !isPackageSource(extension.sourceInfo));

	return extensions.map((extension) => {
		if (isPackageSource(extension.sourceInfo)) {
			return getCompactExtensionLabel(extension.path, extension.sourceInfo, home);
		}

		const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
		if (nonPackageIndex === -1) {
			return getCompactPathLabel(extension.path, extension.sourceInfo, home);
		}

		return getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions, home);
	});
}

/** Source/scope label used by resource diagnostics, e.g. `npm:pkg (project)`. */
export function getDisplaySourceInfo(sourceInfo?: SourceInfo): {
	label: string;
	scopeLabel?: string;
} {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "local") {
		if (scope === "user") {
			return { label: "user" };
		}
		if (scope === "project") {
			return { label: "project" };
		}
		if (scope === "temporary") {
			return { label: "path", scopeLabel: "temp" };
		}
		return { label: "path" };
	}

	if (source === "cli") {
		return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined };
	}

	const scopeLabel =
		scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
	return { label: source, scopeLabel };
}
