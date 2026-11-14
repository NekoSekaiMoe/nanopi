/**
 * The `generate_image` tool: the one caller of `modelRegistry.generateImages()`.
 *
 * Until this module existed the image APIs on the tree (OpenRouter, and now
 * ChatGPT OAuth) had no consumer — `generateImages()` was reachable from a
 * module and from nothing else, so a model could not ask for a picture. The
 * tool is that request path: prompt in, image out, plus the bytes saved to disk
 * when the caller names a path.
 */

import type { AssistantImages, ImageModel } from "@nanopi/pi-ai";
import { Text } from "@nanopi/pi-tui";
import type { ModuleToolContext, ModuleToolsSurface, Theme } from "@nanopi/pi-coding-agent";
import { writeFile } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { type Static, Type } from "typebox";

const generateImageParams = Type.Object({
	prompt: Type.String({ description: "What the image should show, in plain words" }),
	path: Type.Optional(
		Type.String({
			description:
				"File to write the image to, relative to the working directory. The extension comes from the image format. Omit to keep the image in the transcript only.",
		}),
	),
});

export interface GenerateImageDetails {
	provider?: string;
	model?: string;
	mimeType?: string;
	path?: string;
	bytes?: number;
}

const EXTENSIONS: Record<string, string> = {
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
	"image/svg+xml": ".svg",
};

export function extensionForMimeType(mimeType: string): string {
	return EXTENSIONS[mimeType] ?? ".png";
}

/**
 * The image model a request should use: the caller's own provider first (a
 * ChatGPT OAuth session draws with its own subscription), then whatever image
 * model the build has credentials for.
 */
async function resolveImageModel(ctx: ModuleToolContext, signal?: AbortSignal): Promise<ImageModel<string>> {
	const registry = ctx.modelRegistry;
	const provider = ctx.model?.provider;
	const candidates = [
		...(provider ? await registry.getAvailableOfType("image", provider, { signal }) : []),
		...(await registry.getAvailableOfType("image", undefined, { signal })),
	];
	const model = candidates[0];
	if (!model) {
		throw new Error(
			"No image model is available. Log in to the provider that offers one (openai-codex, or openrouter) and try again.",
		);
	}
	return model as ImageModel<string>;
}

function failureMessage(result: AssistantImages): string {
	if (result.stopReason === "aborted") return "Image generation was aborted.";
	return result.errorMessage ?? "Image generation failed without a provider message.";
}

export function registerImageTool(pi: ModuleToolsSurface): void {
	pi.registerTool({
		name: "generate_image",
		label: "Generate image",
		description:
			"Generate an image from a text prompt and return it, optionally writing it to a file. Use it when the task's output includes an image file, or when the user asks for a picture, diagram, icon or illustration.",
		promptSnippet: "Generate an image from a prompt",
		promptGuidelines: [
			"Use generate_image when the task's output includes an image file (an og:image, a placeholder for a component, a test fixture), or when the user asks for an image. Write the prompt yourself: describe the subject, style and composition instead of repeating the request verbatim.",
			"Pass path when the image is meant to end up in the repository or a document; the tool picks the extension from the format the provider returned.",
		],
		annotations: { readOnlyHint: false, openWorldHint: true },
		parameters: generateImageParams,

		async execute(_toolCallId, params: Static<typeof generateImageParams>, signal, _onUpdate, ctx) {
			const model = await resolveImageModel(ctx, signal);
			const result = await ctx.modelRegistry.generateImages(
				model,
				{ input: [{ type: "text", text: params.prompt }] },
				{ signal },
			);
			if (result.stopReason !== "stop") throw new Error(failureMessage(result));

			const image = result.output.find((block) => block.type === "image");
			if (!image) throw new Error("The provider reported success but returned no image.");

			const details: GenerateImageDetails = {
				provider: result.provider,
				model: result.model,
				mimeType: image.mimeType,
			};
			const lines = [`Generated a ${image.mimeType} image with ${result.provider}/${result.model}.`];
			if (params.path) {
				const target = isAbsolute(params.path) ? params.path : resolve(ctx.cwd, params.path);
				// Only the file name decides whether the caller already named a
				// format; a dot in a parent directory is part of the path.
				const withExtension = basename(target).includes(".")
					? target
					: `${target}${extensionForMimeType(image.mimeType)}`;
				const bytes = Buffer.from(image.data, "base64");
				await writeFile(withExtension, bytes);
				details.path = withExtension;
				details.bytes = bytes.byteLength;
				lines.push(`Saved to ${withExtension} (${bytes.byteLength} bytes).`);
			}
			return {
				content: [{ type: "text" as const, text: lines.join("\n") }, image],
				details,
			};
		},

		renderCall(args: Static<typeof generateImageParams>, theme: Theme) {
			return new Text(theme.fg("toolTitle", theme.bold("generate_image ")) + theme.fg("muted", args.prompt), 0, 0);
		},

		renderResult(result, options, theme) {
			const details = result.details as GenerateImageDetails | undefined;
			const summary = details?.path ? `saved ${details.path}` : `${details?.mimeType ?? "image"}`;
			if (!options.expanded) return new Text(theme.fg("dim", summary), 0, 0);
			const text = result.content.find((block) => block.type === "text");
			const body = text && text.type === "text" ? text.text : summary;
			return new Text(theme.fg("dim", body), 0, 0);
		},
	});
}
