import type { AssistantMessage } from "@nanopi/pi-ai";
import { Container, Markdown, type MarkdownTheme, MouseRegion, Spacer, Text } from "@nanopi/pi-tui";
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

	updateContent(message: AssistantMessage, isStreaming = this.isStreaming): void {
		this.lastMessage = message;
		this.isStreaming = isStreaming;

		// Clear content container
		this.contentContainer.clear();

		if (this.renderers.length > 0 && this.renderWithModules(message, isStreaming)) {
			return;
		}

		this.renderDefault(message, isStreaming);
	}

	/**
	 * Offer the message to the registered renderers. A renderer that returns true
	 * has drawn the body; the container is cleared back to the pre-render state
	 * when none of them claims it, so the default renderer sees a clean slate.
	 */
	private renderWithModules(message: AssistantMessage, isStreaming: boolean): boolean {
		let claimed = false;
		const previousTheme = this.markdownTheme;
		const context = {
			isStreaming,
			outputPad: this.outputPad,
			markdownTheme: this.markdownTheme,
			transform: (messageType: MarkdownTransformContext["messageType"], markdown: string) =>
				this.applyTransforms(messageType, markdown),
			addChild: (component: Parameters<Container["addChild"]>[0]) => {
				this.contentContainer.addChild(component);
			},
			renderText: (text: string) => {
				this.contentContainer.addChild(
					new Markdown(text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", isStreaming, this.markdownTransformers),
					}),
				);
			},
			renderStopReason: (value: {
				stopReason?: string;
				errorMessage?: string;
				content: readonly { type: string }[];
			}) => {
				this.renderStopReason(value, isStreaming);
			},
		};
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
		if (!claimed) this.contentContainer.clear();
		return claimed;
	}

	/** Run the registered markdown transformers for one block kind. */
	private applyTransforms(messageType: MarkdownTransformContext["messageType"], markdown: string): string {
		return createMarkdownTransform(messageType, this.isStreaming, this.markdownTransformers)(markdown, 0);
	}

	private renderDefault(message: AssistantMessage, isStreaming: boolean): void {
		const hasVisibleContent = message.content.some(
			(c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
		);

		if (hasVisibleContent) {
			this.contentContainer.addChild(new Spacer(1));
		}

		// Render content in order
		let thinkingRunIndex = 0;
		for (let i = 0; i < message.content.length; i++) {
			const content = message.content[i];
			if (content.type === "text" && content.text.trim()) {
				// Assistant text messages with no background - trim the text
				// Set paddingY=0 to avoid extra spacing before tool executions
				this.contentContainer.addChild(
					new Markdown(content.text.trim(), this.outputPad, 0, this.markdownTheme, undefined, {
						transform: createMarkdownTransform("assistant", this.isStreaming, this.markdownTransformers),
					}),
				);
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
					? new Text(theme.italic(theme.fg("thinkingText", this.hiddenThinkingLabel)), this.outputPad, 0)
					: new Markdown(
							thinkingBlocks.join("\n\n"),
							this.outputPad,
							0,
							this.markdownTheme,
							{
								color: (text: string) => theme.fg("thinkingText", text),
								italic: true,
							},
							{
								transform: createMarkdownTransform(
									"assistant-thinking",
									this.isStreaming,
									this.markdownTransformers,
								),
							},
						);
				this.contentContainer.addChild(
					new MouseRegion(thinkingComponent, (event) => {
						if (event.type !== "click" || event.button !== "left") return undefined;
						this.thinkingVisibilityOverrides.set(runIndex, !hidden);
						if (this.lastMessage) this.updateContent(this.lastMessage);
						return { handled: true };
					}),
				);
				if (hasVisibleContentAfter) {
					this.contentContainer.addChild(new Spacer(1));
				}
			}
		}

		this.renderStopReason(message, isStreaming);
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
			this.contentContainer.addChild(new Spacer(1));
			this.contentContainer.addChild(
				new Text(theme.fg("error", "Response was truncated before completion."), this.outputPad, 0),
			);
		} else if (!hasToolCalls) {
			if (message.stopReason === "aborted") {
				const abortMessage =
					message.errorMessage && message.errorMessage !== "Request was aborted"
						? message.errorMessage
						: "Operation aborted";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", abortMessage), this.outputPad, 0));
			} else if (message.stopReason === "error") {
				const errorMsg = message.errorMessage || "Unknown error";
				this.contentContainer.addChild(new Spacer(1));
				this.contentContainer.addChild(new Text(theme.fg("error", `Error: ${errorMsg}`), this.outputPad, 0));
			}
		}
	}
}
