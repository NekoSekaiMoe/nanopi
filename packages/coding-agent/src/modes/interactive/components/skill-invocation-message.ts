import { Container, Markdown, type MarkdownTheme, MouseRegion, Text } from "@nanopi/pi-tui";
import type { ParsedSkillBlock } from "../../../core/agent-session.ts";
import { getMarkdownTheme, theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";

/**
 * Component that renders a skill invocation message with collapsed/expanded state.
 *
 * Uses the compact tool-row shape (`read skill <name>`), the same label the read
 * renderer gives a SKILL.md load, so invoking a skill reads like any other call.
 */
export class SkillInvocationMessageComponent extends Container {
	private expanded = false;
	private skillBlock: ParsedSkillBlock;
	private markdownTheme: MarkdownTheme;
	private outputPad: number;

	constructor(skillBlock: ParsedSkillBlock, markdownTheme: MarkdownTheme = getMarkdownTheme(), outputPad = 1) {
		super();
		this.skillBlock = skillBlock;
		this.markdownTheme = markdownTheme;
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.outputPad = outputPad;
		this.updateDisplay();
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	private updateDisplay(): void {
		this.clear();

		const title = theme.fg("toolTitle", theme.bold("read skill"));
		const name = theme.fg("accent", this.skillBlock.name);
		const content = new Container();

		if (this.expanded) {
			content.addChild(new Text(`${title} ${name}`, this.outputPad, 0));
			const body = `**${this.skillBlock.name}**\n\n${this.skillBlock.content}`;
			content.addChild(
				new Markdown(body, 1, 0, this.markdownTheme, {
					color: (text: string) => theme.fg("toolOutput", text),
				}),
			);
		} else {
			const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			content.addChild(new Text(`${title} ${name}${expandHint}`, this.outputPad, 0));
		}

		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
