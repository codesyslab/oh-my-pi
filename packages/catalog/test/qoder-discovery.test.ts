import { afterEach, describe, expect, it } from "bun:test";
import { CATALOG_PROVIDERS } from "@oh-my-pi/pi-catalog/provider-models/descriptors";
import { isCredentialScopedModelCacheProvider } from "@oh-my-pi/pi-catalog/provider-models/cache-provider-id";
import {
	QODER_CN_SEED_SPECS,
	QODER_CN_STATIC_MODELS,
	qoderCnModelManagerOptions,
} from "@oh-my-pi/pi-catalog/provider-models/special";
import { type QoderCnDiscoveryOptions, fetchQoderCnModels } from "@oh-my-pi/pi-catalog/discovery/qoder";
import {
	isQoderPersonalAccessToken,
	QoderAuthError,
	QoderCredentialResolver,
	resetQoderCredentialCachesForTests,
} from "@oh-my-pi/pi-catalog/qoder/auth";
import { resolveQoderCnEndpoints } from "@oh-my-pi/pi-catalog/qoder/endpoints";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

const PAT = "pt-fixture-token";
const JOB_TOKEN = "jt-exchanged-token";
const USERINFO = { id: 12345, name: "Test User", email: "test@example.com" };

const ENDPOINTS = resolveQoderCnEndpoints();

type RecordedCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function discoveryFetch(
	entries: Array<{ key: string; display_name?: string; enable?: boolean; [k: string]: unknown }>,
): { fetch: FetchImpl; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, init: init ?? {} });
		if (url === ENDPOINTS.patExchangeUrl) return jsonResponse({ token: JOB_TOKEN });
		if (url === ENDPOINTS.userInfoUrl) return jsonResponse(USERINFO);
		if (url === ENDPOINTS.modelListUrl) return jsonResponse({ chat: entries });
		return jsonResponse({ message: "unexpected" }, 404);
	}) as FetchImpl;
	return { fetch, calls };
}

afterEach(() => {
	resetQoderCredentialCachesForTests();
});

describe("qoder-cn descriptor", () => {
	it("is registered as a catalog provider with the documented defaults", () => {
		const entry = CATALOG_PROVIDERS.find(provider => provider.id === "qoder-cn");
		expect(entry).toBeDefined();
		expect(entry?.defaultModel).toBe("deepseek-v4-pro");
		expect(entry?.envVars).toEqual(["QODER_PERSONAL_ACCESS_TOKEN"]);
		expect(entry?.catalogDiscovery?.label).toBe("Qoder CN");
		expect(entry?.dynamicModelsAuthoritative).toBe(true);
		expect(entry?.allowUnauthenticated).toBe(true);
		expect(isCredentialScopedModelCacheProvider("qoder-cn")).toBe(true);
	});

	it("exposes the deepseek-v4-pro default through the static seed so it resolves before discovery", () => {
		const options = qoderCnModelManagerOptions();
		expect(options.providerId).toBe("qoder-cn");
		expect(options.staticModels).toBe(QODER_CN_SEED_SPECS);
		const deepseekSeed = options.staticModels?.find(model => model.id === "deepseek-v4-pro");
		expect(deepseekSeed).toBeDefined();
	});

	it("does not enable discovery without an apiKey (no fetchDynamicModels, no dynamicModelsAuthoritative)", () => {
		const options = qoderCnModelManagerOptions();
		expect(options.fetchDynamicModels).toBeUndefined();
		expect(options.dynamicModelsAuthoritative).toBeUndefined();
	});

	it("wires the apiKey through fetchDynamicModels + dynamicModelsAuthoritative when present", () => {
		const options = qoderCnModelManagerOptions({ apiKey: PAT });
		expect(options.fetchDynamicModels).toBeDefined();
		expect(options.dynamicModelsAuthoritative).toBe(true);
	});

	it("captures every vendor-verified id in the static seed", () => {
		const expectedIds = new Set([
			"qwen3.8-max",
			"qwen3.8-flash",
			"qwen3.7-max",
			"qwen3.7-plus",
			"qwen3.7-flash",
			"deepseek-v4-pro",
			"deepseek-v4-flash",
			"glm-5.3",
			"glm-5.3-flash",
			"glm-5.2",
			"kimi-k2.7-code",
			"kimi-k3",
			"minimax-m2.7",
		]);
		const seedIds = new Set(QODER_CN_SEED_SPECS.map(spec => spec.id));
		expect(seedIds).toEqual(expectedIds);
		expect(QODER_CN_STATIC_MODELS.length).toBe(expectedIds.size);
	});
});

describe("fetchQoderCnModels", () => {
	it("returns null when credential exchange fails so the static seed survives", async () => {
		const calls: RecordedCall[] = [];
		const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({ url, init: init ?? {} });
			if (url === ENDPOINTS.patExchangeUrl) {
				return jsonResponse({ message: "unauthorized" }, 401);
			}
			return jsonResponse({});
		}) as FetchImpl;
		const options: QoderCnDiscoveryOptions = { apiKey: PAT, fetch };
		const result = await fetchQoderCnModels(options);
		expect(result).toBeNull();
		expect(calls.length).toBe(1);
		expect(calls[0]?.url).toBe(ENDPOINTS.patExchangeUrl);
	});

	it("returns null when the live list is empty so the static seed survives", async () => {
		const { fetch } = discoveryFetch([]);
		expect(await fetchQoderCnModels({ apiKey: PAT, fetch })).toBeNull();
	});

	it("maps verified wire keys onto canonical operator ids and leaves unknown wire keys as-is", async () => {
		const entries = [
			{ key: "qmodel_38max", enable: true, display_name: "Qwen3.8-Max" },
			{ key: "dmodel", enable: true, display_name: "DeepSeek-V4-Pro" },
			{ key: "kmodel_latest", enable: true, display_name: "Kimi-K3" },
			{ key: "future-model", enable: true, display_name: "Future Model" },
		];
		const { fetch, calls } = discoveryFetch(entries);
		const result = await fetchQoderCnModels({ apiKey: PAT, fetch });
		expect(result).not.toBeNull();
		const byId = new Map(result!.map(model => [model.id, model]));
		expect(byId.get("qwen3.8-max")?.requestModelId).toBe("qmodel_38max");
		expect(byId.get("qwen3.8-max")?.name).toBe("Qwen3.8-Max");
		expect(byId.get("deepseek-v4-pro")?.requestModelId).toBe("dmodel");
		expect(byId.get("deepseek-v4-pro")?.name).toBe("DeepSeek-V4-Pro");
		expect(byId.get("kimi-k3")?.requestModelId).toBe("kmodel_latest");
		expect(byId.get("kimi-k3")?.name).toBe("Kimi-K3");
		// Unknown wire keys stay keyed on their wire key with the gateway display name.
		expect(byId.get("future-model")?.requestModelId).toBe("future-model");
		expect(byId.get("future-model")?.name).toBe("Future Model");
		// PAT was exchanged first, then the signed /model/list was issued.
		expect(calls.map(call => call.url)).toEqual([
			ENDPOINTS.patExchangeUrl,
			ENDPOINTS.userInfoUrl,
			ENDPOINTS.modelListUrl,
		]);
	});

	it("excludes disabled entries from the live catalog", async () => {
		const entries = [
			{ key: "qmodel_38max", enable: true, display_name: "Qwen3.8-Max" },
			{ key: "retired", enable: false, display_name: "Retired" },
		];
		const { fetch } = discoveryFetch(entries);
		const result = await fetchQoderCnModels({ apiKey: PAT, fetch });
		const ids = result!.map(model => model.id).sort();
		expect(ids).toEqual(["qwen3.8-max"]);
	});

	it("does not pass non-PAT credentials to the resolver", () => {
		expect(isQoderPersonalAccessToken("pt-...")).toBe(true);
		expect(isQoderPersonalAccessToken("sk-...")).toBe(false);
	});

	it("rejects non-PAT credentials through the resolver", async () => {
		const resolver = new QoderCredentialResolver("sk-not-a-pat", ENDPOINTS);
		const calls: RecordedCall[] = [];
		const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({ url, init: init ?? {} });
			return jsonResponse({});
		}) as FetchImpl;
		try {
			await resolver.resolve(fetch);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(QoderAuthError);
		}
		expect(calls.length).toBe(0);
	});
});
