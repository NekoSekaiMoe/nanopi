import { ProcessTerminal, setCapabilityOverrides, setKeybindings, type TUI, TuiMainScreen } from "@nanopi/pi-tui";
import { getAgentDir } from "../config.ts";
import { KeybindingsManager } from "../core/keybindings.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { ExtensionInputComponent } from "../modes/interactive/components/extension-input.ts";
import { ExtensionSelectorComponent } from "../modes/interactive/components/extension-selector.ts";
import {
	initTheme,
	markTerminalColorsPending,
	refreshSystemTheme,
	setTerminalColors,
} from "../modes/interactive/theme/theme.ts";
import { requestTerminalColors } from "../modes/interactive/theme/theme-controller.ts";
import { flushStdout } from "../utils/flush-stdout.ts";

export async function createStartupTui(settingsManager: SettingsManager): Promise<TUI> {
	setCapabilityOverrides(settingsManager.getTerminalCapabilityOverrides());
	// The system theme starts in grayscale until the terminal reports its colors.
	markTerminalColorsPending();
	initTheme();
	setKeybindings(KeybindingsManager.create());
	const ui: TUI = new TuiMainScreen(new ProcessTerminal(), settingsManager.getShowHardwareCursor(), getAgentDir());
	ui.setClearOnShrink(settingsManager.getClearOnShrink());
	return ui;
}

export function startStartupTui(ui: TUI): void {
	ui.start();
	queryStartupTerminalColors(ui);
}

/**
 * Query the terminal's colors without waiting for them. When they arrive, including after the timeout,
 * record them, regenerate the system theme, and re-render.
 */
function queryStartupTerminalColors(ui: TUI): void {
	void requestTerminalColors(ui, (colors) => {
		setTerminalColors(colors);
		refreshSystemTheme();
		ui.invalidate();
		ui.requestRender();
	});
}

async function clearStartupTui(ui: TUI): Promise<void> {
	ui.clear();
	ui.requestRender();
	await new Promise((resolve) => setTimeout(resolve, 25));
}

export async function showStartupSelector<T>(
	settingsManager: SettingsManager,
	title: string,
	options: Array<{ label: string; value: T }>,
): Promise<T | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: T | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			await clearStartupTui(ui);
			ui.stop();
			await flushStdout();
			resolve(result);
		};

		const selector = new ExtensionSelectorComponent(
			title,
			options.map((option) => option.label),
			(option) => void finish(options.find((entry) => entry.label === option)?.value),
			() => void finish(undefined),
			{ tui: ui },
		);
		ui.addChild(selector);
		ui.setFocus(selector);
		startStartupTui(ui);
	});
}

export async function showStartupInput(
	settingsManager: SettingsManager,
	title: string,
	placeholder?: string,
): Promise<string | undefined> {
	const ui = await createStartupTui(settingsManager);
	return new Promise((resolve) => {
		let settled = false;
		const finish = async (result: string | undefined) => {
			if (settled) {
				return;
			}
			settled = true;
			input.dispose();
			await clearStartupTui(ui);
			ui.stop();
			await flushStdout();
			resolve(result);
		};

		const input = new ExtensionInputComponent(
			title,
			placeholder,
			(value) => void finish(value),
			() => void finish(undefined),
			{
				tui: ui,
			},
		);
		ui.addChild(input);
		ui.setFocus(input);
		startStartupTui(ui);
	});
}
