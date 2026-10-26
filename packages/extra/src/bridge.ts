/**
 * In-process bridge between the extra extension and the webui server.
 *
 * The extension and `nanopi webui` share one process and one module instance,
 * so the bridge is a plain singleton: the webui server reads mode state,
 * subscribes to permission prompts, and edits extra settings through it. When a
 * build flavor excludes the module, the bundle scripts replace this module with
 * an inert stub whose `available` is false.
 */

import { type JudgeModelRegistry, judgeWithModel } from "./ai-judge.ts";
import { AskBroker } from "./ask-broker.ts";
import { type ModeEngine, modeEngine } from "./mode-engine.ts";
import { PermissionBroker } from "./permissions.ts";
import {
	type ExtraSettingsPatch,
	loadExtraSettings,
	type ResolvedExtraSettings,
	saveExtraSettings,
} from "./settings-store.ts";
import type { ExtraStatePayload, RunMode, SubsystemKey, SubsystemStatus } from "./types.ts";
import { isPermissionDecision, isRunMode } from "./types.ts";

/** Extension-side hooks registered when the extra extension loads. */
export interface BridgeExtensionHooks {
	/** Live subsystem availability/enabled status for display. */
	subsystemStatus(): SubsystemStatus[];
	/** Immediate in-session effect of a subsystem toggle (tool filtering). */
	applySubsystem(key: SubsystemKey, enabled: boolean): void;
	/** Re-derive the active tool set from the current mode (minimal narrows it). */
	applyModeToolSet(): void;
	/** The prompt the input box should offer while the gate holds a call, if any. */
	continueSuggestion?(): string | undefined;
}

/** Session-side judge inputs the extension binds for webui-mode AI decisions. */
export interface BridgeJudgeContext {
	model: unknown;
	registry: JudgeModelRegistry | undefined;
	cwd?: string;
}

export class ExtraBridge {
	readonly available = true as const;
	readonly engine: ModeEngine = modeEngine;
	readonly permissions = new PermissionBroker();
	/** Structured-input channel for webui sessions (see ask-broker.ts). */
	readonly asks = new AskBroker();

	private extensionHooks: BridgeExtensionHooks | undefined;
	private bridgeCwd: string | undefined;
	private judgeContext: BridgeJudgeContext | undefined;

	/** Called by the extension when its session starts (webui mode included). */
	bindSession(hooks: BridgeExtensionHooks, cwd: string, judge: BridgeJudgeContext): void {
		this.extensionHooks = hooks;
		this.bridgeCwd = cwd;
		this.judgeContext = judge;
	}

	/** Called by the webui server once at startup. */
	state(): ExtraStatePayload {
		const snapshot = this.engine.snapshot();
		return { available: true, mode: snapshot.mode, yolo: snapshot.yolo };
	}

	/**
	 * Validate and switch the run mode (webui /approval_mode, /extra/mode, and the
	 * `approval_mode` field of /chat). The engine notifies the extension, which
	 * applies the tool set; the explicit call covers a bridge used before its
	 * session bound its hooks.
	 */
	setMode(value: unknown): { ok: true; mode: RunMode } | { ok: false; error: string } {
		if (!isRunMode(value)) return { ok: false, error: `invalid run mode: ${String(value)}` };
		const changed = this.engine.mode !== value;
		this.engine.setMode(value, "webui");
		if (changed) this.extensionHooks?.applyModeToolSet();
		return { ok: true, mode: value };
	}

	/** Validate and persist the default mode for new sessions. */
	setDefaultMode(value: unknown): { ok: true } | { ok: false; error: string } {
		if (!isRunMode(value)) return { ok: false, error: `invalid default mode: ${String(value)}` };
		saveExtraSettings({ defaultMode: value });
		return { ok: true };
	}

	/**
	 * Prompt to offer in the input box while a permission prompt is holding a call.
	 *
	 * Feature-detected by the caller: a build flavor that excludes this module
	 * substitutes `{}` for the bridge, so the method is absent rather than inert.
	 */
	continueSuggestion?(): string | undefined {
		return this.extensionHooks?.continueSuggestion?.();
	}

	/**
	 * Validate and answer the outstanding permission prompt.
	 *
	 * `"explain"` is not a decision: it pauses the prompt and asks the model to
	 * describe the call. It is accepted here only when a permission prompt is
	 * actually waiting, which `PermissionBroker.answer` checks.
	 */
	answerPermission(decision: string, callId: string | undefined, toolName: string | undefined): boolean {
		if (decision === "explain") return this.permissions.answer(callId, toolName, decision);
		if (!isPermissionDecision(decision)) return false;
		return this.permissions.answer(callId, toolName, decision);
	}

	settings(): ResolvedExtraSettings {
		return loadExtraSettings(this.bridgeCwd ?? process.cwd());
	}

	updateSettings(patch: ExtraSettingsPatch): ReturnType<typeof saveExtraSettings> {
		return saveExtraSettings(patch);
	}

	subsystemStatus(): SubsystemStatus[] {
		return this.extensionHooks?.subsystemStatus() ?? [];
	}

	/** Toggle a subsystem: persist the extra switch and apply the in-session tool effect. */
	setSubsystem(key: SubsystemKey, enabled: boolean): SubsystemStatus[] {
		saveExtraSettings({ subsystems: { [key]: enabled } });
		this.extensionHooks?.applySubsystem(key, enabled);
		return this.subsystemStatus();
	}

	/** Judge a gated call with the bound session model (webui-mode AI decisions). */
	judge(info: Parameters<typeof judgeWithModel>[0]): ReturnType<typeof judgeWithModel> {
		return judgeWithModel(info, this.judgeContext?.model, this.judgeContext?.registry, {
			cwd: this.judgeContext?.cwd ?? this.bridgeCwd,
		});
	}
}

/** Shared bridge instance; aliased to an inert stub when the flavor excludes the module. */
export const extraBridge = new ExtraBridge();
