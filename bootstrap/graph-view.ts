/**
 * Pure, deterministic graph layout and box-drawing renderer for bootstrap plans and live runs.
 *
 * No filesystem, process, or Pi runtime dependencies: used both by `formatPlan` (dry-run preview
 * without status colours) and by the live orchestrator widget.
 */

export type GraphNodeState =
	| "pending"
	| "waiting"
	| "running"
	| "succeeded"
	| "partial"
	| "failed"
	| "blocked"
	| "skipped"
	| "cancelled"
	| "needs_attention"
	| "parked";

export type GraphEdgeState = "pending" | "fired" | "dead";

export interface GraphLoopInfo {
	attempt: number;
	/** Includes the initial attempt and all allowed revisions for this loop. */
	maxAttempts: number;
	lastVerdict?: string;
}

export interface GraphViewNode {
	id: string;
	label?: string;
	inboundEdges: string[];
	state?: GraphNodeState;
	elapsedMs?: number;
	loop?: GraphLoopInfo;
	edgeStates?: Record<string, GraphEdgeState>;
}

export interface GraphViewModel {
	mode?: "plan" | "live";
	runId?: string;
	topology: "chain" | "team" | "graph";
	outcome?: string;
	cleaned?: boolean;
	elapsedMs?: number;
	pendingCount?: number;
	errorCount?: number;
	maxHeight?: number;
	nodes: GraphViewNode[];
}

export interface GraphTheme {
	fg(color: string, text: string): string;
}

const DEFAULT_MAX_HEIGHT = 24;
const ANSI_RE = /\x1b\[[0-9;]*m/g;

const STATE_GLYPH: Record<GraphNodeState, string> = {
	pending: "◌",
	waiting: "◌",
	running: "●",
	succeeded: "✓",
	partial: "◐",
	failed: "✗",
	blocked: "⊘",
	skipped: "↷",
	cancelled: "⊗",
	needs_attention: "!",
	parked: "⏸",
};

const STATE_COLOR: Record<GraphNodeState, string> = {
	pending: "dim",
	waiting: "dim",
	running: "accent",
	succeeded: "success",
	partial: "warning",
	failed: "error",
	blocked: "warning",
	skipped: "dim",
	cancelled: "dim",
	needs_attention: "error",
	parked: "warning",
};

function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const emojiPresentation = /[\p{Emoji_Presentation}\uFE0F\u20E3]/u;

function graphemeWidth(cluster: string): number {
	if (emojiPresentation.test(cluster)) return 2;
	const base = cluster.match(/[^\p{Mark}\p{Default_Ignorable_Code_Point}\p{Control}]/u)?.[0];
	if (!base) return 0;
	const code = base.codePointAt(0)!;
	// East Asian wide and fullwidth ranges. Ambiguous characters (including box drawing) use one cell.
	return code >= 0x1100 && (
		code <= 0x115f || code === 0x2329 || code === 0x232a ||
		(code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) ||
		(code >= 0xa960 && code <= 0xa97c) ||
		(code >= 0xac00 && code <= 0xd7a3) ||
		(code >= 0xf900 && code <= 0xfaff) ||
		(code >= 0xfe10 && code <= 0xfe19) ||
		(code >= 0xfe30 && code <= 0xfe6f) ||
		(code >= 0xff01 && code <= 0xff60) ||
		(code >= 0xffe0 && code <= 0xffe6) ||
		(code >= 0x16fe0 && code <= 0x18dff) ||
		(code >= 0x1aff0 && code <= 0x1b2ff) ||
		(code >= 0x1f200 && code <= 0x1f251) ||
		(code >= 0x20000 && code <= 0x3fffd)
	) ? 2 : 1;
}

function visibleLength(text: string): number {
	const plain = stripAnsi(text);
	let width = 0;
	for (const { segment } of graphemes.segment(plain)) width += graphemeWidth(segment);
	return width;
}

function truncatePlain(text: string, maxWidth: number, ellipsis = "…"): string {
	if (maxWidth <= 0) return "";
	if (visibleLength(text) <= maxWidth) return text;
	let width = 0;
	const budget = maxWidth - visibleLength(ellipsis);
	let prefix = "";
	for (const { segment } of graphemes.segment(text)) {
		width += graphemeWidth(segment);
		if (width > budget) break;
		prefix += segment;
	}
	return prefix + ellipsis;
}

function truncateVisible(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (visibleLength(text) <= maxWidth) return text;
	return truncatePlain(stripAnsi(text), maxWidth);
}

/** Clip plain widget notices to fit without breaking graphemes. */
export const clipGraphText = (text: string, width: number): string => truncatePlain(text, width, "");

function formatDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function colorize(theme: GraphTheme | undefined, useColors: boolean, color: string, text: string): string {
	if (!useColors || !theme) return text;
	return theme.fg(color, text);
}

function nodeGlyph(node: GraphViewNode, useColors: boolean, theme?: GraphTheme): string {
	const state = node.state ?? "pending";
	const glyph = STATE_GLYPH[state] ?? "◌";
	return colorize(theme, useColors, STATE_COLOR[state] ?? "dim", glyph);
}

function outcomeGlyph(outcome: string | undefined, useColors: boolean, theme?: GraphTheme): string {
	const normalized = outcome?.toLowerCase() ?? "running";
	const state: GraphNodeState =
		normalized === "succeeded" || normalized === "cleaned" ? "succeeded"
		: normalized === "partial" ? "partial"
		: normalized === "failed" || normalized === "error" ? "failed"
		: normalized === "blocked" ? "blocked"
		: normalized === "cancelled" ? "cancelled"
		: normalized === "needs_attention" ? "needs_attention"
		: "running";
	return colorize(theme, useColors, STATE_COLOR[state], STATE_GLYPH[state]);
}

function formatNodeText(node: GraphViewNode, useColors: boolean, theme?: GraphTheme): string {
	const glyph = nodeGlyph(node, useColors, theme);
	const label = node.label ?? node.id;
	const elapsed = node.state === "running" && node.elapsedMs !== undefined ? ` ${formatDuration(node.elapsedMs)}` : "";
	return `${glyph} ${label}${elapsed}`;
}

function formatLoopAnnotation(node: GraphViewNode, useColors: boolean, theme?: GraphTheme): string | undefined {
	if (!node.loop) return undefined;
	const verdict = node.loop.lastVerdict ? ` (${node.loop.lastVerdict})` : "";
	return colorize(theme, useColors, "dim", `↺ ${node.loop.attempt}/${node.loop.maxAttempts}${verdict}`);
}

interface LayoutData {
	levels: GraphViewNode[][];
	levelOf: Map<string, number>;
	rowOf: Map<string, number>;
	outbound: Map<string, string[]>;
	cycleEdges: Array<{ source: string; destination: string }>;
}

/**
 * Assign dependency levels by longest path from roots, then order rows within each level
 * using forward/backward barycenter passes with deterministic input-order tie-breaking.
 */
function computeLayout(nodes: GraphViewNode[]): LayoutData {
	const byId = new Map(nodes.map(n => [n.id, n]));
	const orderIndex = new Map(nodes.map((n, i) => [n.id, i]));
	const outbound = new Map<string, string[]>(nodes.map(n => [n.id, []]));

	const levelOf = new Map<string, number>();
	const visiting = new Set<string>();
	const cycleEdges: LayoutData["cycleEdges"] = [];
	const cyclicParents = new Map<string, Set<string>>();

	function computeLevel(id: string): number {
		const cached = levelOf.get(id);
		if (cached !== undefined) return cached;
		visiting.add(id);
		const node = byId.get(id)!;
		let maxParent = -1;
		for (const src of node.inboundEdges) {
			if (!byId.has(src)) continue;
			if (visiting.has(src)) {
				const parents = cyclicParents.get(id) ?? new Set();
				if (!parents.has(src)) cycleEdges.push({ source: src, destination: id });
				parents.add(src);
				cyclicParents.set(id, parents);
				continue;
			}
			maxParent = Math.max(maxParent, computeLevel(src));
		}
		visiting.delete(id);
		const lvl = maxParent + 1;
		levelOf.set(id, lvl);
		return lvl;
	}

	let maxLevel = 0;
	for (const node of nodes) {
		maxLevel = Math.max(maxLevel, computeLevel(node.id));
	}

	const levels: GraphViewNode[][] = Array.from({ length: maxLevel + 1 }, () => []);
	for (const node of nodes) {
		const removed = cyclicParents.get(node.id);
		const inboundEdges = removed ? node.inboundEdges.filter(src => !removed.has(src)) : node.inboundEdges;
		for (const src of inboundEdges) outbound.get(src)?.push(node.id);
		levels[levelOf.get(node.id)!].push(removed ? { ...node, inboundEdges } : node);
	}

	const rowOf = new Map<string, number>();
	const syncRows = () => {
		rowOf.clear();
		for (const col of levels) {
			col.forEach((node, row) => rowOf.set(node.id, row));
		}
	};
	syncRows();

	const sortByBarycenter = (col: GraphViewNode[], neighbors: (n: GraphViewNode) => string[]) => {
		const scores = new Map<string, number>();
		for (const node of col) {
			const linked = neighbors(node).filter(id => rowOf.has(id));
			if (linked.length === 0) {
				scores.set(node.id, rowOf.get(node.id)!);
			} else {
				const sum = linked.reduce((acc, id) => acc + rowOf.get(id)!, 0);
				scores.set(node.id, sum / linked.length);
			}
		}
		col.sort((a, b) => {
			const diff = scores.get(a.id)! - scores.get(b.id)!;
			if (diff !== 0) return diff;
			return orderIndex.get(a.id)! - orderIndex.get(b.id)!;
		});
	};

	for (let pass = 0; pass < 2; pass++) {
		for (let l = 1; l <= maxLevel; l++) {
			sortByBarycenter(levels[l], n => n.inboundEdges);
			syncRows();
		}
		for (let l = maxLevel - 1; l >= 0; l--) {
			sortByBarycenter(levels[l], n => outbound.get(n.id) ?? []);
			syncRows();
		}
	}

	return { levels, levelOf, rowOf, outbound, cycleEdges };
}

function edgeSegment(
	state: GraphEdgeState | undefined,
	length: number,
	arrow: boolean,
	isLive: boolean,
	useColors: boolean,
	theme?: GraphTheme,
): string {
	if (!isLive) {
		return `${"─".repeat(length)}${arrow ? "▶" : ""}`;
	}
	let glyph: string;
	let color: string;
	if (state === "fired") {
		glyph = `${"─".repeat(length)}${arrow ? "▶" : ""}`;
		color = "success";
	} else if (state === "dead") {
		const bar = length <= 1 ? "✗".repeat(length) : `${"─".repeat(length - 1)}✗`;
		glyph = `${bar}${arrow ? "▶" : ""}`;
		color = "error";
	} else {
		glyph = `${"╌".repeat(length)}${arrow ? "▶" : ""}`;
		color = "dim";
	}
	return useColors && theme ? theme.fg(color, glyph) : glyph;
}

function combineOutEdgeStates(states: Array<GraphEdgeState | undefined>): GraphEdgeState | undefined {
	const defined = states.filter((s): s is GraphEdgeState => s !== undefined);
	if (defined.length === 0) return undefined;
	if (defined.includes("fired")) return "fired";
	if (defined.includes("dead") && !defined.includes("pending")) return "dead";
	return "pending";
}

function combineInEdgeStates(states: Array<GraphEdgeState | undefined>): GraphEdgeState | undefined {
	const defined = states.filter((s): s is GraphEdgeState => s !== undefined);
	if (defined.length === 0) return undefined;
	if (defined.includes("dead")) return "dead";
	if (defined.every(s => s === "fired")) return "fired";
	return "pending";
}

function padVisible(text: string, targetWidth: number): string {
	const len = visibleLength(text);
	return len >= targetWidth ? text : `${text}${" ".repeat(targetWidth - len)}`;
}

interface BodyLine {
	text: string;
	nodeIds: string[];
}

interface GapEdge {
	srcId: string;
	dstId: string;
	sr: number;
	dr: number;
	state?: GraphEdgeState;
}

interface GapComponent {
	edges: GapEdge[];
	srcs: number[];
	dsts: number[];
	minR: number;
	maxR: number;
	kind: "straight" | "star" | "up_skew" | "down_skew" | "complex";
}

function classifyGapComponents(edges: GapEdge[]): GapComponent[] {
	if (edges.length === 0) return [];
	const parent = edges.map((_, i) => i);
	const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
	const union = (a: number, b: number) => {
		const ra = find(a);
		const rb = find(b);
		if (ra !== rb) parent[ra] = rb;
	};
	for (let i = 0; i < edges.length; i++) {
		for (let j = i + 1; j < edges.length; j++) {
			if (edges[i].sr === edges[j].sr || edges[i].dr === edges[j].dr) {
				union(i, j);
			}
		}
	}
	const groups = new Map<number, GapEdge[]>();
	for (let i = 0; i < edges.length; i++) {
		const root = find(i);
		const list = groups.get(root) ?? [];
		list.push(edges[i]);
		groups.set(root, list);
	}
	const components: GapComponent[] = [];
	for (const group of groups.values()) {
		const srcs = [...new Set(group.map(e => e.sr))].sort((a, b) => a - b);
		const dsts = [...new Set(group.map(e => e.dr))].sort((a, b) => a - b);
		const minR = Math.min(...srcs, ...dsts);
		const maxR = Math.max(...srcs, ...dsts);
		let kind: GapComponent["kind"] = "complex";
		if (srcs.length === 1 && dsts.length === 1 && srcs[0] === dsts[0]) {
			kind = "straight";
		} else if (srcs.length === 1 || dsts.length === 1) {
			kind = "star";
		} else if (srcs.length === 2 && dsts.length === 2 && maxR - minR === 1 && group.length === 3) {
			const r = minR;
			const hasTopLeft = group.some(e => e.sr === r && e.dr === r);
			const hasBotRight = group.some(e => e.sr === r + 1 && e.dr === r + 1);
			const hasDownDiag = group.some(e => e.sr === r && e.dr === r + 1);
			const hasUpDiag = group.some(e => e.sr === r + 1 && e.dr === r);
			if (hasTopLeft && hasBotRight && hasDownDiag && !hasUpDiag) {
				kind = "down_skew";
			} else if (hasTopLeft && hasBotRight && hasUpDiag && !hasDownDiag) {
				kind = "up_skew";
			}
		}
		components.push({ edges: group, srcs, dsts, minR, maxR, kind });
	}
	components.sort((a, b) => a.minR - b.minR || a.maxR - b.maxR);
	return components;
}

/**
 * Render the left-to-right box-drawing graph. Returns null if the layout does not fit in `width`
 * or if edges cannot be drawn unambiguously without crossings.
 */
function renderHorizontal(
	layout: LayoutData,
	width: number,
	isLive: boolean,
	useColors: boolean,
	theme?: GraphTheme,
): BodyLine[] | null {
	const { levels, levelOf, outbound } = layout;
	if (levels.length === 0) return [];

	const numCols = levels.length;
	const numRows = Math.max(...levels.map(col => col.length));
	const colWidths = levels.map(col => Math.max(0, ...col.map(n => visibleLength(formatNodeText(n, useColors, theme)))));

	// Detect skip-level edges (levelOf(dst) - levelOf(src) > 1).
	const skipEdges: Array<{ src: GraphViewNode; dst: GraphViewNode; l1: number; l2: number; state?: GraphEdgeState }> = [];
	for (let l = 0; l < numCols; l++) {
		for (const node of levels[l]) {
			for (const tid of outbound.get(node.id) ?? []) {
				const l2 = levelOf.get(tid);
				if (l2 !== undefined && l2 - l > 1) {
					const dst = levels[l2].find(n => n.id === tid)!;
					skipEdges.push({ src: node, dst, l1: l, l2, state: dst.edgeStates?.[node.id] });
				}
			}
		}
	}

	// Skip-level edges are drawn as horizontal bypass tracks when numRows === 1 and endpoints don't collide;
	// multi-row skip-level graphs fall back to vertical layout with explicit edge annotations.
	if (skipEdges.length > 0) {
		if (numRows > 1 || skipEdges.length > 1) return null;
	}

	// Analyze each column gap independently.
	const gapComponents: GapComponent[][] = [];
	const gapWidths: number[] = [];
	const spacerAfterRow = Array.from({ length: Math.max(0, numRows - 1) }, () => false);

	for (let l = 0; l < numCols - 1; l++) {
		const col = levels[l];
		const nextCol = levels[l + 1];
		const edges: GapEdge[] = [];
		for (let sr = 0; sr < col.length; sr++) {
			const src = col[sr];
			for (const tid of outbound.get(src.id) ?? []) {
				const dr = nextCol.findIndex(n => n.id === tid);
				if (dr >= 0) {
					const dst = nextCol[dr];
					edges.push({ srcId: src.id, dstId: tid, sr, dr, state: dst.edgeStates?.[src.id] });
				}
			}
		}
		const comps = classifyGapComponents(edges);
		for (let i = 0; i < comps.length; i++) {
			if (comps[i].kind === "complex") return null;
			if (i > 0 && comps[i].minR <= comps[i - 1].maxR) return null; // Overlapping components in same gap
			if (comps[i].kind === "down_skew" || comps[i].kind === "up_skew") {
				spacerAfterRow[comps[i].minR] = true;
			}
		}
		gapComponents.push(comps);

		const hasSkew = comps.some(c => c.kind === "down_skew" || c.kind === "up_skew");
		const hasStar = comps.some(c => c.kind === "star");
		const hasSkipTap = skipEdges.some(se => se.l1 === l || se.l2 === l + 1);
		gapWidths.push(hasSkew ? 12 : hasStar || hasSkipTap ? 8 : 5);
	}

	// Leave room between annotations on the same row while keeping the node columns aligned.
	for (let r = 0; r < numRows; r++) {
		let hasLaterAnnotation = false;
		for (let l = numCols - 1; l >= 0; l--) {
			const node = levels[l][r];
			const annotation = node && formatLoopAnnotation(node, useColors, theme);
			if (!annotation) continue;
			if (hasLaterAnnotation) colWidths[l] = Math.max(colWidths[l], visibleLength(annotation) + 1 - gapWidths[l]);
			hasLaterAnnotation = true;
		}
	}

	const lines: BodyLine[] = [];
	const skipEdge = skipEdges[0];

	for (let r = 0; r < numRows; r++) {
		let line = "";
		let annotationLine = "";
		let hasAnnotation = false;
		const rowNodeIds: string[] = [];

		for (let l = 0; l < numCols; l++) {
			const col = levels[l];
			const node = col[r];
			if (node) rowNodeIds.push(node.id);
			const nodeText = node ? formatNodeText(node, useColors, theme) : "";
			const hasMoreRight = levels.slice(l + 1).some(c => c[r] !== undefined);

			if (l < numCols - 1) {
				const nextCol = levels[l + 1];
				const comps = gapComponents[l];
				const comp = comps.find(c => r >= c.minR && r <= c.maxR);
				const gWidth = gapWidths[l];
				const padNode = node ? padVisible(nodeText, colWidths[l]) : " ".repeat(colWidths[l]);

				const hasSkipOut = skipEdge && skipEdge.l1 === l && r === 0;
				const hasSkipIn = skipEdge && skipEdge.l2 === l + 1 && r === 0;

				let connector = " ".repeat(gWidth);
				let hasActiveConnector = false;

				if (gWidth === 5) {
					if (comp && comp.kind === "straight") {
						connector = ` ${edgeSegment(comp.edges[0].state, 2, true, isLive, useColors, theme)} `;
						hasActiveConnector = true;
					}
				} else if (gWidth === 8) {
					if (comp && comp.kind === "straight" && !hasSkipOut && !hasSkipIn) {
						const eState = comp.edges[0].state;
						connector = ` ${edgeSegment(eState, 5, true, isLive, useColors, theme)} `;
						hasActiveConnector = true;
					} else if (comp && (comp.kind === "star" || hasSkipOut || hasSkipIn)) {
						const edgesFromRow = comp.edges.filter(e => e.sr === r);
						const edgesToRow = comp.edges.filter(e => e.dr === r);
						const hasSrc = edgesFromRow.length > 0 || Boolean(hasSkipOut);
						const hasDst = edgesToRow.length > 0 || Boolean(hasSkipIn);
						const outStates = edgesFromRow.map(e => e.state);
						if (hasSkipOut && skipEdge) outStates.push(skipEdge.state);
						const inStates = edgesToRow.map(e => e.state);
						if (hasSkipIn && skipEdge) inStates.push(skipEdge.state);
						const outState = combineOutEdgeStates(outStates);
						const inState = combineInEdgeStates(inStates);
						const leftArm = hasSrc ? ` ${edgeSegment(outState, 2, false, isLive, useColors, theme)}` : "   ";
						const rightArm = hasDst ? `${edgeSegment(inState, 2, true, isLive, useColors, theme)} ` : "    ";

						const effectiveMaxR = hasSkipOut || hasSkipIn ? Math.max(comp.maxR, 1) : comp.maxR;
						let mid = " ";
						if (hasSrc && hasDst) {
							if (hasSkipOut || hasSkipIn) {
								mid = "┬";
							} else {
								mid = r === comp.minR && r === comp.maxR ? "─" : r === comp.minR ? "┬" : r === comp.maxR ? "┴" : "┼";
							}
						} else if (hasSrc) {
							mid = r === comp.minR ? "┐" : r === effectiveMaxR ? "┘" : "┤";
						} else if (hasDst) {
							mid = r === comp.minR ? "┌" : r === comp.maxR ? "└" : "├";
						} else {
							mid = "│";
						}
						connector = `${leftArm}${mid}${rightArm}`;
						hasActiveConnector = true;
					}
				} else if (gWidth === 12 && comp) {
					if (comp.kind === "straight") {
						connector = ` ${edgeSegment(comp.edges[0].state, 9, true, isLive, useColors, theme)} `;
						hasActiveConnector = true;
					} else if (comp.kind === "star") {
						const edgesFromRow = comp.edges.filter(e => e.sr === r);
						const edgesToRow = comp.edges.filter(e => e.dr === r);
						const hasSrc = edgesFromRow.length > 0;
						const hasDst = edgesToRow.length > 0;
						const outState = combineOutEdgeStates(edgesFromRow.map(e => e.state));
						const inState = combineInEdgeStates(edgesToRow.map(e => e.state));
						const leftArm = hasSrc ? ` ${edgeSegment(outState, 2, false, isLive, useColors, theme)}` : "   ";
						const rightArm = hasDst ? `${edgeSegment(inState, 6, true, isLive, useColors, theme)} ` : "        ";
						let mid = "│";
						if (hasSrc && hasDst) {
							mid = r === comp.minR ? "┬" : r === comp.maxR ? "┴" : "┼";
						} else if (hasSrc) {
							mid = r === comp.minR ? "┐" : r === comp.maxR ? "┘" : "┤";
						} else if (hasDst) {
							mid = r === comp.minR ? "┌" : r === comp.maxR ? "└" : "├";
						}
						connector = `${leftArm}${mid}${rightArm}`;
						hasActiveConnector = true;
					} else if (comp.kind === "down_skew") {
						const diag = comp.edges.find(e => e.sr === comp.minR && e.dr === comp.minR + 1)!;
						if (r === comp.minR) {
							const topEdge = comp.edges.find(e => e.sr === r && e.dr === r)!;
							const outState = combineOutEdgeStates([topEdge.state, diag.state]);
							connector = ` ${edgeSegment(outState, 2, false, isLive, useColors, theme)}┬${edgeSegment(topEdge.state, 6, true, isLive, useColors, theme)} `;
						} else {
							const botEdge = comp.edges.find(e => e.sr === r && e.dr === r)!;
							const inState = combineInEdgeStates([botEdge.state, diag.state]);
							connector = ` ${edgeSegment(botEdge.state, 6, false, isLive, useColors, theme)}┴${edgeSegment(inState, 2, true, isLive, useColors, theme)} `;
						}
						hasActiveConnector = true;
					} else if (comp.kind === "up_skew") {
						const diag = comp.edges.find(e => e.sr === comp.minR + 1 && e.dr === comp.minR)!;
						if (r === comp.minR) {
							const topEdge = comp.edges.find(e => e.sr === r && e.dr === r)!;
							const inState = combineInEdgeStates([topEdge.state, diag.state]);
							connector = ` ${edgeSegment(topEdge.state, 2, false, isLive, useColors, theme)}┬${edgeSegment(inState, 6, true, isLive, useColors, theme)} `;
						} else {
							const botEdge = comp.edges.find(e => e.sr === r && e.dr === r)!;
							const outState = combineOutEdgeStates([botEdge.state, diag.state]);
							connector = ` ${edgeSegment(outState, 6, false, isLive, useColors, theme)}┴${edgeSegment(botEdge.state, 2, true, isLive, useColors, theme)} `;
						}
						hasActiveConnector = true;
					}
				}

				const isRowEmptyAfter = !hasMoreRight && !hasActiveConnector;
				line += isRowEmptyAfter ? nodeText : `${padNode}${connector}`;

				const loopText = node ? formatLoopAnnotation(node, useColors, theme) : undefined;
				if (loopText) hasAnnotation = true;
				annotationLine += padVisible(loopText ?? "", colWidths[l] + gWidth);
			} else {
				if (node) line += nodeText;
				const loopText = node ? formatLoopAnnotation(node, useColors, theme) : undefined;
				if (loopText) hasAnnotation = true;
				if (loopText) annotationLine += loopText;
			}
		}

		const trimmedLine = line.trimEnd();
		if (visibleLength(trimmedLine) > width) return null;
		lines.push({ text: trimmedLine, nodeIds: rowNodeIds });
		if (hasAnnotation) {
			const trimmedAnn = annotationLine.trimEnd();
			if (visibleLength(trimmedAnn) > width) return null;
			lines.push({ text: trimmedAnn, nodeIds: [] });
		}

		if (r < numRows - 1 && spacerAfterRow[r]) {
			let spacer = "";
			for (let l = 0; l < numCols - 1; l++) {
				spacer += " ".repeat(colWidths[l]);
				const comp = gapComponents[l].find(c => r >= c.minR && r + 1 <= c.maxR);
				const gWidth = gapWidths[l];
				if (comp && comp.kind === "down_skew" && comp.minR === r) {
					const diag = comp.edges.find(e => e.sr === r && e.dr === r + 1)!;
					const bar = diag.state === "dead" ? colorize(theme, useColors, "error", "└─✗─┐")
						: colorize(theme, useColors, diag.state === "fired" ? "success" : "dim", diag.state === "fired" || !useColors ? "└───┐" : "└╌╌╌┐");
					spacer += `   ${bar}    `;
				} else if (comp && comp.kind === "up_skew" && comp.minR === r) {
					const diag = comp.edges.find(e => e.sr === r + 1 && e.dr === r)!;
					const bar = diag.state === "dead" ? colorize(theme, useColors, "error", "┌─✗─┘")
						: colorize(theme, useColors, diag.state === "fired" ? "success" : "dim", diag.state === "fired" || !useColors ? "┌───┘" : "┌╌╌╌┘");
					spacer += `   ${bar}    `;
				} else if (comp && comp.kind === "star") {
					spacer += gWidth === 12 ? "   │        " : "   │    ";
				} else {
					spacer += " ".repeat(gWidth);
				}
			}
			const trimmedSpacer = spacer.trimEnd();
			if (visibleLength(trimmedSpacer) > width) return null;
			lines.push({ text: trimmedSpacer, nodeIds: [] });
		}
	}

	if (skipEdge) {
		let prefixWidth = 0;
		for (let l = 0; l < skipEdge.l1; l++) {
			prefixWidth += colWidths[l] + gapWidths[l];
		}
		prefixWidth += colWidths[skipEdge.l1] + 3;

		let endX = 0;
		for (let l = 0; l < skipEdge.l2 - 1; l++) {
			endX += colWidths[l] + gapWidths[l];
		}
		endX += colWidths[skipEdge.l2 - 1] + 3;

		const span = Math.max(0, endX - prefixWidth - 1);
		const trackChar = skipEdge.state === "dead" ? "✗" : skipEdge.state === "fired" || !useColors ? "─" : "╌";
		const trackColor = skipEdge.state === "dead" ? "error" : skipEdge.state === "fired" ? "success" : "dim";
		const track = colorize(theme, useColors, trackColor, `└${trackChar.repeat(span)}┘`);
		const bypassLine = `${" ".repeat(prefixWidth)}${track}`;
		if (visibleLength(bypassLine) > width) return null;
		lines.push({ text: bypassLine, nodeIds: [] });
	}

	return lines;
}

function edgeStateMark(state: GraphEdgeState | undefined): { mark: string; color: string } {
	if (state === "fired") return { mark: "✓", color: "success" };
	if (state === "dead") return { mark: "✗", color: "error" };
	return { mark: "…", color: "dim" };
}

/**
 * Render the vertical fallback: one level per row, parallel nodes side by side, labels truncated.
 * Emits explicit edge annotations whenever connectivity between levels is not a simple full join/chain,
 * or in live mode when a level has multiple branches so edge states remain visible.
 */
function renderVertical(
	layout: LayoutData,
	width: number,
	isLive: boolean,
	useColors: boolean,
	theme?: GraphTheme,
): BodyLine[] {
	const lines: BodyLine[] = [];
	const safeWidth = Math.max(4, width);
	const nodeById = new Map<string, GraphViewNode>();
	for (const level of layout.levels) {
		for (const node of level) nodeById.set(node.id, node);
	}

	for (let l = 0; l < layout.levels.length; l++) {
		const col = layout.levels[l];
		const gap = "  ";
		const count = col.length;
		const totalGap = gap.length * Math.max(0, count - 1);
		const perNodeBudget = Math.max(4, Math.floor((safeWidth - totalGap) / Math.max(1, count)));

		const formattedNodes = col.map(node => {
			const raw = formatNodeText(node, useColors, theme);
			if (visibleLength(raw) <= perNodeBudget) return raw;
			const glyph = nodeGlyph(node, useColors, theme);
			const label = node.label ?? node.id;
			const elapsed = node.state === "running" && node.elapsedMs !== undefined ? ` ${formatDuration(node.elapsedMs)}` : "";
			const prefixLen = visibleLength(glyph) + 1;
			const avail = Math.max(1, perNodeBudget - prefixLen);
			return `${glyph} ${truncatePlain(`${label}${elapsed}`, avail)}`;
		});

		const row = truncateVisible(formattedNodes.join(gap), safeWidth);
		lines.push({ text: row, nodeIds: col.map(n => n.id) });

		const loopAnnotations = col
			.map(n => formatLoopAnnotation(n, useColors, theme))
			.filter((a): a is string => Boolean(a));
		if (loopAnnotations.length > 0) {
			lines.push({ text: truncateVisible(loopAnnotations.join(gap), safeWidth), nodeIds: [] });
		}

		if (l < layout.levels.length - 1) {
			const nextCol = layout.levels[l + 1];
			const hasSkipOut = col.some(n =>
				(layout.outbound.get(n.id) ?? []).some(tid => (layout.levelOf.get(tid) ?? l + 1) > l + 1),
			);
			const hasSkipIn = nextCol.some(n =>
				n.inboundEdges.some(sid => {
					const sl = layout.levelOf.get(sid);
					return sl !== undefined && sl < l;
				}),
			);
			const isSimpleToSingleNext =
				nextCol.length === 1 &&
				!hasSkipOut &&
				!hasSkipIn &&
				col.every(n => (layout.outbound.get(n.id) ?? []).includes(nextCol[0].id));

			if (isSimpleToSingleNext && (!isLive || col.length === 1)) {
				lines.push({ text: colorize(theme, useColors, "dim", "↓"), nodeIds: [] });
			} else {
				const outParts: Array<{ plain: string; colored: string }> = [];
				for (const n of col) {
					const targets = layout.outbound.get(n.id) ?? [];
					if (targets.length === 0) continue;
					if (!isLive) {
						const text = `${n.id}→${targets.join(",")}`;
						outParts.push({ plain: text, colored: colorize(theme, useColors, "dim", text) });
					} else {
						const tagged = targets.map(tid => {
							const { mark, color } = edgeStateMark(nodeById.get(tid)?.edgeStates?.[n.id]);
							const plain = `${tid}${mark}`;
							return { plain, colored: colorize(theme, useColors, color, plain) };
						});
						const plain = `${n.id}→${tagged.map(t => t.plain).join(",")}`;
						const colored = `${colorize(theme, useColors, "dim", `${n.id}→`)}${tagged.map(t => t.colored).join(colorize(theme, useColors, "dim", ","))}`;
						outParts.push({ plain, colored });
					}
				}
				if (outParts.length === 0) {
					lines.push({ text: colorize(theme, useColors, "dim", "↓"), nodeIds: [] });
				} else {
					let currentPlain = "↓ ";
					let currentColored = colorize(theme, useColors, "dim", "↓ ");
					for (let i = 0; i < outParts.length; i++) {
						const sep = i === 0 || currentPlain === "  " ? "" : " · ";
						const candidatePlain = `${currentPlain}${sep}${outParts[i].plain}`;
						if (visibleLength(candidatePlain) <= safeWidth || currentPlain === "↓ " || currentPlain === "  ") {
							currentPlain = candidatePlain;
							currentColored = `${currentColored}${colorize(theme, useColors, "dim", sep)}${outParts[i].colored}`;
						} else {
							lines.push({
								text: visibleLength(currentPlain) <= safeWidth ? currentColored : truncateVisible(currentColored, safeWidth),
								nodeIds: [],
							});
							currentPlain = `  ${outParts[i].plain}`;
							currentColored = `  ${outParts[i].colored}`;
						}
					}
					lines.push({
						text: visibleLength(currentPlain) <= safeWidth ? currentColored : truncateVisible(currentColored, safeWidth),
						nodeIds: [],
					});
				}
			}
		}
	}

	return lines;
}

function renderHeader(model: GraphViewModel, width: number, useColors: boolean, theme?: GraphTheme): string {
	const countText = `${model.nodes.length} node${model.nodes.length === 1 ? "" : "s"}`;
	if (model.mode === "plan" || !model.runId) {
		return truncateVisible(`plan · ${model.topology} · ${countText}`, width);
	}
	const glyph = outcomeGlyph(model.outcome, useColors, theme);
	const parts = [`${glyph} run ${model.runId}`, model.topology, countText];
	if (model.outcome) parts.push(model.outcome);
	if (model.cleaned) parts.push("cleaned");
	if (model.elapsedMs !== undefined) parts.push(formatDuration(model.elapsedMs));
	return truncateVisible(parts.join(" · "), width);
}

function renderFooter(model: GraphViewModel, width: number, useColors: boolean, theme?: GraphTheme): string | undefined {
	if (model.mode === "plan" || (model.pendingCount === undefined && model.errorCount === undefined)) {
		return undefined;
	}
	const pending = model.pendingCount ?? 0;
	const errors = model.errorCount ?? 0;
	const errText = `${errors} error${errors === 1 ? "" : "s"}`;
	const text = `${pending} pending · ${errors > 0 ? colorize(theme, useColors, "error", errText) : errText} · bootstrap_status`;
	return truncateVisible(text, width);
}

function applyHeightCap(
	header: string,
	body: BodyLine[],
	footer: string | undefined,
	totalNodes: number,
	maxHeight: number,
	width: number,
): string[] {
	const cap = Math.max(1, Math.floor(maxHeight));
	if (cap === 1) return [header];
	if (footer && cap === 2) return [header, footer];

	const overhead = footer ? 2 : 1;
	const bodyBudget = cap - overhead;
	if (body.length <= bodyBudget) {
		return [header, ...body.map(b => b.text), ...(footer ? [footer] : [])];
	}

	const keep = Math.max(0, bodyBudget - 1);
	const keptBody = body.slice(0, keep);
	const visibleNodes = new Set<string>();
	for (const line of keptBody) {
		for (const id of line.nodeIds) visibleNodes.add(id);
	}
	const hiddenNodes = Math.max(0, totalNodes - visibleNodes.size);
	if (hiddenNodes === 0) {
		return [header, ...body.slice(0, bodyBudget).map(b => b.text), ...(footer ? [footer] : [])];
	}

	return [
		header,
		...keptBody.map(b => b.text),
		truncateVisible(`+${hiddenNodes} more`, width),
		...(footer ? [footer] : []),
	];
}

/**
 * Pure deterministic graph renderer.
 *
 * Lays nodes out left-to-right by longest path from roots with barycenter row ordering.
 * Falls back to a vertical one-level-per-row layout when horizontal lanes exceed `width`
 * or edges cannot be drawn unambiguously, and caps output height with `+N more` hidden nodes.
 */
export function renderGraph(model: GraphViewModel, width: number, theme?: GraphTheme): string {
	const safeWidth = Math.max(4, Math.floor(width));
	const isLive = model.mode !== "plan";
	const useColors = isLive && theme !== undefined;
	const maxHeight = model.maxHeight ?? DEFAULT_MAX_HEIGHT;

	const header = renderHeader(model, safeWidth, useColors, theme);
	const footer = renderFooter(model, safeWidth, useColors, theme);

	if (model.nodes.length === 0) {
		return applyHeightCap(header, [{ text: "(no nodes)", nodeIds: [] }], footer, 0, maxHeight, safeWidth).join("\n");
	}

	const layout = computeLayout(model.nodes);
	const body = renderHorizontal(layout, safeWidth, isLive, useColors, theme) ?? renderVertical(layout, safeWidth, isLive, useColors, theme);
	body.unshift(...layout.cycleEdges.map(({ source, destination }) => ({
		text: truncateVisible(`cycle edge: ${source}→${destination}`, safeWidth), nodeIds: [],
	})));
	return applyHeightCap(header, body, footer, model.nodes.length, maxHeight, safeWidth).join("\n");
}
