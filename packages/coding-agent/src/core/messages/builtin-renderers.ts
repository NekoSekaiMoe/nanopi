/**
 * Interactive renderers for the message kinds this app writes itself.
 *
 * The codecs in `builtin-codecs.ts` are pure projection, and compaction reaches them: one
 * `renderRun` there dragged the whole theme and component tree into every summary path, which is
 * most of the 180-file graph behind `core/compaction`. These functions know about the transcript,
 * so they are loaded lazily and only when the transcript actually draws such a message.
 *
 * The deferral is why this file exists; a static import from `builtin-codecs.ts` would put the
 * cost straight back. That is also why nothing here imports `@nanopi/pi-tui`: its barrel pulls the
 * renderer, the terminal and the key parser, and the transcript's own component types are
 * structural anyway. The one import left is erased before Node sees it.
 */

import type { MessageRunRenderOptions } from "./codec.ts";

type RenderRun = (message: never, options: MessageRunRenderOptions) => Renderable;

/** The slice of `Component` a transcript view is drawn through. */
interface Renderable {
	render(width: number): string[];
	invalidate(): void;
}

interface MessageComponent {
	setExpanded?(expanded: boolean): void;
	render(width: number): string[];
	invalidate(): void;
}

export const renderBranchSummary: RenderRun = (message, options) =>
	new DeferredMessageComponent(
		import("../../modes/interactive/components/branch-summary-message.ts").then(
			(m) => m.BranchSummaryMessageComponent,
		),
		message,
		options,
	);

export const renderCompactionSummary: RenderRun = (message, options) =>
	new DeferredMessageComponent(
		import("../../modes/interactive/components/compaction-summary-message.ts").then(
			(m) => m.CompactionSummaryMessageComponent,
		),
		message,
		options,
	);

/**
 * Stand-in that fills in once the lazily loaded component module resolves. Until then it renders
 * nothing; the transcript redraws after the microtask queue drains, which is before the next frame.
 */
class DeferredMessageComponent implements Renderable {
	private readonly source: Promise<new (message: never, theme: never, outputPad: number) => MessageComponent>;
	private readonly message: never;
	private readonly options: MessageRunRenderOptions;
	private inner: MessageComponent | undefined;

	constructor(
		source: Promise<new (message: never, theme: never, outputPad: number) => MessageComponent>,
		message: never,
		options: MessageRunRenderOptions,
	) {
		this.source = source;
		this.message = message;
		this.options = options;
		void this.source.then(async (Component) => {
			const { getMarkdownTheme } = await import("../../modes/interactive/theme/theme.ts");
			const inner = new Component(this.message, getMarkdownTheme() as never, this.options.outputPad);
			inner.setExpanded?.(this.options.expanded);
			this.inner = inner;
		});
	}

	invalidate(): void {
		this.inner?.invalidate();
	}

	render(width: number): string[] {
		return this.inner?.render(width) ?? [];
	}
}
