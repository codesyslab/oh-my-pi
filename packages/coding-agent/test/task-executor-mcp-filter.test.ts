/**
 * Verifies the executor's MCP proxy tool allowlist filter on task agents.
 *
 * A task agent's `mcpServers` frontmatter is the canonical place for an
 * operator to declare which inherited parent MCP servers a subagent may
 * see. This file focuses on the *filter* surface — i.e. that
 * `createMCPProxyTools` narrows by exact `mcpServerName` identity (not a
 * lossy name prefix), that omitted/`"*"` preserve today's all-parent
 * behavior, that explicit `[]` removes every proxy, and that nameless
 * tools cannot bypass an allowlist by hiding their server identity.
 */
import { describe, expect, it, vi } from "bun:test";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { createMCPProxyTools } from "@oh-my-pi/pi-coding-agent/task/executor";
import { createMockConnection, createMockTransport } from "./mcp-test-utils";

const EXA: MCPToolDefinition = {
	name: "search",
	description: "Exa search",
	inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
};
const GITHUB: MCPToolDefinition = {
	name: "issues",
	description: "GitHub issues",
	inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
};
const GIT: MCPToolDefinition = {
	name: "log",
	description: "git log",
	inputSchema: { type: "object", properties: { n: { type: "number" } } },
};

function makeConnection(): MCPServerConnection {
	const transport = createMockTransport(new Map(), () => {});
	return createMockConnection({ tools: {} }, transport);
}

function buildManager(tools: Array<{ server: string; tool: MCPToolDefinition }>): MCPManager {
	const manager = new MCPManager(process.cwd());
	const connections = new Map<string, MCPServerConnection>();
	const built = tools.map(({ server, tool }) => {
		const connection = makeConnection();
		// Reflect what `MCPManager` would normally stamp on the tool after
		// discovery: the owning server name and the original tool name.
		Object.assign(connection, { name: server });
		connections.set(server, connection);
		return new MCPTool(connection, tool);
	});
	vi.spyOn(manager, "getTools").mockImplementation(() => built);
	// Allow the source-tool re-resolution inside the proxy to find its server.
	(manager as unknown as { getConnection: (n: string) => MCPServerConnection | undefined }).getConnection = (
		name: string,
	) => connections.get(name);
	return manager;
}

describe("createMCPProxyTools allowlist filter", () => {
	it("preserves today's all-parent behavior when allowedMCPServers is omitted", () => {
		const manager = buildManager([
			{ server: "exa", tool: EXA },
			{ server: "github", tool: GITHUB },
			{ server: "git", tool: GIT },
		]);

		const proxies = createMCPProxyTools(manager);

		const servers = proxies.map(t => t.mcpServerName).sort();
		expect(servers).toEqual(["exa", "git", "github"]);
		const toolNames = proxies.map(t => t.mcpToolName).sort();
		expect(toolNames).toEqual(["issues", "log", "search"]);
	});

	it("'*' is equivalent to omitting the filter", () => {
		const manager = buildManager([
			{ server: "exa", tool: EXA },
			{ server: "github", tool: GITHUB },
		]);

		const proxies = createMCPProxyTools(manager, "*");

		expect(proxies.map(t => t.mcpServerName).sort()).toEqual(["exa", "github"]);
	});

	it("exposes only proxy tools whose MCP server is in the allowlist (subset)", () => {
		const manager = buildManager([
			{ server: "exa", tool: EXA },
			{ server: "github", tool: GITHUB },
			{ server: "git", tool: GIT },
		]);

		const proxies = createMCPProxyTools(manager, ["exa", "github"]);

		expect(proxies.map(t => t.mcpServerName).sort()).toEqual(["exa", "github"]);
		expect(proxies.find(t => t.mcpServerName === "git")).toBeUndefined();
	});

	it("explicit [] drops every inherited proxy tool (no MCP)", () => {
		const manager = buildManager([
			{ server: "exa", tool: EXA },
			{ server: "github", tool: GITHUB },
		]);

		const proxies = createMCPProxyTools(manager, []);

		expect(proxies).toEqual([]);
	});

	it("ignores display-name prefixes — only raw mcpServerName membership decides", () => {
		// Two distinct MCP servers, one of which is a substring prefix of the
		// other. A lossy name-prefix filter would over-match; the contract
		// requires exact server identity so 'git' is not selected just
		// because 'github' shares a prefix.
		const manager = buildManager([
			{ server: "git", tool: GIT },
			{ server: "github", tool: GITHUB },
		]);

		const proxies = createMCPProxyTools(manager, ["git"]);

		expect(proxies).toHaveLength(1);
		expect(proxies[0]?.mcpServerName).toBe("git");
		expect(proxies[0]?.mcpToolName).toBe("log");
	});

	it("drops tools with no resolvable mcpServerName whenever an allowlist is present", () => {
		// A nameless tool (no `mcpServerName` stamped) cannot be matched by
		// exact-identity membership. Allowing it under a non-wildcard filter
		// would let an upstream owner smuggle capabilities past the
		// allowlist by hiding their identity.
		const manager = new MCPManager(process.cwd());
		const exaConnection = makeConnection();
		Object.assign(exaConnection, { name: "exa" });
		const namedTool = new MCPTool(exaConnection, EXA);
		const namelessTool: unknown = {
			name: "shadow",
			label: "shadow",
			description: "shadow",
			parameters: { type: "object", properties: {} },
			// mcpServerName intentionally omitted
		};
		vi.spyOn(manager, "getTools").mockReturnValue([namedTool, namelessTool] as never);

		const proxies = createMCPProxyTools(manager, ["exa"]);

		expect(proxies).toHaveLength(1);
		expect(proxies[0]?.mcpServerName).toBe("exa");
	});

	it("preserves source-tool reconnect re-resolution under filtering", async () => {
		// The proxy re-resolves its source by raw MCP metadata so reconnects
		// are honored. This must keep working when a filter narrows the
		// proxy surface.
		const exaConnection = makeConnection();
		Object.assign(exaConnection, { name: "exa" });
		const staleTool = new MCPTool(exaConnection, EXA);
		const freshTool = new MCPTool(exaConnection, EXA);

		const manager = new MCPManager(process.cwd());
		const getTools = vi.spyOn(manager, "getTools").mockReturnValue([staleTool]);

		const [proxy] = createMCPProxyTools(manager, ["exa"]);
		if (!proxy?.execute) throw new Error("proxy missing execute");

		// Simulate a reconnect that replaces the source instance.
		getTools.mockReturnValue([freshTool]);

		const ctx = {} as Parameters<typeof proxy.execute>[3];
		await proxy.execute("c1", { q: "x" }, undefined, ctx, undefined);
		expect(getTools).toHaveBeenCalled();
	});
});
