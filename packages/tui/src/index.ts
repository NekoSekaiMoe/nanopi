// Core TUI interfaces and classes

// Named exports, not `export *` per source: this root is a deliberately small
// rendering contract, so a name reaches it only when a line here says so. That is
// not the same argument as the coding-agent root's, where a wildcard is right
// because that root already hands out a whole agent and per-source lists only
// drifted — here the list is the contract, and there are more sources than names.
// Cost is unbudgeted in `scripts/check-entry-graphs.mjs`; if that changes, cap
// this entry rather than growing it.

export { Marked, type Token, type Tokens } from "marked";
// Autocomplete support
export {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	CombinedAutocompleteProvider,
	type SlashCommand,
} from "./autocomplete.ts";
// Colors and styling
export {
	backgroundAnsi,
	type Color,
	type ColorMixSpace,
	colorToHex,
	colorToOkhsl,
	colorToOklch,
	colorToRgb,
	foregroundAnsi,
	type IndexedColor,
	indexedColor,
	mixColors,
	type OkhslChannels,
	type OklchChannels,
	type OklchColorValue,
	okhslColor,
	oklchColor,
	parseColor,
	type RgbColorValue,
	rgbColor,
	styleText,
	styleTextWithAnsi,
	type TerminalColorMode,
	type TextAttributes,
	type TextStyle,
} from "./colors.ts";
// Component interface and mouse events (what a component is, what a mouse event looks like)
export type {
	Component,
	TuiMouseButton,
	TuiMouseEvent,
	TuiMouseEventResult,
	TuiMouseEventType,
} from "./component.ts";
// Components
export { Box } from "./components/box.ts";
export { CancellableLoader } from "./components/cancellable-loader.ts";
export { Editor, type EditorOptions, type EditorTheme } from "./components/editor.ts";
export { HStack } from "./components/h-stack.ts";
export {
	Image,
	type ImageOptions,
	type ImageTheme,
	type ImageTranscoder,
	setImageTranscoder,
} from "./components/image.ts";
export { Input } from "./components/input.ts";
export { Loader, type LoaderIndicatorOptions } from "./components/loader.ts";
export { type DefaultTextStyle, Markdown, type MarkdownOptions, type MarkdownTheme } from "./components/markdown.ts";
export { MouseRegion, type MouseRegionHandler } from "./components/mouse-region.ts";
export {
	ScrollView,
	type ScrollViewOptions,
	type ScrollViewScrollbar,
	type ScrollViewScrollToOptions,
} from "./components/scroll-view.ts";
export {
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	type SelectListTheme,
	type SelectListTruncatePrimaryContext,
} from "./components/select-list.ts";
export { type SettingItem, SettingsList, type SettingsListTheme } from "./components/settings-list.ts";
export { Spacer } from "./components/spacer.ts";
export { Text } from "./components/text.ts";
export { TruncatedText } from "./components/truncated-text.ts";
export {
	type StackChild,
	type StackEntry,
	type StackEntryOptions,
	type StackOptions,
	VStack,
} from "./components/v-stack.ts";
// Editor component interface (for custom editors)
export type { EditorComponent } from "./editor-component.ts";
// Fuzzy matching
export { type FuzzyMatch, fuzzyFilter, fuzzyMatch } from "./fuzzy.ts";
// Keybindings
export {
	getKeybindings,
	type Keybinding,
	type KeybindingConflict,
	type KeybindingDefinition,
	type KeybindingDefinitions,
	type Keybindings,
	type KeybindingsConfig,
	KeybindingsManager,
	setKeybindings,
	TUI_KEYBINDINGS,
} from "./keybindings.ts";
// Keyboard input handling
export {
	decodeKittyPrintable,
	isKeyRelease,
	isKeyRepeat,
	isKittyProtocolActive,
	Key,
	type KeyEventType,
	type KeyId,
	matchesKey,
	parseKey,
	setKittyProtocolActive,
} from "./keys.ts";
// LaTeX rendering
export { type RenderLatexOptions, renderLatex } from "./latex.ts";
// Layout contracts shared by stack and scroll components
export {
	getLayoutNode,
	LAYOUT_NODE,
	type LayoutComponent,
	type LayoutNode,
	type LayoutViewport,
	type ScrollLayoutNode,
	type ScrollLayoutState,
	type StackLayoutEntry,
	type StackLayoutNode,
} from "./layout-node.ts";
// Native prebuild lookup
export {
	getNativeModuleCandidates,
	getNativeModulePath,
	type NativeModuleCandidateOptions,
} from "./native-module-path.ts";
// Native platform integration
export { getNativeClipboard, type NativeClipboard } from "./native-platform.ts";
export { oklabToOkhslLightness } from "./oklab.ts";
// Paging rules shared by lists and scroll dialogs
export {
	clampScrollOffset,
	type PageSelectionOptions,
	pageScrollOffset,
	pageStep,
	windowStart,
} from "./pager.ts";
// Program status reporting (OSC 7501)
export { formatProgramStatus, type ProgramStatus } from "./program-status.ts";
// Input buffering for batch splitting
export { StdinBuffer, type StdinBufferEventMap, type StdinBufferOptions } from "./stdin-buffer.ts";
// Terminal interface and implementations
export { isAppleTerminalSession, ProcessTerminal, type Terminal } from "./terminal.ts";
// Terminal colors
export {
	parseTerminalColorSchemeReport,
	type RgbColor,
	type TerminalColorScheme,
	type TerminalColors,
} from "./terminal-colors.ts";
// Terminal image support
export {
	allocateImageId,
	type CellDimensions,
	calculateImageRows,
	deleteAllKittyImages,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getCellDimensions,
	getGifDimensions,
	getImageDimensions,
	getJpegDimensions,
	getPngDimensions,
	getTerminalColorMode,
	getWebpDimensions,
	hyperlink,
	type ImageDimensions,
	type ImageProtocol,
	type ImageRenderOptions,
	imageFallback,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	setCellDimensions,
	type TerminalCapabilities,
} from "./terminal-image.ts";
export {
	Container,
	CURSOR_MARKER,
	compositeTuiLine,
	type Focusable,
	isFocusable,
	isViewportTUI,
	type OverlayAnchor,
	type OverlayBounds,
	type OverlayHandle,
	type OverlayMargin,
	type OverlayOptions,
	type OverlayUnfocusOptions,
	renderFakeCursor,
	type SizeValue,
	type TUI,
	type TuiInputListener,
	type TuiInputListenerResult,
	type TuiMode,
	type TuiStopOptions,
	type ViewportTUI,
} from "./tui.ts";
export { TuiAltScreen, type TuiAltScreenOptions } from "./tui-alt-screen.ts";
export { TuiMainScreen, type TuiMainScreenRenderState } from "./tui-main-screen.ts";
// Utilities
export {
	getOsc8LinkAtColumn,
	sliceByColumn,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "./utils.ts";
export type { WheelScrollLines } from "./wheel-scroll.ts";
