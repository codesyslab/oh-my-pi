/**
 * Regression tests for the three reviewer-flagged bypasses that let a
 * subagent (or any session sharing a parent MCP manager) re-acquire MCP
 * capabilities that its allowlist explicitly excluded.
 *
 * 1. Subagent `getMcpServerInstructions` callback returned the parent's
 *    full instructions map, leaking excluded server instructions into
 *    the child system prompt.
 * 2. `reconcileBrowserMcpFilter` returned the parent's full tools after
 *    a `browser.enabled` toggle, re-enabling excluded MCP for a filtered
 *    child via `refreshMCPTools`.
 * 3. `MCPManager.#applyBrowserFilter` reloaded configs without the
 *    process `OMP_MCP_SERVER_ALLOWLIST`, so a Paseo worker whose only
 *    declaration was the env value would reconnect excluded servers on
 *    the next browser toggle.
 *
 * Each test below would fail without the corresponding fix and pass
 * after it. `bun run check` is the package-level gate.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

const EXA_INSTRUCTIONS = "EXA_SEARCH_GUIDANCE_DO_NOT_LEAK";
const GITHUB_INSTRUCTIONS = "GITHUB_TOKEN_HANDLING_DO_NOT_LEAK";

function makeProxyTool(
	server: string,
	toolName: string,
): {
	name: string;
	label: string;
	mcpServerName: string;
	mcpToolName: string;
} {
	return {
		name: `mcp__${server}_${toolName}`,
		label: `${server}/${toolName}`,
		mcpServerName: server,
		mcpToolName: toolName,
	};
}

describe("SDK MCP allowlist callbacks (subagent leak regression)", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-allow-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.setRuntimeApiKey("google", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("getMcpServerInstructions filters excluded servers from the child system prompt", async () => {
		// Parent manager holds two servers. The child session declares
		// `allowedMCPServers: ["exa"]`; the SDK callback that feeds the
		// system-prompt's MCP Server Instructions block must drop github.
		const manager = new MCPManager(registryDir, null, async () => ({
			configs: {},
			sources: {},
			exaApiKeys: [],
		}));
		vi.spyOn(manager, "getServerInstructions").mockReturnValue(
			new Map([
				["exa", EXA_INSTRUCTIONS],
				["github", GITHUB_INSTRUCTIONS],
			]),
		);
		const settings = Settings.isolated();
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			mcpManager: manager,
			allowedMCPServers: ["exa"],
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		await session.runToolRegistryMutation(async () => undefined);
		const prompt = session.agent.state.systemPrompt.join("\n\n");
		// Pre-fix: the parent's full instructions map leaked into the
		// child system prompt because the SDK callback returned
		// `mcpManager.getServerInstructions()` unfiltered.
		expect(prompt).toContain(EXA_INSTRUCTIONS);
		expect(prompt).not.toContain(GITHUB_INSTRUCTIONS);
		expect(prompt).toContain("### exa");
		expect(prompt).not.toContain("### github");
	});

	it("getMcpServerInstructions drops every entry when allowedMCPServers is []", async () => {
		// An explicit-empty allowlist must lock the child out of MCP
		// instruction text, not just tools — instructions are server-
		// controlled and equally part of the capability surface.
		const manager = new MCPManager(registryDir, null, async () => ({
			configs: {},
			sources: {},
			exaApiKeys: [],
		}));
		vi.spyOn(manager, "getServerInstructions").mockReturnValue(
			new Map([
				["exa", EXA_INSTRUCTIONS],
				["github", GITHUB_INSTRUCTIONS],
			]),
		);
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			mcpManager: manager,
			allowedMCPServers: [],
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		await session.runToolRegistryMutation(async () => undefined);
		const prompt = session.agent.state.systemPrompt.join("\n\n");
		expect(prompt).not.toContain(EXA_INSTRUCTIONS);
		expect(prompt).not.toContain(GITHUB_INSTRUCTIONS);
	});

	it("getMcpServerInstructions preserves every server when allowedMCPServers is omitted", async () => {
		// Backward-compat: today's behavior is that an omitted allowlist
		// means the child sees the parent's full instructions map. The fix
		// must not regress this path.
		const manager = new MCPManager(registryDir, null, async () => ({
			configs: {},
			sources: {},
			exaApiKeys: [],
		}));
		vi.spyOn(manager, "getServerInstructions").mockReturnValue(
			new Map([
				["exa", EXA_INSTRUCTIONS],
				["github", GITHUB_INSTRUCTIONS],
			]),
		);
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			mcpManager: manager,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		await session.runToolRegistryMutation(async () => undefined);
		const prompt = session.agent.state.systemPrompt.join("\n\n");
		expect(prompt).toContain(EXA_INSTRUCTIONS);
		expect(prompt).toContain(GITHUB_INSTRUCTIONS);
	});

	it("reconcileBrowserMcpFilter returns only allowed tools after a browser toggle", async () => {
		// Bug #2: the SDK callback returned `mcpManager.getTools()` directly,
		// so a `browser.enabled` toggle re-registered every parent tool —
		// including excluded servers — for a filtered child. The fix
		// filters the callback's return by `allowedMCPServers` so a child
		// sharing the parent's manager cannot regain excluded tools via
		// `refreshMCPTools`.
		const manager = new MCPManager(registryDir, null, async () => ({
			configs: {},
			sources: {},
			exaApiKeys: [],
		}));
		// The shared parent manager exposes tools from both `exa` and
		// `github` (the parent's full surface). The child allowlist is
		// only `["exa"]`.
		const parentTools = [makeProxyTool("exa", "search"), makeProxyTool("github", "issues")];
		vi.spyOn(manager, "getTools").mockReturnValue(parentTools as never);
		vi.spyOn(manager, "reconcileBrowserFilter").mockResolvedValue();
		const settings = Settings.isolated({ "browser.enabled": false });
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			mcpManager: manager,
			allowedMCPServers: ["exa"],
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		const refreshSpy = vi.spyOn(session, "refreshMCPTools");
		settings.override("browser.enabled", true);
		// Yield to the settings.onEffectiveChange handler so the SDK
		// callback fires and calls refreshMCPTools with the filtered set.
		await new Promise(resolve => setImmediate(resolve));
		expect(refreshSpy).toHaveBeenCalled();
		const lastCallTools = refreshSpy.mock.calls.at(-1)?.[0] as Array<{ mcpServerName?: string }> | undefined;
		expect(lastCallTools).toBeDefined();
		const serverNames = new Set(lastCallTools?.map(t => t.mcpServerName));
		// Pre-fix: both `exa` and `github` would be present.
		expect(serverNames.has("github")).toBe(false);
		expect(serverNames.has("exa")).toBe(true);
	});

	it("reconcileBrowserMcpFilter returns no tools when allowedMCPServers is []", async () => {
		// An explicit-empty allowlist means the child has no MCP
		// capabilities at all — the browser toggle must not silently
		// re-populate the session tool registry.
		const manager = new MCPManager(registryDir, null, async () => ({
			configs: {},
			sources: {},
			exaApiKeys: [],
		}));
		vi.spyOn(manager, "getTools").mockReturnValue([makeProxyTool("exa", "search")] as never);
		vi.spyOn(manager, "reconcileBrowserFilter").mockResolvedValue();
		const settings = Settings.isolated({ "browser.enabled": false });
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			mcpManager: manager,
			allowedMCPServers: [],
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);
		const refreshSpy = vi.spyOn(session, "refreshMCPTools");
		settings.override("browser.enabled", true);
		await new Promise(resolve => setImmediate(resolve));
		const lastCallTools = refreshSpy.mock.calls.at(-1)?.[0] as unknown[] | undefined;
		expect(lastCallTools ?? []).toEqual([]);
	});
});
