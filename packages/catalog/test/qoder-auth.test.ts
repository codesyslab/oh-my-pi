import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";
import {
	isQoderPersonalAccessToken,
	QoderAuthError,
	QoderCredentialResolver,
	resetQoderCredentialCachesForTests,
} from "@oh-my-pi/pi-catalog/qoder/auth";
import { resolveQoderCnEndpoints } from "@oh-my-pi/pi-catalog/qoder/endpoints";
import { resetQoderMachineIdForTests } from "@oh-my-pi/pi-catalog/qoder/machine-id";

const PAT = "pt-fixture-token";
const JOB_TOKEN = "jt-exchanged-token";
const USERINFO = { id: 12345, name: "Test User", email: "test@example.com" };

const ENDPOINTS = resolveQoderCnEndpoints();

type RecordedCall = { url: string; init: RequestInit };

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function makeFetch(options: {
	exchange?: (call: RecordedCall) => Response;
	userinfo?: (call: RecordedCall) => Response;
}): { fetch: FetchImpl; calls: RecordedCall[] } {
	const calls: RecordedCall[] = [];
	const fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		const record: RecordedCall = { url, init: init ?? {} };
		calls.push(record);
		if (record.url === ENDPOINTS.patExchangeUrl) {
			return options.exchange ? options.exchange(record) : jsonResponse({ token: JOB_TOKEN });
		}
		if (record.url === ENDPOINTS.userInfoUrl) {
			return options.userinfo ? options.userinfo(record) : jsonResponse(USERINFO);
		}
		return jsonResponse({ message: "unexpected url" }, 404);
	}) as FetchImpl;
	return { fetch, calls };
}

beforeEach(() => {
	resetQoderCredentialCachesForTests();
	resetQoderMachineIdForTests();
});

afterEach(() => {
	resetQoderCredentialCachesForTests();
	resetQoderMachineIdForTests();
});

describe("isQoderPersonalAccessToken", () => {
	it("matches the pt- prefix and rejects everything else", () => {
		expect(isQoderPersonalAccessToken("pt-...")).toBe(true);
		expect(isQoderPersonalAccessToken("sk-...")).toBe(false);
		expect(isQoderPersonalAccessToken("")).toBe(false);
	});
});

describe("QoderCredentialResolver", () => {
	it("exchanges the PAT, resolves identity via userinfo, and pins expiresAt from expires_in (ms)", async () => {
		const { fetch, calls } = makeFetch({});
		const resolver = new QoderCredentialResolver(PAT, ENDPOINTS);
		const resolved = await resolver.resolve(fetch);
		expect(calls.map(call => call.url)).toEqual([ENDPOINTS.patExchangeUrl, ENDPOINTS.userInfoUrl]);
		expect(resolved.userID).toBe(String(USERINFO.id));
		expect(resolved.name).toBe(USERINFO.name);
		expect(resolved.email).toBe(USERINFO.email);
		// expires_in defaults to ms (86400000 = 24h) — resolvedAt is roughly `now + 24h`.
		const delta = resolved.expiresAt - Date.now();
		expect(delta).toBeGreaterThan(23.9 * 60 * 60 * 1000);
		expect(delta).toBeLessThan(24.1 * 60 * 60 * 1000);
		// PAT never travels on userinfo.
		expect(calls[1]?.init.headers).toMatchObject({ Authorization: `Bearer ${JOB_TOKEN}` });
	});

	it("prefers expires_at (ISO timestamp) when present, falling back to expires_in (ms)", async () => {
		const fixedExpiry = Date.now() + 60_000;
		const { fetch } = makeFetch({
			exchange: () => jsonResponse({ token: JOB_TOKEN, expires_at: new Date(fixedExpiry).toISOString() }),
		});
		const resolver = new QoderCredentialResolver(PAT, ENDPOINTS);
		const resolved = await resolver.resolve(fetch);
		expect(Math.abs(resolved.expiresAt - fixedExpiry)).toBeLessThan(5);
	});

	it("falls back to a 24h TTL when both expires_at and expires_in are missing", async () => {
		const { fetch } = makeFetch({ exchange: () => jsonResponse({ token: JOB_TOKEN }) });
		const resolver = new QoderCredentialResolver(PAT, ENDPOINTS);
		const resolved = await resolver.resolve(fetch);
		const delta = resolved.expiresAt - Date.now();
		expect(delta).toBeGreaterThan(23.9 * 60 * 60 * 1000);
		expect(delta).toBeLessThan(24.1 * 60 * 60 * 1000);
	});

	it("surfaces exchange 401 as QoderAuthError with the upstream status", async () => {
		const { fetch } = makeFetch({
			exchange: () => jsonResponse({ message: "invalid" }, 401),
		});
		const resolver = new QoderCredentialResolver(PAT, ENDPOINTS);
		try {
			await resolver.resolve(fetch);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(QoderAuthError);
			expect((err as QoderAuthError).status).toBe(401);
		}
	});

	it("fails closed when userinfo yields no uid (CN rejects placeholder uid with code 105)", async () => {
		const { fetch } = makeFetch({ userinfo: () => jsonResponse({ email: "test@example.com" }) });
		const resolver = new QoderCredentialResolver(PAT, ENDPOINTS);
		try {
			await resolver.resolve(fetch);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(QoderAuthError);
			expect((err as Error).message).toMatch(/userinfo returned no uid/);
		}
	});

	it("rejects non-PAT credentials without making a network call", async () => {
		const calls: RecordedCall[] = [];
		const fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			calls.push({ url, init: {} });
			return jsonResponse({});
		}) as FetchImpl;
		const resolver = new QoderCredentialResolver("sk-not-a-pat", ENDPOINTS);
		try {
			await resolver.resolve(fetch);
			throw new Error("expected throw");
		} catch (err) {
			expect(err).toBeInstanceOf(QoderAuthError);
		}
		expect(calls.length).toBe(0);
	});

	it("shares a single in-flight exchange across concurrent resolves for the same PAT", async () => {
		let exchangeCalls = 0;
		const fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === ENDPOINTS.patExchangeUrl) {
				exchangeCalls++;
				await new Promise(resolve => setTimeout(resolve, 5));
				return jsonResponse({ token: JOB_TOKEN });
			}
			if (url === ENDPOINTS.userInfoUrl) {
				return jsonResponse(USERINFO);
			}
			return jsonResponse({}, 404);
		}) as FetchImpl;
		const resolver = new QoderCredentialResolver(PAT, ENDPOINTS);
		const results = await Promise.all([resolver.resolve(fetch), resolver.resolve(fetch), resolver.resolve(fetch)]);
		expect(exchangeCalls).toBe(1);
		expect(results[0]?.userID).toBe(String(USERINFO.id));
		expect(results[2]?.userID).toBe(String(USERINFO.id));
	});

	it("reuses the cached resolved credentials until the expiry buffer window passes", async () => {
		let exchangeCalls = 0;
		const fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === ENDPOINTS.patExchangeUrl) {
				exchangeCalls++;
				return jsonResponse({ token: JOB_TOKEN });
			}
			if (url === ENDPOINTS.userInfoUrl) {
				return jsonResponse(USERINFO);
			}
			return jsonResponse({}, 404);
		}) as FetchImpl;
		const resolver = new QoderCredentialResolver(PAT, ENDPOINTS);
		await resolver.resolve(fetch);
		await resolver.resolve(fetch);
		await resolver.resolve(fetch);
		expect(exchangeCalls).toBe(1);
	});

	it("forceRefresh invalidates the cache so the next resolve re-exchanges", async () => {
		let exchangeCalls = 0;
		const fetch = (async (input: string | URL | Request): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			if (url === ENDPOINTS.patExchangeUrl) {
				exchangeCalls++;
				return jsonResponse({ token: JOB_TOKEN });
			}
			if (url === ENDPOINTS.userInfoUrl) {
				return jsonResponse(USERINFO);
			}
			return jsonResponse({}, 404);
		}) as FetchImpl;
		const resolver = new QoderCredentialResolver(PAT, ENDPOINTS);
		await resolver.resolve(fetch);
		await resolver.forceRefresh(fetch);
		expect(exchangeCalls).toBe(2);
	});
});

describe("getQoderMachineId", () => {
	it("persists a generated id under the omp config dir when ~/.qoder/.auth/machine_id is absent", async () => {
		resetQoderMachineIdForTests();
		// Use a temp HOME to avoid touching the user's real ~/.qoder/.auth or ~/.omp.
		const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-cn-test-"));
		const previousHome = process.env.HOME;
		process.env.HOME = tempHome;
		try {
			const { getQoderMachineId } = await import("@oh-my-pi/pi-catalog/qoder/machine-id");
			const id = getQoderMachineId();
			expect(id).toMatch(/^[0-9a-f-]{36}$/);
			const persisted = await fs.readFile(path.join(tempHome, ".omp", "qoder-machine-id"), "utf8");
			expect(persisted).toBe(id);
			// Second call returns the cached value without re-persisting.
			expect(getQoderMachineId()).toBe(id);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await fs.rm(tempHome, { recursive: true, force: true });
			resetQoderMachineIdForTests();
		}
	});

	it("reuses an existing ~/.qoder/.auth/machine_id when present", async () => {
		resetQoderMachineIdForTests();
		const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "qoder-cn-test-"));
		const previousHome = process.env.HOME;
		process.env.HOME = tempHome;
		try {
			const cliId = "11111111-2222-3333-4444-555555555555";
			await fs.mkdir(path.join(tempHome, ".qoder", ".auth"), { recursive: true });
			await fs.writeFile(path.join(tempHome, ".qoder", ".auth", "machine_id"), cliId);
			const { getQoderMachineId } = await import("@oh-my-pi/pi-catalog/qoder/machine-id");
			expect(getQoderMachineId()).toBe(cliId);
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			await fs.rm(tempHome, { recursive: true, force: true });
			resetQoderMachineIdForTests();
		}
	});
});
