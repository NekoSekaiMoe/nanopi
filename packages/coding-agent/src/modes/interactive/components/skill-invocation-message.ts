import { type Component, Container, Markdown, type MarkdownTheme, MouseRegion, Text } from "@nanopi/pi-tui";
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
	/**
	 * The expanded body, kept across rebuilds so expanding or collapsing calls
	 * `setText` instead of allocating a fresh `Markdown`. The collapsed state
	 * leaves it unfilled: the row is one `Text` and needs no token cache.
	 */
	private body: Markdown | undefined;
	private content: Container | undefined;
	private region: MouseRegion | undefined;
	private row: Text | undefined;

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
		const title = theme.fg("toolTitle", theme.bold("read skill"));
		const name = theme.fg("accent", this.skillBlock.name);

		if (this.expanded) {
			this.rowText(`${title} ${name}`);
			const text = `**${this.skillBlock.name}**\n\n${this.skillBlock.content}`;
			if (this.body) {
				this.body.setText(text);
				this.body.setTheme(this.markdownTheme);
			} else {
				this.body = new Markdown(text, 1, 0, this.markdownTheme, {
					color: (value: string) => theme.fg("toolOutput", value),
				});
			}
			this.replaceChildren(this.row as Text, this.body);
		} else {
			this.body = undefined;
			const expandHint = theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`);
			this.rowText(`${title} ${name}${expandHint}`);
			this.replaceChildren(this.row as Text);
		}
	}

	/** Point the single header row at `text`, keeping the instance. */
	private rowText(text: string): void {
		if (this.row) {
			this.row.setText(text);
			return;
		}
		this.row = new Text(text, this.outputPad, 0);
	}

	/** Own the children of the clickable region, wrapping it once. */
	private replaceChildren(...children: Component[]): void {
		if (!this.content) {
			this.content = new Container();
			this.region = new MouseRegion(this.content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			});
			this.addChild(this.region);
		}
		this.content.clear();
		for (const child of children) this.content.addChild(child);
	}
}
