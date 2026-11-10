import type { AssistantMessage } from "@nanopi/pi-ai";
import {
	type Component,
	Container,
	type DefaultTextStyle,
	Markdown,
	type MarkdownTheme,
	MouseRegion,
	Spacer,
	Text,
} from "@nanopi/pi-tui";
import type {
	AssistantMessageRenderer,
	MarkdownTransformContext,
	MarkdownTransformer,
} from "../../../core/modules/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** One content block of the body: the component that draws it, plus the blank line after it. */
interface BodyBlock {
	component: Component;
	/** `undefined` when the body puts no spacer after this block. */
	spacer: Component | undefined;
}

/**
 * Component that renders a complete assistant message
 */
export class AssistantMessageComponent extends Container {
	private contentContainer: Container;
	private hideThinkingBlock: boolean;
	private markdownTheme: MarkdownTheme;
	private hiddenThinkingLabel: string;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	private lastMessage?: AssistantMessage;
	private hasToolCalls = false;
	private isStreaming = false;
	private thinkingVisibilityOverrides = new Map<number, boolean>();
	/** First renderer that claims a message owns that message's body. */
	private renderers: readonly AssistantMessageRenderer[] = [];
	/**
	 * One component per content index, kept across `updateContent` calls so a
	 * streamed delta calls `setText` instead of allocating a fresh Markdown. A
	 * fresh instance starts with an empty token cache, so rebuilding the body per
	 * delta re-lexed the whole message text every time.
	 */
	private blockComponents = new Map<string, Markdown | Text>();
	/**
	 * The blocks of the current body, in order. The rows after them (the leading
	 * and trailing stop-reason rows) are rebuilt whenever a block disappears:
	 * `Container.handleMouse` dispatches through a layout grown at render time
	 * and only descends into the first `children.length` rows, so a block cannot
	 * be spliced out of the middle without shifting every row behind it.
	 */
	private bodyBlocks: BodyBlock[] = [];
	private tailRows: Component[] = [];

	constructor(
		message?: AssistantMessage,
		hideThinkingBlock = false,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		hiddenThinkingLabel = "Thinking...",
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();

		this.hideThinkingBlock = hideThinkingBlock;
		this.markdownTheme = markdownTheme;
		this.hiddenThinkingLabel = hiddenThinkingLabel;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;

		// Container for text/thinking content
		this.contentContainer = new Container();
		this.addChild(this.contentContainer);

		if (message) {
			this.updateContent(message);
		}
	}

	override invalidate(): void {
		super.invalidate();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHideThinkingBlock(hide: boolean): void {
		this.hideThinkingBlock = hide;
		this.thinkingVisibilityOverrides.clear();
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setHiddenThinkingLabel(label: string): void {
		this.hiddenThinkingLabel = label;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/**
	 * Install the markdown theme to draw the body with.
	 *
	 * A block kept across passes holds the rows its theme produced, so a theme
	 * switch has to reach it: the `blockKey` includes the theme, which drops a
	 * block that was built with a different one.
	 */
	setMarkdownTheme(markdownTheme: MarkdownTheme): void {
		if (this.markdownTheme === markdownTheme) return;
		this.markdownTheme = markdownTheme;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/**
	 * Install `registerAssistantMessageRenderer` renderers for this component.
	 * They run before the default body: the first one that returns true drew the
	 * message, and the default renderer stays available to it as `renderText` /
	 * `renderStopReason` on the context.
	 */
	setMessageRenderers(renderers: readonly AssistantMessageRenderer[]): void {
		this.renderers = renderers;
		if (this.lastMessage) {
			this.updateContent(this.lastMessage);
		}
	}

	/** Read-only view of this component's streaming state, for a message renderer. */
	getIsStreaming(): boolean {
		return this.isStreaming;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (this.hasToolCalls || lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}

	override clear(): void {
		super.clear();
		this.blockComponents.clear();
		this.markdownThemeIds.clear();
		this.nextMarkdownThemeId = 0;
		this.bodyBlocks = [];
		this.tailRows = [];
	}

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// A block keeps its component through `blockComponent`; everything the
		// pass rebuilds is re-appended below.
		this.contentContainer.clear();
		this.bodyBlocks = [];
		this.tailRows = [];
		let leadingRows: Component[] = [];
		if (this.renderers.length > 0) {
			const drawn = this.renderWithModules(message, isStreaming);
			if (drawn) {
				leadingRows = drawn.leading;
			} else {
				this.contentContainer.clear();
				this.bodyBlocks = [];
				this.tailRows = [];
				leadingRows = this.renderDefault(message, isStreaming);
			}
		} else {
			leadingRows = this.renderDefault(message, isStreaming);
		}

		// Blocks first, then the rows around them: the block components are the
		// long-lived ones, and their order is what `thinkingRunIndex` mirrors.
		for (const row of leadingRows) this.contentContainer.addChild(row);
		for (const block of this.bodyBlocks) {
			this.contentContainer.addChild(block.component);
			if (block.spacer) this.contentContainer.addChild(block.spacer);
		}
		for (const row of this.tailRows) this.contentContainer.addChild(row);
	}

	/**
	 * The component for a content block. `setText`, not a new instance, so the
	 * block keeps the token cache `Markdown` parses against. A block only gets
	 * here with a component of the current theme: `blockKey` changes with it.
	 */
	private markdownComponent(key: string, text: string, style?: DefaultTextStyle): Markdown {
		const transformType = key.startsWith("thinking:") ? "assistant-thinking" : "assistant";
		return this.reusedMarkdown(key, text, style, transformType);
	}

	/**
	 * A block a message renderer draws itself. Same key, same component: a
	 * renderer that streams a block calls `setText` on every pass and keeps the
	 * token cache, exactly as the default body does for text blocks.
	 */
	private blockComponent(key: string, text: string, style?: DefaultTextStyle): Markdown {
		return this.reusedMarkdown(key, text, style, "assistant");
	}

	/** The one place a block component is created, so the reuse rule lives once. */
	private reusedMarkdown(
		key: string,
		text: string,
		style: DefaultTextStyle | undefined,
		messageType: MarkdownTransformContext["messageType"],
	): Markdown {
		const composed = this.blockKey(key);
		const existing = this.blockComponents.get(composed);
		if (existing) {
			existing.setText(text);
			return existing as Markdown;
		}
		const created = new Markdown(text, this.outputPad, 0, this.markdownTheme, style, {
			transform: createMarkdownTransform(messageType, this.isStreaming, this.markdownTransformers),
		});
		this.blockComponents.set(composed, created);
		return created;
	}

	/** A collapsed thinking row. It has no text of its own, so it is rebuilt per pass. */
	private hiddenThinkingRow(key: string): Text {
		const label = theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel));
		const composed = this.blockKey(key);
		const existing = this.blockComponents.get(composed);
		if (existing instanceof Text) {
			existing.setText(label);
			return existing;
		}
		const created = new Text(label, this.outputPad, 0);
		this.blockComponents.set(composed, created);
		return created;
	}

	/** Append a content block and the blank line the body puts after it. */
	private addBlock(block: BodyBlock): void {
		this.bodyBlocks.push(block);
	}

	/**
	 * Everything a block component is constructed with, so a change rebuilds it.
	 *
	 * The markdown theme is in the key because a block kept across passes is
	 * rendered with the theme it was built with: `Markdown.setText` reuses the
	 * rows a previous theme produced, so a block that survives a theme switch
	 * still has to be rebuilt. Passes that hand over the same theme object — the
	 * transcript makes a new one per message, so this is every streaming delta —
	 * keep their components.
	 */
	private blockKey(key: string): string {
		return `${key}|${this.outputPad}|${this.isStreaming}|${this.markdownThemeId()}`;
	}

	/** Identity tokens for the themes this component has been rendered with. */
	private markdownThemeIds = new Map<MarkdownTheme, number>();
	private nextMarkdownThemeId = 0;

	/** The token `blockKey` uses for the theme currently installed. */
	private markdownThemeId(): number {
		const known = this.markdownThemeIds.get(this.markdownTheme);
		if (known !== undefined) return known;
		const id = this.nextMarkdownThemeId++;
		this.markdownThemeIds.set(this.markdownTheme, id);
		return id;
	}

	/** Run the registered markdown transformers for one block kind. */
	private applyTransforms(messageType: MarkdownTransformContext["messageType"], markdown: string): string {
		return createMarkdownTransform(messageType, this.isStreaming, this.markdownTransformers)(markdown, 0);
	}

	/** The body rows the default renderer puts before the first block. */
	private renderDefault(message: AssistantMessage, isStreaming: boolean): Component[] {
		const leading: Component[] = [];
		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);
		if (hasVisibleContent) {
			leading.push(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.addBlock({ component: this.markdownComponent(`text:${i}`, content.text.trim()), spacer: undefined });
			} else if (content.type === "thinking") {
				const thinkingBlocks: string[] = [];
				for (; i < message.content.length; i++) {
					const thinkingContent = message.content[i];
					if (thinkingContent.type !== "thinking") {
						break;
					}
					const thinking = thinkingContent.thinking.trim();
					if (thinking) {
						thinkingBlocks.push(thinking);
					}
				}
				i--;

				if (thinkingBlocks.length === 0) {
					continue;
				}

				// Add spacing only when another visible assistant content block follows.
				// This avoids a superfluous blank line before separately-rendered tool execution blocks.
				const hasVisibleContentAfter = message.content
					.slice(i + 1)
					.some((c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()));

				const runIndex = thinkingRunIndex++;
				const hidden = this.thinkingVisibilityOverrides.get(runIndex) ?? this.hideThinkingBlock;
				const thinkingComponent = hidden
					? this.hiddenThinkingRow(`thinking:${runIndex}`)
					: this.markdownComponent(`thinking:${runIndex}`, thinkingBlocks.join("\n\n"), {
							color: (text: string) => theme.fg("thinkingText", text),
							italic: true,
						});
				this.addBlock({
					component: new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
					spacer: hasVisibleContentAfter ? new Spacer(1) : undefined,
				});
			}
		}

		this.renderStopReason(message, isStreaming);
		return leading;
	}

	/**
	 * Offer the message to the registered renderers. A renderer that returns
	 * `undefined` left the message to the default body. A renderer cannot name a
	 * content index, so the blocks it draws directly are rebuilt on every pass;
	 * only `renderText` maps back onto a content block.
	 */
	private renderWithModules(message: AssistantMessage, isStreaming: boolean): { leading: Component[] } | undefined {
		const previousTheme = this.markdownTheme;
		const leading: Component[] = [];
		let textOrdinal = 0;
		const context = {
			isStreaming,
			outputPad: this.outputPad,
			markdownTheme: this.markdownTheme,
			// The module-facing getter, not the static `theme` export: the system
			// theme instance is replaced when the terminal reports its colors.
			theme,
			transform: (messageType: MarkdownTransformContext["messageType"], markdown: string) =>
				this.applyTransforms(messageType, markdown),
			addChild: (component: Component) => {
				this.tailRows.push(component);
			},
			renderText: (text: string) => {
				this.addBlock({
					component: this.markdownComponent(`text:${textOrdinal++}`, text.trim()),
					spacer: undefined,
				});
			},
			renderMarkdown: (key: string, text: string, style?: DefaultTextStyle) => {
				const component = this.blockComponent(key, text, style);
				this.addBlock({ component, spacer: undefined });
				return component;
			},
			renderStopReason: (value: {
				stopReason?: string;
				errorMessage?: string;
				content: readonly { type: string }[];
			}) => {
				this.renderStopReason(value, isStreaming);
			},
		};
		let claimed = false;
		for (const renderer of this.renderers) {
			try {
				if (renderer(message, context)) {
					claimed = true;
					break;
				}
			} catch {
				// A renderer that trips over a message shape leaves it to the default.
			}
		}
		this.markdownTheme = previousTheme;
		return claimed ? { leading } : undefined;
	}

	/**
	 * The stop-reason and error rows. A message renderer that only restyles
	 * content blocks calls this so a truncated or failed turn still says so.
	 */
	renderStopReason(
		message: { stopReason?: string; errorMessage?: string; content: readonly { type: string }[] },
		_isStreaming = this.isStreaming,
	): void {
		// Check if incomplete/failed - show after partial content.
		// For aborted/error tool calls, tool execution components show the error.
		// Length stops can happen before a tool call is complete, so surface them here too.
		const hasToolCalls = message.content.some((c) => c.type === "toolCall");
		this.hasToolCalls = hasToolCalls;
		if (message.stopReason === "length") {
			this.tailRows.push(new Spacer(1));
			this.tailRows.push(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.tailRows.push(new Spacer(1));
				this.tailRows.push(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.tailRows.push(new Spacer(1));
				this.tailRows.push(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
