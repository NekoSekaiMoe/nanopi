import { describe, expect, test } from "vitest";
import { type BadgeThemeSlice, badgeLabels, modeBadgeText } from "../src/badges.ts";
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
		expect(modeBadgeText(engine, fakeTheme)).toBe("<warning>minimal</warning>");
	});

	test("standard shows no mode badge: it is the mode nothing was chosen", () => {
		const engine = new ModeEngine();
		engine.setMode("plan");
		engine.setMode("standard");
		expect(badgeLabels(engine)).toEqual([]);
	});

	test("badge text colors yolo sticky-note style, plan green, minimal yellow", () => {
		const engine = new ModeEngine();
		expect(modeBadgeText(engine, fakeTheme)).toBeUndefined();
		engine.setYolo(true);
		expect(modeBadgeText(engine, fakeTheme)).toBe("<accent>yolo</accent>");
		engine.setMode("plan");
		expect(modeBadgeText(engine, fakeTheme)).toBe("<accent>yolo</accent> <success>plan</success>");
		engine.setMode("minimal");
		expect(modeBadgeText(engine, fakeTheme)).toBe("<accent>yolo</accent> <warning>minimal</warning>");
	});
});
