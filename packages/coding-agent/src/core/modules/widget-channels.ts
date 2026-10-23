/**
 * Named widget channels: the host side.
 *
 * `ctx.ui.setWidget(key, …)` lets any module write any key and lets the host
 * decide how the content is drawn. A channel splits that in two: the producer
 * writes typed content, and a module that registered a transform decides what
 * is drawn. Neither side needs the other's code — they share the channel
 * constant — and the widget key the host ends up writing belongs to the
 * channel, so a transform never has to guess the producer's widget key.
 */

import type {
	ModuleUIContext,
	ModuleWidgetChannel,
	ModuleWidgetChannelContent,
	ModuleWidgetChannelContext,
	ModuleWidgetChannelTransform,
	ModuleWidgetChannelUpdateOptions,
} from "./types.ts";

/** Widget key a channel writes to. Namespaced so it cannot collide with a plain `setWidget` key. */
export function channelWidgetKey(channel: ModuleWidgetChannel): string {
	return `channel:${channel.name}`;
}

interface ChannelState {
	content: unknown;
	options: ModuleWidgetChannelUpdateOptions | undefined;
}

/**
 * Bind a ui context to channels. One host per interactive session: the
 * transforms a module registers only ever see the content written through the
 * same host, so two sessions cannot read each other's rows.
 */
export class WidgetChannelHost {
	private ui: ModuleUIContext | undefined;
	private channelUI: ModuleUIContext | undefined;
	private states = new Map<string, ChannelState>();
	private transforms = new Map<string, ModuleWidgetChannelTransform[]>();

	/** Point the host at a ui context. Undefined detaches it (RPC/print modes have no widgets). */
	bind(ui: ModuleUIContext | undefined): void {
		if (this.ui === ui) return;
		this.ui = ui;
		this.channelUI = undefined;
		// Re-draw whatever a producer wrote before the session had a ui context.
		for (const [name, state] of this.states) {
			if (state.content !== undefined) this.draw(name, state);
		}
	}

	context<T extends ModuleWidgetChannelContent>(channel: ModuleWidgetChannel<T>): ModuleWidgetChannelContext<T> {
		return {
			update: (content, options) => {
				this.update(channel, content, options);
			},
			transform: (transform) => this.addTransform(channel, transform as ModuleWidgetChannelTransform),
		};
	}

	/**
	 * The ui context modules get: the session's own, plus `channel()`. Wrapping
	 * rather than teaching every mode means `setChannel` works in TUI, RPC, and
	 * the no-op context alike, and a module keeps the context object it was
	 * handed.
	 */
	forContext(ui: ModuleUIContext): ModuleUIContext {
		const channel = <T extends ModuleWidgetChannelContent>(c: ModuleWidgetChannel<T>) => this.context(c);
		if (this.channelUI) {
			this.channelUI.channel = channel;
			return this.channelUI;
		}
		this.channelUI = Object.create(ui) as ModuleUIContext;
		this.channelUI.channel = channel;
		return this.channelUI;
	}

	private update<T extends ModuleWidgetChannelContent>(
		channel: ModuleWidgetChannel<T>,
		content: T | undefined,
		options: ModuleWidgetChannelUpdateOptions | undefined,
	): void {
		if (content !== undefined && !channel.is(content)) {
			throw new Error(`Invalid content for widget channel "${channel.name}"`);
		}
		const state: ChannelState = { content, options };
		this.states.set(channel.name, state);
		if (content !== undefined) this.draw(channel.name, state);
		else this.ui?.setWidget(channelWidgetKey(channel), undefined);
	}

	private addTransform(channel: ModuleWidgetChannel, transform: ModuleWidgetChannelTransform): () => void {
		const list = this.transforms.get(channel.name) ?? [];
		list.push(transform);
		this.transforms.set(channel.name, list);
		// A transform that arrives after the first write still has to see it: the
		// producer writes once at session start and never again until the next job.
		const latest = this.states.get(channel.name);
		if (latest?.content !== undefined) this.draw(channel.name, latest);
		return () => {
			const current = this.transforms.get(channel.name);
			if (!current) return;
			const index = current.indexOf(transform);
			if (index === -1) return;
			current.splice(index, 1);
			if (current.length > 0) return;
			// With no transform left the channel falls back to its label, which
			// needs a redraw of the content the producer last wrote.
			this.transforms.delete(channel.name);
			const state = this.states.get(channel.name);
			if (state?.content !== undefined) this.draw(channel.name, state);
		};
	}

	private draw(name: string, state: ChannelState): void {
		const ui = this.ui;
		if (!ui) return;
		const key = `channel:${name}`;
		// Last transform wins: it owns the drawing, and drawing twice would push
		// the earlier one's line count into the widget's layout math.
		const transforms = this.transforms.get(name);
		const transform = transforms?.[transforms.length - 1];
		if (!transform) {
			const label = (state.content as { label: string }).label;
			ui.setWidget(key, [`[${label}]`], state.options);
			return;
		}
		const drawn = transform(state.content as { label: string; kind: string });
		// A transform returning undefined means "draw nothing" — `lines: []` is
		// how one clears the block it owns without giving the channel up.
		if (!drawn) {
			ui.setWidget(key, undefined);
			return;
		}
		if ("lines" in drawn) {
			ui.setWidget(key, drawn.lines, state.options);
			return;
		}
		ui.setWidget(key, drawn.component, state.options);
	}
}
