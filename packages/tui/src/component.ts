/**
 * The two shapes every renderer shares: what a component is, and what a mouse event looks like.
 *
 * Both live here instead of `tui.ts` so that a component can type itself without pulling the
 * renderer, the terminal, the key parser and the color queries behind it. `tui.ts` re-exports
 * them, so `import type { Component } from "@nanopi/pi-tui"` still works and nothing downstream
 * has to change.
 */

export type TuiMouseEventType = "press" | "release" | "move" | "drag" | "click" | "wheel";
export type TuiMouseButton = "left" | "middle" | "right" | "none";

/** Normalized cell-based mouse event. Coordinates are zero-based. */
export interface TuiMouseEvent {
	type: TuiMouseEventType;
	button: TuiMouseButton;
	/** Coordinates local to the receiving component. */
	x: number;
	y: number;
	/** Absolute terminal coordinates. */
	screenX: number;
	screenY: number;
	/** Current component bounds. */
	width: number;
	height: number;
	shift: boolean;
	alt: boolean;
	ctrl: boolean;
	/** Logical lines. Negative values scroll up. */
	wheelDelta?: number;
	/** Consecutive click count when type is click. */
	clickCount?: number;
}

export interface TuiMouseEventResult {
	/** Stop propagation and suppress renderer-level fallback behavior. */
	handled?: boolean;
	/** Route subsequent drag/release events to this component. Implies handled. */
	capture?: boolean;
	/** Give keyboard focus to this component. Implies handled. */
	focus?: boolean;
	/**
	 * Explicitly request or suppress a render. Move and release default to false;
	 * press, click, drag, and wheel default to true.
	 */
	render?: boolean;
}

export interface Component {
	/**
	 * Render the component to lines for the given viewport width
	 * @param width - Current viewport width
	 * @returns Array of strings, each representing a line
	 */
	render(width: number): string[];

	/** Optional handler for keyboard input when component has focus. */
	handleInput?(data: string): void;

	/** Optional normalized mouse handler. */
	handleMouse?(event: TuiMouseEvent): TuiMouseEventResult | undefined;

	/**
	 * If true, component receives key release events (Kitty protocol).
	 * Default is false - release events are filtered out.
	 */
	wantsKeyRelease?: boolean;

	/**
	 * Redraw what is already there: the inputs moved (a theme change, a resize,
	 * a callback the last render scheduled), the content did not. A component
	 * drops its caches and builds again; it must never return lines it cannot
	 * vouch for.
	 *
	 * Containers forward this, not re-render: an invalidated child repaints
	 * itself on its next `render`. A component that owns a subtree and has to
	 * rebuild it to repaint — because the rebuild is what re-reads the theme —
	 * overrides this, calls `super.invalidate()` and rebuilds.
	 *
	 * Content that changed is `setText`, not this. No component here has a
	 * settable text, so this is only the vocabulary; keep the two apart anyway
	 * and do not turn this into "maybe drop the cache": the caller is the one
	 * that knows the content stands, and it cannot tell you whether it does.
	 */
	invalidate(): void;
}
