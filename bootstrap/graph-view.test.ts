import test from "node:test";
import assert from "node:assert/strict";
import { renderGraph, type GraphTheme } from "./graph-view.ts";

const ANSI_COLOR: Record<string, string> = {
	dim: "2",
	accent: "36",
	success: "32",
	warning: "33",
	error: "31",
};

const fakeTheme: GraphTheme = {
	fg: (color, text) => `\x1b[${ANSI_COLOR[color] ?? "37"}m${text}\x1b[0m`,
};

test("renderGraph snapshot: chain in plan mode without status colours", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "chain",
			nodes: [
				{ id: "plan", inboundEdges: [] },
				{ id: "build", inboundEdges: ["plan"] },
				{ id: "check", inboundEdges: ["build"] },
			],
		},
		80,
		fakeTheme,
	);

	assert.equal(
		output,
		[
			"plan · chain · 3 nodes",
			"◌ plan ──▶ ◌ build ──▶ ◌ check",
		].join("\n"),
	);
});

test("renderGraph snapshot: team in plan mode without status colours", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "team",
			nodes: [
				{ id: "scout-a", inboundEdges: [] },
				{ id: "scout-b", inboundEdges: [] },
				{ id: "reviewer", inboundEdges: [] },
			],
		},
		80,
		fakeTheme,
	);

	assert.equal(
		output,
		[
			"plan · team · 3 nodes",
			"◌ scout-a",
			"◌ scout-b",
			"◌ reviewer",
		].join("\n"),
	);
});

test("renderGraph snapshot: narrow-width vertical fallback with truncated labels", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "chain",
			nodes: [
				{ id: "architecture-planner", inboundEdges: [] },
				{ id: "implementation-builder", inboundEdges: ["architecture-planner"] },
				{ id: "verification-reviewer", inboundEdges: ["implementation-builder"] },
			],
		},
		22,
	);

	assert.equal(
		output,
		[
			"plan · chain · 3 nodes",
			"◌ architecture-planner",
			"↓",
			"◌ implementation-buil…",
			"↓",
			"◌ verification-review…",
		].join("\n"),
	);
});

test("renderGraph vertical fallback places parallel nodes side by side and truncates", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "graph",
			nodes: [
				{ id: "scout-alpha", inboundEdges: [] },
				{ id: "scout-bravo", inboundEdges: [] },
				{ id: "integrator-final", inboundEdges: ["scout-alpha", "scout-bravo"] },
			],
		},
		24,
	);

	assert.equal(
		output,
		[
			"plan · graph · 3 nodes",
			"◌ scout-al…  ◌ scout-br…",
			"↓",
			"◌ integrator-final",
		].join("\n"),
	);
});

test("renderGraph applies height cap with +N more", () => {
	const nodes = Array.from({ length: 10 }, (_, i) => ({
		id: `worker-${i + 1}`,
		inboundEdges: [],
	}));
	const output = renderGraph(
		{
			mode: "plan",
			topology: "team",
			maxHeight: 5,
			nodes,
		},
		80,
	);

	assert.equal(
		output,
		[
			"plan · team · 10 nodes",
			"◌ worker-1",
			"◌ worker-2",
			"◌ worker-3",
			"+7 more",
		].join("\n"),
	);
});

test("renderGraph live mode renders status glyphs, colours, elapsed time, loops, and footer", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-3f9a",
			topology: "chain",
			outcome: "running",
			elapsedMs: 134_000,
			pendingCount: 1,
			errorCount: 0,
			nodes: [
				{ id: "build", inboundEdges: [], state: "succeeded", loop: { attempt: 2, maxAttempts: 3, lastVerdict: "reject" } },
				{ id: "review", inboundEdges: ["build"], state: "running", elapsedMs: 15_000, edgeStates: { build: "fired" } },
			],
		},
		80,
		fakeTheme,
	);

	assert.equal(
		output,
		[
			"\x1b[36m●\x1b[0m run r-3f9a · chain · 2 nodes · running · 02:14",
			"\x1b[32m✓\x1b[0m build \x1b[32m──▶\x1b[0m \x1b[36m●\x1b[0m review 00:15",
			"\x1b[2m↺ 2/3 (reject)\x1b[0m",
			"1 pending · 0 errors · bootstrap_status",
		].join("\n"),
	);
});

test("renderGraph layout is deterministic and orders parallel lanes via barycenter", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "graph",
			nodes: [
				{ id: "a", inboundEdges: [] },
				{ id: "b", inboundEdges: ["a"] },
				{ id: "c", inboundEdges: ["a"] },
				{ id: "d", inboundEdges: ["b", "c"] },
			],
		},
		80,
	);

	assert.equal(
		output,
		[
			"plan · graph · 4 nodes",
			"◌ a ──┬──▶ ◌ b ──┬──▶ ◌ d",
			"      └──▶ ◌ c ──┘",
		].join("\n"),
	);
});

test("renderGraph snapshot: skip-level edge draws a->c bypass", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "graph",
			nodes: [
				{ id: "a", inboundEdges: [] },
				{ id: "b", inboundEdges: ["a"] },
				{ id: "c", inboundEdges: ["b", "a"] },
			],
		},
		80,
	);

	assert.equal(
		output,
		[
			"plan · graph · 3 nodes",
			"◌ a ──┬──▶ ◌ b ──┬──▶ ◌ c",
			"      └──────────┘",
		].join("\n"),
	);
});

test("renderGraph snapshot: parallel chains with a join (a->c, b->d, c,d->e)", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "graph",
			nodes: [
				{ id: "a", inboundEdges: [] },
				{ id: "b", inboundEdges: [] },
				{ id: "c", inboundEdges: ["a"] },
				{ id: "d", inboundEdges: ["b"] },
				{ id: "e", inboundEdges: ["c", "d"] },
			],
		},
		80,
	);

	assert.equal(
		output,
		[
			"plan · graph · 5 nodes",
			"◌ a ──▶ ◌ c ──┬──▶ ◌ e",
			"◌ b ──▶ ◌ d ──┘",
		].join("\n"),
	);
});

test("renderGraph snapshot: asymmetric bipartite a->c, a->d, b->d draws only real edges", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "graph",
			nodes: [
				{ id: "a", inboundEdges: [] },
				{ id: "b", inboundEdges: [] },
				{ id: "c", inboundEdges: ["a"] },
				{ id: "d", inboundEdges: ["a", "b"] },
			],
		},
		80,
	);

	assert.equal(
		output,
		[
			"plan · graph · 4 nodes",
			"◌ a ──┬──────▶ ◌ c",
			"      └───┐",
			"◌ b ──────┴──▶ ◌ d",
		].join("\n"),
	);
});

test("renderGraph snapshot: vertical fallback with explicit edge annotations plus height cap counts hidden nodes", () => {
	const output = renderGraph(
		{
			mode: "plan",
			topology: "graph",
			maxHeight: 4,
			nodes: [
				{ id: "a", inboundEdges: [] },
				{ id: "b", inboundEdges: [] },
				{ id: "c", inboundEdges: ["a"] },
				{ id: "d", inboundEdges: ["a", "b"] },
				{ id: "e", inboundEdges: ["c", "d"] },
			],
		},
		18,
	);

	assert.equal(
		output,
		[
			"plan · graph · 5 …",
			"◌ a  ◌ b",
			"↓ a→c,d · b→d",
			"+3 more",
		].join("\n"),
	);
});

test("renderGraph snapshot: maxHeight 1 yields valid header-only output within cap", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-1",
			topology: "chain",
			outcome: "running",
			pendingCount: 2,
			errorCount: 1,
			maxHeight: 1,
			nodes: [
				{ id: "a", inboundEdges: [], state: "running" },
				{ id: "b", inboundEdges: ["a"], state: "pending" },
			],
		},
		80,
	);

	assert.equal(output, "● run r-1 · chain · 2 nodes · running");
});

test("renderGraph snapshot: live mode footer survives truncation and +N more counts hidden nodes", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-9",
			topology: "team",
			outcome: "running",
			elapsedMs: 65_000,
			pendingCount: 3,
			errorCount: 1,
			maxHeight: 5,
			nodes: [
				{ id: "n1", inboundEdges: [], state: "succeeded" },
				{ id: "n2", inboundEdges: [], state: "running", elapsedMs: 12_000 },
				{ id: "n3", inboundEdges: [], state: "pending" },
				{ id: "n4", inboundEdges: [], state: "pending" },
				{ id: "n5", inboundEdges: [], state: "failed" },
			],
		},
		80,
		fakeTheme,
	);

	assert.equal(
		output,
		[
			"\x1b[36m●\x1b[0m run r-9 · team · 5 nodes · running · 01:05",
			"\x1b[32m✓\x1b[0m n1",
			"\x1b[36m●\x1b[0m n2 00:12",
			"+3 more",
			"3 pending · \x1b[31m1 error\x1b[0m · bootstrap_status",
		].join("\n"),
	);
});
