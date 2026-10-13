import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { detectCapabilities, getTerminalColorMode, type TerminalColorMode } from "@nanopi/pi-tui";
import chalk from "chalk";
import { CONFIG_DIR_NAME } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

export type { ResourceCollision, ResourceDiagnostic } from "./diagnostics.ts";

import { canonicalizePath, isLocalPath, resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { createEventBus, type EventBus } from "./event-bus.ts";
import { findGitPaths } from "./footer-data-provider.ts";
import { createModuleRuntime, loadModules } from "./modules/registry.ts";
import type { LoadModulesResult, RegisteredModule, SessionModule } from "./modules/types.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import { type PathMetadata, type ResolvedResource, resolveLocalResources } from "./resource-discovery.ts";
import { SettingsManager } from "./settings-manager.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import { createSourceInfo, type SourceInfo } from "./source-info.ts";
import { resetTimings } from "./timings.ts";

export interface ResourceExtensionPaths {
	skillPaths?: Array<{ path: string; metadata: PathMetadata }>;
	promptPaths?: Array<{ path: string; metadata: PathMetadata }>;
	themePaths?: Array<{ path: string; metadata: PathMetadata }>;
}

export interface ResourceLoaderReloadOptions {
	resolveProjectTrust?: (input: { modulesResult: LoadModulesResult }) => Promise<boolean>;
}

export interface ResourceLoader {
	getModules(): LoadModulesResult;
	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
	getSystemPrompt(): string | undefined;
	getSystemPromptSource(): { path: string } | undefined;
	getAppendSystemPrompt(): string[];
	getAppendSystemPromptSources(): Array<{ path: string }>;
	extendResources(paths: ResourceExtensionPaths): void;
	reload(options?: ResourceLoaderReloadOptions): Promise<void>;
}

function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) {
		return undefined;
	}

	if (existsSync(input)) {
		try {
			return stripBom(readFileSync(input, "utf-8"));
		} catch (error) {
			console.error(chalk.yellow(`Warning: Could not read ${description} file ${input}: ${error}`));
			return input;
		}
	}

	return input;
}

function loadContextFileFromDir(dir: string): { path: string; content: string } | null {
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) {
					continue;
				}
				return {
					path: filePath,
					content: stripBom(readFileSync(filePath, "utf-8")),
				};
			} catch (error) {
				console.error(chalk.yellow(`Warning: Could not read ${filePath}: ${error}`));
			}
		}
	}
	return null;
}

/**
 * The main repo's context file that a nested linked worktree's own copy shadows: both
 * occupy the same logical repository scope, so loading both applies that context twice. Returns
 * undefined when nothing is shadowed, leaving normal ancestor inheritance alone.
 *
 * Returned canonicalized (realpath), because `git worktree add` writes the `.git`
 * file's `gitdir:` target in realpath form while cwd may still be symlinked
 * (macOS `/tmp` -> `/private/tmp`).
 */
function findShadowedContextFile(cwd: string): string | undefined {
	const gitPaths = findGitPaths(cwd);
	if (!gitPaths) return undefined;
	const commonGitDir = canonicalizePath(gitPaths.commonGitDir);
	const worktreeRoot = canonicalizePath(gitPaths.repoDir);
	const mainRepoRoot = dirname(commonGitDir);
	// False for an ordinary repo, where the two are the same dir, and for a sibling
	// worktree (`git worktree add ../feat`), whose main repo is not an ancestor.
	if (!worktreeRoot.startsWith(`${mainRepoRoot}${sep}`)) return undefined;
	// dirname of the common git dir is the main worktree root only when that dir is
	// itself checked out from the same repo. In a bare layout (`proj/.bare` +
	// `proj/main`) it is just the directory holding `.bare`, which tracks nothing; a
	// submodule's gitdir has no `commondir`, so it lands under `.git/modules`.
	if (canonicalizePath(join(mainRepoRoot, ".git")) !== commonGitDir) return undefined;
	const worktreeContextFile = loadContextFileFromDir(worktreeRoot);
	return worktreeContextFile ? join(mainRepoRoot, basename(worktreeContextFile.path)) : undefined;
}

export function loadProjectContextFiles(options: {
	cwd: string;
	agentDir: string;
}): Array<{ path: string; content: string }> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);

	const contextFiles: Array<{ path: string; content: string }> = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolvedAgentDir);
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: Array<{ path: string; content: string }> = [];

	const shadowedContextFile = findShadowedContextFile(resolvedCwd);
	let currentDir = resolvedCwd;

	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		// Compare the directory's real path, not the file's: a worktree AGENTS.md that
		// symlinks to the main repo's file resolves to the shadowed path itself.
		const isShadowed =
			shadowedContextFile !== undefined &&
			contextFile !== null &&
			join(canonicalizePath(currentDir), basename(contextFile.path)) === shadowedContextFile;
		if (contextFile && !isShadowed && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile);
			seenPaths.add(contextFile.path);
		}

		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);

	return contextFiles;
}

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	settingsManager?: SettingsManager;
	eventBus?: EventBus;
	/** Programmatic modules to load (built-ins are passed by the CLI; SDK users pass their own). */
	modules?: SessionModule[];
	additionalSkillPaths?: string[];
	additionalPromptTemplatePaths?: string[];
	additionalThemePaths?: string[];
	noSkills?: boolean;
	noPromptTemplates?: boolean;
	noThemes?: boolean;
	noContextFiles?: boolean;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	/** Replace or filter the loaded module set (tests use this). */
	modulesOverride?: (base: LoadModulesResult) => LoadModulesResult;
	skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	systemPromptOverride?: (base: string | undefined) => string | undefined;
	appendSystemPromptOverride?: (base: string[]) => string[];
}

export class DefaultResourceLoader implements ResourceLoader {
	private cwd: string;
	private agentDir: string;
	private settingsManager: SettingsManager;
	private eventBus: EventBus;
	private staticModules: SessionModule[];
	private additionalSkillPaths: string[];
	private additionalPromptTemplatePaths: string[];
	private additionalThemePaths: string[];
	private noSkills: boolean;
	private noPromptTemplates: boolean;
	private noThemes: boolean;
	private noContextFiles: boolean;
	private systemPromptSource?: string;
	private appendSystemPromptSource?: string[];
	private modulesOverride?: (base: LoadModulesResult) => LoadModulesResult;
	private modulesLoaded = false;
	private skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
		skills: Skill[];
		diagnostics: ResourceDiagnostic[];
	};
	private promptsOverride?: (base: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] }) => {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
	};
	private themesOverride?: (base: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }) => {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	};
	private agentsFilesOverride?: (base: { agentsFiles: Array<{ path: string; content: string }> }) => {
		agentsFiles: Array<{ path: string; content: string }>;
	};
	private systemPromptOverride?: (base: string | undefined) => string | undefined;
	private appendSystemPromptOverride?: (base: string[]) => string[];

	private extensionsResult: LoadModulesResult;
	private skills: Skill[];
	private skillDiagnostics: ResourceDiagnostic[];
	private prompts: PromptTemplate[];
	private promptDiagnostics: ResourceDiagnostic[];
	private themes: Theme[];
	private themeDiagnostics: ResourceDiagnostic[];
	private agentsFiles: Array<{ path: string; content: string }>;
	private systemPrompt?: string;
	private systemPromptSourcePath?: string;
	private appendSystemPrompt: string[];
	private appendSystemPromptSourcePaths: string[];
	private lastSkillPaths: string[];
	private extensionSkillSourceInfos: Map<string, SourceInfo>;
	private extensionPromptSourceInfos: Map<string, SourceInfo>;
	private extensionThemeSourceInfos: Map<string, SourceInfo>;
	private resourceMetadataByPath: Map<string, PathMetadata>;
	private lastPromptPaths: string[];
	private lastThemePaths: string[];

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = resolvePath(options.cwd);
		this.agentDir = resolvePath(options.agentDir);
		this.settingsManager = options.settingsManager ?? SettingsManager.create(this.cwd, this.agentDir);
		this.eventBus = options.eventBus ?? createEventBus();
		this.staticModules = options.modules ?? [];
		this.additionalSkillPaths = options.additionalSkillPaths ?? [];
		this.additionalPromptTemplatePaths = options.additionalPromptTemplatePaths ?? [];
		this.additionalThemePaths = options.additionalThemePaths ?? [];
		this.noSkills = options.noSkills ?? false;
		this.noPromptTemplates = options.noPromptTemplates ?? false;
		this.noThemes = options.noThemes ?? false;
		this.noContextFiles = options.noContextFiles ?? false;
		this.systemPromptSource = options.systemPrompt;
		this.appendSystemPromptSource = options.appendSystemPrompt;
		this.modulesOverride = options.modulesOverride;
		this.skillsOverride = options.skillsOverride;
		this.promptsOverride = options.promptsOverride;
		this.themesOverride = options.themesOverride;
		this.agentsFilesOverride = options.agentsFilesOverride;
		this.systemPromptOverride = options.systemPromptOverride;
		this.appendSystemPromptOverride = options.appendSystemPromptOverride;

		this.extensionsResult = { modules: [], errors: [], warnings: [], runtime: createModuleRuntime() };
		this.skills = [];
		this.skillDiagnostics = [];
		this.prompts = [];
		this.promptDiagnostics = [];
		this.themes = [];
		this.themeDiagnostics = [];
		this.agentsFiles = [];
		this.appendSystemPrompt = [];
		this.appendSystemPromptSourcePaths = [];
		this.lastSkillPaths = [];
		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();
		this.resourceMetadataByPath = new Map();
		this.lastPromptPaths = [];
		this.lastThemePaths = [];
	}

	getModules(): LoadModulesResult {
		return this.extensionsResult;
	}

	/** Run module factories once; later calls reuse the result (modules are static). */
	private async loadModulesOnce(): Promise<LoadModulesResult> {
		if (!this.modulesLoaded) {
			this.extensionsResult = await loadModules(this.staticModules, this.cwd, this.eventBus);
			this.addModuleConflictDiagnostics(this.extensionsResult);
			this.modulesLoaded = true;
		}
		return this.extensionsResult;
	}

	private applyModulesOverride(base: LoadModulesResult): LoadModulesResult {
		return this.modulesOverride ? this.modulesOverride(base) : base;
	}

	getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
		return { skills: this.skills, diagnostics: this.skillDiagnostics };
	}

	getPrompts(): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		return { prompts: this.prompts, diagnostics: this.promptDiagnostics };
	}

	getThemes(): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		return { themes: this.themes, diagnostics: this.themeDiagnostics };
	}

	getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getSystemPromptSource(): { path: string } | undefined {
		return this.systemPromptSourcePath ? { path: this.systemPromptSourcePath } : undefined;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	getAppendSystemPromptSources(): Array<{ path: string }> {
		return this.appendSystemPromptSourcePaths.map((path) => ({ path }));
	}

	extendResources(paths: ResourceExtensionPaths): void {
		const skillPaths = this.normalizeExtensionPaths(paths.skillPaths ?? []);
		const promptPaths = this.normalizeExtensionPaths(paths.promptPaths ?? []);
		const themePaths = this.normalizeExtensionPaths(paths.themePaths ?? []);

		for (const entry of skillPaths) {
			this.extensionSkillSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of promptPaths) {
			this.extensionPromptSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}
		for (const entry of themePaths) {
			this.extensionThemeSourceInfos.set(entry.path, createSourceInfo(entry.path, entry.metadata));
		}

		if (skillPaths.length > 0) {
			this.lastSkillPaths = this.mergePaths(
				this.lastSkillPaths,
				skillPaths.map((entry) => entry.path),
			);
			this.updateSkillsFromPaths(this.lastSkillPaths, this.resourceMetadataByPath);
		}

		if (promptPaths.length > 0) {
			this.lastPromptPaths = this.mergePaths(
				this.lastPromptPaths,
				promptPaths.map((entry) => entry.path),
			);
			this.updatePromptsFromPaths(this.lastPromptPaths, this.resourceMetadataByPath);
		}

		if (themePaths.length > 0) {
			this.lastThemePaths = this.mergePaths(
				this.lastThemePaths,
				themePaths.map((entry) => entry.path),
			);
			this.updateThemesFromPaths(this.lastThemePaths, this.resourceMetadataByPath);
		}
	}

	async reload(options?: ResourceLoaderReloadOptions): Promise<void> {
		resetTimings("extensions");

		if (options?.resolveProjectTrust) {
			// Modules are code and trusted by construction; the pre-trust pass only
			// exists so project_trust handlers (e.g. --yolo) can answer before
			// project-local files load.
			const modulesResult = await this.loadModulesOnce();
			const projectTrusted = await options.resolveProjectTrust({ modulesResult });
			this.settingsManager.setProjectTrusted(projectTrusted);
		}

		// reload() preserves SettingsManager.projectTrusted and reloads settings for that trust state.
		await this.settingsManager.reload();
		if (!this.modulesLoaded) {
			this.extensionsResult = this.applyModulesOverride(await this.loadModulesOnce());
		}
		const resolvedPaths = resolveLocalResources({
			cwd: this.cwd,
			globalBaseDir: this.agentDir,
			projectBaseDir: join(this.cwd, ".nanopi"),
			projectTrusted: this.settingsManager.isProjectTrusted(),
			globalSettings: this.settingsManager.getGlobalSettings(),
			projectSettings: this.settingsManager.getProjectSettings(),
		});
		this.resourceMetadataByPath = new Map();
		const metadataByPath = this.resourceMetadataByPath;

		this.extensionSkillSourceInfos = new Map();
		this.extensionPromptSourceInfos = new Map();
		this.extensionThemeSourceInfos = new Map();

		// Helper to extract enabled paths and store metadata
		const getEnabledResources = (resources: ResolvedResource[]): ResolvedResource[] => {
			for (const r of resources) {
				if (!metadataByPath.has(r.path)) {
					metadataByPath.set(r.path, r.metadata);
				}
			}
			return resources.filter((r) => r.enabled);
		};

		const getEnabledPaths = (resources: ResolvedResource[]): string[] =>
			getEnabledResources(resources).map((r) => r.path);
		const enabledSkillResources = getEnabledResources(resolvedPaths.skills);
		const enabledPrompts = getEnabledPaths(resolvedPaths.prompts);
		const enabledThemes = getEnabledPaths(resolvedPaths.themes);
		const enabledSkills = enabledSkillResources.map((resource) => this.mapSkillPath(resource, metadataByPath));

		const skillPaths = this.noSkills
			? [...this.additionalSkillPaths]
			: this.mergePaths(enabledSkills, this.additionalSkillPaths);

		this.lastSkillPaths = skillPaths;
		this.updateSkillsFromPaths(skillPaths, metadataByPath);
		for (const p of this.additionalSkillPaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.skillDiagnostics.some((d) => d.path === resolved)) {
					this.skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
				}
			}
		}

		const promptPaths = this.noPromptTemplates
			? [...this.additionalPromptTemplatePaths]
			: this.mergePaths(enabledPrompts, this.additionalPromptTemplatePaths);

		this.lastPromptPaths = promptPaths;
		this.updatePromptsFromPaths(promptPaths, metadataByPath);
		for (const p of this.additionalPromptTemplatePaths) {
			if (isLocalPath(p)) {
				const resolved = this.resolveResourcePath(p);
				if (!existsSync(resolved) && !this.promptDiagnostics.some((d) => d.path === resolved)) {
					this.promptDiagnostics.push({
						type: "error",
						message: "Prompt template path does not exist",
						path: resolved,
					});
				}
			}
		}

		const themePaths = this.noThemes
			? [...this.additionalThemePaths]
			: this.mergePaths(enabledThemes, this.additionalThemePaths);

		this.lastThemePaths = themePaths;
		this.updateThemesFromPaths(themePaths, metadataByPath);
		for (const p of this.additionalThemePaths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved) && !this.themeDiagnostics.some((d) => d.path === resolved)) {
				this.themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
			}
		}

		const agentsFiles = {
			agentsFiles: this.noContextFiles
				? []
				: loadProjectContextFiles({
						cwd: this.cwd,
						agentDir: this.agentDir,
					}),
		};
		const resolvedAgentsFiles = this.agentsFilesOverride ? this.agentsFilesOverride(agentsFiles) : agentsFiles;
		this.agentsFiles = resolvedAgentsFiles.agentsFiles;

		const systemPromptSource = this.systemPromptSource ?? this.discoverSystemPromptFile();
		const baseSystemPrompt = resolvePromptInput(systemPromptSource, "system prompt");
		this.systemPrompt = this.systemPromptOverride ? this.systemPromptOverride(baseSystemPrompt) : baseSystemPrompt;
		this.systemPromptSourcePath =
			systemPromptSource && existsSync(systemPromptSource) ? resolvePath(systemPromptSource) : undefined;

		let appendSources = this.appendSystemPromptSource;
		if (!appendSources) {
			const discoveredAppendSystemPromptFile = this.discoverAppendSystemPromptFile();
			appendSources = discoveredAppendSystemPromptFile ? [discoveredAppendSystemPromptFile] : [];
		}
		const baseAppend = appendSources
			.map((s) => resolvePromptInput(s, "append system prompt"))
			.filter((s): s is string => s !== undefined);
		this.appendSystemPrompt = this.appendSystemPromptOverride
			? this.appendSystemPromptOverride(baseAppend)
			: baseAppend;
		this.appendSystemPromptSourcePaths = appendSources
			.filter((source) => existsSync(source))
			.map((source) => resolvePath(source));
	}

	private addModuleConflictDiagnostics(modulesResult: LoadModulesResult): void {
		// Detect module conflicts (tools, commands, flags with same names from different modules)
		// Keep all modules loaded. Conflicts are reported as diagnostics, and precedence is handled by load order.
		const conflicts = this.detectModuleConflicts(modulesResult.modules);
		for (const conflict of conflicts) {
			modulesResult.errors.push({ path: conflict.path, error: conflict.message });
		}
	}

	private mapSkillPath(resource: ResolvedResource, metadataByPath: Map<string, PathMetadata>): string {
		if (resource.metadata.source !== "auto" && resource.metadata.origin !== "package") {
			return resource.path;
		}
		try {
			const stats = statSync(resource.path);
			if (!stats.isDirectory()) {
				return resource.path;
			}
		} catch {
			return resource.path;
		}
		const skillFile = join(resource.path, "SKILL.md");
		if (existsSync(skillFile)) {
			if (!metadataByPath.has(skillFile)) {
				metadataByPath.set(skillFile, resource.metadata);
			}
			return skillFile;
		}
		return resource.path;
	}

	private normalizeExtensionPaths(
		entries: Array<{ path: string; metadata: PathMetadata }>,
	): Array<{ path: string; metadata: PathMetadata }> {
		return entries.map((entry) => {
			const metadata = entry.metadata.baseDir
				? { ...entry.metadata, baseDir: this.resolveResourcePath(entry.metadata.baseDir) }
				: entry.metadata;
			return {
				path: this.resolveResourcePath(entry.path),
				metadata,
			};
		});
	}

	private updateSkillsFromPaths(skillPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
		if (this.noSkills && skillPaths.length === 0) {
			skillsResult = { skills: [], diagnostics: [] };
		} else {
			skillsResult = loadSkills({
				cwd: this.cwd,
				agentDir: this.agentDir,
				skillPaths,
				includeDefaults: false,
			});
		}
		const resolvedSkills = this.skillsOverride ? this.skillsOverride(skillsResult) : skillsResult;
		this.skills = resolvedSkills.skills.map((skill) => ({
			...skill,
			sourceInfo:
				this.findSourceInfoForPath(skill.filePath, this.extensionSkillSourceInfos, metadataByPath) ??
				skill.sourceInfo ??
				this.getDefaultSourceInfoForPath(skill.filePath),
		}));
		this.skillDiagnostics = resolvedSkills.diagnostics;
	}

	private updatePromptsFromPaths(promptPaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
		if (this.noPromptTemplates && promptPaths.length === 0) {
			promptsResult = { prompts: [], diagnostics: [] };
		} else {
			const loaded = loadPromptTemplates({
				cwd: this.cwd,
				agentDir: this.agentDir,
				promptPaths,
				includeDefaults: false,
			});
			const deduped = this.dedupePrompts(loaded.templates);
			promptsResult = {
				prompts: deduped.prompts,
				diagnostics: [...loaded.diagnostics, ...deduped.diagnostics],
			};
		}
		const resolvedPrompts = this.promptsOverride ? this.promptsOverride(promptsResult) : promptsResult;
		this.prompts = resolvedPrompts.prompts.map((prompt) => ({
			...prompt,
			sourceInfo:
				this.findSourceInfoForPath(prompt.filePath, this.extensionPromptSourceInfos, metadataByPath) ??
				prompt.sourceInfo ??
				this.getDefaultSourceInfoForPath(prompt.filePath),
		}));
		this.promptDiagnostics = resolvedPrompts.diagnostics;
	}

	private updateThemesFromPaths(themePaths: string[], metadataByPath?: Map<string, PathMetadata>): void {
		let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
		if (this.noThemes && themePaths.length === 0) {
			themesResult = { themes: [], diagnostics: [] };
		} else {
			// Theme construction only needs trueColor, so skip the unrelated tmux hyperlink probe.
			const colorMode = getTerminalColorMode({
				...detectCapabilities(() => false),
				...this.settingsManager.getTerminalCapabilityOverrides(),
			});
			const loaded = this.loadThemes(themePaths, false, colorMode);
			const deduped = this.dedupeThemes(loaded.themes);
			themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
		}
		const resolvedThemes = this.themesOverride ? this.themesOverride(themesResult) : themesResult;
		this.themes = resolvedThemes.themes.map((theme) => {
			const sourcePath = theme.sourcePath;
			theme.sourceInfo = sourcePath
				? (this.findSourceInfoForPath(sourcePath, this.extensionThemeSourceInfos, metadataByPath) ??
					theme.sourceInfo ??
					this.getDefaultSourceInfoForPath(sourcePath))
				: theme.sourceInfo;
			return theme;
		});
		this.themeDiagnostics = resolvedThemes.diagnostics;
	}

	private mergePaths(primary: string[], additional: string[]): string[] {
		const merged: string[] = [];
		const seen = new Set<string>();

		for (const p of [...primary, ...additional]) {
			const resolved = this.resolveResourcePath(p);
			const canonicalPath = canonicalizePath(resolved);
			if (seen.has(canonicalPath)) continue;
			seen.add(canonicalPath);
			merged.push(resolved);
		}

		return merged;
	}

	private resolveResourcePath(p: string): string {
		return isSyntheticPath(p) ? p : resolvePath(p, this.cwd, { trim: true });
	}

	private loadThemes(
		paths: string[],
		includeDefaults: boolean,
		colorMode: TerminalColorMode,
	): {
		themes: Theme[];
		diagnostics: ResourceDiagnostic[];
	} {
		const themes: Theme[] = [];
		const diagnostics: ResourceDiagnostic[] = [];
		if (includeDefaults) {
			const defaultDirs = [join(this.agentDir, "themes"), join(this.cwd, CONFIG_DIR_NAME, "themes")];

			for (const dir of defaultDirs) {
				this.loadThemesFromDir(dir, themes, diagnostics, colorMode);
			}
		}

		for (const p of paths) {
			const resolved = this.resolveResourcePath(p);
			if (!existsSync(resolved)) {
				diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
				continue;
			}

			try {
				const stats = statSync(resolved);
				if (stats.isDirectory()) {
					this.loadThemesFromDir(resolved, themes, diagnostics, colorMode);
				} else if (stats.isFile() && resolved.endsWith(".json")) {
					this.loadThemeFromFile(resolved, themes, diagnostics, colorMode);
				} else {
					diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : "failed to read theme path";
				diagnostics.push({ type: "warning", message, path: resolved });
			}
		}

		return { themes, diagnostics };
	}

	private loadThemesFromDir(
		dir: string,
		themes: Theme[],
		diagnostics: ResourceDiagnostic[],
		colorMode: TerminalColorMode,
	): void {
		if (!existsSync(dir)) {
			return;
		}

		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				let isFile = entry.isFile();
				if (entry.isSymbolicLink()) {
					try {
						isFile = statSync(join(dir, entry.name)).isFile();
					} catch {
						continue;
					}
				}
				if (!isFile) {
					continue;
				}
				if (!entry.name.endsWith(".json")) {
					continue;
				}
				this.loadThemeFromFile(join(dir, entry.name), themes, diagnostics, colorMode);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme directory";
			diagnostics.push({ type: "warning", message, path: dir });
		}
	}

	private loadThemeFromFile(
		filePath: string,
		themes: Theme[],
		diagnostics: ResourceDiagnostic[],
		colorMode: TerminalColorMode,
	): void {
		try {
			themes.push(loadThemeFromPath(filePath, colorMode));
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to load theme";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
	}

	private dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, PromptTemplate>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const prompt of prompts) {
			const existing = seen.get(prompt.name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "/${prompt.name}" collision`,
					path: prompt.filePath,
					collision: {
						resourceType: "prompt",
						name: prompt.name,
						winnerPath: existing.filePath,
						loserPath: prompt.filePath,
					},
				});
			} else {
				seen.set(prompt.name, prompt);
			}
		}

		return { prompts: Array.from(seen.values()), diagnostics };
	}

	private dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
		const seen = new Map<string, Theme>();
		const diagnostics: ResourceDiagnostic[] = [];

		for (const t of themes) {
			const name = t.name ?? "unnamed";
			const existing = seen.get(name);
			if (existing) {
				diagnostics.push({
					type: "collision",
					message: `name "${name}" collision`,
					path: t.sourcePath,
					collision: {
						resourceType: "theme",
						name,
						winnerPath: existing.sourcePath ?? "<builtin>",
						loserPath: t.sourcePath ?? "<builtin>",
					},
				});
			} else {
				seen.set(name, t);
			}
		}

		return { themes: Array.from(seen.values()), diagnostics };
	}

	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (this.settingsManager.isProjectTrusted() && existsSync(projectPath)) {
			return projectPath;
		}

		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		if (existsSync(globalPath)) {
			return globalPath;
		}

		return undefined;
	}

	private detectModuleConflicts(extensions: RegisteredModule[]): Array<{ path: string; message: string }> {
		const conflicts: Array<{ path: string; message: string }> = [];

		// Track which extension registered each tool and flag
		const toolOwners = new Map<string, string>();
		const flagOwners = new Map<string, string>();

		for (const ext of extensions) {
			// Check tools
			for (const toolName of ext.tools.keys()) {
				const existingOwner = toolOwners.get(toolName);
				if (existingOwner && existingOwner !== ext.name) {
					conflicts.push({
						path: ext.name,
						message: `Tool "${toolName}" conflicts with ${existingOwner}`,
					});
				} else {
					toolOwners.set(toolName, ext.name);
				}
			}

			// Check flags
			for (const flagName of ext.flags.keys()) {
				const existingOwner = flagOwners.get(flagName);
				if (existingOwner && existingOwner !== ext.name) {
					conflicts.push({
						path: ext.name,
						message: `Flag "--${flagName}" conflicts with ${existingOwner}`,
					});
				} else {
					flagOwners.set(flagName, ext.name);
				}
			}
		}

		return conflicts;
	}
}
