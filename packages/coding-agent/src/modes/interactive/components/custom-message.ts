import type { TextContent } from "@nanopi/pi-ai";
import type { Component } from "@nanopi/pi-tui";
import { Box, Container, Markdown, type MarkdownTheme, Spacer, Text } from "@nanopi/pi-tui";
import type { CustomMessage } from "../../../core/messages.ts";
import type { MarkdownTransformer, MessageRenderer } from "../../../core/modules/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

/**
 * Component that renders a custom message entry from extensions.
 * Uses distinct styling to differentiate from user messages.
 */
export class CustomMessageComponent extends Container {
	private message: CustomMessage<unknown>;
	private customRenderer?: MessageRenderer;
	private box: Box;
	private customComponent?: Component;
	private markdownTheme: MarkdownTheme;
	private markdownTransformers: readonly MarkdownTransformer[] = [];
	private _expanded = false;
	private outputPad: number;

	constructor(
		message: CustomMessage<unknown>,
		customRenderer?: MessageRenderer,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
	) {
		super();
		this.message = message;
		this.customRenderer = customRenderer;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;

		this.addChild(new Spacer(1));

		// Create box with purple background (used for default rendering)
		this.box = new Box(1, 1, (t) => theme.bg("customMessageBg", t));

		this.rebuild();
	}

	setExpanded(expanded: boolean): void {
		if (this._expanded !== expanded) {
			this._expanded = expanded;
			this.rebuild();
		}
	}

	setOutputPad(outputPad: number): void {
		if (this.outputPad !== outputPad) {
			this.outputPad = outputPad;
			this.rebuild();
		}
	}

	/**
	 * Install the markdown theme to draw the body with. The body reads the theme
	 * on every pass it runs, but a pass that changes nothing to draw keeps the
	 * rows it already rendered, so the theme has to be handed in rather than
	 * followed through the `theme` proxy.
	 */
	setMarkdownTheme(markdownTheme: MarkdownTheme): void {
		if (this.markdownTheme === markdownTheme) return;
		this.markdownTheme = markdownTheme;
		this.rebuild();
	}

	/**
	 * Run these transformers over the body this component draws.
	 *
	 * The body's `Markdown` gets `applyMarkdownTransformers` as its transform. That method is
	 * written here rather than imported so this file stays usable from `./modules`, which
	 * reaches it through the message codecs and does not budget the interactive components.
	 */
	setMarkdownTransformers(transformers: readonly MarkdownTransformer[]): void {
		this.markdownTransformers = transformers;
		this.rebuild();
	}

	private applyMarkdownTransformers = (markdown: string, availableWidth: number): string => {
		let transformed = markdown;
		for (const transformer of this.markdownTransformers) {
			try {
				const result = transformer(transformed, { messageType: "custom", isStreaming: false, availableWidth });
				if (typeof result === "string") transformed = result;
			} catch {
				// Keep the current Markdown and continue with the next transformer.
			}
		}
		return transformed;
	};

	protected override repaintChildren(): void {
		this.rebuild();
	}

	private rebuild(): void {
		// Remove previous content component
		if (this.customComponent) {
			this.removeChild(this.customComponent);
			this.customComponent = undefined;
		}
		this.removeChild(this.box);

		// Try custom renderer first - it handles its own styling
		if (this.customRenderer) {
			try {
				const component = this.customRenderer(
					this.message,
					{ expanded: this._expanded, outputPad: this.outputPad },
					theme,
				);
				if (component) {
					// Custom renderer provides its own styled component
					this.customComponent = component;
					this.addChild(component);
					return;
				}
			} catch {
				// Fall through to default rendering
			}
		}

		// Default rendering uses our box
		this.addChild(this.box);
		this.box.clear();
		this.box.setPaddingX(this.outputPad);

		// Default rendering: label + content
		const label = theme.fg("customMessageLabel", `\x1b[1m[${this.message.customType}]\x1b[22m`);
		this.box.addChild(new Text(label, 0, 0));
		this.box.addChild(new Spacer(1));

		// Extract text content
		let text: string;
		if (typeof this.message.content === "string") {
			text = this.message.content;
		} else {
			text = this.message.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
		}

		this.box.addChild(
			new Markdown(
				text,
				0,
				0,
				this.markdownTheme,
				{
					color: (text: string) => theme.fg("customMessageText", text),
				},
				{
					transform: this.applyMarkdownTransformers,
				},
			),
		);
	}
}
