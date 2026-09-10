/**
 * End-to-end verification for `MCPManager.discoverAndConnect` honoring the
 * process-scoped `OMP_MCP_SERVER_ALLOWLIST` env value (or an explicit
 * `options.mcpServerAllowlist` override).
 *
 * Acceptance: excluded servers must not reach `connectServers` so they
 * never start. The test injects a fake `loadConfigs` and a spy on
 * `connectServers` to observe what actually gets connected.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { LoadMCPConfigsOptions, LoadMCPConfigsResult } from "@oh-my-pi/pi-coding-agent/mcp/config";
import type { MCPServerConfig } from "@oh-my-pi/pi-coding-agent/mcp/types";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";

const SOURCE: SourceMeta = {
	provider: "test",
	providerName: "Test",
	path: "/tmp/mcp.json",
	level: "user",
};

function buildConfigs(names: string[]): {
	configs: Record<string, MCPServerConfig>;
	sources: Record<string, SourceMeta>;
} {
	const configs: Record<string, MCPServerConfig> = {};
	const sources: Record<string, SourceMeta> = {};
	for (const name of names) {
		configs[name] = { type: "stdio", command: name };
		sources[name] = SOURCE;
	}
	return { configs, sources };
}

describe("MCPManager process-scoped server allowlist (OMP_MCP_SERVER_ALLOWLIST)", () => {
	const ORIGINAL_ENV = process.env.OMP_MCP_SERVER_ALLOWLIST;
	let manager: MCPManager;

	beforeEach(() => {
		// Force a fresh manager per test so cached state doesn't leak.
		MCPManager.resetForTests();
		manager = new MCPManager(process.cwd());
	});

	afterEach(() => {
		if (ORIGINAL_ENV === undefined) {
			delete process.env.OMP_MCP_SERVER_ALLOWLIST;
		} else {
			process.env.OMP_MCP_SERVER_ALLOWLIST = ORIGINAL_ENV;
		}
		MCPManager.resetForTests();
		vi.restoreAllMocks();
	});

	function stubLoader(loaded: { configs: Record<string, MCPServerConfig>; sources: Record<string, SourceMeta> }) {
		// Mirror the post-load contract: the loader receives the manager's
		// `mcpServerAllowlist` (parsed from env or `options`) so it can drop
		// configs before they ever reach `connectServers`.
		const loadConfigs = vi.fn(
			async (_cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> => {
				if (options?.mcpServerAllowlist === undefined) {
					return { configs: loaded.configs, exaApiKeys: [], sources: loaded.sources };
				}
				const { filterMCPServersByAllowlist } = await import("@oh-my-pi/pi-coding-agent/mcp/config");
				const filtered = filterMCPServersByAllowlist(loaded.configs, loaded.sources, options.mcpServerAllowlist);
				return { configs: filtered.configs, exaApiKeys: [], sources: filtered.sources };
			},
		);
		(manager as unknown as { loadConfigs: typeof loadConfigs }).loadConfigs = loadConfigs;
		return loadConfigs;
	}

	it("preserves every loaded server when OMP_MCP_SERVER_ALLOWLIST is unset", async () => {
		delete process.env.OMP_MCP_SERVER_ALLOWLIST;
		const loaded = buildConfigs(["exa", "github", "git"]);
		const loader = stubLoader(loaded);
		const connectSpy = vi
			.spyOn(manager, "connectServers")
			.mockResolvedValue({ tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] });

		await manager.discoverAndConnect();

		expect(loader).toHaveBeenCalledTimes(1);
		const passed = connectSpy.mock.calls[0]?.[0] as Record<string, MCPServerConfig> | undefined;
		expect(Object.keys(passed ?? {}).sort()).toEqual(["exa", "git", "github"]);
	});

	it("passes the env-parsed allowlist into the loader", async () => {
		process.env.OMP_MCP_SERVER_ALLOWLIST = "exa,github";
		const loaded = buildConfigs(["exa", "github", "git"]);
		const loader = stubLoader(loaded);
		const connectSpy = vi
			.spyOn(manager, "connectServers")
			.mockResolvedValue({ tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] });

		await manager.discoverAndConnect();

		const callOptions = loader.mock.calls[0]?.[1];
		expect(callOptions?.mcpServerAllowlist).toEqual(["exa", "github"]);
		const passed = connectSpy.mock.calls[0]?.[0] as Record<string, MCPServerConfig> | undefined;
		// git never reaches the connect step — it was filtered out at load.
		expect(Object.keys(passed ?? {}).sort()).toEqual(["exa", "github"]);
	});

	it("'none' sentinel drops every server before connect", async () => {
		process.env.OMP_MCP_SERVER_ALLOWLIST = "none";
		const loaded = buildConfigs(["exa", "github"]);
		const loader = stubLoader(loaded);
		const connectSpy = vi
			.spyOn(manager, "connectServers")
			.mockResolvedValue({ tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] });

		await manager.discoverAndConnect();

		const callOptions = loader.mock.calls[0]?.[1];
		expect(callOptions?.mcpServerAllowlist).toEqual([]);
		const passed = connectSpy.mock.calls[0]?.[0] as Record<string, MCPServerConfig> | undefined;
		expect(passed).toEqual({});
	});

	it("'*' preserves every server (no narrowing)", async () => {
		process.env.OMP_MCP_SERVER_ALLOWLIST = "*";
		const loaded = buildConfigs(["exa", "github"]);
		const loader = stubLoader(loaded);
		const connectSpy = vi
			.spyOn(manager, "connectServers")
			.mockResolvedValue({ tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] });

		await manager.discoverAndConnect();

		// '*' is normalized to `undefined` at the parser, so the loader
		// sees no allowlist and the manager connects everything.
		expect(loader.mock.calls[0]?.[1]?.mcpServerAllowlist).toBeUndefined();
		const passed = connectSpy.mock.calls[0]?.[0] as Record<string, MCPServerConfig> | undefined;
		expect(Object.keys(passed ?? {}).sort()).toEqual(["exa", "github"]);
	});

	it("explicit options.mcpServerAllowlist supersedes the env value", async () => {
		// Operator-pinned config (e.g. a test harness or embedded entrypoint)
		// must take precedence over the env, so a stray env value cannot
		// silently widen a locked-down manager.
		process.env.OMP_MCP_SERVER_ALLOWLIST = "github";
		const loaded = buildConfigs(["exa", "github", "git"]);
		const loader = stubLoader(loaded);
		const connectSpy = vi
			.spyOn(manager, "connectServers")
			.mockResolvedValue({ tools: [], errors: new Map<string, string>(), connectedServers: [], exaApiKeys: [] });

		await manager.discoverAndConnect({ mcpServerAllowlist: ["exa"] });

		expect(loader.mock.calls[0]?.[1]?.mcpServerAllowlist).toEqual(["exa"]);
		const passed = connectSpy.mock.calls[0]?.[0] as Record<string, MCPServerConfig> | undefined;
		expect(Object.keys(passed ?? {})).toEqual(["exa"]);
	});

	it("reconnect via reconcileBrowserFilter re-applies the env allowlist (no excluded browser servers reconnect)", async () => {
		// Bug #3 (reviewer-found regression): `#applyBrowserFilter` reloaded
		// configs without forwarding `OMP_MCP_SERVER_ALLOWLIST`. A Paseo
		// worker whose only declaration was the env value would silently
		// reconnect excluded browser servers on the next `browser.enabled`
		// toggle. The fix: `discoverAndConnect` resolves the effective
		// allowlist (env or options) once and stores it on `#discoverOptions`,
		// and `#applyBrowserFilter` reads it back when reloading configs.
		process.env.OMP_MCP_SERVER_ALLOWLIST = "exa";
		// First discover: parent has `exa`, `github`, and `git` available;
		// only `exa` survives the env allowlist.
		const initialLoaded = buildConfigs(["exa", "github", "git"]);
		const loader = vi.fn(async (_cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> => {
			if (options?.mcpServerAllowlist === undefined) {
				return { configs: initialLoaded.configs, exaApiKeys: [], sources: initialLoaded.sources };
			}
			const { filterMCPServersByAllowlist } = await import("@oh-my-pi/pi-coding-agent/mcp/config");
			const filtered = filterMCPServersByAllowlist(
				initialLoaded.configs,
				initialLoaded.sources,
				options.mcpServerAllowlist,
			);
			return { configs: filtered.configs, exaApiKeys: [], sources: filtered.sources };
		});
		(manager as unknown as { loadConfigs: typeof loader }).loadConfigs = loader;
		vi.spyOn(manager, "connectServers").mockResolvedValue({
			tools: [],
			errors: new Map<string, string>(),
			connectedServers: [],
			exaApiKeys: [],
		});

		// Initial connect: only `exa` survives.
		await manager.discoverAndConnect();
		const initialLoaderOptions = loader.mock.calls[0]?.[1];
		expect(initialLoaderOptions?.mcpServerAllowlist).toEqual(["exa"]);

		// Browser toggle triggers `#applyBrowserFilter(false)`, which
		// re-runs `loadConfigs` to (re)connect browser servers. The
		// post-toggle call MUST keep the env allowlist applied — without
		// the fix, the loader saw `mcpServerAllowlist: undefined` here and
		// every browser server (including `github`) would be re-connected.
		await manager.reconcileBrowserFilter(false);
		const reloadOptions = loader.mock.calls.at(-1)?.[1];
		expect(reloadOptions?.mcpServerAllowlist).toEqual(["exa"]);
	});

	it("reconnect via reconcileBrowserFilter honors an options-only allowlist (env unset)", async () => {
		// Operator-pinned allowlist (no env value) must also survive a
		// browser-toggle reload — the manager must persist it onto
		// `#discoverOptions` so the reload path sees the same value.
		delete process.env.OMP_MCP_SERVER_ALLOWLIST;
		const loaded = buildConfigs(["exa", "github"]);
		const loader = vi.fn(async (_cwd: string, options?: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> => {
			if (options?.mcpServerAllowlist === undefined) {
				return { configs: loaded.configs, exaApiKeys: [], sources: loaded.sources };
			}
			const { filterMCPServersByAllowlist } = await import("@oh-my-pi/pi-coding-agent/mcp/config");
			const filtered = filterMCPServersByAllowlist(loaded.configs, loaded.sources, options.mcpServerAllowlist);
			return { configs: filtered.configs, exaApiKeys: [], sources: filtered.sources };
		});
		(manager as unknown as { loadConfigs: typeof loader }).loadConfigs = loader;
		vi.spyOn(manager, "connectServers").mockResolvedValue({
			tools: [],
			errors: new Map<string, string>(),
			connectedServers: [],
			exaApiKeys: [],
		});

		await manager.discoverAndConnect({ mcpServerAllowlist: ["exa"] });
		expect(loader.mock.calls[0]?.[1]?.mcpServerAllowlist).toEqual(["exa"]);

		await manager.reconcileBrowserFilter(false);
		// The reload must carry the options-supplied allowlist forward,
		// so an operator-pinned lockdown is not silently widened by a
		// browser-toggle reconcile.
		expect(loader.mock.calls.at(-1)?.[1]?.mcpServerAllowlist).toEqual(["exa"]);
	});
});
