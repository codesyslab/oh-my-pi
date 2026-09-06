// Qoder live model discovery and capability normalization.
//
// The catalog is INTERNAL to this provider: it validates routing targets and
// supplies per-model wire metadata (context options, vision, effort ladders).
// It never feeds the Codex-facing model catalog. Source priority:
//   fresh live list -> stale live list (transient discovery failure) -> static
//   emergency fallback table below.
//
// Vendor-verified capability overlays (the "true" context window, the
// thinking-effort ladder, vision truth) live in the KDL rule tree
// (`packages/catalog/src/compat/rules/providers/qoder-cn.kdl`); the discovery
// path here is responsible only for keys/availability/wire acceptance.
//
// Protocol evidence: QODER_PROTOCOL_CURRENT.md (model catalog section).

import { logger } from "@oh-my-pi/pi-utils";
import type { FetchImpl } from "../types";
import { discoveryFetch } from "../utils";
import { buildQoderCosyHeaders, type QoderCosyCredentials } from "./cosy";
import type { QoderCnEndpoints } from "./endpoints";

/** Raw entry shape returned by the gateway /model/list endpoint. */
export interface QoderModelEntry {
	key?: string;
	enable?: boolean;
	display_name?: string;
	max_input_tokens?: number;
	context_config?: Record<string, { token_count?: number; is_default?: boolean }>;
	is_vl?: boolean;
	is_reasoning?: boolean;
	thinking_config?: {
		disabled?: unknown;
		enabled?: { efforts?: Record<string, { is_default?: boolean }>; is_default?: boolean };
	};
	source?: string;
}

/** Normalized per-model capability used for target eligibility and request building. */
export interface QoderModelCapability {
	/** Qoder wire key — transport-only (X-Model-Key / model_config.key). */
	key: string;
	displayName: string;
	/**
	 * Wire-selectable context options. The KDL overlay is consulted at
	 * `buildModel` time for the vendor-verified ceiling; the values emitted
	 * here are the advertised options, capped at the verified window.
	 */
	contextOptions: number[];
	/** Largest advertised context option; falls back to `QODER_DEFAULT_CONTEXT_WINDOW`. */
	contextWindow: number;
	available: boolean;
}

/** Qoder catalog row pairing the raw entry with its normalized capability. */
export interface QoderCatalogModel {
	capability: QoderModelCapability;
	/** Raw entry, echoed back as `model_config` on inference requests. */
	entry: QoderModelEntry;
}

/**
 * Maximum output tokens sent per request. The Qoder catalog exposes no
 * per-model output cap; the documented upstream ceiling is 131072 (see the
 * reference catalog notes). An explicit caller max_output_tokens still wins.
 */
export const QODER_MAX_OUTPUT_TOKENS = 131072;

/**
 * Fallback context when the catalog omits context_config. `max_input_tokens`
 * ships as a stale 180K floor even on models that accept 1M-token prompts, so
 * it is never used as the window — the overlay in providers/qoder-cn.kdl is.
 */
export const QODER_DEFAULT_CONTEXT_WINDOW = 1_000_000;

/**
 * Pin the largest advertised context option that does not exceed the
 * vendor-verified window (Qoder-advertised options are untrusted — e.g. a 1M
 * option on a 204,800-token model).
 */
export function qoderModelConfigForRequest(entry: QoderModelEntry, capability?: QoderModelCapability): QoderModelEntry {
	const contextConfig = entry.context_config;
	if (!contextConfig || typeof contextConfig !== "object") return entry;
	const cap = capability?.contextWindow;
	let maxTokenCount = 0;
	for (const option of Object.values(contextConfig)) {
		if (
			typeof option?.token_count === "number" &&
			option.token_count > maxTokenCount &&
			(cap === undefined || option.token_count <= cap)
		) {
			maxTokenCount = option.token_count;
		}
	}
	if (maxTokenCount <= 0) return entry;
	return {
		...entry,
		context_config: Object.fromEntries(
			Object.entries(contextConfig).map(([name, option]) => [
				name,
				{ ...option, is_default: option?.token_count === maxTokenCount },
			]),
		),
	};
}

export function normalizeQoderModelEntry(entry: QoderModelEntry): QoderModelCapability | null {
	const key = typeof entry.key === "string" ? entry.key.trim() : "";
	if (!key) return null;
	if (entry.enable === false) return null;
	const displayName = (entry.display_name ?? key).trim() || key;
	const advertisedContext = Object.values(entry.context_config ?? {})
		.map(option => (typeof option?.token_count === "number" ? option.token_count : 0))
		.filter(count => count > 0)
		.sort((a, b) => a - b);
	return {
		key,
		displayName,
		contextOptions: advertisedContext,
		contextWindow: advertisedContext[advertisedContext.length - 1] ?? QODER_DEFAULT_CONTEXT_WINDOW,
		available: true,
	};
}

export function parseQoderModelList(payload: unknown): QoderCatalogModel[] {
	const chat = (payload as { chat?: unknown } | null)?.chat;
	if (!Array.isArray(chat)) return [];
	const models: QoderCatalogModel[] = [];
	for (const raw of chat) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as QoderModelEntry;
		const capability = normalizeQoderModelEntry(entry);
		if (!capability || !capability.available) continue;
		models.push({ capability, entry });
	}
	return models;
}

/**
 * Fetch raw catalog entries from the gateway using COSY-signed GET. Returns
 * the parsed raw entries on success, throws QoderAuthError on 401 (the caller
 * is expected to retry once with a fresh credential), null on any other
 * failure.
 */
export async function fetchQoderCnModelEntries(
	creds: QoderCosyCredentials,
	endpoints?: QoderCnEndpoints,
	fetchFn: FetchImpl = discoveryFetch(),
): Promise<QoderModelEntry[]> {
	const target = endpoints?.modelListUrl;
	if (!target) return [];
	try {
		const headers = buildQoderCosyHeaders(null, target, creds);
		const res = await fetchFn(target, {
			headers: { Accept: "application/json", ...headers },
		});
		if (!res.ok) {
			await res.text().catch(() => "");
			logger.warn("qoder CN model list request rejected", { status: res.status });
			return [];
		}
		const models = parseQoderModelList(await res.json());
		return models.map(model => model.entry);
	} catch (err) {
		logger.warn("qoder CN model list fetch failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}
}
