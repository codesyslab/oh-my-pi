// Qoder CN SSE stream parsing.
//
// Verifies the SSE envelope -> AssistantMessageEventStream contract:
//
//   * `data: {…}` envelope with `statusCodeValue === 200` and `body` carrying
//     a JSON OpenAI chat.completion.chunk produces text/thinking/tool events.
//   * `delta.reasoning_content` becomes `thinking_*` events (stray `<thinking>`
//     tags are stripped).
//   * `delta.content` becomes `text_*` events (with cross-chunk
//     `<thinking>…</thinking>` extraction via the thinking tag parser).
//   * Fragmented `delta.tool_calls` are buffered and emitted as one
//     `toolcall_*` lifecycle.
//   * Multiple parallel tool calls land as separate `toolcall_*` blocks.
//   * `usage` arriving AFTER `finish_reason` is captured (the parser keeps
//     consuming past the finish terminal until [DONE]).
//   * Bare `data: [DONE]`, envelope body `"[DONE]"`, and `event:finish` all
//     terminate the stream with `done`.
//   * Envelope with `statusCodeValue !== 200` (e.g. 402) emits `error`.
//   * Malformed JSON frame is a controlled `error` event, never a throw.
//   * Reader held open past `[DONE]` still completes (cancel-on-terminal).

import { afterEach, describe, expect, it } from "bun:test";

import { streamQoderCn } from "@oh-my-pi/pi-ai/providers/qoder-cn";
import { resetQoderCnResolversForTests } from "@oh-my-pi/pi-ai/providers/qoder-cn";
import type { AssistantMessage, AssistantMessageEvent, Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const TEST_PAT = "pt-test-token-fixtures";

function makeModel(): Model<"qoder-cn"> {
	return buildModel({
		id: "qoder-cn-test",
		name: "Qoder CN Test",
		api: "qoder-cn",
		provider: "qoder-cn",
		baseUrl: "https://gateway.qoder.com.cn",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		requestModelId: "dmodel",
	}) as Model<"qoder-cn">;
}

function envelope(
	body: unknown,
	statusCodeValue = 200,
	statusCode: string = "OK",
	headers: Record<string, string> = {},
): string {
	return `data: ${JSON.stringify({ headers, statusCode, statusCodeValue, body: JSON.stringify(body) })}\n\n`;
}

function chunk(delta: Record<string, unknown>, extras: Record<string, unknown> = {}): string {
	return envelope({
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		model: "dmodel",
		choices: [{ index: 0, delta, finish_reason: null }],
		...extras,
	});
}

function textChunk(text: string, extras: Record<string, unknown> = {}): string {
	return chunk({ content: text, role: "assistant" }, extras);
}

function reasoningChunk(text: string): string {
	return chunk({ reasoning_content: text, role: "assistant" });
}

function toolCallDelta(index: number, args: string, id?: string, name?: string): string {
	return chunk({
		role: "assistant",
		tool_calls: [
			{
				index,
				id,
				type: "function",
				function: { name, arguments: args },
			},
		],
	});
}

function usageFrame(input: number, output: number, cached: number, total: number): string {
	return envelope({
		id: "chatcmpl-test",
		object: "chat.completion.chunk",
		model: "dmodel",
		choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		usage: {
			prompt_tokens: input,
			completion_tokens: output,
			total_tokens: total,
			prompt_tokens_details: { cached_tokens: cached },
		},
	});
}

interface StreamHarness {
	events: AssistantMessageEvent[];
	done: boolean;
	message?: AssistantMessage;
}

async function runStream(
	chunks: string[],
	options: { signal?: AbortSignal; finishLast?: boolean } = {},
): Promise<StreamHarness> {
	const model = makeModel();
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
	const events: AssistantMessageEvent[] = [];
	let streamEnded = false;
	const encoder = new TextEncoder();
	const sseBody = chunks.join("");
	const fetchImpl: FetchImpl = Object.assign(
		async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
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
				// Build a stream that emits the prepared SSE bytes (possibly in
				// many small chunks) and then closes the body — the provider
				// must read past EOF and finalize cleanly.
				const totalBytes = encoder.encode(sseBody);
				let offset = 0;
				const stream = new ReadableStream<Uint8Array>({
					pull(controller) {
						if (offset >= totalBytes.length) {
							controller.close();
							return;
						}
						const chunk = totalBytes.subarray(offset, offset + 1);
						offset += chunk.length;
						controller.enqueue(chunk);
					},
				});
				return new Response(stream, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});
			}
			return new Response("not found", { status: 404 });
		},
		{ preconnect: () => undefined },
	);
	const stream = streamQoderCn(model, context, {
		apiKey: TEST_PAT,
		fetch: fetchImpl,
		...(options.signal ? { signal: options.signal } : {}),
	});
	const terminalPromise = stream.result();
	for await (const event of stream) {
		events.push(event);
		if (event.type === "done") streamEnded = true;
	}
	const message = await terminalPromise.catch(() => undefined);
	return { events, done: streamEnded, message };
}

afterEach(() => {
	resetQoderCnResolversForTests();
});

describe("streamQoderCn SSE parsing", () => {
	it("emits text_start/text_delta/text_end for delta.content", async () => {
		const result = await runStream([
			textChunk("Hello "),
			textChunk("world"),
			envelope({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				model: "dmodel",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			"data: [DONE]\n\n",
		]);
		const textStarts = result.events.filter(e => e.type === "text_start").length;
		const textDeltas = result.events.filter(e => e.type === "text_delta");
		const textEnds = result.events.filter(e => e.type === "text_end").length;
		expect(textStarts).toBe(1);
		expect(textEnds).toBe(1);
		const joined = textDeltas.map(e => (e as { type: "text_delta"; delta: string }).delta).join("");
		expect(joined).toBe("Hello world");
		expect(result.done).toBe(true);
	});

	it("routes delta.reasoning_content to thinking_* events with stray tags stripped", async () => {
		const result = await runStream([
			reasoningChunk("step 1 "),
			reasoningChunk("<thinking>oops</thinking> step 2"),
			envelope({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				model: "dmodel",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			"data: [DONE]\n\n",
		]);
		const reasoningDeltas = result.events
			.filter(e => e.type === "thinking_delta")
			.map(e => (e as { type: "thinking_delta"; delta: string }).delta);
		const joined = reasoningDeltas.join("");
		expect(joined).toBe("step 1 oops step 2");
		expect(joined).not.toContain("<thinking>");
		expect(result.done).toBe(true);
	});

	it("extracts <thinking> blocks from delta.content into thinking_* events", async () => {
		const result = await runStream([
			textChunk("before <thinking>hidden reasoning"),
			textChunk(" more reasoning</thinking> visible"),
			envelope({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				model: "dmodel",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			"data: [DONE]\n\n",
		]);
		const thinkingDeltas = result.events
			.filter(e => e.type === "thinking_delta")
			.map(e => (e as { type: "thinking_delta"; delta: string }).delta);
		const textDeltas = result.events
			.filter(e => e.type === "text_delta")
			.map(e => (e as { type: "text_delta"; delta: string }).delta);
		expect(thinkingDeltas.join("")).toBe("hidden reasoning more reasoning");
		// The opener text + closing text round-trip through the parser; the
		// post-closer gap collapses whitespace per the opencodex reference.
		expect(textDeltas.join("").replace(/\s+/g, " ").trim()).toBe("before visible");
	});

	it("buffers fragmented tool call arguments and emits one toolcall_* lifecycle", async () => {
		const result = await runStream([
			toolCallDelta(0, `{"express`, "call_1", "calc"),
			toolCallDelta(0, `ion":"1+1"}`, "call_1"),
			envelope({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				model: "dmodel",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
			"data: [DONE]\n\n",
		]);
		const starts = result.events.filter(e => e.type === "toolcall_start");
		const ends = result.events.filter(e => e.type === "toolcall_end");
		expect(starts).toHaveLength(1);
		expect(ends).toHaveLength(1);
		const toolCallEnd = ends[0] as {
			type: "toolcall_end";
			toolCall: { id: string; name: string; arguments: Record<string, unknown> };
		};
		expect(toolCallEnd.toolCall.id).toBe("call_1");
		expect(toolCallEnd.toolCall.name).toBe("calc");
		expect(toolCallEnd.toolCall.arguments).toEqual({ expression: "1+1" });
	});

	it("assembles index-only continuation fragments into one tool call (live CN wire shape)", async () => {
		// Regression: the live gateway sends the id/name only on the first
		// fragment; continuation fragments carry just `index` + argument text.
		// Keying the assembly on the id alone spawned one empty tool call per
		// fragment (observed live against deepseek-v4-flash, 2026-09-06).
		const result = await runStream([
			toolCallDelta(0, `{"city":"Ber`, "call_live", "get_weather"),
			toolCallDelta(0, `lin"}`),
			toolCallDelta(0, ``),
			envelope({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				model: "dmodel",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
			"data: [DONE]\n\n",
		]);
		const ends = result.events.filter(e => e.type === "toolcall_end") as Array<{
			type: "toolcall_end";
			toolCall: { id: string; name: string; arguments: Record<string, unknown> };
		}>;
		expect(ends).toHaveLength(1);
		expect(ends[0]!.toolCall.id).toBe("call_live");
		expect(ends[0]!.toolCall.name).toBe("get_weather");
		expect(ends[0]!.toolCall.arguments).toEqual({ city: "Berlin" });
	});

	it("emits separate toolcall_* blocks for parallel tool calls", async () => {
		const result = await runStream([
			toolCallDelta(0, `{"a":1}`, "call_a", "tool_a"),
			toolCallDelta(1, `{"b":2}`, "call_b", "tool_b"),
			envelope({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				model: "dmodel",
				choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			}),
			"data: [DONE]\n\n",
		]);
		const ends = result.events.filter(e => e.type === "toolcall_end") as Array<{
			type: "toolcall_end";
			toolCall: { id: string; name: string; arguments: Record<string, unknown> };
		}>;
		expect(ends).toHaveLength(2);
		const names = ends.map(e => e.toolCall.name).sort();
		expect(names).toEqual(["tool_a", "tool_b"]);
		const ids = ends.map(e => e.toolCall.id).sort();
		expect(ids).toEqual(["call_a", "call_b"]);
	});

	it("captures usage that arrives after finish_reason", async () => {
		const result = await runStream([
			textChunk("hi"),
			envelope({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				model: "dmodel",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			}),
			usageFrame(120, 25, 80, 145),
			"data: [DONE]\n\n",
		]);
		const done = result.events.find(e => e.type === "done") as
			| {
					type: "done";
					message: { usage: { input: number; output: number; cacheRead: number; totalTokens: number } };
			  }
			| undefined;
		expect(done).toBeTruthy();
		expect(done!.message.usage.input).toBe(120);
		expect(done!.message.usage.output).toBe(25);
		expect(done!.message.usage.cacheRead).toBe(80);
		expect(done!.message.usage.totalTokens).toBe(145);
	});

	it("terminates on a bare data: [DONE] frame", async () => {
		const result = await runStream([textChunk("ok"), "data: [DONE]\n\n"]);
		expect(result.events.some(e => e.type === "done")).toBe(true);
		expect(result.events.some(e => e.type === "error")).toBe(false);
	});

	it("terminates on an envelope whose body is exactly [DONE]", async () => {
		const doneEnvelope = `data: ${JSON.stringify({
			headers: {},
			statusCode: "OK",
			statusCodeValue: 200,
			body: "[DONE]",
		})}\n\n`;
		const result = await runStream([textChunk("ok"), doneEnvelope]);
		expect(result.events.some(e => e.type === "done")).toBe(true);
	});

	it("terminates on an `event:finish` frame", async () => {
		const result = await runStream([textChunk("ok"), 'event:finish\ndata: {"status":"ok"}\n\n']);
		expect(result.events.some(e => e.type === "done")).toBe(true);
	});

	it("reports toolUse when a tool call is closed by a bare [DONE] terminal", async () => {
		// Regression: the terminal paths used to consult `pendingToolCalls`
		// AFTER finalizeToolCalls() cleared it, so [DONE]/event:finish turns
		// with tool calls reported stopReason "stop" and the agent loop never
		// executed the call.
		const result = await runStream([
			toolCallDelta(0, '{"city":"Ber', "call_1", "get_weather"),
			toolCallDelta(0, 'lin"}'),
			"data: [DONE]\n\n",
		]);
		expect(result.message?.stopReason).toBe("toolUse");
		const toolCall = result.message?.content.find(b => b.type === "toolCall") as
			| { type: "toolCall"; name: string; arguments: Record<string, unknown> }
			| undefined;
		expect(toolCall?.name).toBe("get_weather");
		expect(toolCall?.arguments).toEqual({ city: "Berlin" });
	});

	it("finalizes user-facing content when EOF arrives without a terminal", async () => {
		// The gateway can hold or drop the socket past the reply; a turn that
		// already delivered text must complete, not surface as
		// "Stream ended without a final result".
		const result = await runStream([textChunk("partial answer")]);
		expect(result.message?.stopReason).toBe("stop");
		expect(result.events.some(e => e.type === "done")).toBe(true);
		expect(result.events.some(e => e.type === "error")).toBe(false);
	});

	it("emits error on an envelope with statusCodeValue 402", async () => {
		const envelope402 = `data: ${JSON.stringify({
			headers: {},
			statusCode: "Payment Required",
			statusCodeValue: 402,
			body: JSON.stringify({ code: "9999", message: "quota exhausted" }),
		})}\n\n`;
		const result = await runStream([textChunk("ok"), envelope402]);
		const errorEvent = result.events.find(e => e.type === "error") as
			| { type: "error"; error: { errorStatus?: number; errorMessage?: string } }
			| undefined;
		expect(errorEvent).toBeTruthy();
		expect(errorEvent!.error.errorStatus).toBe(402);
		expect(errorEvent!.error.errorMessage).toContain("credit balance");
	});

	it("emits error on a malformed JSON frame instead of throwing", async () => {
		const result = await runStream([textChunk("ok"), "data: not-json\n\n"]);
		expect(result.events.some(e => e.type === "error")).toBe(true);
	});

	it("completes when the upstream holds the socket open past [DONE]", async () => {
		// Build a stream that emits the prepared bytes then STAYS OPEN past
		// the terminal — the provider must cancel its reader on [DONE].
		const model = makeModel();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const events: AssistantMessageEvent[] = [];
		const encoder = new TextEncoder();
		const sseBody = [textChunk("done"), "data: [DONE]\n\n"].join("");
		const totalBytes = encoder.encode(sseBody);
		let offset = 0;
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
					const stream = new ReadableStream<Uint8Array>({
						pull(controller) {
							if (offset < totalBytes.length) {
								const chunk = totalBytes.subarray(offset, offset + 1);
								offset += chunk.length;
								controller.enqueue(chunk);
							}
							// Never close — provider must cancel.
						},
					});
					return new Response(stream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: () => undefined },
		);
		const stream = streamQoderCn(model, context, { apiKey: TEST_PAT, fetch: fetchImpl });
		const resultPromise = stream.result();
		for await (const event of stream) events.push(event);
		await resultPromise;
		expect(events.some(e => e.type === "done")).toBe(true);
	});

	it("aborts in-flight stream when the signal fires mid-stream", async () => {
		const controller = new AbortController();
		const model = makeModel();
		const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };
		const encoder = new TextEncoder();
		const fetchImpl: FetchImpl = Object.assign(
			async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
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
					controller.abort();
					const stream = new ReadableStream<Uint8Array>({
						start(controllerStream) {
							controllerStream.enqueue(encoder.encode(textChunk("hi")));
						},
					});
					return new Response(stream, {
						status: 200,
						headers: { "content-type": "text/event-stream" },
					});
				}
				return new Response("not found", { status: 404 });
			},
			{ preconnect: () => undefined },
		);
		const stream = streamQoderCn(model, context, {
			apiKey: TEST_PAT,
			fetch: fetchImpl,
			signal: controller.signal,
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();
		expect(result.stopReason === "aborted" || result.stopReason === "error").toBe(true);
	});

	it("exposes the encrypted chunk envelope path (statusCodeValue 200, body is JSON)", async () => {
		// Some paths emit the inner chunk directly as `body` (already a JSON
		// object) rather than a stringified one. Verify the parser unwraps.
		const directEnvelope = `data: ${JSON.stringify({
			headers: {},
			statusCode: "OK",
			statusCodeValue: 200,
			body: JSON.stringify({
				id: "chatcmpl-test",
				object: "chat.completion.chunk",
				model: "dmodel",
				choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
			}),
		})}\n\n`;
		const result = await runStream([directEnvelope, "data: [DONE]\n\n"]);
		expect(result.events.some(e => e.type === "done")).toBe(true);
		const textDeltas = result.events
			.filter(e => e.type === "text_delta")
			.map(e => (e as { type: "text_delta"; delta: string }).delta);
		expect(textDeltas.join("")).toBe("ok");
	});
});
