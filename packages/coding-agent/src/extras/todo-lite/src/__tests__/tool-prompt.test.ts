// 提示词质量回归：todo tool 的 description 与 runtime 纠错文案必须是
// "弱模型友好"的——description 要写明每个 action 的字段形态并消歧双形陷阱
// （text/texts、id/ids），失败后 throw 要带 Correct 正例让模型自我纠正。
//
// 本测试用源码文本断言锁定这些约束，防止后续重构把正例/反例/纠错文案删掉或
// 弱化。读源码而非 import，避免 mock 链（tool.ts 依赖 typebox/ModuleApi/
// Theme 等值导入）。参考 subagent-workflow 的 prompt 回归范式。

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOL_SRC = readFileSync(join(__dirname, "../tool.ts"), "utf-8");

/**
 * 提取 description 拼接区（从 tool 的 `description:` 到下一个 `promptGuidelines:`）。
 * tool.ts 的 description 是字面量，整段截取后做子串断言。
 */
function extractDescriptionRegion(src: string): string {
	// 锚定到 registerTodoTool 内的 tool description，而非 schema 字段的 description:
	// （Type.String({ description: "..." }) 等 schema 字段会先被 indexOf 命中，导致
	// 捕获区域含 schema 描述 + tool 描述——虽当前子串唯一能过但 fragile to restructuring）。
	const regIdx = src.indexOf("registerTodoTool");
	if (regIdx === -1) throw new Error("registerTodoTool not found in tool.ts");
	const start = src.indexOf("description:", regIdx);
	if (start === -1) throw new Error("tool description: not found in registerTodoTool");
	const end = src.indexOf("promptGuidelines:", start);
	if (end === -1) throw new Error("promptGuidelines: not found in tool.ts");
	return src.slice(start, end);
}

const DESCRIPTION_REGION = extractDescriptionRegion(TOOL_SRC);

// ── description 必须列出每个 action 的字段形态 ───────

describe("todo description — 每个 action 的字段形态", () => {
	it("add 用 texts[]", () => {
		// 弱模型 add 时易误用单数 text；描述必须写成 texts[] 数组。
		expect(DESCRIPTION_REGION).toContain("add(texts[])");
	});

	it("delete 用 ids[]", () => {
		// 弱模型 delete 时易误用单数 id；描述必须写成 ids[] 数组。
		expect(DESCRIPTION_REGION).toContain("delete(ids[])");
	});

	it("update 覆盖单条与批量两条路径", () => {
		// updates[] 批量优先是 [批量优先] 规范的核心，单条路径也要在描述里。
		expect(DESCRIPTION_REGION).toContain("update(id+status/text or updates[])");
	});

	it("给出不使用单数 text/id 的消歧句", () => {
		expect(DESCRIPTION_REGION).toContain("never a singular text/id");
	});
});

// ── runtime throw 必须带 Correct 纠错正例 ───────────

describe("todo runtime — throw 含 Correct 纠错正例", () => {
	it("源码含 ≥4 处 Correct: 纠错文案（覆盖 add/delete/update 路径）", () => {
		// 每个 required throw 必须追加完整 JSON 正例，弱模型失败后能自我纠正。
		const matches = TOOL_SRC.match(/Correct:/g) || [];
		expect(matches.length).toBeGreaterThanOrEqual(4);
	});

	it('add 双形检测：含 singular "text" 纠错文案', () => {
		expect(TOOL_SRC).toContain('singular "text"');
		expect(TOOL_SRC).toContain('"text" — that field is for update');
	});

	it('delete 双形检测：含 singular "id" 纠错文案', () => {
		expect(TOOL_SRC).toContain('singular "id"');
		expect(TOOL_SRC).toContain('"id" — that field is for update');
	});
});
