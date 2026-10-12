/**
 * Process-wide run-mode state. One engine per process: the interactive CLI and
 * the webui server each host a single agent session at a time, and the webui
 * bridge reads this singleton directly.
 *
 * Mode changes notify subscribers (footer badges, webui SSE mirrors); applying
 * tool-set side effects is the extension's job (see extension.ts).
 */

import { isRunMode, type RunMode } from "./types.ts";

export interface ModeSnapshot {
	mode: RunMode;
	yolo: boolean;
	/** Why the current mode was set, shown in mode-change notifications. */
	reason: string | undefined;
}

export type ModeListener = (snapshot: ModeSnapshot) => void;

export class ModeEngine {
	private current: RunMode = "standard";
	private yoloFlag = false;
	private currentReason: string | undefined;
	private readonly listeners = new Set<ModeListener>();
	/** Snapshot of active tools before minimal mode restricted them. */
	private minimalSnapshot: string[] | undefined;

	get mode(): RunMode {
		return this.current;
	}

	get yolo(): boolean {
		return this.yoloFlag;
	}

	get reason(): string | undefined {
		return this.currentReason;
	}

	snapshot(): ModeSnapshot {
		return { mode: this.current, yolo: this.yoloFlag, reason: this.currentReason };
	}

	setYolo(enabled: boolean): void {
		if (this.yoloFlag === enabled) return;
		this.yoloFlag = enabled;
		this.emit();
	}

	setMode(mode: RunMode, reason?: string): void {
		if (!isRunMode(mode)) throw new Error(`invalid run mode: ${String(mode)}`);
		if (this.current === mode) return;
		this.current = mode;
		this.currentReason = reason;
		if (mode !== "minimal") this.minimalSnapshot = undefined;
		this.emit();
	}

	/** Active tools captured when minimal mode was entered; undefined otherwise. */
	get preMinimalTools(): string[] | undefined {
		return this.minimalSnapshot;
	}

	setPreMinimalTools(tools: string[] | undefined): void {
		this.minimalSnapshot = tools;
	}

	subscribe(listener: ModeListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private emit(): void {
		const snapshot = this.snapshot();
		for (const listener of this.listeners) listener(snapshot);
	}
}

/** Shared engine instance used by the extension and the webui bridge. */
export const modeEngine = new ModeEngine();
