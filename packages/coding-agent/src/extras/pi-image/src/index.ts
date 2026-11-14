/**
 * pi-image: image generation as a tool.
 *
 * One tool, `generate_image`, backed by whatever image model the session has
 * credentials for. Without a caller like this the image APIs on the tree have
 * no reachable entry point: `modelRegistry.generateImages()` is the only API and
 * nothing in the agent loop calls it.
 */

import type { ModuleEventsSurface, ModuleToolsSurface } from "@nanopi/pi-coding-agent";
import { registerImageTool } from "./tool.ts";

export default function piImageModule(pi: ModuleEventsSurface & ModuleToolsSurface): void {
	registerImageTool(pi);
}
