// Qoder CN live discovery: PAT -> job token -> signed /model/list -> ModelSpec[].
//
// Identity is the canonical vendor id (deepseek-v4-pro, kimi-k2.7-code, ...);
// the Qoder wire key (dmodel, kmodel, ...) is transport-only and surfaces as
// `requestModelId`. Tier routers (`auto`, `ultimate`, ...) and unknown vendor
// keys are excluded by routing policy.
//
// Vendor-verified capabilities (context window, vision, effort ladder,
// reasoning control) come from the KDL overlay
// (`compat/rules/providers/qoder-cn.kdl`) via `buildModel`; the discovery
// layer only owns identity, wire key, and availability. Return null on any
// discovery failure so the static seed survives.

import { logger } from "@oh-my-pi/pi-utils";
import { isExcludedModel } from "../compat/behavior";
import { THINKING_EFFORTS, type Effort } from "../effort";
import type { FetchImpl, ModelSpec, QoderCnThinkingControl } from "../types";
import { discoveryFetch } from "../utils";
import { resolveQoderCnEndpoints, type QoderCnEndpoints } from "../qoder/endpoints";
import { QoderCredentialResolver } from "../qoder/auth";
import { type QoderModelEntry, fetchQoderCnModelEntries, parseQoderModelList } from "../qoder/models";
import { QODER_CN_STATIC_MODELS, qoderCnSeedSpec, type QoderCnStaticModel } from "../provider-models/special";

const EFFORT_VALUES: ReadonlySet<string> = new Set(THINKING_EFFORTS);

/**
 * Qoder CN identity table: canonical vendor id (operator-facing) <->
 * wire key (transport-only) <- display name. Vendor-verified rows in the
 * static seed cover the full live roster (verified live 2026-09-06); tier
 * routers (`auto`, `ultimate`, `performance`, ...) are deliberately excluded
 * by routing policy. Unknown wire keys (Qoder introduces one) stay keyed on
 * their wire key with the gateway-reported display name; no capabilities are
 * invented for them — the KDL overlay only applies to verified ids.
 */
export interface QoderCnIdentity {
	operatorId: string;
	wireKey: string;
	displayName: string;
}

const QODER_CN_IDENTITY: ReadonlyMap<string, QoderCnIdentity> = new Map(
	QODER_CN_STATIC_MODELS.map((model: QoderCnStaticModel) => [
		model.wireKey,
		{ operatorId: model.id, wireKey: model.wireKey, displayName: model.displayName },
	]),
);

function resolveIdentity(entry: QoderModelEntry): QoderCnIdentity {
	const rawKey = entry.key;
	if (typeof rawKey !== "string") {
		throw new Error("qoder CN discovery entry missing required `key` field");
	}
	const wireKey = rawKey.trim();
	const known = QODER_CN_IDENTITY.get(wireKey);
	if (known) return known;
	return {
		operatorId: wireKey,
		wireKey,
		displayName: (entry.display_name ?? wireKey).trim() || wireKey,
	};
}

/**
 * Reasoning control for an UNKNOWN wire key, derived from the gateway's
 * advertised thinking_config. Only unknown entries use the advertisement as
 * their source; known vendor models take the rule-owned control kind from the
 * static row / KDL overlay because Qoder's self-report is unreliable.
 */
function deriveAdvertisedThinkingControl(entry: QoderModelEntry, reasoning: boolean): QoderCnThinkingControl {
	if (!reasoning) return "none";
	if (advertisedEfforts(entry).length > 0) return "efforts";
	if (entry.thinking_config?.enabled !== undefined) return "toggle";
	return "always";
}

/** Advertised wire effort ladder, filtered to pi effort vocabulary. */
function advertisedEfforts(entry: QoderModelEntry): Effort[] {
	return Object.keys(entry.thinking_config?.enabled?.efforts ?? {}).filter((name): name is Effort =>
		EFFORT_VALUES.has(name),
	);
}

function buildQoderCnSpec(
	entry: QoderModelEntry,
	identity: QoderCnIdentity,
	endpoints: QoderCnEndpoints,
): ModelSpec<"qoder-cn"> {
	// Known vendor models resolve from the vendor-verified static row — the
	// same builder the seed uses — so a live rediscovery can never downgrade a
	// verified capability to Qoder's self-report (stale 180K input floor,
	// phantom vision flags, hallucinated ladders). Live discovery owns only
	// availability (disabled entries never reach this function).
	const verified = QODER_CN_STATIC_MODELS.find(model => model.wireKey === identity.wireKey);
	if (verified) return qoderCnSeedSpec(verified, endpoints.gatewayBaseUrl);

	// Unknown wire key (Qoder introduced a model the static roster predates):
	// map the upstream fields as reported, conservatively. The thinking ladder
	// is set explicitly from the advertisement so the thinking deriver cannot
	// fabricate a generic ladder the gateway never offered.
	const reasoning = entry.is_reasoning === true || entry.thinking_config?.enabled !== undefined;
	const thinkingControl = deriveAdvertisedThinkingControl(entry, reasoning);
	const advertisedContext = Object.values(entry.context_config ?? {})
		.map(option => (typeof option?.token_count === "number" ? option.token_count : 0))
		.filter(count => count > 0)
		.sort((a, b) => a - b);
	const wireEfforts = advertisedEfforts(entry);
	const spec: ModelSpec<"qoder-cn"> = {
		id: identity.operatorId,
		requestModelId: identity.wireKey,
		name: identity.displayName,
		api: "qoder-cn",
		provider: "qoder-cn",
		baseUrl: endpoints.gatewayBaseUrl,
		reasoning,
		input: entry.is_vl === true ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: advertisedContext[advertisedContext.length - 1] ?? null,
		maxTokens: null,
		supportsTools: true,
		headers: {
			"X-Model-Key": identity.wireKey,
			"X-Model-Source": typeof entry.source === "string" && entry.source ? entry.source : "system",
		},
		compat: { thinkingControl },
		...(thinkingControl === "efforts" && wireEfforts.length > 0
			? { thinking: { mode: "effort" as const, efforts: wireEfforts } }
			: {}),
	};
	return spec;
}

export interface QoderCnDiscoveryOptions {
	apiKey: string;
	baseUrl?: string;
	fetch?: FetchImpl;
	/** Optional endpoint overrides for tests (gateway/OpenAPI hosts). */
	endpoints?: {
		gatewayBaseUrl?: string;
		openApiBaseUrl?: string;
	};
}

/**
 * Fetch Qoder CN's live model list, resolve PAT credentials, filter tier
 * routers and disabled entries, and emit ModelSpec rows for the catalog.
 *
 * Returns `null` on credential/exchange failure or when the live list is
 * empty — the static seed must remain visible. The list is intentionally
 * sorted by operator id so the merged catalog is deterministic.
 */
export async function fetchQoderCnModels(options: QoderCnDiscoveryOptions): Promise<ModelSpec<"qoder-cn">[] | null> {
	const endpoints = options.endpoints ? resolveQoderCnEndpoints(options.endpoints) : resolveQoderCnEndpoints();
	const fetchFn = options.fetch ?? discoveryFetch();
	const resolver = new QoderCredentialResolver(options.apiKey, endpoints);
	let creds;
	try {
		creds = await resolver.resolve(fetchFn);
	} catch (err) {
		logger.warn("qoder CN credential resolution failed", {
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
	const entries = await fetchQoderCnModelEntries(creds, endpoints, fetchFn);
	if (entries.length === 0) return null;
	const parsed = parseQoderModelList({ chat: entries });
	if (parsed.length === 0) return null;
	const specs = parsed
		.map(model => buildQoderCnSpec(model.entry, resolveIdentity(model.entry), endpoints))
		// Tier routers and other non-chat SKUs are rule-owned exclusions
		// (`exclude-models` in runtime/behavior.kdl), matching how every other
		// discovery mapper filters its roster.
		.filter(spec => !isExcludedModel("qoder-cn", spec.id))
		.sort((a, b) => a.id.localeCompare(b.id));
	return specs;
}
