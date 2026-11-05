/**
 * Interactive renderers for the message kinds this app writes itself.
 *
 * The codecs in `builtin-codecs.ts` are pure projection, and compaction reaches them: one
 * `renderRun` there dragged the whole theme and component tree into every summary path, which is
 * most of the 180-file graph behind `core/compaction`. These functions know about the transcript,
 * so they are loaded lazily and only when the transcript actually draws such a message.
 *
 * The deferral is why this file exists; a static import from `builtin-codecs.ts` would put the
 * cost straight back.
 */

import type { Component } from "@nanopi/pi-tui";
import type { MessageRunRenderOptions, MessageTypeCodec } from "./codec.ts";

type RenderRun = NonNullable<MessageTypeCodec["renderRun"]>;

interface MessageComponentClass {
	new (message: never, markdownTheme: never, outputPad: number): Component & { setExpanded?(expanded: boolean): void };
}

export const renderBranchSummary: RenderRun = (message, options) =>
	new DeferredMessageComponent(
		import("../../modes/interactive/components/branch-summary-message.ts").then(
			(m) => m.BranchSummaryMessageComponent,
		),
		message as never,
		options,
	);

export const renderCompactionSummary: RenderRun = (message, options) =>
	new DeferredMessageComponent(
		import("../../modes/interactive/components/compaction-summary-message.ts").then(
			(m) => m.CompactionSummaryMessageComponent,
		),
		message as never,
		options,
	);

/**
 * Stand-in that fills in once the lazily loaded component module resolves. Until then it renders
 * nothing; the transcript redraws after the microtask queue drains, which is before the next frame.
 */
class DeferredMessageComponent implements Component {
	private readonly source: Promise<MessageComponentClass>;
	private readonly message: never;
	private readonly options: MessageRunRenderOptions;
	private inner: (Component & { setExpanded?(expanded: boolean): void }) | undefined;

	constructor(source: Promise<MessageComponentClass>, message: never, options: MessageRunRenderOptions) {
		this.source = source;
		this.message = message as never;
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
