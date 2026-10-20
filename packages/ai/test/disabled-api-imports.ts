/**
 * Imports a stand-in module directly, the way scripts/build-apis.mjs aliases it
 * into a build. The file is not imported from src: only the bundle build swaps
 * the real module for it.
 */
export { bedrockConverseStreamApi as disabledBedrockConverseStreamApi } from "../src/api/disabled/bedrock-converse-stream-disabled.ts";
