// Qoder credential resolution for the adapter.
//
// One credential shape reaches the adapter's apiKey slot:
//   - a Personal Access Token (`pt-...`, key login / env reference) — it cannot
//     authenticate inference directly and is exchanged for a short-lived job
//     token (jt-..., ~24h) which is cached in memory with single-flight
//     refresh.
//
// Identity (uid/name/email for the COSY payload) is resolved once per token
// via userinfo and cached with the token.
//
// CN fails closed when the userinfo response yields no uid — Qoder CN rejects
// placeholder uids with code 105 ("Login expired"), so a missing uid is
// unrecoverable and surfaces as QoderAuthError.
//
// The credential is never logged, never sent anywhere but the exchange/userinfo
// endpoints, and never persisted by this module.
//
// Protocol evidence: QODER_PROTOCOL_CURRENT.md (auth chain section).

import crypto from "node:crypto";
import type { FetchImpl } from "../types";
import { discoveryFetch } from "../utils";
import { QODER_CLIENT_TYPE, QODER_OPENAPI_COSY_VERSION, type QoderCosyCredentials } from "./cosy";
import { getQoderMachineId } from "./machine-id";
import type { QoderCnEndpoints } from "./endpoints";

/** Refresh this far ahead of the stated expiry so a long turn never starts stale. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;
/** Fallback lifetime when the exchange response carries no expiry at all. */
const DEFAULT_JOB_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface QoderResolvedCredentials extends QoderCosyCredentials {
	expiresAt: number;
}

/** Auth failures carry the upstream status so the adapter can replay once on 401. */
export class QoderAuthError extends Error {
	readonly status?: number;
	constructor(message: string, status?: number) {
		super(message);
		this.name = "QoderAuthError";
		this.status = status;
	}
}

/** A Qoder Personal Access Token must be exchanged; everything else is used directly. */
export function isQoderPersonalAccessToken(credential: string): boolean {
	return credential.startsWith("pt-");
}

interface QoderExchangeResponse {
	token?: string;
	refresh_token?: string;
	expires_at?: string;
	expires_in?: number;
}

function parseExchangeExpiry(data: QoderExchangeResponse, now: number): number {
	if (typeof data.expires_at === "string" && data.expires_at.length > 0) {
		const parsed = Date.parse(data.expires_at);
		if (!Number.isNaN(parsed)) return parsed;
	}
	// expires_in is milliseconds in the observed exchange response (86400000 = 24h).
	if (typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0) {
		return now + data.expires_in;
	}
	return now + DEFAULT_JOB_TOKEN_TTL_MS;
}

async function exchangePatForJobToken(
	pat: string,
	endpoints: QoderCnEndpoints,
	fetchFn: FetchImpl,
): Promise<{ jobToken: string; expiresAt: number }> {
	const now = Date.now();
	let res: Response;
	try {
		res = await fetchFn(endpoints.patExchangeUrl, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
				"Cosy-Version": QODER_OPENAPI_COSY_VERSION,
				"Cosy-ClientType": QODER_CLIENT_TYPE,
			},
			body: JSON.stringify({ personal_token: pat }),
		});
	} catch {
		throw new QoderAuthError("qoder PAT exchange request failed");
	}
	if (!res.ok) {
		await res.text().catch(() => "");
		throw new QoderAuthError("qoder PAT exchange rejected the credential", res.status);
	}
	let data: QoderExchangeResponse;
	try {
		data = (await res.json()) as QoderExchangeResponse;
	} catch {
		throw new QoderAuthError("qoder PAT exchange returned a malformed response");
	}
	const jobToken = typeof data.token === "string" ? data.token.trim() : "";
	if (!jobToken) throw new QoderAuthError("qoder PAT exchange returned no job token");
	return { jobToken, expiresAt: parseExchangeExpiry(data, now) };
}

interface QoderUserInfo {
	id?: string | number;
	email?: string;
	name?: string;
	username?: string;
}

interface QoderIdentity {
	userID: string;
	name: string;
	email: string;
}

/** Best-effort identity resolution; the COSY payload needs the real uid. */
async function fetchQoderIdentity(
	token: string,
	endpoints: QoderCnEndpoints,
	fetchFn: FetchImpl,
): Promise<QoderIdentity> {
	try {
		const res = await fetchFn(endpoints.userInfoUrl, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/json",
				"Cosy-Version": QODER_OPENAPI_COSY_VERSION,
				"Cosy-ClientType": QODER_CLIENT_TYPE,
			},
		});
		if (!res.ok) {
			await res.text().catch(() => "");
			return { userID: "", name: "", email: "" };
		}
		const info = (await res.json()) as QoderUserInfo;
		return {
			userID: info.id === undefined || info.id === null ? "" : String(info.id),
			name: (typeof info.name === "string" && info.name.trim()) || (info.username ?? "").trim(),
			email: (info.email ?? "").trim(),
		};
	} catch {
		return { userID: "", name: "", email: "" };
	}
}

/**
 * Module-level PAT -> job-token cache: adapters are constructed per turn, but
 * the exchanged token is per-PAT and shared by every concurrent request. One
 * in-flight exchange per (PAT, endpoint) pair; a burst of parallel turns joins
 * it instead of stampeding the exchange endpoint.
 */
const patTokenCache = new Map<string, QoderResolvedCredentials>();
const patExchangeFlights = new Map<string, Promise<QoderResolvedCredentials>>();

function patCacheKey(pat: string, endpoints: QoderCnEndpoints): string {
	return crypto
		.createHash("sha256")
		.update("qoder-pat\0")
		.update(pat)
		.update("\0")
		.update(endpoints.patExchangeUrl)
		.digest("hex");
}

async function resolvePatShared(
	pat: string,
	endpoints: QoderCnEndpoints,
	fetchFn: FetchImpl,
): Promise<QoderResolvedCredentials> {
	const key = patCacheKey(pat, endpoints);
	const cached = patTokenCache.get(key);
	if (cached && cached.expiresAt - EXPIRY_BUFFER_MS > Date.now()) return cached;
	const existing = patExchangeFlights.get(key);
	if (existing) return await existing;
	const promise = (async (): Promise<QoderResolvedCredentials> => {
		const { jobToken, expiresAt } = await exchangePatForJobToken(pat, endpoints, fetchFn);
		const identity = await fetchQoderIdentity(jobToken, endpoints, fetchFn);
		// CN rejects placeholder uids with code 105 ("Login expired"); fail closed
		// rather than let COSY sign with an empty user id.
		if (!identity.userID) {
			throw new QoderAuthError("qoder userinfo returned no uid; CN requires a real account id");
		}
		const resolved: QoderResolvedCredentials = {
			userID: identity.userID,
			authToken: jobToken,
			name: identity.name,
			email: identity.email,
			machineID: getQoderMachineId(),
			expiresAt,
		};
		patTokenCache.set(key, resolved);
		return resolved;
	})();
	patExchangeFlights.set(key, promise);
	try {
		return await promise;
	} finally {
		if (patExchangeFlights.get(key) === promise) patExchangeFlights.delete(key);
	}
}

/**
 * Per-turn credential resolver over the shared cache. An upstream 401 triggers
 * exactly one forced re-resolution per logical request (handled by the caller).
 */
export class QoderCredentialResolver {
	constructor(
		private readonly pat: string,
		private readonly endpoints: QoderCnEndpoints,
	) {}

	async resolve(fetchFn: FetchImpl = discoveryFetch()): Promise<QoderResolvedCredentials> {
		if (!isQoderPersonalAccessToken(this.pat)) {
			throw new QoderAuthError("qoder CN only accepts Personal Access tokens (pt-...)");
		}
		return await resolvePatShared(this.pat, this.endpoints, fetchFn);
	}

	/** Bypass caches after an upstream 401; shares any in-flight resolution. */
	async forceRefresh(fetchFn: FetchImpl = discoveryFetch()): Promise<QoderResolvedCredentials> {
		patTokenCache.delete(patCacheKey(this.pat, this.endpoints));
		return await this.resolve(fetchFn);
	}
}

/** Test seam: forget exchanged job tokens. */
export function resetQoderCredentialCachesForTests(): void {
	patTokenCache.clear();
	patExchangeFlights.clear();
}
