/**
 * Qoder CN endpoint layout. Every URL derives from two configurable bases so
 * protocol drift (gateway host moves, OpenAPI host moves) touches one provider
 * config row, not code. See QODER_PROTOCOL_CURRENT.md.
 *
 * CN is PAT-only: the cpa-plugin capability matrix shows CN device tokens
 * (dt-) cannot authenticate inference, and pi-provider-qoder marks CN
 * `supportsBrowserLogin: false`. PAT creation is a web-session step at
 * `QODER_CN_PAT_MANAGE_URL`.
 */

export const QODER_CN_GATEWAY_BASE_URL = "https://gateway.qoder.com.cn";
export const QODER_CN_OPENAPI_BASE_URL = "https://openapi.qoder.com.cn";

/** Where a CN user creates a Personal Access Token (web session required). */
export const QODER_CN_PAT_MANAGE_URL = "https://qoder.com.cn/account/integrations";

/**
 * Every endpoint the adapter reaches. `chatUrl` and `modelListUrl` live under
 * the gateway (and carry the COSY signature); `patExchangeUrl` and `userInfoUrl`
 * live under the OpenAPI surface and use a plain Bearer token.
 */
export interface QoderCnEndpoints {
	gatewayBaseUrl: string;
	openApiBaseUrl: string;
	chatUrl: string;
	modelListUrl: string;
	patExchangeUrl: string;
	userInfoUrl: string;
}

function trimTrailingSlash(url: string): string {
	return url.replace(/\/+$/, "");
}

/**
 * Resolve the CN endpoint set. Overrides default to the pinned CN bases; an
 * empty / omitted override falls back to the CN constants.
 */
export function resolveQoderCnEndpoints(overrides?: {
	gatewayBaseUrl?: string;
	openApiBaseUrl?: string;
}): QoderCnEndpoints {
	const gatewayBaseUrl = trimTrailingSlash(overrides?.gatewayBaseUrl?.trim() || QODER_CN_GATEWAY_BASE_URL);
	const openApiBaseUrl = trimTrailingSlash(overrides?.openApiBaseUrl?.trim() || QODER_CN_OPENAPI_BASE_URL);
	return {
		gatewayBaseUrl,
		openApiBaseUrl,
		chatUrl:
			`${gatewayBaseUrl}/algo/api/v2/service/pro/sse/agent_chat_generation` +
			`?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
		modelListUrl: `${gatewayBaseUrl}/algo/api/v2/model/list?Encode=1`,
		patExchangeUrl: `${openApiBaseUrl}/api/v1/jobToken/exchange`,
		userInfoUrl: `${openApiBaseUrl}/api/v1/userinfo`,
	};
}
