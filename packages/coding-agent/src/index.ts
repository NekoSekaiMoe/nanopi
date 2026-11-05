// Core session management

// Build flavor surface: what a flavor (buildconfig.json) turned on for this
// build. SDK users ask these before offering a feature whose code the build may
// not carry.
export * from "./build-components.ts";
export * from "./cli/args.ts";
export * from "./config.ts";
export * from "./core/agent-session.ts";
export * from "./core/auth-storage.ts";
export * from "./core/bash-executor.ts";
export * from "./core/compaction/index.ts";
export * from "./core/defaults.ts";
export * from "./core/event-bus.ts";
export * from "./core/exec.ts";
// Only the read-only view a module's footer receives is public; `FooterDataProvider` itself is the
// session's watcher.
export type { ReadonlyFooterDataProvider } from "./core/footer-data-provider.ts";
export * from "./core/messages/index.ts";
export * from "./core/messages.ts";
export * from "./core/model-registry.ts";
export * from "./core/model-resolver.ts";
export * from "./core/model-runtime.ts";
export * from "./core/modules/index.ts";
export * from "./core/project-trust.ts";
export * from "./core/prompt-templates.ts";
export * from "./core/resource-discovery.ts";
export * from "./core/resource-loader.ts";
export * from "./core/sdk.ts";
export * from "./core/session-manager.ts";
export * from "./core/settings-manager.ts";
export * from "./core/skills.ts";
export * from "./core/source-info.ts";
export * from "./core/system-prompt.ts";
export * from "./core/tool-patterns.ts";
export * from "./core/tools/edit-diff.ts";
export * from "./core/tools/index.ts";
// A `export *` per source above, but two roots disagree about the tool factories: `core/tools/`
// declares `createReadTool(cwd)` and `createReadToolDefinition(cwd, options)`, `core/sdk.ts`
// re-exports the same factory, and `core/tools/index.ts` owns a different `createReadTool`
// (single-tool, options-only). Re-exporting one of them by name is the only way to say which;
// `export *` on both barrels would drop the name silently and fail typecheck.
export {
	createBashTool,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createPowerShellTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	withFileMutationQueue,
} from "./core/tools/index.ts";
export * from "./core/trust-manager.ts";
export * from "./core/virtual-models.ts";
export * from "./main.ts";
export * from "./modes/index.ts";
export * from "./modes/interactive/components/index.ts";
export * from "./modes/interactive/theme/theme.ts";
export * from "./modules/index.ts";
export * from "./utils/clipboard.ts";
export * from "./utils/frontmatter.ts";
export * from "./utils/image-convert.ts";
export * from "./utils/image-resize.ts";
export * from "./utils/mime.ts";
export * from "./utils/paths.ts";
export * from "./utils/shell.ts";
