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

test("renderGraph snapshot: live diamond shows per-edge fired/pending/dead states on fan-out and waiting/blocked join", () => {
	const waitingJoin = renderGraph(
		{
			mode: "live",
			runId: "r-dia1",
			topology: "graph",
			outcome: "running",
			elapsedMs: 42_000,
			pendingCount: 2,
			errorCount: 0,
			nodes: [
				{ id: "root", inboundEdges: [], state: "succeeded" },
				{ id: "left", inboundEdges: ["root"], state: "succeeded", edgeStates: { root: "fired" } },
				{ id: "right", inboundEdges: ["root"], state: "running", elapsedMs: 10_000, edgeStates: { root: "fired" } },
				{ id: "merge", inboundEdges: ["left", "right"], state: "waiting", edgeStates: { left: "fired", right: "pending" } },
			],
		},
		100,
		fakeTheme,
	);

	assert.equal(
		waitingJoin,
		[
			"\x1b[36m●\x1b[0m run r-dia1 · graph · 4 nodes · running · 00:42",
			"\x1b[32m✓\x1b[0m root \x1b[32m──\x1b[0m┬\x1b[32m──▶\x1b[0m \x1b[32m✓\x1b[0m left        \x1b[32m──\x1b[0m┬\x1b[2m╌╌▶\x1b[0m \x1b[2m◌\x1b[0m merge",
			"         └\x1b[32m──▶\x1b[0m \x1b[36m●\x1b[0m right 00:10 \x1b[2m╌╌\x1b[0m┘",
			"2 pending · 0 errors · bootstrap_status",
		].join("\n"),
	);

	const blockedJoin = renderGraph(
		{
			mode: "live",
			runId: "r-dia2",
			topology: "graph",
			outcome: "failed",
			elapsedMs: 45_000,
			pendingCount: 0,
			errorCount: 1,
			nodes: [
				{ id: "root", inboundEdges: [], state: "succeeded" },
				{ id: "left", inboundEdges: ["root"], state: "failed", edgeStates: { root: "fired" } },
				{ id: "right", inboundEdges: ["root"], state: "succeeded", edgeStates: { root: "fired" } },
				{ id: "merge", inboundEdges: ["left", "right"], state: "blocked", edgeStates: { left: "dead", right: "fired" } },
			],
		},
		100,
		fakeTheme,
	);

	assert.equal(
		blockedJoin,
		[
			"\x1b[31m✗\x1b[0m run r-dia2 · graph · 4 nodes · failed · 00:45",
			"\x1b[32m✓\x1b[0m root \x1b[32m──\x1b[0m┬\x1b[32m──▶\x1b[0m \x1b[31m✗\x1b[0m left  \x1b[31m─✗\x1b[0m┬\x1b[31m─✗▶\x1b[0m \x1b[33m⊘\x1b[0m merge",
			"         └\x1b[32m──▶\x1b[0m \x1b[32m✓\x1b[0m right \x1b[32m──\x1b[0m┘",
			"0 pending · \x1b[31m1 error\x1b[0m · bootstrap_status",
		].join("\n"),
	);
});

test("renderGraph snapshot: live parallel chains with a join show which branch the join waits on", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-par",
			topology: "graph",
			outcome: "running",
			elapsedMs: 30_000,
			pendingCount: 2,
			errorCount: 0,
			nodes: [
				{ id: "a", inboundEdges: [], state: "succeeded" },
				{ id: "b", inboundEdges: [], state: "succeeded" },
				{ id: "c", inboundEdges: ["a"], state: "succeeded", edgeStates: { a: "fired" } },
				{ id: "d", inboundEdges: ["b"], state: "running", elapsedMs: 5_000, edgeStates: { b: "fired" } },
				{ id: "e", inboundEdges: ["c", "d"], state: "waiting", edgeStates: { c: "fired", d: "pending" } },
			],
		},
		100,
		fakeTheme,
	);

	assert.equal(
		output,
		[
			"\x1b[36m●\x1b[0m run r-par · graph · 5 nodes · running · 00:30",
			"\x1b[32m✓\x1b[0m a \x1b[32m──▶\x1b[0m \x1b[32m✓\x1b[0m c       \x1b[32m──\x1b[0m┬\x1b[2m╌╌▶\x1b[0m \x1b[2m◌\x1b[0m e",
			"\x1b[32m✓\x1b[0m b \x1b[32m──▶\x1b[0m \x1b[36m●\x1b[0m d 00:05 \x1b[2m╌╌\x1b[0m┘",
			"2 pending · 0 errors · bootstrap_status",
		].join("\n"),
	);
});

test("renderGraph snapshot: live skip-level edge shows fired bypass and dead direct edge", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-skip",
			topology: "graph",
			outcome: "failed",
			elapsedMs: 12_000,
			pendingCount: 0,
			errorCount: 1,
			nodes: [
				{ id: "a", inboundEdges: [], state: "succeeded" },
				{ id: "b", inboundEdges: ["a"], state: "failed", edgeStates: { a: "fired" } },
				{ id: "c", inboundEdges: ["b", "a"], state: "blocked", edgeStates: { b: "dead", a: "fired" } },
			],
		},
		100,
		fakeTheme,
	);

	assert.equal(
		output,
		[
			"\x1b[31m✗\x1b[0m run r-skip · graph · 3 nodes · failed · 00:12",
			"\x1b[32m✓\x1b[0m a \x1b[32m──\x1b[0m┬\x1b[32m──▶\x1b[0m \x1b[31m✗\x1b[0m b \x1b[31m─✗\x1b[0m┬\x1b[31m─✗▶\x1b[0m \x1b[33m⊘\x1b[0m c",
			"      \x1b[32m└──────────┘\x1b[0m",
			"0 pending · \x1b[31m1 error\x1b[0m · bootstrap_status",
		].join("\n"),
	);
});

test("renderGraph distinguishes blocked, skipped, and cancelled nodes without colour", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-glyphs",
			topology: "team",
			outcome: "cancelled",
			pendingCount: 0,
			errorCount: 0,
			nodes: [
				{ id: "n-blocked", inboundEdges: [], state: "blocked" },
				{ id: "n-skipped", inboundEdges: [], state: "skipped" },
				{ id: "n-cancelled", inboundEdges: [], state: "cancelled" },
			],
		},
		80,
	);

	assert.equal(
		output,
		[
			"⊗ run r-glyphs · team · 3 nodes · cancelled",
			"⊘ n-blocked",
			"↷ n-skipped",
			"⊗ n-cancelled",
			"0 pending · 0 errors · bootstrap_status",
		].join("\n"),
	);
});

test("renderGraph snapshot: live mode without theme still renders fired, pending, and dead edge glyphs", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-notheme",
			topology: "graph",
			outcome: "blocked",
			pendingCount: 1,
			errorCount: 1,
			nodes: [
				{ id: "root", inboundEdges: [], state: "succeeded" },
				{ id: "left", inboundEdges: ["root"], state: "succeeded", edgeStates: { root: "fired" } },
				{ id: "right", inboundEdges: ["root"], state: "failed", edgeStates: { root: "fired" } },
				{ id: "extra", inboundEdges: ["root"], state: "pending", edgeStates: { root: "pending" } },
				{ id: "merge", inboundEdges: ["left", "right"], state: "blocked", edgeStates: { left: "fired", right: "dead" } },
			],
		},
		100,
	);

	assert.doesNotMatch(output, /\x1b\[/);
	assert.equal(
		output,
		[
			"⊘ run r-notheme · graph · 5 nodes · blocked",
			"✓ root ──┬──▶ ✓ left  ──┬─✗▶ ⊘ merge",
			"         ├──▶ ✗ right ─✗┘",
			"         └╌╌▶ ◌ extra",
			"1 pending · 1 error · bootstrap_status",
		].join("\n"),
	);
});

test("renderGraph snapshot: vertical fallback in live mode tags each listed edge with its state", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-narrow",
			topology: "graph",
			outcome: "running",
			pendingCount: 2,
			errorCount: 0,
			nodes: [
				{ id: "left", inboundEdges: [], state: "succeeded" },
				{ id: "right", inboundEdges: [], state: "running" },
				{ id: "merge", inboundEdges: ["left", "right"], state: "pending", edgeStates: { left: "fired", right: "pending" } },
			],
		},
		20,
	);

	assert.equal(
		output,
		[
			"● run r-narrow · gr…",
			"✓ left  ● right",
			"↓ left→merge✓",
			"  right→merge…",
			"◌ merge",
			"2 pending · 0 error…",
		].join("\n"),
	);
});

test("renderGraph snapshot: wide 3-arm fan-out in live mode", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-fan3",
			topology: "graph",
			outcome: "running",
			pendingCount: 2,
			errorCount: 0,
			nodes: [
				{ id: "root", inboundEdges: [], state: "succeeded" },
				{ id: "arm1", inboundEdges: ["root"], state: "succeeded", edgeStates: { root: "fired" } },
				{ id: "arm2", inboundEdges: ["root"], state: "running", edgeStates: { root: "fired" } },
				{ id: "arm3", inboundEdges: ["root"], state: "pending", edgeStates: { root: "pending" } },
			],
		},
		100,
	);

	assert.equal(
		output,
		[
			"● run r-fan3 · graph · 4 nodes · running",
			"✓ root ──┬──▶ ✓ arm1",
			"         ├──▶ ● arm2",
			"         └╌╌▶ ◌ arm3",
			"2 pending · 0 errors · bootstrap_status",
		].join("\n"),
	);
});

test("renderGraph snapshot: 3-way fan-in join in live mode", () => {
	const output = renderGraph(
		{
			mode: "live",
			runId: "r-join3",
			topology: "graph",
			outcome: "blocked",
			pendingCount: 1,
			errorCount: 1,
			nodes: [
				{ id: "a", inboundEdges: [], state: "succeeded" },
				{ id: "b", inboundEdges: [], state: "failed" },
				{ id: "c", inboundEdges: [], state: "running" },
				{ id: "join", inboundEdges: ["a", "b", "c"], state: "blocked", edgeStates: { a: "fired", b: "dead", c: "pending" } },
			],
		},
		100,
	);

	assert.equal(
		output,
		[
			"⊘ run r-join3 · graph · 4 nodes · blocked",
			"✓ a ──┬─✗▶ ⊘ join",
			"✗ b ─✗┤",
			"● c ╌╌┘",
			"1 pending · 1 error · bootstrap_status",
		].join("\n"),
	);
});

test("widget marks a defensive cycle edge and draws the remaining edges", () => {
	const view = renderGraph({ topology: "graph", nodes: [
		{ id: "a", inboundEdges: ["b"] },
		{ id: "b", inboundEdges: ["a"] },
		{ id: "c", inboundEdges: ["a"] },
	] }, 80);
	assert.match(view, /cycle edge: a→b/);
	assert.match(view, /◌ b.*▶.*◌ a.*▶.*◌ c/);
});

test("widget measures wide labels and truncates whole emoji and combining characters", () => {
	const wide = renderGraph({ topology: "graph", nodes: [
		{ id: "a", label: "界", inboundEdges: [] },
		{ id: "b", label: "abc", inboundEdges: [] },
		{ id: "c", label: "🙂", inboundEdges: ["a"] },
		{ id: "d", label: "xyz", inboundEdges: ["b"] },
	] }, 80);
	assert.equal(wide.split("\n")[1].indexOf("▶") + 1, wide.split("\n")[2].indexOf("▶"));
	const narrow = renderGraph({ mode: "live", topology: "graph", runId: "界👩‍💻abc", nodes: [
		{ id: "a", label: "界👩‍💻x", inboundEdges: [] },
		{ id: "b", label: "e\u0301yz", inboundEdges: ["a"] },
	] }, 6);
	assert.deepEqual(narrow.split("\n"), ["● run…", "◌ 界…", "↓", "◌ e\u0301yz"]);
});
