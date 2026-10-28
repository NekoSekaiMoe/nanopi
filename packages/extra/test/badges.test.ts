import { describe, expect, test } from "vitest";
import { type BadgeThemeSlice, badgeLabels, modeBadgeText, shellLabel } from "../src/badges.ts";
import { ModeEngine } from "../src/mode-engine.ts";

const fakeTheme: BadgeThemeSlice = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
};

describe("mode badges", () => {
	test("yolo and the run mode show together", () => {
		const engine = new ModeEngine();
		expect(badgeLabels(engine)).toEqual([]);
		engine.setYolo(true);
		expect(badgeLabels(engine)).toEqual(["yolo"]);
		engine.setMode("plan");
		expect(badgeLabels(engine)).toEqual(["yolo", "plan"]);
		engine.setMode("minimal");
		expect(badgeLabels(engine)).toEqual(["yolo", "minimal"]);
	});

	test("minimal is a badge on its own", () => {
		const engine = new ModeEngine();
		expect(modeBadgeText(engine, fakeTheme)).toBeUndefined();
		engine.setMode("minimal");
		expect(modeBadgeText(engine, fakeTheme)).toBe("<modeMinimal>minimal</modeMinimal>");
	});

	test("standard shows no badge: it is the absence of a run mode", () => {
		const engine = new ModeEngine();
		engine.setMode("plan");
		engine.setMode("standard");
		expect(badgeLabels(engine)).toEqual([]);
	});

	test("run modes never show at once: each one replaces the last", () => {
		const engine = new ModeEngine();
		engine.setMode("plan");
		engine.setMode("minimal");
		expect(badgeLabels(engine)).toEqual(["minimal"]);
		engine.setMode("standard");
		expect(badgeLabels(engine)).toEqual([]);
	});

	test("badge text colors yolo red, plan green, minimal blue", () => {
		const engine = new ModeEngine();
		expect(modeBadgeText(engine, fakeTheme)).toBeUndefined();
		engine.setYolo(true);
		expect(modeBadgeText(engine, fakeTheme)).toBe("<modeYolo>yolo</modeYolo>");
		engine.setMode("plan");
		expect(modeBadgeText(engine, fakeTheme)).toBe("<modeYolo>yolo</modeYolo> <modePlan>plan</modePlan>");
		engine.setMode("minimal");
		expect(modeBadgeText(engine, fakeTheme)).toBe("<modeYolo>yolo</modeYolo> <modeMinimal>minimal</modeMinimal>");
	});

	test("shell mode takes the slot; the badge comes back when it ends", () => {
		const engine = new ModeEngine();
		engine.setYolo(true);
		engine.setMode("plan");
		expect(modeBadgeText(engine, fakeTheme, true)).toBeUndefined();
		expect(shellLabel(fakeTheme)).toBe("<bashMode>shell</bashMode>");
		expect(modeBadgeText(engine, fakeTheme, false)).toBe("<modeYolo>yolo</modeYolo> <modePlan>plan</modePlan>");
	});
});
