/**
 * Stand-in for `openrouter-images.ts` in a build whose API set leaves
 * openrouter-images out (buildconfig.json `apiSets`).
 *
 * The build aliases the implementation module to this file at resolve time
 * (scripts/build-apis.mjs). The images registration
 * (`providers/images/register-builtins.ts`) imports the module type and lazily
 * imports its `generateImages`, so a runtime filter would keep both in the
 * graph.
 *
 * The export names and signatures match `openrouter-images.ts`; only the body
 * differs. A call reports the build flavor instead of loading anything.
 */

import type {
	AssistantImages,
	ImageApi,
	ImageModel,
	ImagesContext,
	ImagesFunction,
	ImagesOptions,
} from "../../types.ts";

export const generateImages: ImagesFunction<ImagesOptions> = async (
	_model: ImageModel<ImageApi>,
	_context: ImagesContext,
	_options?: ImagesOptions,
): Promise<AssistantImages> => {
	throw new Error("openrouter-images is not included in this build (buildconfig.json apiSets)");
};
