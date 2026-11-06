// Core session management
//
// Why `export *` per source instead of a hand-maintained whitelist: the list is
// one row per source, so it is the whitelist — what changed is that a name can
// no longer arrive as a half-edited line. A whitelist has to be edited twice for
// every new export (once in the source, once here) and rots silently when it is
// not; it had already done so before #506 — `ExecOptions`, `copyToClipboard` and
// `main` were listed as public after their sources stopped exporting them, and
// nothing failed until CI typechecked the barrel.
//
// The two costs that made the list look necessary are covered elsewhere:
// ambiguity is TS2308 at the typecheck, not the runtime's silent omission, so a
// collision cannot reach CI unnoticed; and hiding a symbol is a one-line diff at
// its declaration, which `export *` cannot override. The surface is measured
// against the emitted `.d.ts` rather than counted by hand; unpublishing a name
// later is still a breaking change.

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
