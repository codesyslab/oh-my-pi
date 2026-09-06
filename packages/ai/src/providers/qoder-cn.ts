// Qoder CN streaming provider.
//
// Qoder CN is a subscription-backed raw model transport. The provider is the
// pi-ai half of a protocol split: the catalog core owns auth, COSY signing, and
// discovery (see `packages/catalog/src/qoder/`); this module owns the
// AssistantMessageEventStream lifecycle — request body build (OpenAI-chat
// shaped messages + tools), reasoning parameter mapping, single-flight COSY
// signing at fetch time, SSE envelope parsing, and 401-driven one-replay.
//
// Source priority for this file:
//   - protocol: QODER_PROTOCOL_CURRENT.md / QODER_NATIVE_PROVIDER_TZ.md
//     (CN endpoints + COSY signing).
//   - reference: opencodex/src/adapters/qoder/{index,protocol,stream,thinking,
//     errors}.ts — adapted to pi-ai's AssistantMessageEventStream contract.
//   - sister file: devin.ts — for the provider boilerplate (event shapes,
//     usage mapping, calculateCost, AIError.finalize).

import * as crypto from "node:crypto";

import { buildQoderCosyHeaders, type QoderCosyCredentials, qoderEncodeBody } from "@oh-my-pi/pi-catalog/qoder/cosy";
import {
	QoderAuthError,
	QoderCredentialResolver,
	type QoderResolvedCredentials,
} from "@oh-my-pi/pi-catalog/qoder/auth";
import { resolveQoderCnEndpoints, type QoderCnEndpoints } from "@oh-my-pi/pi-catalog/qoder/endpoints";
import {
	QODER_DEFAULT_CONTEXT_WINDOW,
	QODER_MAX_OUTPUT_TOKENS,
	type QoderModelEntry,
} from "@oh-my-pi/pi-catalog/qoder/models";
import { qoderModelConfigForRequest } from "@oh-my-pi/pi-catalog/qoder/models";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { logger } from "@oh-my-pi/pi-utils";

import * as AIError from "../error";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
} from "../types";
import { isDemotedThinking } from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { toolWireSchema } from "../utils/schema/wire";
import { transformMessages } from "./transform-messages";

export interface QoderCnOptions extends StreamOptions {
	reasoning?: Effort;
	/** Force-disable reasoning where the model's thinking config exposes a real off path. */
	disableReasoning?: boolean;
	/** Provider-level override for the gateway base URL. */
	gatewayBaseUrl?: string;
	/** Provider-level override for the OpenAPI base URL. */
	openApiBaseUrl?: string;
}

const EFFORT_RANK: readonly Effort[] = [
	Effort.Minimal,
	Effort.Low,
	Effort.Medium,
	Effort.High,
	Effort.XHigh,
	Effort.Max,
];

/** Tag variants that occasionally leak into the text/reasoning channel. */
const QODER_THINKING_TAG_VARIANTS: Array<{ open: string; close: string }> = [
	{ open: "<thinking>", close: "</thinking>" },
	{ open: "<think>", close: "</think>" },
	{ open: "<reasoning>", close: "</reasoning>" },
	{ open: "<thought>", close: "</thought>" },
];

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * Per-process resolver cache keyed by SHA-256 of the PAT so the shared single-flight
 * exchange cache lives behind one resolver per credential. Constructing a new
 * resolver per stream() is fine — the underlying auth module already coalesces.
 */
const resolverCache = new Map<string, QoderCredentialResolver>();

function resolverFor(pat: string, endpoints: QoderCnEndpoints): QoderCredentialResolver {
	const key = crypto.createHash("sha256").update("qoder-resolver\0").update(pat).digest("hex");
	const cached = resolverCache.get(key);
	if (cached) return cached;
	const fresh = new QoderCredentialResolver(pat, endpoints);
	resolverCache.set(key, fresh);
	return fresh;
}

/** Test seam: forget every cached resolver so auth/cache state cannot leak across cases. */
export function resetQoderCnResolversForTests(): void {
	resolverCache.clear();
}

// ---------------------------------------------------------------------------
// Reasoning parameter mapping
// ---------------------------------------------------------------------------

interface QoderReasoningParams {
	enable_thinking?: boolean;
	reasoning_effort?: string;
}

/**
 * Resolve the requested reasoning setting to exact Qoder wire parameters.
 * Trust model — the vendor-verified control kind (`model.compat.thinkingControl`,
 * rule-owned in `compat/rules/providers/qoder-cn.kdl`) decides, never Qoder's
 * self-report:
 *   - `model.reasoning === false` or control `none` → never send reasoning
 *     params, never scan content for thinking tags.
 *   - `always` (Kimi-K2.7-Code, MiniMax-M2.7 — reason unconditionally, no
 *     control exists) → send NO reasoning parameters, including on an off
 *     request; an `enable_thinking:false` the model cannot honor is worse
 *     than omission. `delta.reasoning_content` is still parsed.
 *   - `toggle` (Qwen 3.7) → the wire has no effort ladder: `enable_thinking`
 *     follows the request, omitted when unset. `reasoning_effort` is never
 *     sent.
 *   - `efforts` → `enable_thinking: true` + `reasoning_effort` clamped to
 *     the `thinking.efforts` ladder (vendor-verified ∩ gateway-advertised);
 *     "minimal" maps to the lowest rung. Off request: `enable_thinking: false`
 *     when the model has a real non-thinking mode; when
 *     `thinking.requiresEffort` (GLM — thinking cannot be disabled) clamp to
 *     the lowest rung instead.
 */
function resolveReasoningParams(
	model: Model<"qoder-cn">,
	requestedEffort: Effort | undefined,
	disableReasoning: boolean | undefined,
	forceReasoningOff: boolean | undefined,
): QoderReasoningParams | undefined {
	if (!model.reasoning) return undefined;
	const control = model.compat?.thinkingControl;
	if (control === "none" || control === "always") return undefined;

	const thinking = model.thinking;
	const wantsOff = disableReasoning === true || forceReasoningOff === true;
	const requestedRaw: Effort | undefined = wantsOff ? undefined : requestedEffort;

	if (control === "toggle") {
		if (wantsOff) return { enable_thinking: false };
		// Unset means "no opinion": omit the field and leave the gateway default.
		return requestedRaw === undefined ? undefined : { enable_thinking: true };
	}

	// `efforts` (or an unmarked spec whose ladder was resolved explicitly).
	if (!thinking) return undefined;
	const wireEfforts = thinking.efforts;

	if (wantsOff) {
		if (thinking.requiresEffort) {
			// mandatory-reasoning endpoint: clamp to the lowest supported effort
			// instead of `enable_thinking:false` the upstream cannot honor.
			const floor = wireEfforts[0];
			if (!floor) return undefined;
			return { enable_thinking: true, reasoning_effort: floor };
		}
		return { enable_thinking: false };
	}

	if (requestedRaw === undefined) return undefined;

	// No advertised ladder and no control surface — sending `enable_thinking`
	// would commit to a value the model has no ladder for. Stay silent and
	// let the upstream use its server-side default.
	if (wireEfforts.length === 0) return undefined;

	// effort-capable: clamp by ladder rank to the nearest advertised rung at
	// or below the request; fall back to the lowest rung if none qualify.
	const requestedRank = EFFORT_RANK.indexOf(requestedRaw);
	let best: Effort | undefined;
	let bestRank = -1;
	for (const effort of wireEfforts) {
		const rank = EFFORT_RANK.indexOf(effort);
		if (rank < 0) continue;
		if ((requestedRank < 0 || rank <= requestedRank) && rank > bestRank) {
			best = effort;
			bestRank = rank;
		}
	}
	if (best === undefined) {
		for (const effort of wireEfforts) {
			const rank = EFFORT_RANK.indexOf(effort);
			if (rank >= 0 && (bestRank === -1 || rank < bestRank)) {
				best = effort;
				bestRank = rank;
			}
		}
	}
	if (best === undefined) {
		// No advertised rung can match the request: omit reasoning entirely
		// rather than send a value the upstream will reject.
		return undefined;
	}
	return { enable_thinking: true, reasoning_effort: best };
}

// ---------------------------------------------------------------------------
// Message conversion (omp Message → OpenAI-chat shape)
// ---------------------------------------------------------------------------

type QoderTextPart = { type: "text"; text: string };
type QoderImagePart = { type: "image_url"; image_url: { url: string } };
type QoderContent = string | Array<QoderTextPart | QoderImagePart> | null;

interface QoderToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface QoderMessage {
	role: "system" | "user" | "assistant" | "tool";
	content: QoderContent;
	tool_calls?: QoderToolCall[];
	tool_call_id?: string;
}

function contentPartText(content: string | Array<TextContent | ImageContent>): string {
	if (typeof content === "string") return content;
	let text = "";
	for (const part of content) {
		if (part.type === "text") text += part.text;
	}
	return text;
}

function contentPartImages(content: string | Array<TextContent | ImageContent>): QoderImagePart[] {
	if (typeof content === "string") return [];
	return content.flatMap(part =>
		part.type === "image"
			? [{ type: "image_url" as const, image_url: { url: `data:${part.mimeType};base64,${part.data}` } }]
			: [],
	);
}

function userContent(content: string | Array<TextContent | ImageContent>, supportsImages: boolean): QoderContent {
	if (typeof content === "string") return content;
	const images = supportsImages ? contentPartImages(content) : [];
	if (images.length === 0) return contentPartText(content);
	const text = contentPartText(content);
	const parts: Array<QoderTextPart | QoderImagePart> = [];
	if (text) parts.push({ type: "text", text });
	parts.push(...images);
	return parts;
}

/**
 * Translate omp history into the OpenAI-chat-shaped message list Qoder accepts.
 * Thinking replays as `<thinking>...</thinking>` text (the only channel the wire
 * has for it); assistant turns with tool_calls but no text get a single-space
 * placeholder (the gateway drops null-content assistants and orphans the
 * matching tool result); tool results with images become a follow-up user
 * message (the OpenAI `tool` role has no image slot).
 */
function buildMessages(messages: Message[], supportsImages: boolean): QoderMessage[] {
	const out: QoderMessage[] = [];
	for (const msg of messages) {
		if (msg.role === "developer") {
			const text = contentPartText(msg.content);
			if (text) out.push({ role: "system", content: text });
			continue;
		}
		if (msg.role === "user") {
			out.push({ role: "user", content: userContent(msg.content, supportsImages) });
			continue;
		}
		if (msg.role === "assistant") {
			let text = "";
			const toolCalls: QoderToolCall[] = [];
			for (const part of msg.content) {
				if (part.type === "text") {
					text += `${part.text}${isDemotedThinking(part) ? "\n" : ""}`;
				} else if (part.type === "thinking") {
					if (part.thinking) text += `<thinking>${part.thinking}</thinking>\n\n`;
				} else if (part.type === "toolCall") {
					toolCalls.push({
						id: part.id,
						type: "function",
						function: {
							name: part.name,
							arguments: JSON.stringify(part.arguments ?? {}),
						},
					});
				}
			}
			out.push({
				role: "assistant",
				content: text || (toolCalls.length > 0 ? " " : null),
				...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
			});
			continue;
		}
		// toolResult
		out.push({
			role: "tool",
			tool_call_id: msg.toolCallId,
			content: contentPartText(msg.content),
		});
		const images = supportsImages ? contentPartImages(msg.content) : [];
		if (images.length > 0) {
			out.push({
				role: "user",
				content: [
					{
						type: "text",
						text: `[${images.length} image${images.length === 1 ? "" : "s"} returned by the previous tool call]`,
					},
					...images,
				],
			});
		}
	}
	return out;
}

function buildTools(tools: Tool[] | undefined): Array<Record<string, unknown>> {
	if (!tools || tools.length === 0) return [];
	const formatted: Array<Record<string, unknown>> = [];
	for (const tool of tools) {
		formatted.push({
			type: "function",
			function: {
				name: tool.name,
				...(tool.description ? { description: tool.description } : {}),
				parameters: toolWireSchema(tool),
			},
		});
	}
	return formatted;
}

// ---------------------------------------------------------------------------
// Request body build
// ---------------------------------------------------------------------------

/** Lookup table for the live wire key for a given qoder-cn model. Falls back
 * to a synthesized entry when no live catalog snapshot has been seen. */
function synthesizeEntry(model: Model<"qoder-cn">): QoderModelEntry {
	const wireKey = model.requestModelId ?? model.id;
	const contextWindow = model.contextWindow ?? QODER_DEFAULT_CONTEXT_WINDOW;
	return {
		key: wireKey,
		enable: true,
		display_name: model.name,
		source: "system",
		is_reasoning: !!model.reasoning,
		is_vl: model.input.includes("image"),
		context_config: {
			[`ctx${contextWindow}`]: { token_count: contextWindow, is_default: true },
		},
	};
}

interface BuildResult {
	bodyJson: string;
	requestId: string;
	encodedBody: string;
	modelKey: string;
	modelSource: string;
}

/** Pure builder: catalog lookup + body composition + body encoding. No network. */
function buildRequest(
	model: Model<"qoder-cn">,
	context: Context,
	options: QoderCnOptions | undefined,
	entry: QoderModelEntry,
): BuildResult {
	const supportsImages = model.input.includes("image");
	const messages = buildMessages(transformMessages(context.messages, model), supportsImages);

	// The server ignores the top-level `system` field; the prompt rides as a
	// leading role:"system" message (verified by the opencodex reference).
	const systemText = context.systemPrompt?.join("\n\n").trim() ?? "";
	if (systemText) messages.unshift({ role: "system", content: systemText });

	let lastUserText = "";
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "user") {
			lastUserText =
				typeof m.content === "string"
					? m.content
					: (m.content ?? []).map(part => (part.type === "text" ? part.text : "")).join("");
			break;
		}
	}

	const tools = buildTools(context.tools);
	const maxTokens = Math.min(
		options?.maxTokens ?? model.maxTokens ?? QODER_MAX_OUTPUT_TOKENS,
		model.maxTokens ?? QODER_MAX_OUTPUT_TOKENS,
	);

	const reasoningParams = resolveReasoningParams(
		model,
		options?.reasoning,
		options?.disableReasoning,
		options?.forceReasoningOff,
	);

	// Unique request_id per inference — the server answers code 103 on
	// duplicates; request_set_id/chat_record_id stay stable for identical
	// payloads; session_id is transport metadata only.
	const requestId = crypto.randomUUID();
	const recordId = crypto
		.createHash("sha256")
		.update(`qoder-record\0${entry.key ?? ""}\0`)
		.update(JSON.stringify(messages))
		.update("\0")
		.update(JSON.stringify(tools))
		.update(`\0mt=${maxTokens}`)
		.digest("hex")
		.slice(0, 16);
	const sessionId = `${crypto
		.createHash("sha256")
		.update(`qoder-session\0${entry.key ?? ""}`)
		.digest("hex")
		.slice(0, 16)}-${crypto.randomUUID()}`;

	const body: Record<string, unknown> = {
		request_id: requestId,
		request_set_id: recordId,
		chat_record_id: recordId,
		session_id: sessionId,
		stream: true,
		chat_task: "FREE_INPUT",
		is_reply: true,
		is_retry: false,
		source: 1,
		version: "3",
		session_type: "qodercli",
		agent_id: "agent_common",
		task_id: "common",
		code_language: "",
		chat_prompt: "",
		image_urls: null,
		aliyun_user_type: "",
		system: "",
		messages,
		tools,
		parameters: {
			max_tokens: maxTokens,
			...reasoningParams,
		},
		chat_context: {
			chatPrompt: "",
			imageUrls: null,
			extra: {
				context: [],
				modelConfig: {
					key: entry.key ?? model.id,
					is_reasoning: !!model.reasoning,
				},
				originalContent: lastUserText,
			},
			features: [],
			text: lastUserText,
		},
		model_config: qoderModelConfigForRequest(entry),
		business: {
			product: "cli",
			version: "1.0.0",
			type: "agent",
			stage: "start",
			id: crypto.randomUUID(),
			name: lastUserText.substring(0, 30),
			begin_at: Date.now(),
		},
	};

	const bodyJson = JSON.stringify(body);
	return {
		bodyJson,
		requestId,
		encodedBody: qoderEncodeBody(bodyJson),
		modelKey: entry.key ?? model.requestModelId ?? model.id,
		modelSource: typeof entry.source === "string" && entry.source ? entry.source : "system",
	};
}

// ---------------------------------------------------------------------------
// SSE parser
// ---------------------------------------------------------------------------

interface PendingToolCall {
	/** Stream-assembly key (index- or id-scoped); NOT the tool-call id. */
	key: string;
	id: string;
	name: string;
	args: string;
	started: boolean;
}

interface PendingUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function qoderUsageFromChunk(usage: unknown): PendingUsage | undefined {
	if (!isRecord(usage)) return undefined;
	const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
	// OpenAI semantics: prompt_tokens INCLUDES cached tokens — matches pi-ai's
	// canonical input convention (total prompt size).
	const input = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
	const output = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
	const cached = typeof promptDetails?.cached_tokens === "number" ? promptDetails.cached_tokens : 0;
	return {
		input,
		output,
		cacheRead: cached,
		cacheWrite: 0,
		totalTokens: typeof usage.total_tokens === "number" ? usage.total_tokens : input + output,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function stripThinkingTags(text: string): string {
	let out = text;
	for (const { open, close } of QODER_THINKING_TAG_VARIANTS) {
		if (out.includes(open)) out = out.split(open).join("");
		if (out.includes(close)) out = out.split(close).join("");
	}
	return out;
}

class QoderThinkingTagParser {
	#buffer = "";
	#inThinking = false;
	#thinkingDone = false;
	#activeClose = QODER_THINKING_TAG_VARIANTS[0]!.close;
	readonly #onText: (text: string) => void;
	readonly #onThinking: (text: string) => void;

	constructor(onText: (text: string) => void, onThinking: (text: string) => void) {
		this.#onText = onText;
		this.#onThinking = onThinking;
	}

	processChunk(chunk: string): void {
		this.#buffer += chunk;
		while (this.#buffer.length > 0) {
			const previousLength = this.#buffer.length;
			if (!this.#inThinking && !this.#thinkingDone) {
				this.#processOutside();
				if (this.#buffer.length === 0) break;
			}
			if (this.#inThinking) {
				this.#processInside();
				if (this.#buffer.length === 0) break;
			}
			if (this.#thinkingDone) {
				this.#flushText();
				break;
			}
			if (this.#buffer.length >= previousLength) break;
		}
	}

	finalize(): void {
		if (this.#buffer.length === 0) return;
		if (this.#inThinking) this.#onThinking(this.#buffer);
		else this.#onText(this.#buffer);
		this.#buffer = "";
	}

	#processOutside(): void {
		let bestOpenPos = -1;
		let bestOpen: (typeof QODER_THINKING_TAG_VARIANTS)[number] | null = null;
		let bestClosePos = -1;
		let bestClose: (typeof QODER_THINKING_TAG_VARIANTS)[number] | null = null;
		for (const variant of QODER_THINKING_TAG_VARIANTS) {
			const openPos = this.#buffer.indexOf(variant.open);
			if (openPos !== -1 && (bestOpenPos === -1 || openPos < bestOpenPos)) {
				bestOpenPos = openPos;
				bestOpen = variant;
			}
			const closePos = this.#buffer.indexOf(variant.close);
			if (closePos !== -1 && (bestClosePos === -1 || closePos < bestClosePos)) {
				bestClosePos = closePos;
				bestClose = variant;
			}
		}

		if (bestOpen !== null && (bestClose === null || bestOpenPos < bestClosePos)) {
			if (bestOpenPos > 0) this.#onText(this.#buffer.slice(0, bestOpenPos));
			this.#buffer = this.#buffer.slice(bestOpenPos + bestOpen.open.length);
			this.#activeClose = bestOpen.close;
			this.#inThinking = true;
			return;
		}

		if (bestClose !== null) {
			if (bestClosePos > 0) this.#onText(this.#buffer.slice(0, bestClosePos));
			this.#buffer = this.#buffer.slice(bestClosePos + bestClose.close.length);
			if (this.#buffer.startsWith("\n\n")) this.#buffer = this.#buffer.slice(2);
			else if (this.#buffer.startsWith("\n")) this.#buffer = this.#buffer.slice(1);
			return;
		}

		const allTags = QODER_THINKING_TAG_VARIANTS.flatMap(v => [v.open, v.close]);
		const holdBack = maxTrailingTagPrefix(this.#buffer, allTags);
		const safeLength = this.#buffer.length - holdBack;
		if (safeLength > 0) {
			this.#onText(this.#buffer.slice(0, safeLength));
			this.#buffer = this.#buffer.slice(safeLength);
		}
	}

	#processInside(): void {
		const endPos = this.#buffer.indexOf(this.#activeClose);
		if (endPos !== -1) {
			if (endPos > 0) this.#onThinking(this.#buffer.slice(0, endPos));
			this.#buffer = this.#buffer.slice(endPos + this.#activeClose.length);
			this.#inThinking = false;
			this.#thinkingDone = true;
			if (this.#buffer.startsWith("\n\n")) this.#buffer = this.#buffer.slice(2);
			return;
		}
		const holdBack = trailingTagPrefix(this.#buffer, this.#activeClose);
		const safeLength = this.#buffer.length - holdBack;
		if (safeLength > 0) {
			this.#onThinking(this.#buffer.slice(0, safeLength));
			this.#buffer = this.#buffer.slice(safeLength);
		}
	}

	#flushText(): void {
		if (this.#buffer.length > 0) this.#onText(this.#buffer);
		this.#buffer = "";
	}
}

function trailingTagPrefix(text: string, tag: string): number {
	const max = Math.min(text.length, tag.length - 1);
	for (let len = max; len > 0; len--) {
		if (text.endsWith(tag.slice(0, len))) return len;
	}
	return 0;
}

function maxTrailingTagPrefix(text: string, tags: string[]): number {
	let max = 0;
	for (const tag of tags) max = Math.max(max, trailingTagPrefix(text, tag));
	return max;
}

/** Frame-level error: statusCodeValue != 200 or chunk.error present. */
function streamError(statusCodeValue: unknown, body: unknown): { type: "error"; status: number; message: string } {
	const status =
		typeof statusCodeValue === "number" &&
		Number.isInteger(statusCodeValue) &&
		statusCodeValue >= 100 &&
		statusCodeValue <= 599
			? statusCodeValue
			: 502;
	const code = typeof body === "string" ? extractQoderErrorCode(body) : undefined;
	const message =
		status === 401
			? "upstream authentication was rejected"
			: status === 402
				? "upstream reports the subscription credit balance is exhausted"
				: status === 429
					? "upstream rate limit reached"
					: "upstream returned an error frame";
	const messageWithCode = code ? `${message} (code ${code})` : message;
	return { type: "error", status, message: messageWithCode };
}

function extractQoderErrorCode(body: string): string | undefined {
	try {
		const parsed = JSON.parse(body) as { code?: unknown };
		if (typeof parsed.code === "string" && /^\d{3,6}$/.test(parsed.code)) return parsed.code;
		if (typeof parsed.code === "number") return String(parsed.code);
	} catch {
		// Not JSON — nothing safe to extract.
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// streamQoderCn
// ---------------------------------------------------------------------------

export const streamQoderCn: StreamFunction<"qoder-cn"> = (
	model: Model<"qoder-cn">,
	context: Context,
	options?: QoderCnOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	void (async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "qoder-cn" as AssistantMessage["api"],
			provider: model.provider,
			model: model.id,
			usage: { ...ZERO_USAGE },
			stopReason: "stop",
			timestamp: Date.now(),
		};

		let currentTextBlock: TextContent | null = null;
		let currentThinkingBlock: ThinkingContent | null = null;
		const toolBlocks = new Map<string, ToolCall>();
		const pendingToolCalls: PendingToolCall[] = [];
		let pendingUsage: PendingUsage | undefined;

		const markFirstToken = (): void => {
			if (firstTokenTime === undefined) firstTokenTime = performance.now();
		};

		const endTextBlock = (): void => {
			const block = currentTextBlock;
			if (!block) return;
			currentTextBlock = null;
			stream.push({
				type: "text_end",
				contentIndex: output.content.indexOf(block),
				content: block.text,
				partial: output,
			});
		};

		const endThinkingBlock = (): void => {
			const block = currentThinkingBlock;
			if (!block) return;
			currentThinkingBlock = null;
			stream.push({
				type: "thinking_end",
				contentIndex: output.content.indexOf(block),
				content: block.thinking,
				partial: output,
			});
		};

		try {
			const fetchImpl = options?.fetch ?? fetch;
			const endpoints = resolveQoderCnEndpoints({
				...(options?.gatewayBaseUrl ? { gatewayBaseUrl: options.gatewayBaseUrl } : {}),
				...(options?.openApiBaseUrl ? { openApiBaseUrl: options.openApiBaseUrl } : {}),
			});

			const pat = (options?.apiKey ?? "").trim();
			if (!pat) {
				throw new AIError.ConfigurationError(
					`qoder-cn provider has no credential — set the QODER_PERSONAL_ACCESS_TOKEN env var or sign in via /login qoder-cn`,
				);
			}

			const entry = synthesizeEntry(model);
			const build = buildRequest(model, context, options, entry);

			const send = async (creds: QoderResolvedCredentials, buildSnapshot: BuildResult): Promise<Response> => {
				const cosyHeaders = buildQoderCosyHeaders(
					buildSnapshot.encodedBody,
					endpoints.chatUrl,
					creds as QoderCosyCredentials,
				);
				return await fetchImpl(endpoints.chatUrl, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						"Cache-Control": "no-cache",
						"Accept-Encoding": "identity",
						"X-Model-Key": buildSnapshot.modelKey,
						"X-Model-Source": buildSnapshot.modelSource,
						...cosyHeaders,
					},
					body: buildSnapshot.encodedBody,
					signal: options?.signal,
				});
			};

			let creds: QoderResolvedCredentials;
			try {
				creds = await resolverFor(pat, endpoints).resolve(fetchImpl);
			} catch (error) {
				if (error instanceof QoderAuthError) {
					throw new AIError.ConfigurationError(`qoder-cn auth failed: ${error.message}`, { cause: error });
				}
				throw error;
			}

			let response = await send(creds, build);
			// Single forced re-auth + single replay. The encoded body and its
			// request_id stay identical so the upstream cannot see a duplicate
			// request_id unless the cache itself is poisoned.
			if (response.status === 401 && !options?.signal?.aborted) {
				await response.text().catch(() => "");
				let refreshed: QoderResolvedCredentials;
				try {
					refreshed = await resolverFor(pat, endpoints).forceRefresh(fetchImpl);
				} catch (error) {
					if (error instanceof QoderAuthError) {
						throw new AIError.ConfigurationError(`qoder-cn re-auth failed: ${error.message}`, { cause: error });
					}
					throw error;
				}
				response = await send(refreshed, build);
			}

			if (!response.ok) {
				// The upstream body is untrusted and may echo request internals
				// (signing wrapper, headers). Surface only the status-mapped
				// message plus the machine code — same contract as streamError.
				const text = await response.text().catch(() => "");
				const safe = streamError(response.status, text);
				throw new AIError.ProviderHttpError(`qoder-cn: ${safe.message}`, safe.status);
			}
			if (!response.body) {
				throw new AIError.ProviderResponseError("qoder-cn: response body is empty", {
					provider: model.provider,
					kind: "empty-body",
				});
			}

			stream.push({ type: "start", partial: output });

			const reader = response.body.getReader();
			const decoder = new TextDecoder();
			const thinkingScanner = model.reasoning
				? new QoderThinkingTagParser(
						text => {
							markFirstToken();
							endThinkingBlock();
							const block: TextContent = currentTextBlock ?? { type: "text", text: "" };
							if (currentTextBlock !== block) {
								output.content.push(block);
								currentTextBlock = block;
								stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							}
							block.text += text;
							stream.push({
								type: "text_delta",
								contentIndex: output.content.indexOf(block),
								delta: text,
								partial: output,
							});
						},
						thinking => {
							markFirstToken();
							const block: ThinkingContent = currentThinkingBlock ?? {
								type: "thinking",
								thinking: "",
							};
							if (currentThinkingBlock !== block) {
								output.content.push(block);
								currentThinkingBlock = block;
								stream.push({
									type: "thinking_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
							block.thinking += thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: output.content.indexOf(block),
								delta: thinking,
								partial: output,
							});
						},
					)
				: null;

			const finalizeToolCalls = (): void => {
				for (const call of pendingToolCalls) {
					let block = toolBlocks.get(call.id);
					if (!block) {
						block = {
							type: "toolCall",
							id: call.id,
							name: call.name,
							arguments: safeJsonParse(call.args),
						};
						output.content.push(block);
						toolBlocks.set(call.id, block);
					}
					block.name = call.name || block.name;
					block.arguments = safeJsonParse(call.args);
					stream.push({
						type: "toolcall_end",
						contentIndex: output.content.indexOf(block),
						toolCall: block,
						partial: output,
					});
				}
				pendingToolCalls.length = 0;
			};

			const handleChunk = (chunk: Record<string, unknown>): "continue" | "terminate" => {
				if (chunk.error !== undefined && chunk.error !== null) {
					const err = streamError(undefined, JSON.stringify(chunk.error));
					finalizeToolCalls();
					endTextBlock();
					endThinkingBlock();
					stream.push({ type: "error", reason: "error", error: attachError(output, err.status, err.message) });
					return "terminate";
				}
				if (chunk.usage) pendingUsage = qoderUsageFromChunk(chunk.usage);

				const choices = chunk.choices;
				if (choices === undefined) return "continue";
				if (!Array.isArray(choices) || choices.length === 0) {
					// Empty/missing choices: ignore, like openai-completions.
					return "continue";
				}
				const rawChoice = choices[0];
				if (!isRecord(rawChoice)) {
					const err = streamError(undefined, "malformed choices payload");
					finalizeToolCalls();
					endTextBlock();
					endThinkingBlock();
					stream.push({ type: "error", reason: "error", error: attachError(output, err.status, err.message) });
					return "terminate";
				}

				const finishReason = typeof rawChoice.finish_reason === "string" ? rawChoice.finish_reason : undefined;
				const delta = isRecord(rawChoice.delta) ? rawChoice.delta : undefined;
				if (delta) {
					if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
						const cleaned = stripThinkingTags(delta.reasoning_content);
						if (cleaned) {
							markFirstToken();
							endTextBlock();
							const block: ThinkingContent = currentThinkingBlock ?? {
								type: "thinking",
								thinking: "",
							};
							if (currentThinkingBlock !== block) {
								output.content.push(block);
								currentThinkingBlock = block;
								stream.push({
									type: "thinking_start",
									contentIndex: output.content.length - 1,
									partial: output,
								});
							}
							block.thinking += cleaned;
							stream.push({
								type: "thinking_delta",
								contentIndex: output.content.indexOf(block),
								delta: cleaned,
								partial: output,
							});
						}
					}
					if (typeof delta.content === "string" && delta.content.length > 0) {
						markFirstToken();
						endThinkingBlock();
						if (thinkingScanner) {
							thinkingScanner.processChunk(delta.content);
						} else {
							const block: TextContent = currentTextBlock ?? { type: "text", text: "" };
							if (currentTextBlock !== block) {
								output.content.push(block);
								currentTextBlock = block;
								stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
							}
							block.text += delta.content;
							stream.push({
								type: "text_delta",
								contentIndex: output.content.indexOf(block),
								delta: delta.content,
								partial: output,
							});
						}
					}

					const rawToolCalls = delta.tool_calls;
					if (rawToolCalls !== undefined && rawToolCalls !== null) {
						if (!Array.isArray(rawToolCalls)) {
							const err = streamError(undefined, "malformed tool_calls payload");
							finalizeToolCalls();
							endTextBlock();
							endThinkingBlock();
							stream.push({
								type: "error",
								reason: "error",
								error: attachError(output, err.status, err.message),
							});
							return "terminate";
						}
						for (const rawToolCall of rawToolCalls) {
							if (
								!isRecord(rawToolCall) ||
								(rawToolCall.function !== undefined &&
									rawToolCall.function !== null &&
									!isRecord(rawToolCall.function))
							) {
								const err = streamError(undefined, "malformed tool_calls payload");
								finalizeToolCalls();
								endTextBlock();
								endThinkingBlock();
								stream.push({
									type: "error",
									reason: "error",
									error: attachError(output, err.status, err.message),
								});
								return "terminate";
							}
							const fn = isRecord(rawToolCall.function) ? rawToolCall.function : undefined;
							const idDelta = typeof rawToolCall.id === "string" ? rawToolCall.id : "";
							const rawIndex = rawToolCall.index;
							// Fragments for one logical call are keyed by `index` (or id
							// when no index is present); continuation fragments carry
							// neither, so they join the most recent pending call. The
							// key is distinct from the wire id — matching on id alone
							// spawns a fresh call per fragment.
							const key =
								typeof rawIndex === "number"
									? `i:${rawIndex}`
									: idDelta
										? `id:${idDelta}`
										: pendingToolCalls[pendingToolCalls.length - 1]?.key;
							let call = key !== undefined ? pendingToolCalls.find(c => c.key === key) : undefined;
							if (!call && idDelta) call = pendingToolCalls.find(c => c.id === idDelta);
							if (!call) {
								const generatedId = idDelta || `call_${pendingToolCalls.length + 1}`;
								call = {
									key: key ?? `seq:${pendingToolCalls.length}`,
									id: generatedId,
									name: "",
									args: "",
									started: false,
								};
								pendingToolCalls.push(call);
							}
							if (idDelta && !call.id) call.id = idDelta;
							if (typeof fn?.name === "string" && fn.name && !call.name) {
								call.name = fn.name;
							}
							if (typeof fn?.arguments === "string" && fn.arguments) {
								if (!call.started) {
									const block: ToolCall = {
										type: "toolCall",
										id: call.id,
										name: call.name,
										arguments: {},
									};
									output.content.push(block);
									toolBlocks.set(call.id, block);
									stream.push({
										type: "toolcall_start",
										contentIndex: output.content.indexOf(block),
										partial: output,
									});
									call.started = true;
								}
								call.args += fn.arguments;
								const block = toolBlocks.get(call.id);
								stream.push({
									type: "toolcall_delta",
									contentIndex: block ? output.content.indexOf(block) : output.content.length - 1,
									delta: fn.arguments,
									partial: output,
								});
							}
						}
					}
				}

				if (finishReason) {
					finalizeToolCalls();
				}
				return "continue";
			};

			const dispatchFrame = (data: string, event: string): "continue" | "terminate" => {
				if (event === "finish") {
					finalizeToolCalls();
					endTextBlock();
					endThinkingBlock();
					applyUsage(output, pendingUsage, model);
					calculateCost(model, output.usage);
					output.duration = performance.now() - startTime;
					if (firstTokenTime) output.ttft = firstTokenTime - startTime;
					output.stopReason = computeStopReason(toolBlocks.size > 0, output);
					stream.push({ type: "done", reason: output.stopReason, message: output });
					return "terminate";
				}
				const trimmed = data.trim();
				if (trimmed === "") return "continue";
				if (trimmed === "[DONE]") {
					finalizeToolCalls();
					endTextBlock();
					endThinkingBlock();
					applyUsage(output, pendingUsage, model);
					calculateCost(model, output.usage);
					output.duration = performance.now() - startTime;
					if (firstTokenTime) output.ttft = firstTokenTime - startTime;
					output.stopReason = computeStopReason(toolBlocks.size > 0, output);
					stream.push({ type: "done", reason: output.stopReason, message: output });
					return "terminate";
				}
				let envelope: unknown;
				try {
					envelope = JSON.parse(trimmed);
				} catch {
					const err = streamError(undefined, "malformed upstream SSE data frame");
					finalizeToolCalls();
					endTextBlock();
					endThinkingBlock();
					stream.push({ type: "error", reason: "error", error: attachError(output, err.status, err.message) });
					return "terminate";
				}
				if (!isRecord(envelope)) return "continue";
				const statusCodeValue = envelope.statusCodeValue;
				if (typeof statusCodeValue === "number" && statusCodeValue !== 200) {
					const err = streamError(statusCodeValue, envelope.body);
					finalizeToolCalls();
					endTextBlock();
					endThinkingBlock();
					stream.push({ type: "error", reason: "error", error: attachError(output, err.status, err.message) });
					return "terminate";
				}

				// Two body shapes: wrapped envelope {"body": "<inner json>"} or
				// direct un-enveloped chunk (`choices` at the envelope root).
				const innerSource =
					typeof envelope.body === "string" ? envelope.body : envelope.choices !== undefined ? trimmed : undefined;
				if (innerSource === undefined) return "continue";
				if (innerSource.trim() === "[DONE]") {
					finalizeToolCalls();
					endTextBlock();
					endThinkingBlock();
					applyUsage(output, pendingUsage, model);
					calculateCost(model, output.usage);
					output.duration = performance.now() - startTime;
					if (firstTokenTime) output.ttft = firstTokenTime - startTime;
					output.stopReason = computeStopReason(toolBlocks.size > 0, output);
					stream.push({ type: "done", reason: output.stopReason, message: output });
					return "terminate";
				}
				let inner: unknown;
				try {
					inner = JSON.parse(innerSource);
				} catch {
					// Keep-alive / non-JSON envelope body — skip it.
					return "continue";
				}
				if (!isRecord(inner)) return "continue";
				return handleChunk(inner);
			};

			let buffer = "";
			let bufferEvent = "";
			let bufferData: string[] = [];
			let terminated = false;
			while (!terminated) {
				if (options?.signal?.aborted) break;
				const { done, value } = await reader.read();
				if (value && value.length > 0) {
					buffer += decoder.decode(value, { stream: true });
				}
				let nl = buffer.indexOf("\n");
				while (nl !== -1) {
					const line = buffer.slice(0, nl).replace(/\r$/, "");
					buffer = buffer.slice(nl + 1);
					if (line === "") {
						// Frame boundary.
						const data = bufferData.join("\n");
						const outcome = dispatchFrame(data, bufferEvent);
						bufferEvent = "";
						bufferData = [];
						if (outcome === "terminate") {
							terminated = true;
							break;
						}
					} else if (line.startsWith("event:")) {
						bufferEvent = line.slice(6).trim();
					} else if (line.startsWith("data:")) {
						bufferData.push(line.slice(5).trim());
					}
					nl = buffer.indexOf("\n");
				}
				if (done) break;
			}

			if (!terminated) {
				// EOF: flush any trailing partial frame.
				const trailing = buffer.trim();
				if (trailing !== "" || bufferEvent !== "" || bufferData.length > 0) {
					const data = bufferData.length > 0 ? bufferData.join("\n") : trailing;
					dispatchFrame(data, bufferEvent);
				}
			}

			// Always cancel the reader — the gateway keeps the socket open past
			// [DONE] (opencodex reference behavior); cancel to release the
			// connection instead of waiting for the upstream timeout.
			try {
				await reader.cancel();
			} catch {
				// Already closed — nothing to do.
			}

			if (!terminated) {
				// EOF without a terminal signal ([DONE] / event:finish): the
				// gateway is known to hold or drop the socket past the reply, so
				// a turn with user-facing content finalizes with what arrived;
				// an empty or thinking-only turn is a truncation and errors.
				finalizeToolCalls();
				endTextBlock();
				endThinkingBlock();
				if (output.content.length === 0 || output.content.every(b => b.type === "thinking")) {
					const message =
						output.content.length === 0
							? "qoder-cn stream ended with no output"
							: "qoder-cn stream ended with thinking-only output and no terminal signal";
					const errOutput: AssistantMessage = {
						...output,
						stopReason: "error",
						errorStatus: 502,
						errorMessage: message,
					};
					stream.push({ type: "error", reason: "error", error: errOutput });
				} else {
					applyUsage(output, pendingUsage, model);
					calculateCost(model, output.usage);
					output.duration = performance.now() - startTime;
					if (firstTokenTime) output.ttft = firstTokenTime - startTime;
					output.stopReason = computeStopReason(toolBlocks.size > 0, output);
					stream.push({ type: "done", reason: output.stopReason, message: output });
				}
			}
			stream.end();
		} catch (error) {
			logger.error("qoder-cn: stream failed", { error: String(error) });
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				signal: options?.signal,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: result.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

function safeJsonParse(raw: string): Record<string, unknown> {
	if (!raw) return {};
	try {
		const parsed = JSON.parse(raw);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function applyUsage(output: AssistantMessage, usage: PendingUsage | undefined, _model: Model<"qoder-cn">): void {
	if (!usage) return;
	output.usage.input = usage.input;
	output.usage.output = usage.output;
	output.usage.cacheRead = usage.cacheRead;
	output.usage.cacheWrite = usage.cacheWrite;
	output.usage.totalTokens = usage.totalTokens || usage.input + usage.output;
}

function computeStopReason(
	hasToolCalls: boolean,
	output: AssistantMessage,
): Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> {
	if (hasToolCalls) return "toolUse";
	if (output.stopReason === "length") return "length";
	return "stop";
}

function attachError(output: AssistantMessage, status: number, message: string): AssistantMessage {
	const next: AssistantMessage = {
		...output,
		stopReason: "error",
		errorStatus: status,
		errorMessage: message,
	};
	return next;
}

// Internal re-export used by the test surface — never a public type.
export type { BuildResult as _BuildResult };
