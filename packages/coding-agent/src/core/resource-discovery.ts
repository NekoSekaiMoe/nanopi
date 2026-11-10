/**
 * Local resource discovery: skills and prompt templates from the settings
 * arrays and the conventional directories. The user scope is `~/.nanopi` plus
 * `~/.agents/skills`; the project scope is `.agents/` (in cwd and its
 * ancestors) plus `.nanopi/`. Extracted from the removed package manager;
 * extension/package sources are gone - only local paths are discovered.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import ignore from "ignore";
import { minimatch } from "minimatch";
import { normalizePath } from "../utils/paths.ts";
import { projectResourceDirs } from "./agents-dirs.ts";
import type { SourceScope } from "./source-info.ts";

export interface PathMetadata {
	source: string;
	scope: SourceScope;
	origin: "package" | "top-level";
	baseDir?: string;
	changelogPath?: string;
}

export interface ResolvedResource {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
}

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

type IgnoreMatcher = ReturnType<typeof ignore>;

function toPosixPath(p: string): string {
	return p.split(sep).join("/");
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

type SkillDiscoveryMode = "nanopi" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });

		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") {
				continue;
			}

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			if (isFile && !ig.ignores(relPath)) {
				entries.push(fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			// A nanopi resource directory never holds dot entries, while an
			// `.agents/skills` directory may lead to one (`skills/.system/...`).
			if (mode === "nanopi" && entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isDir = entry.isDirectory();
			let isFile = entry.isFile();

			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDir = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(root, fullPath));
			const shouldIncludeMarkdownFile =
				isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "nanopi" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(fullPath);
				continue;
			}

			if (!isDir) continue;
			if (ig.ignores(`${relPath}/`)) continue;

			entries.push(...collectSkillEntries(fullPath, mode, ig, root));
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function collectAutoPromptEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;

			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					continue;
				}
			}

			const relPath = toPosixPath(relative(dir, fullPath));
			if (ig.ignores(relPath)) continue;

			if (isFile && entry.name.endsWith(".md")) {
				entries.push(fullPath);
			}
		}
	} catch {
		// Ignore errors
	}

	return entries;
}

function normalizePattern(pattern: string): string {
	const normalized = pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
	// Expands ~ so !/+/- setting entries such as !~/skills/pdf match (#10765).
	return toPosixPath(normalizePath(normalized));
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentName = isSkillFile ? basename(parentDir!) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalizedPattern = normalizePattern(pattern);
		if (
			minimatch(rel, normalizedPattern) ||
			minimatch(name, normalizedPattern) ||
			minimatch(filePathPosix, normalizedPattern)
		) {
			return true;
		}
		if (!isSkillFile) return false;
		return (
			minimatch(parentRel!, normalizedPattern) ||
			minimatch(parentName!, normalizedPattern) ||
			minimatch(parentDirPosix!, normalizedPattern)
		);
	});
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
	if (patterns.length === 0) return false;
	const rel = toPosixPath(relative(baseDir, filePath));
	const name = basename(filePath);
	const filePathPosix = toPosixPath(filePath);
	const isSkillFile = name === "SKILL.md";
	const parentDir = isSkillFile ? dirname(filePath) : undefined;
	const parentRel = isSkillFile ? toPosixPath(relative(baseDir, parentDir!)) : undefined;
	const parentDirPosix = isSkillFile ? toPosixPath(parentDir!) : undefined;

	return patterns.some((pattern) => {
		const normalized = normalizePattern(pattern);
		if (normalized === rel || normalized === filePathPosix) {
			return true;
		}
		if (!isSkillFile) return false;
		return normalized === parentRel || normalized === parentDirPosix;
	});
}

function getOverridePatterns(entries: string[]): string[] {
	return entries.filter((pattern) => pattern.startsWith("!") || pattern.startsWith("+") || pattern.startsWith("-"));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
	const overrides = getOverridePatterns(patterns);
	const excludes = overrides.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
	const forceIncludes = overrides.filter((pattern) => pattern.startsWith("+")).map((pattern) => pattern.slice(1));
	const forceExcludes = overrides.filter((pattern) => pattern.startsWith("-")).map((pattern) => pattern.slice(1));

	let enabled = true;
	if (excludes.length > 0 && matchesAnyPattern(filePath, excludes, baseDir)) {
		enabled = false;
	}
	if (forceIncludes.length > 0 && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
		enabled = true;
	}
	if (forceExcludes.length > 0 && matchesAnyExactPattern(filePath, forceExcludes, baseDir)) {
		enabled = false;
	}
	return enabled;
}

/** Discover local skills and prompts for the current trust state.
 * No package or extension sources: only local paths are discovered. */
export function resolveLocalResources(options: {
	cwd: string;
	globalBaseDir: string;
	projectBaseDir: string;
	projectTrusted: boolean;
	globalSettings: { skills?: string[]; prompts?: string[] };
	projectSettings: { skills?: string[]; prompts?: string[] };
}): { skills: ResolvedResource[]; prompts: ResolvedResource[] } {
	const { cwd, globalBaseDir, projectBaseDir, projectTrusted } = options;
	const globalMetadata: PathMetadata = { source: "auto", scope: "user", origin: "top-level", baseDir: globalBaseDir };
	const projectMetadata: PathMetadata = {
		source: "auto",
		scope: "project",
		origin: "top-level",
		baseDir: projectBaseDir,
	};

	const skills = new Map<string, ResolvedResource>();
	const prompts = new Map<string, ResolvedResource>();

	// A path found twice keeps the highest-precedence directory's metadata, so
	// `.agents/skills` wins over an `.nanopi/skills` entry reaching the same file
	// (a checkout that still has one symlinked into the other).
	const add = (
		target: Map<string, ResolvedResource>,
		paths: string[],
		metadata: PathMetadata,
		overrides: string[],
		baseDir: string,
	) => {
		for (const path of paths) {
			if (!target.has(path)) {
				target.set(path, { path, metadata, enabled: isEnabledByOverrides(path, overrides, baseDir) });
			}
		}
	};

	if (projectTrusted) {
		// Every directory supplies its own metadata base, so no project-wide base
		// is used here. `.nanopi/skills` reads as a nanopi skill directory (a
		// flat set of `.md` files is valid there); every other entry is an
		// `.agents/skills`, read with the agents convention, where only nested
		// `SKILL.md` files count. The two collapse into one directory only when
		// cwd sits inside its own `.agents` tree (`$HOME`), and that one is kept
		// last.
		const skillDirs = projectResourceDirs(cwd, "skills");
		for (const [index, dir] of skillDirs.entries()) {
			const resourceDir = dirname(dir);
			add(
				skills,
				collectSkillEntries(dir, index === skillDirs.length - 1 ? "nanopi" : "agents"),
				{ ...projectMetadata, baseDir: resourceDir },
				options.projectSettings.skills ?? [],
				resourceDir,
			);
		}
		for (const dir of projectResourceDirs(cwd, "prompts")) {
			const resourceDir = dirname(dir);
			add(
				prompts,
				collectAutoPromptEntries(dir),
				{ ...projectMetadata, baseDir: resourceDir },
				options.projectSettings.prompts ?? [],
				resourceDir,
			);
		}
	}

	add(
		skills,
		collectSkillEntries(join(globalBaseDir, "skills"), "nanopi"),
		globalMetadata,
		options.globalSettings.skills ?? [],
		globalBaseDir,
	);
	const userAgentsSkillsDir = join(homedir(), ".agents", "skills");
	add(
		skills,
		collectSkillEntries(userAgentsSkillsDir, "agents"),
		{ ...globalMetadata, baseDir: dirname(userAgentsSkillsDir) },
		options.globalSettings.skills ?? [],
		dirname(userAgentsSkillsDir),
	);
	add(
		prompts,
		collectAutoPromptEntries(join(globalBaseDir, "prompts")),
		globalMetadata,
		options.globalSettings.prompts ?? [],
		globalBaseDir,
	);

	return {
		skills: [...skills.values()],
		prompts: [...prompts.values()],
	};
}
