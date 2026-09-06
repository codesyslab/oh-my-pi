// Qoder CN 401 → re-auth + single replay.
//
// Protocol contract (QODER_PROTOCOL_CURRENT.md): an upstream 401 means the
// credential (PAT → job token) is stale; the provider must:
//   1. Force re-exchange the PAT once (`QoderCredentialResolver.forceRefresh`).
//   2. Re-sign the COSY wrapper with the fresh job token.
//   3. Replay the IDENTICAL encoded body so the upstream `request_id` stays
//      unique to this inference (not a duplicate-request code 103).
// This file exercises the contract end-to-end with a stubbed fetch and
// validates that:
//   * both fetches saw the same encoded body bytes,
//   * the second fetch carries a different COSY `Authorization` header
//     (because the new AES key + request id are random per signing call),
//   * the third fetch is never made (one replay only).

import { afterEach, describe, expect, it } from "bun:test";

import { streamQoderCn } from "@oh-my-pi/pi-ai/providers/qoder-cn";
import { resetQoderCnResolversForTests } from "@oh-my-pi/pi-ai/providers/qoder-cn";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { qoderDecodeBody } from "@oh-my-pi/pi-catalog/qoder/cosy";

const TEST_PAT = "pt-test-token-fixtures";

function makeModel(): Model<"qoder-cn"> {
	return buildModel({
		id: "qoder-cn-test",
		name: "Qoder CN Test",
		api: "qoder-cn",
		provider: "qoder-cn",
		baseUrl: "https://gateway.qoder.com.cn",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		requestModelId: "dmodel",
	}) as Model<"qoder-cn">;
}

interface Capture {
	url: string;
	body: string;
	authorization: string;
	bodyHash: string;
}

async function run401Replay(): Promise<{ captures: Capture[]; successBody: string }> {
	const model = makeModel();
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
	const captures: Capture[] = [];
	let chatAttempt = 0;
	const decoder = new TextDecoder();
	const fetchImpl: FetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const url = String(input);
			const initHeaders =
				init?.headers instanceof Headers
					? init.headers
					: new Headers((init?.headers as Record<string, string> | undefined) ?? {});
			let body = "";
			if (init?.body) {
				body = typeof init.body === "string" ? init.body : decoder.decode(init.body as Uint8Array);
			}
			if (url.includes("/jobToken/exchange")) {
				return new Response(
					JSON.stringify({
						token: "jt-fixture",
						refresh_token: "jrt-fixture",
						expires_in: 86_400_000,
					}),
					{ status: 200 },
				);
			}
			if (url.includes("/userinfo")) {
				return new Response(JSON.stringify({ id: "10042", name: "x", email: "x@x.com" }), { status: 200 });
			}
			if (url.includes("/agent_chat_generation")) {
				chatAttempt++;
				const capture: Capture = {
					url,
					body,
					authorization: initHeaders.get("authorization") ?? "",
					bodyHash: initHeaders.get("cosy-bodyhash") ?? "",
				};
				captures.push(capture);
				if (chatAttempt === 1) {
					return new Response("unauthorized", { status: 401 });
				}
				return new Response("data: [DONE]\n\n", { status: 200 });
			}
			return new Response("not found", { status: 404 });
		},
		{ preconnect: () => undefined },
	);
	const stream = streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl });
	await stream.result();
	const successBody = captures[1]?.body ?? "";
	return { captures, successBody };
}

afterEach(() => {
	resetQoderCnResolversForTests();
});

describe("streamQoderCn 401 → re-auth + single replay", () => {
	it("replays with the identical encoded body and a freshly signed COSY wrapper", async () => {
		const { captures, successBody } = await run401Replay();
		expect(captures).toHaveLength(2);
		// Same body bytes — the encoded payload survives across the retry.
		expect(captures[0]!.body).toBe(captures[1]!.body);
		expect(captures[0]!.body).toBeTruthy();
		// Freshly signed: COSY Authorization must change between calls.
		expect(captures[0]!.authorization).not.toBe(captures[1]!.authorization);
		expect(captures[0]!.authorization.startsWith("Bearer COSY.")).toBe(true);
		expect(captures[1]!.authorization.startsWith("Bearer COSY.")).toBe(true);
		// Body hash stays the same because the body bytes are identical.
		expect(captures[0]!.bodyHash).toBe(captures[1]!.bodyHash);
		// Decoded body should still carry the same request_id (it is generated
		// at build time, NOT per signing call, so the replay stays valid).
		const decoded = JSON.parse(qoderDecodeBody(successBody)) as { request_id: string };
		expect(decoded.request_id).toBeTruthy();
	});

	it("does not retry a third time on a persistent 401", async () => {
		const model = makeModel();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		let chatAttempts = 0;
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url.includes("/jobToken/exchange")) {
					return new Response(
						JSON.stringify({
							token: "jt-fixture",
							refresh_token: "jrt-fixture",
							expires_in: 86_400_000,
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/userinfo")) {
					return new Response(JSON.stringify({ id: "10042", name: "x", email: "x@x.com" }), { status: 200 });
				}
				if (url.includes("/agent_chat_generation")) {
					chatAttempts++;
					return new Response("unauthorized", { status: 401 });
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: () => undefined },
		);
		const stream = streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl });
		const result = await stream.result();
		// 1 initial + 1 replay = 2 chat attempts. No third.
		expect(chatAttempts).toBe(2);
		expect(result.stopReason).toBe("error");
		expect(result.errorStatus).toBe(401);
	});

	it("surfaces a configuration error when the apiKey is missing", async () => {
		const model = makeModel();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const stream = streamQoderCn(model, context, { fetch: globalThis.fetch });
		const result = await stream.result();
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("no credential");
	});

	it("maps a 402 quota exhaustion envelope to a controlled error event", async () => {
		const model = makeModel();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				if (url.includes("/jobToken/exchange")) {
					return new Response(
						JSON.stringify({
							token: "jt-fixture",
							refresh_token: "jrt-fixture",
							expires_in: 86_400_000,
						}),
						{ status: 200 },
					);
				}
				if (url.includes("/userinfo")) {
					return new Response(JSON.stringify({ id: "10042", name: "x", email: "x@x.com" }), { status: 200 });
				}
				if (url.includes("/agent_chat_generation")) {
					const body = JSON.stringify({
						headers: {},
						statusCode: "Payment Required",
						statusCodeValue: 402,
						body: JSON.stringify({ code: "9999", message: "quota exhausted" }),
					});
					return new Response(`data: ${body}\n\n`, { status: 200 });
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: () => undefined },
		);
		const stream = streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl });
		const events = [];
		for await (const event of stream) events.push(event);
		const errorEvent = events.find(e => e.type === "error") as
			| { type: "error"; error: { errorStatus?: number; errorMessage?: string } }
			| undefined;
		expect(errorEvent).toBeTruthy();
		expect(errorEvent!.error.errorStatus).toBe(402);
		expect(errorEvent!.error.errorMessage).toContain("credit balance");
	});
});
