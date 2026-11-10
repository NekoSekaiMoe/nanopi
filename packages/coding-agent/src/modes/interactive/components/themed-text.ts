import { Text } from "@nanopi/pi-tui";
import { getThemeInstance } from "../theme/theme.ts";

/**
 * Text whose content applies theme colors. Plain `Text` keeps the colors its string was built with, so
 * a theme change, or the system theme receiving the terminal's colors, would leave it stale. This
 * rebuilds the string from `build` whenever the theme instance or the build changes, and after an
 * invalidation.
 *
 * `build` must return the same content each time, apart from colors. Snapshot changing data before
 * creating the component, or call `setBuild` or `invalidate()` after changing state that `build` reads.
 */
export class ThemedText extends Text {
	private build: () => string;
	/**
	 * The theme the text was last built from. A theme change installs a new
	 * instance, and a regenerated theme can resolve to the same escape
	 * sequences, so `Text.setText` dropping a repeated string is not enough to
	 * tell "already current" from "stale colors".
	 */
	private builtFor: unknown;
	/**
	 * Whether the next render has to rebuild. `invalidate()` is called by the UI
	 * for reflows the component cannot observe, and by hosts that changed state
	 * `build` reads; both want a fresh string even when the theme is unchanged.
	 */
	private stale = true;

	constructor(build: () => string, paddingX = 1, paddingY = 1) {
		super("", paddingX, paddingY);
		this.build = build;
	}

	/** Replace what `build` returns, then rebuild. */
	setBuild(build: () => string): void {
		this.build = build;
		this.stale = true;
	}

	override invalidate(): void {
		super.invalidate();
		this.stale = true;
	}

	override render(width: number): string[] {
		const currentTheme = getThemeInstance();
		if (this.stale || this.builtFor !== currentTheme) {
			this.stale = false;
			this.builtFor = currentTheme;
			const next = this.build();
			// A regenerated theme can resolve to the same sequences, and repeating
			// the string leaves the lines `invalidate` just dropped to be rebuilt
			// anyway; nothing to do in that case.
			if (next !== this.getText()) this.setText(next);
		}
		return super.render(width);
	}
}
