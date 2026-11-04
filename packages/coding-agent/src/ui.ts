/**
 * Narrow entry point for rendering inside nanopi: the theme a renderer styles
 * with and the components it can return from `registerMessageRenderer`,
 * `registerEntryRenderer`, or `registerToolRenderer`.
 *
 * Building a UI does not need the session, the tools, or resource discovery, so
 * this surface does not reach them.
 */

export type { Component } from "@nanopi/pi-tui";
export type {
	EntryRenderOptions,
	MarkdownTransformContext,
	MarkdownTransformer,
	ShellEntryState,
	ToolRowRenderContext,
	ToolRowRenderers,
	WorkingIndicatorRenderer,
	WorkingIndicatorState,
} from "./core/modules/index.ts";
export {
	BorderedLoader,
	CustomEditor,
	type CustomEditorOptions,
	DynamicBorder,
	type RenderDiffOptions,
	renderDiff,
	ToolExecutionComponent,
	type ToolExecutionOptions,
	truncateToVisualLines,
	type VisualTruncateResult,
} from "./modes/interactive/components/index.ts";
export {
	getLanguageFromPath,
	getMarkdownTheme,
	getSelectListTheme,
	getSettingsListTheme,
	getThemeInstance,
	highlightCode,
	initTheme,
	Theme,
	type ThemeAppearance,
	type ThemeBg,
	type ThemeColor,
	type ThemeStyle,
	type ThemeToken,
} from "./modes/interactive/theme/theme.ts";
