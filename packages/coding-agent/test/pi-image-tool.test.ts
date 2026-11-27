/**
 * The `generate_image` tool: the caller the image APIs needed.
 *
 * These tests drive the tool's `execute` with a stub registry, so they cover the
 * parts the tool owns — picking a model, turning a provider result into a tool
 * result, writing the file — without a provider in the loop.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantImages, ImageModel } from "@nanopi/pi-ai";
import type { ModuleEventsSurface, ModuleToolContext, ModuleToolsSurface } from "@nanopi/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import piImageModule from "../src/modules/pi-image/src/index.ts";
import { extensionForMimeType } from "../src/modules/pi-image/src/tool.ts";

const IMAGE_MODEL: ImageModel<string> = {
	type: "image",
	id: "gpt-5.6-luna",
	name: "ChatGPT image generation",
	api: "openai-codex-images",
	provider: "openai-codex",
	baseUrl: "https://chatgpt.com/backend-api",
	input: ["text"],
	output: ["image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

type RegisteredTool = {
	name: string;
	execute: (
		toolCallId: string,
		params: { prompt: string; path?: string },
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: ModuleToolContext,
	) => Promise<{ content: unknown[]; details?: unknown }>;
};

function registerTool(): RegisteredTool {
	let registered: RegisteredTool | undefined;
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		on: () => () => {},
		registerTool(tool: RegisteredTool) {
			registered = tool;
		},
	} as unknown as ModuleEventsSurface & ModuleToolsSurface;
	piImageModule(pi);
	if (!registered) throw new Error("the module registered no tool");
	return registered;
}

function imageResult(overrides: Partial<AssistantImages> = {}): AssistantImages {
	return {
		api: "openai-codex-images",
		provider: "openai-codex",
		model: "gpt-5.6-luna",
		output: [{ type: "image", data: Buffer.from("png-bytes").toString("base64"), mimeType: "image/png" }],
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

function context(options: {
	imageModels?: ImageModel<string>[];
	result?: AssistantImages;
	cwd?: string;
	provider?: string;
}): ModuleToolContext {
	const generateImages = vi.fn(async () => options.result ?? imageResult());
	return {
		cwd: options.cwd ?? process.cwd(),
		model: options.provider ? ({ provider: options.provider } as ModuleToolContext["model"]) : undefined,
		modelRegistry: {
			getAvailableOfType: vi.fn(async (_type: string, provider?: string) =>
				options.imageModels === undefined
					? []
					: options.imageModels.filter((model) => provider === undefined || model.provider === provider),
			),
			generateImages,
		},
	} as unknown as ModuleToolContext;
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("generate_image tool", () => {
	it("returns the image alongside a one-line summary", async () => {
		const tool = registerTool();
		const result = await tool.execute(
			"call-1",
			{ prompt: "a red fox" },
			undefined,
			undefined,
			context({ imageModels: [IMAGE_MODEL] }),
		);

		expect(result.content).toHaveLength(2);
		expect(result.details).toMatchObject({ provider: "openai-codex", model: "gpt-5.6-luna", mimeType: "image/png" });
	});

	it("writes the bytes and picks the extension from the format", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-image-"));
		tempDirs.push(dir);
		const tool = registerTool();
		const result = await tool.execute(
			"call-1",
			{ prompt: "a red fox", path: "fox" },
			undefined,
			undefined,
			context({ imageModels: [IMAGE_MODEL], cwd: dir }),
		);

		const details = result.details as { path: string; bytes: number };
		expect(details.path).toBe(join(dir, "fox.png"));
		expect(details.bytes).toBe("png-bytes".length);
		expect(readFileSync(details.path, "utf8")).toBe("png-bytes");
	});

	it("prefers an image model from the session's own provider", async () => {
		const tool = registerTool();
		const other: ImageModel<string> = { ...IMAGE_MODEL, id: "gemini-image", provider: "openrouter" };
		const ctx = context({ imageModels: [other, IMAGE_MODEL], provider: "openai-codex" });
		await tool.execute("call-1", { prompt: "a red fox" }, undefined, undefined, ctx);

		const registry = ctx.modelRegistry as unknown as { generateImages: ReturnType<typeof vi.fn> };
		expect(registry.generateImages.mock.calls[0]?.[0]).toBe(IMAGE_MODEL);
	});

	it("explains a build with no reachable image model", async () => {
		const tool = registerTool();
		await expect(
			tool.execute("call-1", { prompt: "a red fox" }, undefined, undefined, context({ imageModels: [] })),
		).rejects.toThrow(/No image model is available/);
	});

	it("surfaces the provider's error message", async () => {
		const tool = registerTool();
		await expect(
			tool.execute(
				"call-1",
				{ prompt: "a red fox" },
				undefined,
				undefined,
				context({
					imageModels: [IMAGE_MODEL],
					result: imageResult({ stopReason: "error", errorMessage: "quota" }),
				}),
			),
		).rejects.toThrow("quota");
	});

	it("keeps a caller-supplied extension", () => {
		expect(extensionForMimeType("image/png")).toBe(".png");
		expect(extensionForMimeType("image/jpeg")).toBe(".jpg");
		expect(extensionForMimeType("image/webp")).toBe(".webp");
	});
});
