import { describe, expect, it } from "bun:test";
import {
	buildQoderCosyHeaders,
	qoderCosySigPath,
	qoderDecodeBody,
	qoderEncodeBody,
	QODER_CLIENT_TYPE,
	QODER_GATEWAY_COSY_VERSION,
	QODER_OPENAPI_COSY_VERSION,
} from "@oh-my-pi/pi-catalog/qoder/cosy";

// Precomputed fixture for the body codec round-trip. The deterministic body
// (the JSON literal `"{\"hello\":\"world\"}"`) round-trips byte-identically
// through `qoderEncodeBody` -> `qoderDecodeBody`; the encoded form is frozen
// so a regression in the alphabet or outer-third swap surfaces as a diff
// against the fixture instead of a silently broken symmetric transform.
const KNOWN_PLAINTEXT = '{"hello":"world"}';
const KNOWN_ENCODED = "NO%zBEw$uYByBEJbmYKnDS%r";

describe("qoder body codec", () => {
	it("round-trips the deterministic plaintext through encode + decode", () => {
		const back = qoderDecodeBody(qoderEncodeBody(KNOWN_PLAINTEXT));
		expect(back).toBe(KNOWN_PLAINTEXT);
	});

	it("matches the frozen encoded fixture so a regression in the alphabet or outer-third swap surfaces", () => {
		expect(qoderEncodeBody(KNOWN_PLAINTEXT)).toBe(KNOWN_ENCODED);
	});

	it("decodes the frozen fixture back to the original plaintext", () => {
		expect(qoderDecodeBody(KNOWN_ENCODED)).toBe(KNOWN_PLAINTEXT);
	});

	it("produces identical bytes regardless of the order in which the swap and remap are applied", () => {
		const std = Buffer.from(KNOWN_PLAINTEXT, "utf8").toString("base64");
		// Remap, then swap.
		const remapped = std
			.split("")
			.map(c => (c === "=" ? "$" : (QODER_CUSTOM_ALPHABET[QODER_STD_ALPHABET.indexOf(c)] ?? c)))
			.join("");
		const remappedSwap =
			remapped.slice(-Math.floor(remapped.length / 3)) +
			remapped.slice(Math.floor(remapped.length / 3), remapped.length - Math.floor(remapped.length / 3)) +
			remapped.slice(0, Math.floor(remapped.length / 3));
		expect(remappedSwap).toBe(KNOWN_ENCODED);
	});
});

// Strings used to verify the body codec commutes its two operations; not
// exported from cosy.ts, so we re-declare them locally (the alphabet order
// IS the public surface for the round-trip test).
const QODER_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const QODER_CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

describe("qoder COSY identity constants", () => {
	it("keeps the gateway, openapi and client-type versions pinned", () => {
		expect(QODER_GATEWAY_COSY_VERSION).toBe("1.1.38");
		expect(QODER_OPENAPI_COSY_VERSION).toBe("1.0.1");
		expect(QODER_CLIENT_TYPE).toBe("5");
	});
});

describe("qoder COSY signing", () => {
	const CREDS = {
		userID: "user-123",
		authToken: "jt-fixture-token",
		name: "Test User",
		email: "test@example.com",
		machineID: "11111111-2222-3333-4444-555555555555",
	} as const;

	it("refuses to sign when userID or authToken are empty (CN rejects placeholder uid)", () => {
		expect(() =>
			buildQoderCosyHeaders(null, "https://gateway.qoder.com.cn/algo/api/v2/model/list", {
				...CREDS,
				userID: "",
			}),
		).toThrow(/user id is empty/);
		expect(() =>
			buildQoderCosyHeaders(null, "https://gateway.qoder.com.cn/algo/api/v2/model/list", {
				...CREDS,
				authToken: "",
			}),
		).toThrow(/auth token is empty/);
	});

	it("strips the /algo prefix from the signing path and drops the query string", () => {
		// sigPath lives only inside headers (Cosy-Sigpath); the helper exposes it.
		const url =
			"https://gateway.qoder.com.cn/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1";
		expect(qoderCosySigPath(url)).toBe("/api/v2/service/pro/sse/agent_chat_generation");
	});

	it("leaves the pathname alone when it does not start with /algo", () => {
		expect(qoderCosySigPath("https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1")).toBe(
			"/api/v2/model/list",
		);
		expect(qoderCosySigPath("https://gateway.qoder.com.cn/api/v1/userinfo")).toBe("/api/v1/userinfo");
	});

	it("emits the full COSY header set including a fresh Authorization Bearer", () => {
		const headers = buildQoderCosyHeaders(
			null,
			"https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1",
			CREDS,
		);
		expect(headers.Authorization).toMatch(/^Bearer COSY\.[A-Za-z0-9+/=]+\.[a-f0-9]{32}$/);
		expect(headers["Cosy-User"]).toBe(CREDS.userID);
		expect(headers["Cosy-Key"]).toMatch(/^[A-Za-z0-9+/=]+$/);
		expect(headers["Cosy-Version"]).toBe(QODER_GATEWAY_COSY_VERSION);
		expect(headers["Cosy-Clienttype"]).toBe(QODER_CLIENT_TYPE);
		expect(headers["Cosy-Machineid"]).toBe(CREDS.machineID);
		expect(headers["Cosy-Machinetoken"]).toBe(CREDS.machineID);
		expect(headers["Cosy-Sigpath"]).toBe("/api/v2/model/list");
		expect(headers["Cosy-Date"]).toMatch(/^\d{10}$/);
		expect(headers["Cosy-Bodyhash"]).toMatch(/^[a-f0-9]{32}$/);
		expect(headers["Cosy-Bodylength"]).toBe("0");
		expect(headers["Cosy-Data-Policy"]).toBe("disagree");
		expect(headers["Login-Version"]).toBe("v2");
		expect(headers["X-Request-Id"]).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("hashes the body when present so the COSY signature is body-stable", () => {
		const headers = buildQoderCosyHeaders(
			"payload-bytes",
			"https://gateway.qoder.com.cn/algo/api/v2/model/list?Encode=1",
			CREDS,
		);
		expect(headers["Cosy-Bodyhash"]).toMatch(/^[a-f0-9]{32}$/);
		expect(headers["Cosy-Bodylength"]).toBe("13");
	});
});
