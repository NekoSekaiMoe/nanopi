import { describe, expect, test } from "vitest";
import { type BadgeThemeSlice, badgeLabels, modeBadgeText } from "../src/badges.ts";
import { ModeEngine } from "../src/mode-engine.ts";

const fakeTheme: BadgeThemeSlice = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
};

describe("mode badges", () => {
	test("yolo and plan badges can show together", () => {
		const engine = new ModeEngine();
		expect(badgeLabels(engine)).toEqual([]);
		engine.setYolo(true);
		expect(badgeLabels(engine)).toEqual(["yolo"]);
		engine.setMode("plan");
		expect(badgeLabels(engine)).toEqual(["yolo", "plan"]);
		engine.setMode("minimal");
		expect(badgeLabels(engine)).toEqual(["yolo"]);
	});

	test("badge text colors yolo red and plan green", () => {
		const engine = new ModeEngine();
		expect(modeBadgeText(engine, fakeTheme)).toBeUndefined();
		engine.setYolo(true);
		expect(modeBadgeText(engine, fakeTheme)).toBe("<error>yolo</error>");
		engine.setMode("plan");
		expect(modeBadgeText(engine, fakeTheme)).toBe("<error>yolo</error> <success>plan</success>");
	});
});
