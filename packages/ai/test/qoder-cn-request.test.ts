// Qoder CN request body shape.
//
// The body is the Qoder RemoteChatAsk wire shape, adapted from the opencodex
// reference and verified against QODER_PROTOCOL_CURRENT.md:
//
//   * system prompt rides as a leading role:"system" message (top-level `system`
//     is empty — the server ignores it).
//   * Assistant turns with `tool_calls` but no text get a single-space content
//     placeholder so the gateway doesn't drop them and orphan the matching
//     tool result.
//   * Tool results become role:"tool" messages; tool results that also carry
//     images become a follow-up user message (OpenAI has no image slot on
//     the tool role).
//   * Images are dropped for text-only models.
//   * `request_id` is a fresh UUID per inference — duplicates earn code 103.
//   * Thinking history replays as `<thinking>…</thinking>` text (the only
//     channel the wire has for it).
//   * Reasoning parameters follow the model.thinking config + caller options:
//       - `model.reasoning === false` → no reasoning params, no tag scan
//       - always-thinks (Kimi, MiniMax) → no params, still parse
//         `delta.reasoning_content`
//       - `thinking.efforts` → `enable_thinking: true` + clamped
//         `reasoning_effort`
//       - `thinking` without `efforts` (toggle) → `enable_thinking` follows
//         the request (omitted when unset)
//       - off request when `thinking.requiresEffort` (mandatory-reasoning) →
//         clamp to the lowest supported effort, never `enable_thinking:false`.

import { afterEach, describe, expect, it } from "bun:test";

import { streamQoderCn } from "@oh-my-pi/pi-ai/providers/qoder-cn";
import { resetQoderCnResolversForTests } from "@oh-my-pi/pi-ai/providers/qoder-cn";
import type { Context, FetchImpl, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { qoderDecodeBody } from "@oh-my-pi/pi-catalog/qoder/cosy";

interface ChatMsg {
	role: string;
	content: unknown;
	tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
	tool_call_id?: string;
}

const TEST_PAT = "pt-test-token-fixtures";

function makeModel(overrides: Partial<Model<"qoder-cn">> = {}): Model<"qoder-cn"> {
	return buildModel({
		id: overrides.id ?? "qoder-cn-test",
		name: "Qoder CN Test",
		api: "qoder-cn",
		provider: "qoder-cn",
		baseUrl: "https://gateway.qoder.com.cn",
		reasoning: overrides.reasoning ?? false,
		thinking: overrides.thinking,
		input: overrides.input ?? ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: overrides.contextWindow ?? 200_000,
		maxTokens: "maxTokens" in overrides ? (overrides.maxTokens ?? null) : 64_000,
		requestModelId: overrides.requestModelId ?? "dmodel",
		...(overrides.compat ? { compat: overrides.compat } : {}),
	}) as Model<"qoder-cn">;
}

const sampleTool: Tool = {
	name: "calc",
	description: "calculator",
	parameters: {
		type: "object",
		properties: {
			expression: { type: "string" },
		},
		required: ["expression"],
	},
};

function decodeRequest(encoded: string): Record<string, unknown> {
	const json = qoderDecodeBody(encoded);
	return JSON.parse(json) as Record<string, unknown>;
}

interface FakeHarness {
	calls: Array<{ url: string; body: string }>;
	userInfoHeaders: Array<string | null>;
}

function fakeFetch(handler: (requestInit: RequestInit, body: string) => Response): {
	fetch: FetchImpl;
	harness: FakeHarness;
} {
	const harness: FakeHarness = { calls: [], userInfoHeaders: [] };
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
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/userinfo")) {
				harness.userInfoHeaders.push(initHeaders.get("authorization"));
				return new Response(
					JSON.stringify({
						id: "10042",
						name: "Qoder Tester",
						email: "tester@example.com",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			if (url.includes("/agent_chat_generation")) {
				harness.calls.push({ url, body });
				return handler(init ?? {}, body);
			}
			return new Response("not found", { status: 404 });
		},
		{ preconnect: () => undefined },
	);
	return { fetch: fetchImpl, harness };
}

afterEach(() => {
	resetQoderCnResolversForTests();
});

describe("streamQoderCn request body shape", () => {
	it("emits a leading system message and empty top-level system field", async () => {
		const model = makeModel();
		const context: Context = {
			systemPrompt: ["You are concise."],
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		const { fetch: fetchImpl, harness } = fakeFetch(
			() =>
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const body = decodeRequest(harness.calls[0]!.body);
		expect(body.system).toBe("");
		const messages = body.messages as ChatMsg[];
		expect(messages[0]?.role).toBe("system");
		expect(messages[0]?.content).toBe("You are concise.");
		expect(messages[1]?.role).toBe("user");
	});

	it("places a single-space placeholder on assistant turns whose only content is tool_calls", async () => {
		const model = makeModel();
		const context: Context = {
			messages: [
				{ role: "user", content: "compute", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "calc",
							arguments: { expression: "1+1" },
						} as never,
					],
					api: "qoder-cn",
					provider: "qoder-cn",
					model: "qoder-cn-test",
					stopReason: "toolUse",
					timestamp: 1,
				} as never,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "calc",
					content: [{ type: "text", text: "2" }],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: "thanks", timestamp: 3 },
			],
		};
		const { fetch: fetchImpl, harness } = fakeFetch(
			() =>
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const messages = bodyOf(harness.calls[0]!.body).messages as ChatMsg[];
		const assistantTurn = messages.find(m => m.role === "assistant");
		expect(assistantTurn?.content).toBe(" ");
		expect(assistantTurn?.tool_calls?.[0]?.function.name).toBe("calc");
		const toolTurn = messages.find(m => m.role === "tool");
		expect(toolTurn?.tool_call_id).toBe("call_1");
	});

	it("translates tool results to role:tool and drops images for text-only models", async () => {
		const model = makeModel({ input: ["text"] });
		const context: Context = {
			messages: [
				{ role: "user", content: "screenshot", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "snap",
							arguments: {},
						} as never,
					],
					api: "qoder-cn",
					provider: "qoder-cn",
					model: "qoder-cn-test",
					stopReason: "toolUse",
					timestamp: 1,
				} as never,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "snap",
					content: [
						{ type: "text", text: "captured" },
						{ type: "image", data: "QUJD", mimeType: "image/png" } as never,
					],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const { fetch: fetchImpl, harness } = fakeFetch(
			() =>
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const messages = bodyOf(harness.calls[0]!.body).messages as ChatMsg[];
		expect(messages[2]?.role).toBe("tool");
		expect(messages[2]?.tool_call_id).toBe("call_1");
		// No follow-up user message — the image was dropped for text-only targets.
		expect(messages.length).toBe(3);
	});

	it("routes tool-result images to a follow-up user message when the model supports vision", async () => {
		const model = makeModel({ input: ["text", "image"] });
		const context: Context = {
			messages: [
				{ role: "user", content: "snap", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "call_1",
							name: "snap",
							arguments: {},
						} as never,
					],
					api: "qoder-cn",
					provider: "qoder-cn",
					model: "qoder-cn-test",
					stopReason: "toolUse",
					timestamp: 1,
				} as never,
				{
					role: "toolResult",
					toolCallId: "call_1",
					toolName: "snap",
					content: [
						{ type: "text", text: "captured" },
						{ type: "image", data: "QUJD", mimeType: "image/png" } as never,
					],
					isError: false,
					timestamp: 2,
				},
			],
		};
		const { fetch: fetchImpl, harness } = fakeFetch(
			() =>
				new Response("data: [DONE]\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
		);
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const messages = bodyOf(harness.calls[0]!.body).messages as ChatMsg[];
		expect(messages[2]?.role).toBe("tool");
		expect(messages[3]?.role).toBe("user");
		const userPayload = messages[3]?.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
		expect(userPayload[0]?.text).toContain("[1 image returned by the previous tool call]");
		expect(userPayload[1]?.type).toBe("image_url");
		// ImageContent.data is raw base64 — the wire requires a data: URL.
		expect(userPayload[1]?.image_url?.url).toBe("data:image/png;base64,QUJD");
	});

	it("generates a unique request_id per build", async () => {
		const model = makeModel();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const bodies: string[] = [];
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const url = String(input);
				if (url.includes("/jobToken/exchange")) {
					return new Response(
						JSON.stringify({
							token: "jt-fixture",
							refresh_token: "jrt-fixture",
							expires_in: 86_400_000,
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					);
				}
				if (url.includes("/userinfo")) {
					return new Response(JSON.stringify({ id: "10042", name: "x", email: "x@x.com" }), { status: 200 });
				}
				if (url.includes("/agent_chat_generation")) {
					const body = typeof init?.body === "string" ? init.body : "";
					bodies.push(body);
					return new Response("data: [DONE]\n\n", { status: 200 });
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: () => undefined },
		);
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const ids = bodies.map(b => bodyOf(b).request_id);
		expect(ids[0]).toBeTruthy();
		expect(ids[1]).toBeTruthy();
		expect(ids[0]).not.toBe(ids[1]);
	});

	it("formats OpenAI function tools with parameters, omitting when empty", async () => {
		const model = makeModel();
		const context: Context = {
			tools: [sampleTool],
			messages: [{ role: "user", content: "hi", timestamp: 0 }],
		};
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const body = bodyOf(harness.calls[0]!.body);
		expect(body.tools).toEqual([
			{
				type: "function",
				function: {
					name: "calc",
					description: "calculator",
					parameters: expect.objectContaining({
						type: "object",
						properties: expect.objectContaining({
							expression: expect.objectContaining({ type: "string" }),
						}),
					}),
				},
			},
		]);
	});

	it("omits tools when context.tools is undefined", async () => {
		const model = makeModel();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const body = bodyOf(harness.calls[0]!.body);
		expect(body.tools).toEqual([]);
	});

	it("omits thinking history from a non-native assistant turn", async () => {
		const model = makeModel({ reasoning: true });
		const context: Context = {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "old reasoning" },
						{ type: "text", text: "old answer" },
					],
					api: "openai-completions",
					provider: "openai",
					model: "gpt-5.6",
					stopReason: "stop",
					timestamp: 0,
				} as never,
				{ role: "user", content: "continue", timestamp: 1 },
			],
		};
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const messages = bodyOf(harness.calls[0]!.body).messages as ChatMsg[];
		const assistantTurn = messages.find(m => m.role === "assistant");
		// Cross-API foreign thinking survives as `<thinking>…</thinking>` text
		// (transformMessages demotes to text on cross-model hops; renderDemotedThinking
		// wraps the block in `<thinking>…</thinking>` with a trailing newline).
		expect(assistantTurn?.content as string).toContain("<thinking>");
		expect(assistantTurn?.content as string).toContain("old reasoning");
	});

	it("caps max_tokens to the model ceiling", async () => {
		const model = makeModel({ maxTokens: 8000 });
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			maxTokens: 256_000,
		}).result();
		const body = bodyOf(harness.calls[0]!.body);
		expect((body.parameters as Record<string, unknown>).max_tokens).toBe(8000);
	});

	it("uses QODER_MAX_OUTPUT_TOKENS as the fallback when neither caller nor model set it", async () => {
		const model = makeModel({ maxTokens: null });
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
		}).result();
		const body = bodyOf(harness.calls[0]!.body);
		expect((body.parameters as Record<string, unknown>).max_tokens).toBe(131072);
	});
});

describe("streamQoderCn reasoning mapping", () => {
	it("emits no reasoning params when the model is non-reasoning", async () => {
		const model = makeModel({ reasoning: false });
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("emits no reasoning params for an always-thinks model even with reasoning requested", async () => {
		// Always-thinks model (Kimi-K2.7-Code, MiniMax-M2.7): thinking is undefined
		// because the catalog has no control surface for these entries.
		const model = makeModel({ reasoning: true });
		// buildModel infers a thinking config from reasoning:true; force-clear it
		// to mirror the always-thinks catalog shape (no control surface).
		(model as { thinking: undefined }).thinking = undefined;
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			reasoning: Effort.High,
		}).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("clamps the requested effort to the wire ladder for an effort-capable model", async () => {
		// Advertised ladder: low/medium/high. Caller requests max → clamp to high.
		const model = makeModel({
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
			},
		});
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			reasoning: Effort.Max,
		}).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe(Effort.High);
	});

	it("uses the lowest rung for an effort-capable model when caller requests 'minimal'", async () => {
		const model = makeModel({
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
			},
		});
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			reasoning: Effort.Minimal,
		}).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe(Effort.Low);
	});

	it("sends enable_thinking:false when disableReasoning is set on a suppressable effort model", async () => {
		const model = makeModel({
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.Medium, Effort.High],
			},
		});
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			disableReasoning: true,
		}).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBe(false);
	});

	it("clamps to lowest effort instead of sending enable_thinking:false on a mandatory-reasoning model", async () => {
		// Mandatory-reasoning endpoint (GLM-5.x: requiresEffort, disableAllowed false).
		const model = makeModel({
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.High, Effort.Max],
				requiresEffort: true,
			},
		});
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			disableReasoning: true,
		}).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBe(Effort.High);
	});

	it("emits only enable_thinking for a toggle model when the caller requests reasoning", async () => {
		// Toggle model (Qwen 3.7): the wire has no effort ladder, so the catalog
		// shape is thinkingControl "toggle" + thinking undefined. A requested
		// effort must degrade to a bare enable_thinking — sending
		// reasoning_effort to a toggle-only model is a wire error.
		const model = makeModel({ reasoning: true, compat: { thinkingControl: "toggle" } });
		(model as { thinking: undefined }).thinking = undefined;
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			reasoning: Effort.Medium,
		}).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBe(true);
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("emits enable_thinking:false for a toggle model on an off request", async () => {
		const model = makeModel({ reasoning: true, compat: { thinkingControl: "toggle" } });
		(model as { thinking: undefined }).thinking = undefined;
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			disableReasoning: true,
		}).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBe(false);
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("omits reasoning params for a toggle model when the caller expresses no opinion", async () => {
		const model = makeModel({ reasoning: true, compat: { thinkingControl: "toggle" } });
		(model as { thinking: undefined }).thinking = undefined;
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl }).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("emits no reasoning params for an always-thinks model even on an off request", async () => {
		// Kimi-K2.7-Code / MiniMax-M2.7 reason unconditionally; an
		// enable_thinking:false they cannot honor is worse than omission.
		const model = makeModel({ reasoning: true, compat: { thinkingControl: "always" } });
		(model as { thinking: undefined }).thinking = undefined;
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const { fetch: fetchImpl, harness } = fakeFetch(() => new Response("data: [DONE]\n\n", { status: 200 }));
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			disableReasoning: true,
		}).result();
		const params = bodyOf(harness.calls[0]!.body).parameters as Record<string, unknown>;
		expect(params.enable_thinking).toBeUndefined();
		expect(params.reasoning_effort).toBeUndefined();
	});

	it("matches the endpoint to the override gatewayBaseUrl", async () => {
		const model = makeModel();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const overrideBase = "https://override.qoder.example";
		const expectedChatUrl = `${overrideBase}/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1`;
		const seenUrls: string[] = [];
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request): Promise<Response> => {
				const url = String(input);
				seenUrls.push(url);
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
				if (url === expectedChatUrl) {
					return new Response("data: [DONE]\n\n", { status: 200 });
				}
				return new Response("wrong url", { status: 404 });
			},
			{ preconnect: () => undefined },
		);
		await streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			gatewayBaseUrl: overrideBase,
		}).result();
		expect(seenUrls).toContain(expectedChatUrl);
	});
});

function bodyOf(encoded: string): Record<string, unknown> {
	return decodeRequest(encoded);
}
