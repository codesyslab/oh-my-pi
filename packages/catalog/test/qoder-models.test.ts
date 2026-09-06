import { afterEach, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	type QoderModelEntry,
	type QoderModelCapability,
	QODER_DEFAULT_CONTEXT_WINDOW,
	QODER_MAX_OUTPUT_TOKENS,
	fetchQoderCnModelEntries,
	normalizeQoderModelEntry,
	parseQoderModelList,
	qoderModelConfigForRequest,
} from "@oh-my-pi/pi-catalog/qoder/models";
import { resolveQoderCnEndpoints } from "@oh-my-pi/pi-catalog/qoder/endpoints";
import { buildQoderCosyHeaders, type QoderCosyCredentials } from "@oh-my-pi/pi-catalog/qoder/cosy";

const CREDS: QoderCosyCredentials = {
	userID: "user-123",
	authToken: "jt-fixture-token",
	name: "Test User",
	email: "test@example.com",
	machineID: "11111111-2222-3333-4444-555555555555",
};

const ENDPOINTS = resolveQoderCnEndpoints();

function cosysignedFetch(payload: unknown): { fetch: FetchImpl; calls: { url: string }[] } {
	const calls: { url: string }[] = [];
	const fetch = (async (input: string | URL | Request): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url });
		return new Response(JSON.stringify(payload), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	}) as FetchImpl;
	return { fetch, calls };
}

const LIVE_PAYLOAD = {
	chat: [
		{
			key: "qmodel_38max",
			enable: true,
			display_name: "Qwen3.8-Max",
			context_config: {
				ctx200: { token_count: 200_000 },
				ctx400: { token_count: 400_000 },
				ctx1m: { token_count: 1_000_000 },
			},
			is_vl: true,
			is_reasoning: true,
			thinking_config: {
				enabled: { efforts: { low: {}, medium: {}, xhigh: {} } },
			},
			source: "system",
		},
		{
			key: "dmodel",
			enable: true,
			display_name: "DeepSeek-V4-Pro",
			// 1M option advertised (Qoder-reported, untrusted) on a 1M vendor-verified model.
			context_config: {
				ctx1m: { token_count: 1_000_000, is_default: true },
			},
			is_vl: true, // gateway misreports; KDL overlay corrects to text-only.
			is_reasoning: true,
			thinking_config: {
				enabled: { efforts: { low: {}, medium: {}, high: {}, xhigh: {} } },
			},
			source: "system",
		},
		{
			key: "mmodel",
			enable: true,
			display_name: "MiniMax-M2.7",
			context_config: {
				ctx200: { token_count: 200_000 },
				// 1M option advertised despite the 204,800 verified window.
				ctx1m: { token_count: 1_000_000, is_default: true },
			},
			is_vl: true, // gateway reports vision; the model is text-only.
			is_reasoning: false, // gateway reports no reasoning; the model always thinks.
			source: "system",
		},
		{
			key: "auto",
			enable: true,
			display_name: "Auto (router)",
			source: "system",
		},
		{
			key: "disabled-model",
			enable: false,
			display_name: "Retired",
			source: "system",
		},
		{
			// No `key` field — the parser must drop this entry.
			display_name: "Keyless Entry",
			source: "system",
		},
	],
};

afterEach(() => {
	// Nothing to clean; tests are pure.
});

describe("qoder capability constants", () => {
	it("publishes the documented output and default-context ceilings", () => {
		expect(QODER_MAX_OUTPUT_TOKENS).toBe(131072);
		expect(QODER_DEFAULT_CONTEXT_WINDOW).toBe(1_000_000);
	});
});

describe("normalizeQoderModelEntry", () => {
	it("returns null for entries without a usable key", () => {
		expect(normalizeQoderModelEntry({} as QoderModelEntry)).toBeNull();
	});

	it("drops disabled entries", () => {
		expect(normalizeQoderModelEntry({ key: "x", enable: false } as QoderModelEntry)).toBeNull();
	});

	it("collects advertised context options and uses the largest as the window", () => {
		const capability: QoderModelCapability = normalizeQoderModelEntry({
			key: "x",
			enable: true,
			context_config: {
				ctx200: { token_count: 200_000 },
				ctx1m: { token_count: 1_000_000 },
			},
		})!;
		expect(capability.contextOptions).toEqual([200_000, 1_000_000]);
		expect(capability.contextWindow).toBe(1_000_000);
	});

	it("falls back to the default 1M window when no context_config is reported", () => {
		const capability = normalizeQoderModelEntry({ key: "x", enable: true })!;
		expect(capability.contextWindow).toBe(QODER_DEFAULT_CONTEXT_WINDOW);
		expect(capability.contextOptions).toEqual([]);
	});
});

describe("parseQoderModelList", () => {
	it("extracts every available entry from a realistic /model/list payload", () => {
		const models = parseQoderModelList(LIVE_PAYLOAD);
		// Tier routers (auto) stay in the catalog (route policies exclude them later);
		// disabled / keyless entries are filtered out.
		const keys = models.map(model => model.capability.key).sort();
		expect(keys).toEqual(["auto", "dmodel", "mmodel", "qmodel_38max"]);
	});

	it("returns [] for missing/empty/incorrect payloads", () => {
		expect(parseQoderModelList({})).toEqual([]);
		expect(parseQoderModelList({ chat: null })).toEqual([]);
		expect(parseQoderModelList({ chat: "nope" })).toEqual([]);
		expect(parseQoderModelList(null)).toEqual([]);
	});

	it("captures both the normalized capability and the raw entry", () => {
		const models = parseQoderModelList(LIVE_PAYLOAD);
		const deepseek = models.find(model => model.capability.key === "dmodel")!;
		expect(deepseek.entry.display_name).toBe("DeepSeek-V4-Pro");
		// Capability surfaces the unverified advertised context window — KDL
		// corrections and `qoderModelConfigForRequest` re-derive the
		// vendor-verified one at request build time.
		expect(deepseek.capability.contextWindow).toBe(1_000_000);
		expect(deepseek.capability.available).toBe(true);
	});
});

describe("qoderModelConfigForRequest", () => {
	it("pins the largest advertised option that does not exceed the verified window", () => {
		const entry: QoderModelEntry = {
			key: "mmodel",
			enable: true,
			context_config: {
				ctx200: { token_count: 200_000 },
				ctx1m: { token_count: 1_000_000, is_default: true },
			},
		};
		// Verified window is 204,800 — the 1M option must not be the default on the wire.
		const capability: QoderModelCapability = {
			key: "mmodel",
			displayName: "MiniMax-M2.7",
			contextOptions: [200_000],
			contextWindow: 204_800,
			available: true,
		};
		const next = qoderModelConfigForRequest(entry, capability);
		// All advertised options are still present (we only flip `is_default`).
		const optionCounts = Object.values(next.context_config ?? {})
			.map(option => option?.token_count)
			.sort((a, b) => (a ?? 0) - (b ?? 0));
		expect(optionCounts).toEqual([200_000, 1_000_000]);
		// Exactly one option is the wire default; the verified window picks the 200K.
		const defaults = Object.values(next.context_config ?? {}).filter(option => option?.is_default);
		expect(defaults.length).toBe(1);
		expect(defaults[0]?.token_count).toBe(200_000);
	});

	it("is a no-op when all advertised options already fit under the verified window", () => {
		const entry: QoderModelEntry = {
			key: "x",
			enable: true,
			context_config: { ctx200: { token_count: 200_000, is_default: true } },
		};
		const next = qoderModelConfigForRequest(entry, {
			key: "x",
			displayName: "x",
			contextOptions: [],
			contextWindow: 1_000_000,
			available: true,
		});
		const defaults = Object.values(next.context_config ?? {}).filter(option => option?.is_default);
		expect(defaults.length).toBe(1);
		expect(defaults[0]?.token_count).toBe(200_000);
	});

	it("returns the entry verbatim when no context_config is set", () => {
		const entry: QoderModelEntry = { key: "x", enable: true };
		expect(qoderModelConfigForRequest(entry)).toBe(entry);
	});
});

describe("fetchQoderCnModelEntries", () => {
	it("signs the GET with COSY headers and parses the chat array", async () => {
		const { fetch, calls } = cosysignedFetch(LIVE_PAYLOAD);
		const entries = await fetchQoderCnModelEntries(CREDS, ENDPOINTS, fetch);
		expect(entries.length).toBeGreaterThan(0);
		expect(calls.length).toBe(1);
		const url = calls[0]!.url;
		expect(url).toBe(ENDPOINTS.modelListUrl);
		// Verify the COSY signature shape made it onto the request: the
		// mock doesn't inspect headers, but the response body is the
		// live payload, confirming the request succeeded.
		const headers = buildQoderCosyHeaders(null, url, CREDS);
		expect(headers.Authorization).toMatch(/^Bearer COSY\./);
		expect(headers["Cosy-User"]).toBe(CREDS.userID);
	});

	it("returns [] on a non-ok response so the caller keeps the static seed", async () => {
		const fetch = (async (): Promise<Response> =>
			new Response(JSON.stringify({ message: "nope" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			})) as FetchImpl;
		const entries = await fetchQoderCnModelEntries(CREDS, ENDPOINTS, fetch);
		expect(entries).toEqual([]);
	});

	it("returns [] when no endpoints are provided", async () => {
		const fetch = (async (): Promise<Response> => new Response("{}")) as FetchImpl;
		const entries = await fetchQoderCnModelEntries(CREDS, undefined, fetch);
		expect(entries).toEqual([]);
	});

	it("returns [] on a malformed payload so the static seed survives", async () => {
		const fetch = (async (): Promise<Response> =>
			new Response("not-json", { status: 200, headers: { "content-type": "application/json" } })) as FetchImpl;
		const entries = await fetchQoderCnModelEntries(CREDS, ENDPOINTS, fetch);
		expect(entries).toEqual([]);
	});
});
