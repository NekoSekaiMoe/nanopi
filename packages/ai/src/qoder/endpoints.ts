/**
 * Qoder (qoder.com / qoder.com.cn) endpoints, split by the account's region:
 * the international site issues tokens that the domestic OpenAPI host rejects
 * with 401, so every call has to pick the region's host.
 */

export type QoderRegion = "global" | "cn";

export interface QoderEndpoints {
	/** Browser page where the device code is entered. */
	deviceLoginBase: string;
	/** Device-token poll endpoint for the OAuth login. */
	pollEndpoint: string;
	userInfo: string;
	plan: string;
	/** OpenAPI host that serves the daily check-in endpoints. */
	openApiHost: string;
	/** Signed `/algo` endpoint that lists the models the account may use. */
	modelListUrl: string;
}

const GLOBAL_ENDPOINTS: QoderEndpoints = {
	deviceLoginBase: "https://qoder.com/device/selectAccounts",
	pollEndpoint: "https://openapi.qoder.sh/api/v1/deviceToken/poll",
	userInfo: "https://openapi.qoder.sh/api/v1/userinfo",
	plan: "https://openapi.qoder.sh/api/v2/user/plan",
	openApiHost: "openapi.qoder.sh",
	modelListUrl: "https://api2.qoder.sh/algo/api/v2/model/list?Encode=1",
};

const CN_ENDPOINTS: QoderEndpoints = {
	deviceLoginBase: "https://qoder.com.cn/device/selectAccounts",
	pollEndpoint: "https://openapi.qoder.com.cn/api/v1/deviceToken/poll",
	userInfo: "https://openapi.qoder.com.cn/api/v1/userinfo",
	plan: "https://openapi.qoder.com.cn/api/v2/user/plan",
	openApiHost: "openapi.qoder.com.cn",
	modelListUrl: "https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1",
};

export function qoderEndpoints(region: QoderRegion): QoderEndpoints {
	return region === "cn" ? CN_ENDPOINTS : GLOBAL_ENDPOINTS;
}

/** Provider ids: one catalog per site, since they bill and route separately. */
export const QODER_GLOBAL_PROVIDER_ID = "qoder";
export const QODER_CN_PROVIDER_ID = "qoder-cn";
