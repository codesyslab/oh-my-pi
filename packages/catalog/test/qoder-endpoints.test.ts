import { describe, expect, it } from "bun:test";
import {
	QODER_CN_GATEWAY_BASE_URL,
	QODER_CN_OPENAPI_BASE_URL,
	QODER_CN_PAT_MANAGE_URL,
	resolveQoderCnEndpoints,
} from "@oh-my-pi/pi-catalog/qoder/endpoints";

describe("Qoder CN endpoint constants", () => {
	it("pins the CN gateway and openapi base URLs", () => {
		expect(QODER_CN_GATEWAY_BASE_URL).toBe("https://gateway.qoder.com.cn");
		expect(QODER_CN_OPENAPI_BASE_URL).toBe("https://openapi.qoder.com.cn");
	});

	it("exposes the PAT management URL on the CN web dashboard", () => {
		expect(QODER_CN_PAT_MANAGE_URL).toBe("https://qoder.com.cn/account/integrations");
	});
});

describe("resolveQoderCnEndpoints", () => {
	const defaults = resolveQoderCnEndpoints();

	it("uses the CN defaults when no overrides are supplied", () => {
		expect(defaults.gatewayBaseUrl).toBe(QODER_CN_GATEWAY_BASE_URL);
		expect(defaults.openApiBaseUrl).toBe(QODER_CN_OPENAPI_BASE_URL);
	});

	it("builds the chatUrl with the documented COSY query parameters", () => {
		expect(defaults.chatUrl).toBe(
			`${QODER_CN_GATEWAY_BASE_URL}/algo/api/v2/service/pro/sse/agent_chat_generation` +
				`?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`,
		);
	});

	it("builds the modelListUrl with the COSY Encode marker", () => {
		expect(defaults.modelListUrl).toBe(`${QODER_CN_GATEWAY_BASE_URL}/algo/api/v2/model/list?Encode=1`);
	});

	it("builds the patExchangeUrl and userInfoUrl under the OpenAPI base", () => {
		expect(defaults.patExchangeUrl).toBe(`${QODER_CN_OPENAPI_BASE_URL}/api/v1/jobToken/exchange`);
		expect(defaults.userInfoUrl).toBe(`${QODER_CN_OPENAPI_BASE_URL}/api/v1/userinfo`);
	});

	it("applies gateway + openapi overrides verbatim, trimming trailing slashes", () => {
		const resolved = resolveQoderCnEndpoints({
			gatewayBaseUrl: "https://gateway.example.test/",
			openApiBaseUrl: "https://openapi.example.test//",
		});
		expect(resolved.gatewayBaseUrl).toBe("https://gateway.example.test");
		expect(resolved.openApiBaseUrl).toBe("https://openapi.example.test");
		expect(resolved.chatUrl).toContain(
			"https://gateway.example.test/algo/api/v2/service/pro/sse/agent_chat_generation",
		);
		expect(resolved.patExchangeUrl).toBe("https://openapi.example.test/api/v1/jobToken/exchange");
	});

	it("falls back to the CN constants when overrides are empty / whitespace", () => {
		const resolved = resolveQoderCnEndpoints({ gatewayBaseUrl: " ", openApiBaseUrl: "" });
		expect(resolved.gatewayBaseUrl).toBe(QODER_CN_GATEWAY_BASE_URL);
		expect(resolved.openApiBaseUrl).toBe(QODER_CN_OPENAPI_BASE_URL);
	});
});
