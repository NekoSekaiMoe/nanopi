import { Container, Markdown, type MarkdownTheme } from "@nanopi/pi-tui";
import type { MarkdownTransformer } from "../../../core/modules/types.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { createMarkdownTransform } from "./markdown-transform.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private text: string;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;
	private markdownTransformers: readonly MarkdownTransformer[];
	/**
	 * The body. Kept across rebuilds so a re-layout calls `setText` instead of
	 * allocating a fresh `Markdown`, whose token cache would start empty again.
	 */
	private body: Markdown | undefined;

	constructor(
		text: string,
		markdownTheme: MarkdownTheme = getMarkdownTheme(),
		outputPad = 1,
		markdownTransformers: readonly MarkdownTransformer[] = [],
	) {
		super();
		this.text = text;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.markdownTransformers = markdownTransformers;
		this.rebuild();
	}

	setOutputPad(padding: number): void {
		this.outputPad = padding;
		this.rebuild();
	}

	private rebuild(): void {
		// The Markdown pads and colors its own background: a Box around it would keep a second full-width copy of every
		// line, with identical output.
		if (this.body) {
			this.body.setText(this.text);
			this.body.setTheme(this.markdownTheme);
			return;
		}
		this.body = new Markdown(
			this.text,
			this.outputPad,
			1,
			this.markdownTheme,
			{
				color: (content: string) => theme.fg("userMessageText", content),
				bgColor: (content: string) => theme.bg("userMessageBg", content),
			},
			{
				preserveOrderedListMarkers: true,
				preserveBackslashEscapes: true,
				transform: createMarkdownTransform("user", false, this.markdownTransformers),
			},
		);
		this.addChild(this.body);
	}

	override clear(): void {
		super.clear();
		this.body = undefined;
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}
