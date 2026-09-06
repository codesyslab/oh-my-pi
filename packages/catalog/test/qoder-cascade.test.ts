import { describe, expect, it } from "bun:test";
import { resolveCascade } from "@oh-my-pi/pi-catalog/compat/cascade";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { QODER_CN_SEED_SPECS } from "@oh-my-pi/pi-catalog/provider-models/special";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";

// Asserts the vendor-verified cascade surfaces the right thinking control and
// context window for every seeded qoder-cn id. These come from the KDL rule
// tree (compat/rules/providers/qoder-cn.kdl) — the static seed mirrors them
// inline, so this is a through-rule resolution, not a parsing test.
describe("qoder-cn cascade resolution", () => {
	it("pins text-only input on DeepSeek-V4-Pro even when the gateway reports is_vl:true", () => {
		const spec = QODER_CN_SEED_SPECS.find(model => model.id === "deepseek-v4-pro") as ModelSpec;
		const built = buildModel(spec);
		expect(built.provider).toBe("qoder-cn");
		expect(built.input).toEqual(["text"]);
	});

	it("resolves DeepSeek-V4-Pro on qoder-cn to a high/max effort ladder", () => {
		const resolved = resolveCascade({
			provider: "qoder-cn",
			class: "deepseek",
			family: "pro",
			model: "deepseek-v4-pro",
			revision: "4",
			reasoning: true,
		});
		expect(resolved.thinking.efforts).toContain(Effort.High);
		expect(resolved.thinking.efforts).toContain(Effort.Max);
	});

	it("resolves GLM-5.3 to text-only input and a low/high/max ladder with mandatory thinking", () => {
		const spec = QODER_CN_SEED_SPECS.find(model => model.id === "glm-5.3") as ModelSpec;
		const built = buildModel(spec);
		expect(built.input).toEqual(["text"]);
		const resolved = resolveCascade({
			provider: "qoder-cn",
			class: "glm",
			model: "glm-5.3",
			reasoning: true,
		});
		expect(resolved.thinking.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		expect(resolved.thinking.requiresEffort).toBe(true);
	});

	it("pins GLM-5.3-Flash to image-capable and a high/max ladder with mandatory thinking", () => {
		const spec = QODER_CN_SEED_SPECS.find(model => model.id === "glm-5.3-flash") as ModelSpec;
		const built = buildModel(spec);
		expect(built.input).toEqual(["text", "image"]);
		const resolved = resolveCascade({
			provider: "qoder-cn",
			class: "glm",
			model: "glm-5.3-flash",
			reasoning: true,
		});
		expect(resolved.thinking.efforts).toContain(Effort.High);
		expect(resolved.thinking.requiresEffort).toBe(true);
	});

	it("clamps the minimax-m2.7 window to the vendor-verified 204,800-token ceiling", () => {
		const spec = QODER_CN_SEED_SPECS.find(model => model.id === "minimax-m2.7") as ModelSpec;
		const built = buildModel(spec);
		// The seed already carries 204_800; the cascade overlay must not widen it.
		expect(built.contextWindow).toBe(204_800);
		// The KDL limits-patch is the authority when discovery surfaces a stale 1M row.
		const resolved = resolveCascade({
			provider: "qoder-cn",
			class: "minimax",
			family: "m2",
			model: "minimax-m2.7",
			reasoning: true,
		});
		const limitsPatch = resolved.catalog.limitsPatch as { contextWindow?: number } | undefined;
		expect(limitsPatch?.contextWindow).toBe(204_800);
	});

	it("clamps the kimi-k2.7-code window to the vendor-verified 256K ceiling", () => {
		const spec = QODER_CN_SEED_SPECS.find(model => model.id === "kimi-k2.7-code") as ModelSpec;
		const built = buildModel(spec);
		expect(built.contextWindow).toBe(256_000);
		const resolved = resolveCascade({
			provider: "qoder-cn",
			class: "kimi",
			model: "kimi-k2.7-code",
			reasoning: true,
		});
		const limitsPatch = resolved.catalog.limitsPatch as { contextWindow?: number } | undefined;
		expect(limitsPatch?.contextWindow).toBe(256_000);
	});

	it("resolves the qwen3.8 effort ladder to low/medium/xhigh", () => {
		const resolved = resolveCascade({
			provider: "qoder-cn",
			class: "qwen",
			model: "qwen3.8-max",
			reasoning: true,
		});
		expect(resolved.thinking.efforts).toEqual([Effort.Low, Effort.Medium, Effort.XHigh]);
	});

	it("resolves qwen3.7-plus to toggle control with no fabricated effort ladder", () => {
		// Toggle models take a bare `enable_thinking` on the wire — the catalog
		// must NOT invent an effort ladder for them, or the provider would send
		// `reasoning_effort` to a model that has none. The control kind is the
		// rule-owned compat field; `thinking` stays undefined.
		const spec = QODER_CN_SEED_SPECS.find(model => model.id === "qwen3.7-plus") as ModelSpec;
		const built = buildModel(spec);
		expect(built.thinking).toBeUndefined();
		expect(built.reasoning).toBe(true);
		const compat = built.compat as { thinkingControl?: string };
		expect(compat.thinkingControl).toBe("toggle");
	});

	it("resolves always-thinks models to no thinking surface and always control", () => {
		// Kimi-K2.7-Code / MiniMax-M2.7 reason unconditionally with no wire
		// control: no ladder may be fabricated and the provider must learn the
		// "always" kind so it never sends `enable_thinking:false`.
		for (const id of ["kimi-k2.7-code", "minimax-m2.7"]) {
			const spec = QODER_CN_SEED_SPECS.find(model => model.id === id) as ModelSpec;
			const built = buildModel(spec);
			expect(built.thinking).toBeUndefined();
			expect(built.reasoning).toBe(true);
			const compat = built.compat as { thinkingControl?: string };
			expect(compat.thinkingControl).toBe("always");
		}
	});
});
