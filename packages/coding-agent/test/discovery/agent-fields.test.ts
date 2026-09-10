import { describe, expect, test } from "bun:test";
import { Effort } from "@oh-my-pi/pi-ai";
import { parseAgentFields } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

describe("parseAgentFields", () => {
	test("rejects the reserved `main` and `sub` agent definition names", () => {
		expect(parseAgentFields({ name: "main", description: "desc" })).toBeNull();
		expect(parseAgentFields({ name: " Main ", description: "desc" })).toBeNull();
		expect(parseAgentFields({ name: "sub", description: "desc" })).toBeNull();
		expect(parseAgentFields({ name: " Sub ", description: "desc" })).toBeNull();
	});

	test("parses blocking from boolean frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: true,
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(true);
	});

	test("parses blocking from string frontmatter", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "false",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBe(false);
	});

	test("ignores invalid blocking values", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			blocking: "sometimes",
		});

		expect(fields).toBeDefined();
		expect(fields?.blocking).toBeUndefined();
	});
	test("parses legacy thinking key", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "medium",
		});

		expect(fields).toBeDefined();
		expect(fields?.thinkingLevel).toBe(Effort.Medium);
	});

	test("prefers thinking-level over legacy thinking", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			thinking: "minimal",
			thinkingLevel: Effort.High,
		});

		expect(fields?.thinkingLevel).toBe(Effort.High);
	});
	test("accepts the auto thinking selector", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "auto",
		});

		expect(fields?.thinkingLevel).toBe(AUTO_THINKING);
	});

	test("rejects unknown thinking selectors", () => {
		const fields = parseAgentFields({
			name: "worker",
			description: "desc",
			thinkingLevel: "turbo",
		});

		expect(fields?.thinkingLevel).toBeUndefined();
	});

	test("lowercases tool names", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Read", "Search"],
		});

		expect(fields?.tools).toEqual(["read", "grep", "yield"]);
	});
	test("keeps an explicitly empty tools list distinct from an absent one", () => {
		expect(parseAgentFields({ name: "quiet", description: "desc", tools: [] })?.tools).toEqual(["yield"]);
		expect(parseAgentFields({ name: "quiet", description: "desc" })?.tools).toBeUndefined();
	});

	test("maps legacy search and find tool names", () => {
		const fields = parseAgentFields({
			name: "reviewer",
			description: "desc",
			tools: ["Find", "Glob", "Search", "Grep"],
		});

		expect(fields?.tools).toEqual(["glob", "grep", "yield"]);
	});

	test("parses autoloadSkills from array frontmatter", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: ["user-created-skill-a", "user-created-skill-b"],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("parses autoloadSkills from CSV string", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: "user-created-skill-a, user-created-skill-b",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toEqual(["user-created-skill-a", "user-created-skill-b"]);
	});

	test("returns undefined autoloadSkills when field absent", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("returns undefined autoloadSkills for empty array", () => {
		const fields = parseAgentFields({
			name: "oracle",
			description: "desc",
			autoloadSkills: [],
		});

		expect(fields).toBeDefined();
		expect(fields?.autoloadSkills).toBeUndefined();
	});

	test("parses readSummarize from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: false })?.readSummarize).toBe(false);
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: true })?.readSummarize).toBe(true);
	});

	test("parses readSummarize from string frontmatter", () => {
		expect(parseAgentFields({ name: "scout", description: "desc", readSummarize: "false" })?.readSummarize).toBe(
			false,
		);
	});

	test("ignores invalid readSummarize values", () => {
		expect(
			parseAgentFields({ name: "scout", description: "desc", readSummarize: "nope" })?.readSummarize,
		).toBeUndefined();
	});

	test("returns undefined readSummarize when field absent", () => {
		expect(parseAgentFields({ name: "scout", description: "desc" })?.readSummarize).toBeUndefined();
	});
	test("parses prewalk from boolean frontmatter", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: true })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: false })?.prewalk).toBe(false);
	});

	test("parses prewalk boolean strings as booleans", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "true" })?.prewalk).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "false" })?.prewalk).toBe(false);
	});

	test("parses prewalk model pattern strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: " @smol " })?.prewalk).toBe("@smol");
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "openai/gpt-5-mini" })?.prewalk).toBe(
			"openai/gpt-5-mini",
		);
	});

	test("ignores empty and absent prewalk values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", prewalk: "  " })?.prewalk).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.prewalk).toBeUndefined();
	});
	test("parses advisor from boolean frontmatter and boolean strings", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: true })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: false })?.advisor).toBe(false);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "true" })?.advisor).toBe(true);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "false" })?.advisor).toBe(false);
	});

	test("parses advisor model pattern strings and ignores empty/absent values", () => {
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: " moonshot/k3 " })?.advisor).toBe(
			"moonshot/k3",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "@smol:high" })?.advisor).toBe(
			"@smol:high",
		);
		expect(parseAgentFields({ name: "worker", description: "desc", advisor: "  " })?.advisor).toBeUndefined();
		expect(parseAgentFields({ name: "worker", description: "desc" })?.advisor).toBeUndefined();
	});

	describe("mcpServers allowlist", () => {
		test("omitted mcpServers preserves parent's full MCP surface", () => {
			expect(parseAgentFields({ name: "worker", description: "desc" })?.mcpServers).toBeUndefined();
		});

		test("'*' string preserves parent's full MCP surface", () => {
			expect(parseAgentFields({ name: "worker", description: "desc", mcpServers: "*" })?.mcpServers).toBe("*");
		});

		test("parses mcpServers from array frontmatter", () => {
			expect(
				parseAgentFields({ name: "worker", description: "desc", mcpServers: ["exa", "github"] })?.mcpServers,
			).toEqual(["exa", "github"]);
		});

		test("parses mcpServers from CSV string frontmatter", () => {
			expect(
				parseAgentFields({ name: "worker", description: "desc", mcpServers: "exa, github , exa" })?.mcpServers,
			).toEqual(["exa", "github"]);
		});

		test("preserves explicit empty array distinct from omitted", () => {
			// An empty array means "no MCP proxy tools"; omitting means
			// "preserve parent's full MCP surface". The two must round-trip
			// distinctly so a deliberate lockdown is not silently widened
			// on save/reload.
			expect(parseAgentFields({ name: "quiet", description: "desc", mcpServers: [] })?.mcpServers).toEqual([]);
			expect(parseAgentFields({ name: "quiet", description: "desc" })?.mcpServers).toBeUndefined();
		});

		test("treats empty CSV string as explicit empty array", () => {
			expect(parseAgentFields({ name: "quiet", description: "desc", mcpServers: "   " })?.mcpServers).toEqual([]);
			expect(parseAgentFields({ name: "quiet", description: "desc", mcpServers: "" })?.mcpServers).toEqual([]);
		});

		test("ignores non-string entries in array form", () => {
			// Booleans/numbers slip in through manual frontmatter edits; the
			// filter only trusts exact server-name strings.
			expect(
				parseAgentFields({
					name: "worker",
					description: "desc",
					mcpServers: ["exa", 42, true, "github", ""] as unknown as string[],
				})?.mcpServers,
			).toEqual(["exa", "github"]);
		});

		test("ignores unrecognized scalar mcpServers values", () => {
			// Anything that is not "*", an array, or a CSV string is dropped;
			// the agent falls back to the parent's full MCP surface rather
			// than having a malformed allowlist silently mean "no MCP".
			expect(parseAgentFields({ name: "worker", description: "desc", mcpServers: 42 })?.mcpServers).toBeUndefined();
			expect(
				parseAgentFields({ name: "worker", description: "desc", mcpServers: true })?.mcpServers,
			).toBeUndefined();
			expect(
				parseAgentFields({ name: "worker", description: "desc", mcpServers: { exa: true } })?.mcpServers,
			).toBeUndefined();
		});

		test("deduplicates repeated entries", () => {
			expect(
				parseAgentFields({ name: "worker", description: "desc", mcpServers: ["exa", "exa", "github"] })?.mcpServers,
			).toEqual(["exa", "github"]);
		});
	});
});
