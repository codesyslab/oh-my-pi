// Qoder COSY request signing and the gateway body codec.
//
// Pure-software implementation of the signing scheme the Qoder CLI gateway
// expects (no WASM, no Qoder CLI). Protocol evidence: QODER_PROTOCOL_CURRENT.md.
// Structure follows the MIT-licensed reference `pi-provider-qoder` (src/cosy.ts,
// src/protocol/encoding.ts); the signing scheme itself was independently
// confirmed by the qoder-cpa (Go) and cpa-plugin (Python) implementations.
//
// node:crypto is required here on purpose: COSY needs RSA PKCS#1 v1.5 public
// encryption and AES-128-CBC, neither of which WebCrypto exposes. This module
// owns that compatibility role for the Qoder adapter.

import crypto from "node:crypto";

const QODER_RSA_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * COSY client identity sent to the gateway. A stale gateway version makes
 * /model/list return a reduced catalog, so keep this aligned with the current
 * Qoder CLI catalog protocol. The OpenAPI (PAT exchange/userinfo) surface uses
 * QODER_OPENAPI_COSY_VERSION instead.
 */
export const QODER_GATEWAY_COSY_VERSION = "1.1.38";
export const QODER_OPENAPI_COSY_VERSION = "1.0.1";
export const QODER_CLIENT_TYPE = "5";

const QODER_DATA_POLICY = "disagree";
const QODER_LOGIN_VERSION = "v2";
const QODER_MACHINE_TYPE = "5";
const QODER_MACHINE_OS =
	process.platform === "win32"
		? process.arch === "arm64"
			? "aarch64_windows"
			: "x86_64_windows"
		: process.arch === "arm64"
			? "aarch64_linux"
			: "x86_64_linux";

export interface QoderCosyCredentials {
	userID: string;
	/** Short-lived job token (jt-...). Never logged. */
	authToken: string;
	name: string;
	email: string;
	machineID: string;
}

function rsaEncryptBase64(data: string): string {
	const encrypted = crypto.publicEncrypt(
		{ key: QODER_RSA_PUBLIC_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
		Buffer.from(data, "utf8"),
	);
	return encrypted.toString("base64");
}

function aesEncryptCbcBase64(plaintext: string, keyStr: string): string {
	const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(keyStr, "utf8"), Buffer.from(keyStr, "utf8"));
	return cipher.update(plaintext, "utf8", "base64") + cipher.final("base64");
}

function md5Hex(data: string | Buffer): string {
	return crypto.createHash("md5").update(data).digest("hex");
}

/**
 * COSY signs the URL pathname without the gateway `/algo` prefix and without
 * the query string (e.g. /algo/api/v2/service/... -> /api/v2/service/...).
 */
export function qoderCosySigPath(requestURL: string): string {
	const pathname = new URL(requestURL).pathname;
	// Anchor on the path segment: `/algofoo` must not be stripped to `foo`.
	return pathname.startsWith("/algo/") ? pathname.slice("/algo".length) : pathname;
}

/**
 * Build the COSY auth header set for one signed gateway request. `body` must be
 * the exact bytes sent on the wire (the encoded body for inference, empty for a
 * signed GET). Every call draws fresh randomness (AES key, request ids), so the
 * headers are single-use and concurrency-safe by construction.
 */
export function buildQoderCosyHeaders(
	body: string | null,
	requestURL: string,
	creds: QoderCosyCredentials,
): Record<string, string> {
	if (!creds.userID) throw new Error("qoder cosy: user id is empty");
	if (!creds.authToken) throw new Error("qoder cosy: auth token is empty");

	const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
	const infoB64 = aesEncryptCbcBase64(
		JSON.stringify({
			uid: creds.userID,
			security_oauth_token: creds.authToken,
			name: creds.name || "",
			aid: "",
			email: creds.email || "",
		}),
		aesKey,
	);
	const cosyKey = rsaEncryptBase64(aesKey);

	const timestamp = Math.floor(Date.now() / 1000).toString();
	const payloadB64 = Buffer.from(
		JSON.stringify({
			version: "v1",
			requestId: crypto.randomUUID(),
			info: infoB64,
			cosyVersion: QODER_GATEWAY_COSY_VERSION,
			ideVersion: "",
		}),
	).toString("base64");

	const sigPath = qoderCosySigPath(requestURL);
	const bodyStr = body ?? "";
	const signature = md5Hex(`${payloadB64}\n${cosyKey}\n${timestamp}\n${bodyStr}\n${sigPath}`);

	return {
		Authorization: `Bearer COSY.${payloadB64}.${signature}`,
		"Cosy-Key": cosyKey,
		"Cosy-User": creds.userID,
		"Cosy-Date": timestamp,
		"Cosy-Version": QODER_GATEWAY_COSY_VERSION,
		"Cosy-Machineid": creds.machineID,
		"Cosy-Machinetoken": creds.machineID,
		"Cosy-Machinetype": QODER_MACHINE_TYPE,
		"Cosy-Machineos": QODER_MACHINE_OS,
		"Cosy-Clienttype": QODER_CLIENT_TYPE,
		"Cosy-Clientip": "127.0.0.1",
		"Cosy-Bodyhash": md5Hex(bodyStr),
		"Cosy-Bodylength": Buffer.byteLength(bodyStr).toString(),
		"Cosy-Sigpath": sigPath,
		"Cosy-Data-Policy": QODER_DATA_POLICY,
		"Login-Version": QODER_LOGIN_VERSION,
		"X-Request-Id": crypto.randomUUID(),
	};
}

const QODER_CUSTOM_ALPHABET = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const QODER_STD_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/**
 * The Qoder gateway request-body codec ("qoder-waf"): standard padded base64,
 * map into the custom alphabet with `=` -> `$`, then swap the outer thirds
 * (k = floor(len/3); C || B || A). Deterministic and reversible — an encoding,
 * not encryption. Only request bodies use it; responses are plaintext SSE.
 */
export function qoderEncodeBody(plaintext: string): string {
	const std = Buffer.from(plaintext, "utf8").toString("base64");
	const n = std.length;
	const third = Math.floor(n / 3);
	const rearranged = std.slice(n - third) + std.slice(third, n - third) + std.slice(0, third);
	let out = "";
	for (let i = 0; i < n; i++) {
		const c = rearranged[i];
		if (c === undefined) continue;
		if (c === "=") {
			out += "$";
			continue;
		}
		const idx = QODER_STD_ALPHABET.indexOf(c);
		out += idx >= 0 ? QODER_CUSTOM_ALPHABET[idx] : c;
	}
	return out;
}

/** Inverse of qoderEncodeBody. Used by tests and conformance tooling. */
export function qoderDecodeBody(encoded: string): string {
	const n = encoded.length;
	const third = Math.floor(n / 3);
	const swapped = encoded.slice(n - third) + encoded.slice(third, n - third) + encoded.slice(0, third);
	let std = "";
	for (let i = 0; i < n; i++) {
		const c = swapped[i];
		if (c === undefined) continue;
		if (c === "$") {
			std += "=";
			continue;
		}
		const idx = QODER_CUSTOM_ALPHABET.indexOf(c);
		std += idx >= 0 ? QODER_STD_ALPHABET[idx] : c;
	}
	return Buffer.from(std, "base64").toString("utf8");
}
