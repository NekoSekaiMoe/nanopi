import { DEFAULT_RADIUS_GATEWAY, normalizeRadiusGatewayUrl } from "@nanopi/pi-ai/providers/radius-config";

export const RADIUS_PROVIDER_ID = "radius";
export const ENV_RADIUS_GATEWAY = "NANOPI_RADIUS_GATEWAY";
/** Radius gateway origin, honoring the `NANOPI_RADIUS_GATEWAY` override. */
export function getRadiusGatewayUrl(): string {
	return normalizeRadiusGatewayUrl(process.env[ENV_RADIUS_GATEWAY] ?? DEFAULT_RADIUS_GATEWAY);
}
