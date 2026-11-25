import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import vm from "node:vm";
import { verifyReadOnlyViewer } from "./test-support/factory-viewer-fixture.ts";

function emptyViewerDb(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "fwv-mat-guard-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const statePath = join(root, "factories.sqlite");
	const coordinationPath = join(root, "factory-coordination.sqlite");
	const db = new DatabaseSync(statePath);
	db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT);");
	db.close();
	return { root, statePath, coordinationPath };
}

function stripCssComments(css: string): string {
	return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

function splitSelectorList(header: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let parenDepth = 0;
	let bracketDepth = 0;
	for (const ch of header) {
		if (ch === "(") parenDepth++;
		else if (ch === ")" && parenDepth > 0) parenDepth--;
		else if (ch === "[") bracketDepth++;
		else if (ch === "]" && bracketDepth > 0) bracketDepth--;
		if (ch === "," && parenDepth === 0 && bracketDepth === 0) {
			const trimmed = cur.trim().replace(/\s+/g, " ");
			if (trimmed) parts.push(trimmed);
			cur = "";
		} else {
			cur += ch;
		}
	}
	const tail = cur.trim().replace(/\s+/g, " ");
	if (tail) parts.push(tail);
	return parts;
}

function analyzeCss(css: string): { selectors: string[]; atRules: string[] } {
	const clean = stripCssComments(css);
	const selectors: string[] = [];
	const atRules: string[] = [];
	let buf = "";
	let quote: "'" | '"' | null = null;
	let escaped = false;
	const stack: Array<"at-group" | "at-skip" | "rule"> = [];

	const recordAtRule = (rawHeader: string) => {
		const trimmed = rawHeader.trim().replace(/\s+/g, " ");
		if (!trimmed.startsWith("@")) return;
		const m = /^@([a-z0-9_-]+)/i.exec(trimmed);
		atRules.push(m ? `@${m[1].toLowerCase()}` : "@");
	};

	for (let i = 0; i < clean.length; i++) {
		const ch = clean[i];
		const top = stack[stack.length - 1];
		const inHeaderOrRule = top !== "at-skip";

		if (inHeaderOrRule && quote) {
			buf += ch;
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === quote) {
				quote = null;
			}
			continue;
		}
		if (inHeaderOrRule && (ch === "'" || ch === '"')) {
			quote = ch;
			buf += ch;
			continue;
		}

		if (ch === "{") {
			const header = buf.trim().replace(/\s+/g, " ");
			buf = "";
			if (!inHeaderOrRule) {
				stack.push("at-skip");
			} else if (header.startsWith("@")) {
				recordAtRule(header);
				if (/^@(?:media|supports|layer)(?=$|[\s(])/i.test(header)) {
					stack.push("at-group");
				} else {
					stack.push("at-skip");
				}
			} else {
				const parsed = splitSelectorList(header);
				if (parsed.length) {
					for (const sel of parsed) selectors.push(sel);
				} else if (top === "rule") {
					selectors.push("{}");
				}
				stack.push("rule");
			}
		} else if (ch === ";") {
			if (inHeaderOrRule) {
				if (top !== "rule") recordAtRule(buf);
				buf = "";
			}
		} else if (ch === "}") {
			buf = "";
			stack.pop();
		} else if (inHeaderOrRule) {
			buf += ch;
		}
	}
	if (buf.trim().startsWith("@")) {
		recordAtRule(buf);
	}
	return { selectors, atRules };
}

function extractCssSelectors(css: string): string[] {
	return analyzeCss(css).selectors;
}

function extractCssClassNames(css: string): Set<string> {
	const classes = new Set<string>();
	for (const sel of extractCssSelectors(css)) {
		for (const m of sel.matchAll(/\.([A-Za-z_-][A-Za-z0-9_-]*)/g)) {
			classes.add(m[1]);
		}
	}
	return classes;
}

function extractHtmlClasses(html: string): Set<string> {
	const classes = new Set<string>();
	for (const m of html.matchAll(/\bclass\s*=\s*"([^"]*)"/gi)) {
		for (const cls of m[1].split(/\s+/)) {
			if (cls) classes.add(cls);
		}
	}
	return classes;
}

function extractAppStaticAndComposedClasses(appCode: string): Set<string> {
	const found = new Set<string>();
	const addList = (raw: string) => {
		for (const cls of raw.split(/\s+/)) {
			if (cls) found.add(cls);
		}
	};

	const toneBlock = /const TONE_PALETTE_CLASSES = Object\.freeze\(\{([\s\S]*?)\}\);/.exec(appCode);
	if (toneBlock) {
		for (const m of toneBlock[1].matchAll(/:\s*"([^"]+)"/g)) {
			addList(m[1]);
		}
	}

	for (const m of appCode.matchAll(/\.classList\.(?:add|remove|toggle)\(\s*"([^"]+)"/g)) {
		addList(m[1]);
	}

	for (const m of appCode.matchAll(/\bclass:\s*"([^"]+)"/g)) {
		addList(m[1]);
	}

	// Capture string literals inside `class: <ternary>` expressions and `setAttrIfChanged(..., "class", ...)` / `buildLink(..., "cls")`
	for (const m of appCode.matchAll(/buildLink\([^)]*,\s*"([^"]+)"\s*\)/g)) {
		addList(m[1]);
	}
	for (const m of appCode.matchAll(/\bclass:\s*[^,\n}]+?\?\s*"([^"]+)"\s*:\s*"([^"]*)"/g)) {
		addList(m[1]);
		addList(m[2]);
	}

	// Capture literal class tokens in template strings (including ternary branches inside `${...}`),
	// and explicitly expand known composed class families.
	for (const m of appCode.matchAll(/\b(?:class|gClass|pathClass)\s*:\s*`([^`]+)`/g)) {
		const tmpl = m[1];
		for (const exprMatch of tmpl.matchAll(/\$\{([^}]+)\}/g)) {
			for (const ternMatch of exprMatch[1].matchAll(/\?\s*"([^"]*)"\s*:\s*"([^"]*)"/g)) {
				addList(ternMatch[1]);
				addList(ternMatch[2]);
			}
		}
		for (const token of tmpl.replace(/\$\{[^}]+\}/g, " ").split(/\s+/)) {
			if (token && !token.endsWith("-")) {
				found.add(token);
			}
		}
	}
	if (appCode.includes("edge-${st}")) {
		for (const st of ["pending", "fired", "dead", "unknown"]) found.add(`edge-${st}`);
	}
	if (appCode.includes("edge-allow-partial")) found.add("edge-allow-partial");
	if (appCode.includes("status-${n.status")) {
		for (const st of ["pending", "waiting", "running", "succeeded", "partial", "failed", "blocked", "skipped", "cancelled", "needs_attention", "unknown"]) {
			found.add(`status-${st}`);
		}
	}
	return found;
}

const PERMANENT_CLASS_ALLOWLIST = new Set([
	// 1. Run graph SVG
	"graph-svg",
	"graph-edges-layer",
	"graph-nodes-layer",
	"edge-dep",
	"edge-allow-partial",
	"edge-pending",
	"edge-fired",
	"edge-dead",
	"edge-unknown",
	"edge-feedback",
	"edge-label-bg",
	"edge-label-text",
	"graph-node",
	"node-box",
	"node-title",
	"node-status-line",
	"node-meta-line",
	"selected",
	"status-pending",
	"status-waiting",
	"status-running",
	"status-succeeded",
	"status-partial",
	"status-failed",
	"status-blocked",
	"status-skipped",
	"status-cancelled",
	"status-needs_attention",
	"status-unknown",
	// 3. Skip link and screen-reader-only text
	"skip-link",
	"sr-only",
	// 5. Drawer open state
	"open",
	// 7. Table scroll wrapper
	"table-wrap",
	// 9. Wrapping for long identifiers
	"mono",
]);

const TEMPORARY_LEGACY_CLASS_ALLOWLIST = new Set<string>();

const PERMANENT_STYLE_SELECTORS_BY_CATEGORY = {
	// 1. Run graph SVG, using Materialize palette hex values
	category1RunGraphSvg: [
		"svg.graph-svg",
		".edge-dep",
		".edge-dep.edge-allow-partial",
		".edge-dep.edge-dead",
		".edge-dep.edge-fired",
		".edge-feedback",
		".edge-label-bg",
		".edge-label-text",
		".graph-node",
		".graph-node rect.node-box",
		".graph-node.status-running rect.node-box",
		".graph-node.status-succeeded rect.node-box",
		".graph-node.status-waiting rect.node-box",
		".graph-node.status-partial rect.node-box",
		".graph-node.status-blocked rect.node-box",
		".graph-node.status-failed rect.node-box",
		".graph-node.status-needs_attention rect.node-box",
		".graph-node.selected rect.node-box",
		".graph-node:focus rect.node-box",
		".graph-node text",
		".node-title",
		".node-status-line",
		".node-meta-line",
	],
	// 2. Focus outlines
	category2FocusOutlines: [
		"a:focus-visible",
		"button:focus-visible",
		"input:focus-visible",
		"select:focus-visible",
		"summary:focus-visible",
		"[tabindex]:focus-visible",
		"nav a:focus-visible",
		"nav button:focus-visible",
		".sidenav .collection-item.active:focus-visible",
	],
	// 3. Skip link and screen-reader-only text
	category3SkipAndSrOnly: [
		".skip-link",
		".skip-link:focus",
		".sr-only",
	],
	// 4. Reduced motion
	category4ReducedMotion: [
		"*",
		"*::before",
		"*::after",
	],
	// 5. Drawer open/closed state, overlay visibility, 300px content offset
	category5DrawerAndOffset: [
		"header",
		"main",
		".sidenav-overlay",
		".sidenav.sidenav-fixed:not(.open)",
		".sidenav.sidenav-fixed.open",
		".sidenav-overlay:not([hidden])",
	],
	// 6. Accordion body shown when open, and native open/closed marker kept
	category6Accordion: [
		"details[open] > .collapsible-body",
		"summary.collapsible-header",
	],
	// 7. Table scroll wrapper
	category7TableScroll: [
		".table-wrap",
		".table-wrap .chip",
	],
	// 8. Heading sizes: h1-h4 use v1's own h5/h6 sizes and margins; levels are unchanged
	category8HeadingSizes: [
		"h1",
		"h2",
		"h3",
		"h4",
		"nav h1.brand-logo",
	],
	// 9. Wrapping for long identifiers
	category9Wrapping: [
		"code",
		".mono",
		"#content .btn",
		"#content .btn-flat",
		".collection .collection-item",
		"dd",
	],
	// 10. Contrast fixes and content-link underlines
	category10ContrastAndUnderlines: [
		"#content a:not(.btn):not(.btn-flat)",
		"#content a:not(.btn):not(.btn-flat):hover",
	],
};

const TEMPORARY_LEGACY_STYLE_SELECTORS = new Set<string>();

function validateClassesAgainstAllowlist(usedClasses: Iterable<string>, materializeClasses: Set<string>): void {
	const unknown: string[] = [];
	for (const cls of usedClasses) {
		if (!materializeClasses.has(cls) && !PERMANENT_CLASS_ALLOWLIST.has(cls) && !TEMPORARY_LEGACY_CLASS_ALLOWLIST.has(cls)) {
			unknown.push(cls);
		}
	}
	assert.deepEqual(unknown, [], `Unexpected classes not in materialize.min.css or allowlist: ${unknown.join(", ")}`);
}

const ALLOWED_LOCAL_AT_RULES = new Set(["@media", "@supports"]);

function validateLocalSelectorsAgainstAllowlist(localCss: string): void {
	assert.doesNotMatch(localCss, /--fv-[a-z0-9-]+/i, "style.css must not contain --fv-* tokens");
	assert.doesNotMatch(localCss, /font-family\s*:\s*system-ui/i, "style.css must not override Materialize font-family");

	const { selectors, atRules } = analyzeCss(localCss);
	const unexpectedAtRules = atRules.filter((at) => !ALLOWED_LOCAL_AT_RULES.has(at));
	assert.deepEqual(unexpectedAtRules, [], `Unexpected at-rules in style.css (only @media and @supports allowed): ${unexpectedAtRules.join(", ")}`);

	const permanentAllowed = new Set(Object.values(PERMANENT_STYLE_SELECTORS_BY_CATEGORY).flat());
	const unexpected = selectors.filter((sel) => !permanentAllowed.has(sel) && !TEMPORARY_LEGACY_STYLE_SELECTORS.has(sel));
	assert.deepEqual(unexpected, [], `Unexpected selectors in style.css not on allowlist: ${unexpected.join(", ")}`);
}

function validateNoStaleTemporaryEntries(localCss: string, usedClasses: Set<string>): void {
	assert.equal(TEMPORARY_LEGACY_CLASS_ALLOWLIST.size, 0, "TEMPORARY_LEGACY_CLASS_ALLOWLIST must be empty in Slice 3");
	assert.equal(TEMPORARY_LEGACY_STYLE_SELECTORS.size, 0, "TEMPORARY_LEGACY_STYLE_SELECTORS must be empty in Slice 3");

	const cssSelectors = new Set(extractCssSelectors(localCss));
	const staleSelectors = [...TEMPORARY_LEGACY_STYLE_SELECTORS].filter((sel) => !cssSelectors.has(sel));
	assert.deepEqual(
		staleSelectors,
		[],
		`Stale entries in TEMPORARY_LEGACY_STYLE_SELECTORS not present in style.css: ${staleSelectors.join(", ")}`,
	);

	const staleClasses = [...TEMPORARY_LEGACY_CLASS_ALLOWLIST].filter((cls) => !usedClasses.has(cls));
	assert.deepEqual(
		staleClasses,
		[],
		`Stale entries in TEMPORARY_LEGACY_CLASS_ALLOWLIST not present in used classes: ${staleClasses.join(", ")}`,
	);

	const deadAllowlistedSelectors = Object.values(PERMANENT_STYLE_SELECTORS_BY_CATEGORY)
		.flat()
		.filter((sel) => !cssSelectors.has(sel));
	assert.deepEqual(
		deadAllowlistedSelectors,
		[],
		`Dead selectors in PERMANENT_STYLE_SELECTORS_BY_CATEGORY not present in style.css: ${deadAllowlistedSelectors.join(", ")}`,
	);
}

/* ---------- DOM Test Harness (reusing existing fake-DOM + node:vm seam) ---------- */

class FakeNode {
	parentNode: FakeNode | null = null;
	remove() {
		if (this.parentNode && "children" in this.parentNode) {
			const parent = this.parentNode as FakeElement;
			parent.children = parent.children.filter((c) => c !== this);
			this.parentNode = null;
		}
	}
}

class FakeTextNode extends FakeNode {
	nodeType = 3;
	#text: string;
	constructor(text: string) {
		super();
		this.#text = String(text);
	}
	get textContent() { return this.#text; }
	set textContent(v: string) { this.#text = String(v); }
}

class FakeElement extends FakeNode {
	nodeType = 1;
	tagName: string;
	namespaceURI: string | null;
	children: FakeNode[] = [];
	attributes = new Map<string, string>();
	listeners = new Map<string, Array<(e: any) => void>>();
	style: Record<string, string> = {};
	offsetLeft = 0;
	offsetWidth = 90;
	value = "";
	disabled = false;
	selected = false;
	open = false;
	inert = false;
	clientWidth = 800;
	#ownerDoc: { activeElement: FakeNode } | null = null;
	classList: {
		add: (...cls: string[]) => void;
		remove: (...cls: string[]) => void;
		toggle: (cls: string, force?: boolean) => boolean;
		contains: (cls: string) => boolean;
	};
	dataset: Record<string, string>;

	constructor(tagName: string, namespaceURI: string | null = null, ownerDoc: { activeElement: FakeNode } | null = null) {
		super();
		this.tagName = tagName.toLowerCase();
		this.namespaceURI = namespaceURI;
		this.#ownerDoc = ownerDoc;
		const attrs = this.attributes;
		const getClasses = () => (attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
		const setClasses = (list: string[]) => {
			if (list.length) attrs.set("class", list.join(" "));
			else attrs.delete("class");
		};
		this.classList = {
			add: (...cls) => {
				const set = new Set(getClasses());
				for (const c of cls) set.add(c);
				setClasses([...set]);
			},
			remove: (...cls) => {
				const drop = new Set(cls);
				setClasses(getClasses().filter((c) => !drop.has(c)));
			},
			toggle: (cls, force) => {
				const set = new Set(getClasses());
				const next = force === undefined ? !set.has(cls) : Boolean(force);
				if (next) set.add(cls);
				else set.delete(cls);
				setClasses([...set]);
				return next;
			},
			contains: (cls) => getClasses().includes(cls),
		};
		this.dataset = new Proxy({}, {
			get(_t, prop) {
				if (typeof prop !== "string") return undefined;
				return attrs.get(`data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`);
			},
			set(_t, prop, val) {
				if (typeof prop !== "string") return false;
				attrs.set(`data-${prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`, String(val));
				return true;
			},
		});
	}

	get id() { return this.attributes.get("id") ?? ""; }
	set id(v: string) { this.attributes.set("id", String(v)); }
	get firstChild() { return this.children[0] ?? null; }
	get lastChild() { return this.children[this.children.length - 1] ?? null; }
	get textContent(): string {
		return this.children.map((c) => (c as FakeTextNode | FakeElement).textContent).join("");
	}
	set textContent(v: string) {
		this.children = v === "" ? [] : [new FakeTextNode(String(v))];
	}
	setAttribute(k: string, v: string) {
		this.attributes.set(k, String(v));
		if (k === "value") this.value = String(v);
		if (k === "open") this.open = true;
		if (k === "inert") this.inert = true;
	}
	getAttribute(k: string) { return this.attributes.has(k) ? this.attributes.get(k)! : null; }
	removeAttribute(k: string) {
		this.attributes.delete(k);
		if (k === "open") this.open = false;
		if (k === "inert") this.inert = false;
	}
	hasAttribute(k: string) { return this.attributes.has(k); }
	append(...nodes: Array<FakeNode | string>) {
		for (const n of nodes) {
			const child = typeof n === "string" ? new FakeTextNode(n) : n;
			child.remove();
			child.parentNode = this;
			this.children.push(child);
		}
	}
	insertBefore(newNode: FakeNode, refNode: FakeNode | null) {
		newNode.remove();
		newNode.parentNode = this;
		if (!refNode) {
			this.children.push(newNode);
			return newNode;
		}
		const idx = this.children.indexOf(refNode);
		if (idx === -1) this.children.push(newNode);
		else this.children.splice(idx, 0, newNode);
		return newNode;
	}
	replaceChildren(...nodes: Array<FakeNode | string>) {
		for (const ch of this.children) ch.parentNode = null;
		this.children = [];
		this.append(...nodes);
	}
	addEventListener(type: string, fn: (e: any) => void) {
		const list = this.listeners.get(type) ?? [];
		list.push(fn);
		this.listeners.set(type, list);
	}
	removeEventListener(type: string, fn: (e: any) => void) {
		const list = this.listeners.get(type);
		if (list) this.listeners.set(type, list.filter((f) => f !== fn));
	}
	contains(other: FakeNode | null): boolean {
		let cur = other;
		while (cur) {
			if (cur === this) return true;
			cur = cur.parentNode;
		}
		return false;
	}
	focus() {
		if (this.#ownerDoc) this.#ownerDoc.activeElement = this;
	}
	scrollIntoView() {}
	closest(sel: string) {
		let cur: FakeNode | null = this;
		while (cur) {
			if (cur instanceof FakeElement && matchesSelector(cur, sel)) return cur;
			cur = cur.parentNode;
		}
		return null;
	}
	setPointerCapture() {}
	querySelectorAll(sel: string): FakeElement[] {
		const out: FakeElement[] = [];
		const walk = (node: FakeNode) => {
			if (node instanceof FakeElement) {
				if (matchesSelector(node, sel)) out.push(node);
				for (const ch of node.children) walk(ch);
			}
		};
		for (const ch of this.children) walk(ch);
		return out;
	}
	querySelector(sel: string): FakeElement | null {
		return this.querySelectorAll(sel)[0] ?? null;
	}
}

function matchesSelector(el: FakeElement, sel: string): boolean {
	for (const part of sel.split(",")) {
		const s = part.trim();
		if (s.startsWith("#") && el.id === s.slice(1)) return true;
		if (s.startsWith(".") && el.classList.contains(s.slice(1))) return true;
		if (s === "[data-view]" && el.hasAttribute("data-view")) return true;
		if (s === "a[href]" && el.tagName === "a" && el.hasAttribute("href")) return true;
		if (s === "button:not([disabled])" && el.tagName === "button" && !el.disabled && !el.hasAttribute("disabled")) return true;
		if (/^[a-z]+$/i.test(s) && el.tagName === s.toLowerCase()) return true;
	}
	return false;
}

function collectAllElements(rootEl: FakeElement): FakeElement[] {
	const out: FakeElement[] = [];
	const walk = (n: FakeNode) => {
		if (n instanceof FakeElement) {
			out.push(n);
			for (const ch of n.children) walk(ch);
		}
	};
	walk(rootEl);
	return out;
}

type FetchHandler = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

function bootShellApp(
	viewerUrl: string,
	safeCode: string,
	appCode: string,
	initialSearch: string,
	fetchHandler: FetchHandler,
	options: { narrow?: boolean } = {},
) {
	const docListeners = new Map<string, Array<(e: any) => void>>();
	const winListeners = new Map<string, Array<(e: any) => void>>();
	let isNarrow = Boolean(options.narrow);

	const body = new FakeElement("body");
	const documentElement = new FakeElement("html");
	const fakeDocument: any = {
		body,
		documentElement,
		activeElement: body,
		hidden: false,
		createElement: (tag: string) => new FakeElement(tag, null, fakeDocument),
		createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns, fakeDocument),
		createTextNode: (txt: string) => new FakeTextNode(txt),
		getElementById: (id: string) => collectAllElements(body).find((e) => e.id === id) ?? null,
		querySelector: (sel: string) => body.querySelector(sel),
		querySelectorAll: (sel: string) => body.querySelectorAll(sel),
		addEventListener: (type: string, fn: (e: any) => void) => {
			const list = docListeners.get(type) ?? [];
			list.push(fn);
			docListeners.set(type, list);
		},
	};

	const skipLink = new FakeElement("a", null, fakeDocument);
	skipLink.setAttribute("class", "skip-link");
	skipLink.setAttribute("href", "#main-content");

	const header = new FakeElement("header", null, fakeDocument);
	const viewsNav = new FakeElement("nav", null, fakeDocument);
	viewsNav.setAttribute("class", "nav-extended blue-grey darken-3");
	viewsNav.setAttribute("aria-label", "Views");
	const menuToggle = new FakeElement("button", null, fakeDocument);
	menuToggle.id = "menu-toggle";
	menuToggle.setAttribute("class", "btn-flat white-text sidenav-trigger hide-on-large-only");
	menuToggle.setAttribute("aria-expanded", "false");
	menuToggle.setAttribute("aria-controls", "sidebar");
	const headerScope = new FakeElement("span", null, fakeDocument);
	headerScope.id = "header-scope";
	headerScope.setAttribute("class", "right hide-on-med-and-down");
	const tabsList = new FakeElement("ul", null, fakeDocument);
	tabsList.setAttribute("class", "tabs tabs-transparent");

	const viewNames = ["factories", "live", "inspect", "queue", "receipts", "requests", "proposals"];
	viewNames.forEach((v, idx) => {
		const li = new FakeElement("li", null, fakeDocument);
		li.setAttribute("class", "tab");
		li.offsetLeft = idx * 110;
		li.offsetWidth = 100 + idx * 5;
		const tab = new FakeElement("a", null, fakeDocument);
		tab.setAttribute("data-view", v);
		li.append(tab);
		tabsList.append(li);
	});
	const tabIndicator = new FakeElement("li", null, fakeDocument);
	tabIndicator.setAttribute("class", "indicator");
	tabsList.append(tabIndicator);
	viewsNav.append(menuToggle, headerScope, tabsList);
	header.append(viewsNav);

	const drawerBackdrop = new FakeElement("div", null, fakeDocument);
	drawerBackdrop.id = "drawer-backdrop";
	drawerBackdrop.setAttribute("class", "sidenav-overlay");
	drawerBackdrop.setAttribute("hidden", "");

	const sidebar = new FakeElement("aside", null, fakeDocument);
	sidebar.id = "sidebar";
	sidebar.setAttribute("class", "sidenav sidenav-fixed");
	const drawerClose = new FakeElement("button", null, fakeDocument);
	drawerClose.id = "drawer-close";
	drawerClose.setAttribute("class", "btn-flat teal-text text-darken-3 hide-on-large-only right");
	const factoriesNav = new FakeElement("div", null, fakeDocument);
	factoriesNav.setAttribute("role", "navigation");
	factoriesNav.setAttribute("aria-label", "Factories");
	const factoriesList = new FakeElement("div", null, fakeDocument);
	factoriesList.id = "factories-list";
	factoriesList.setAttribute("class", "collection");
	factoriesNav.append(factoriesList);
	sidebar.append(drawerClose, factoriesNav);

	const mainContent = new FakeElement("main", null, fakeDocument);
	mainContent.id = "main-content";
	const viewHeading = new FakeElement("h2", null, fakeDocument);
	viewHeading.id = "view-heading";
	const factorySubtitle = new FakeElement("p", null, fakeDocument);
	factorySubtitle.id = "factory-subtitle";
	const content = new FakeElement("section", null, fakeDocument);
	content.id = "content";
	content.setAttribute("aria-busy", "false");
	mainContent.append(viewHeading, factorySubtitle, content);

	body.append(skipLink, header, drawerBackdrop, sidebar, mainContent);

	const pushHistory: string[] = [];
	const locationObj = { origin: viewerUrl, pathname: "/", search: initialSearch };
	const mqlListeners: Array<() => void> = [];

	const context: Record<string, any> = {
		URL,
		URLSearchParams,
		Object,
		Set,
		Map,
		Array,
		String,
		Boolean,
		Number,
		Math,
		Promise,
		Error,
		TypeError,
		AbortController,
		Node: FakeNode,
		Element: FakeElement,
		document: fakeDocument,
		location: locationObj,
		history: {
			pushState(_s: unknown, _t: string, nextUrl: string) {
				pushHistory.push(nextUrl);
				const parsed = new URL(nextUrl, viewerUrl);
				locationObj.pathname = parsed.pathname;
				locationObj.search = parsed.search;
			},
		},
		fetch: (url: string, init?: { signal?: AbortSignal }) => fetchHandler(url, init),
		setTimeout,
		clearTimeout,
		matchMedia: (q: string) => ({
			matches: q.includes("992px") ? isNarrow : false,
			addEventListener: (_t: string, fn: () => void) => { mqlListeners.push(fn); },
		}),
		getComputedStyle: () => ({ display: "block", visibility: "visible" }),
		addEventListener: (type: string, fn: (e: any) => void) => {
			const list = winListeners.get(type) ?? [];
			list.push(fn);
			winListeners.set(type, list);
		},
	};
	context.window = context;
	context.globalThis = context;

	vm.runInNewContext(safeCode, context);
	vm.runInNewContext(appCode, context);

	const triggerResize = (nextNarrow: boolean, tabWidthBase = 100) => {
		isNarrow = nextNarrow;
		const lis = tabsList.children.filter((c): c is FakeElement => c instanceof FakeElement && c.classList.contains("tab"));
		lis.forEach((li, idx) => {
			li.offsetLeft = idx * (tabWidthBase + 10);
			li.offsetWidth = tabWidthBase;
		});
		for (const fn of winListeners.get("resize") ?? []) fn({});
	};

	const dispatchDocKey = (key: string, shiftKey = false) => {
		let prevented = false;
		const ev = { key, shiftKey, preventDefault() { prevented = true; } };
		for (const fn of docListeners.get("keydown") ?? []) fn(ev);
		return prevented;
	};

	const dispatchWindowPopstate = (nextSearch: string) => {
		locationObj.search = nextSearch;
		for (const fn of winListeners.get("popstate") ?? []) fn({});
	};

	return {
		context,
		body,
		skipLink,
		header,
		viewsNav,
		tabsList,
		tabIndicator,
		menuToggle,
		drawerClose,
		drawerBackdrop,
		sidebar,
		factoriesList,
		mainContent,
		content,
		fakeDocument,
		locationObj,
		pushHistory,
		triggerResize,
		dispatchDocKey,
		dispatchWindowPopstate,
		collectRenderedClasses: () => {
			const used = new Set<string>();
			for (const el of collectAllElements(body)) {
				const raw = el.getAttribute("class") ?? "";
				for (const cls of raw.split(/\s+/)) {
					if (cls) used.add(cls);
				}
			}
			return used;
		},
	};
}

const jsonResp = (status: number, bodyObj: unknown) => ({
	ok: status >= 200 && status < 300,
	status,
	text: async () => JSON.stringify(bodyObj),
});

const flushMicrotasks = async () => {
	for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

test("Materialize guard: every served shell and emitted class exists in materialize.min.css or allowlist, style.css selectors match 10 categories, and negative controls fail", async (t) => {
	const { root, statePath, coordinationPath } = emptyViewerDb(t);
	await verifyReadOnlyViewer(
		{ stateDirs: root, viewerOptions: { statePath, coordinationPath, host: "127.0.0.1", port: 0 } },
		async (viewer) => {
			const [html, css, matCss, safeCode, appCode] = await Promise.all([
				fetch(`${viewer.url}/`).then((r) => r.text()),
				fetch(`${viewer.url}/style.css`).then((r) => r.text()),
				fetch(`${viewer.url}/vendor/materialize/materialize.min.css`).then((r) => r.text()),
				fetch(`${viewer.url}/safe.js`).then((r) => r.text()),
				fetch(`${viewer.url}/app.js`).then((r) => r.text()),
			]);

			const materializeClasses = extractCssClassNames(matCss);

			// 1. Validate served style.css selectors against the 10-category + temporary legacy allowlists
			validateLocalSelectorsAgainstAllowlist(css);

			// 2. Validate served index.html classes and app.js static/composed/toggled classes
			const usedClasses = new Set<string>([
				...extractHtmlClasses(html),
				...extractAppStaticAndComposedClasses(appCode),
			]);

			// 3. Exercise served app.js in the DOM harness across loading, error, empty, sidebar sections, narrow drawer, and all 7 views
			const fixtures: Record<string, unknown> = {
				"/api/factories": {
					factories: [{ factory_id: "fac_1", name: "Alpha", current_version: "v2", management: "managed" }],
					deleted: [{ factory_id: "fac_del", name: "Retired", current_version: "v1", management: "managed", deleted: true, deletion: { deleted_at: "2026-11-25T10:00:00Z" } }],
					damaged: [{ factory_id: "fac_dmg", name: "Damaged", current_version: "v1", damaged: true, evidence: "unavailable", status: "uncertain", explanation: "Corrupt" }],
				},
				"/api/factories/fac_1/live": {
					factory_id: "fac_1",
					current_version: "v2",
					checked_at: "2026-11-25T12:00:00Z",
					state: "running",
					reason: "Running",
					run: { run_id: "run-1", attempt_id: "att-1", bound_version: "v1" },
					outcome: "incomplete",
					settlement: "unsettled",
					capacity_release: "held",
					launch_blocker: { kind: "held", explanation: "Checkout held" },
					head_status: { eligible: false, blocking_kind: "stopped", explanation: "Stopped" },
					graph: {
						evidence: "available",
						bound_version: "v1",
						topology: "graph",
						nodes: [
							{ id: "left", kind: "agent", status: "succeeded", parked: true, current_attempt: { attempt_id: "left.1", attempt_number: 1, max_attempts: 2, instance_id: "i1", process_state: "idle", resource_state: "open", started_at: "t0", updated_at: "t1", completed_at: "t2" }, configuration_link: { href: "/?factory=fac_1&view=inspect&version=v1&node=left", node_id: "left", version: "v1" } },
							{ id: "right", kind: "command", status: "running", current_attempt: { attempt_id: "right.1", attempt_number: 1, max_attempts: 2, instance_id: "i2", process_state: "alive", resource_state: "open", causes: [{ node_id: "left", state: "blocked", reason: "Wait", check: { name: "lint", evidence: "passed" } }] } },
							{ id: "merge", kind: "agent", status: "failed", join: { policy: "allow_partial", sources: ["left", "right"] } },
						],
						edges: [
							{ from: "left", to: "merge", kind: "dependency", dependency_policy: "require_success", state: "fired" },
							{ from: "right", to: "merge", kind: "dependency", dependency_policy: "allow_partial", state: "dead" },
							{ from: "merge", to: "left", kind: "feedback", reject: "reject", max_revisions: 2 },
						],
					},
				},
				"/api/factories/fac_1/inspect": {
					factory_id: "fac_1",
					current_version: "v2",
					inspected_version: "v1",
					evidence: "available",
					attention_summary: {
						name: "Alpha",
						management: { state: "managed", explanation: "Managed" },
						stop_state: { state: "active", explanation: "Active" },
						capacity: { queue_used: 1, queue_limit: 4, factory_slot: { state: "held" }, checkout_slot: { state: "held" }, blocking_hold: { explanation: "Active" } },
						queue_head: { explanation: "Head" },
						attention: { items: [{ kind: "uncertain", label: "Check", explanation: "Review", detail_view: "requests", detail_url: "/api/factories/fac_1/requests" }] },
					},
					target_node: { verified: true, version: "v1", node: { id: "left", anchor: "left" }, explanation: "Found" },
					damaged_records: { count: 1, explanation: "One damaged", items: [{ scope: "version", version: "v0", absence: "evidence unavailable", explanation: "Bad JSON" }] },
					versions: [{ version: "v1", current: false, inspected: true, restored_from: { absence: "not applicable" }, digest: "abcdef0123456789abcd", created_at: "t0", evidence: "available" }],
					definition: {
						version: "v1",
						topology: "graph",
						restored_from: { absence: "not applicable" },
						nodes: [{
							id: "left",
							anchor: "left",
							kind: "agent",
							persona: { name: "builder" },
							model: { id: "m1", thinking: "medium" },
							dependencies: { items: [] },
							join: { absence: "not applicable" },
							decision: { absence: "not applicable" },
							feedback_target: { absence: "not applicable" },
							required_checks: { items: ["test"] },
						}],
						limits: { max_total_attempts: 3, max_total_attempts_source: "built-in", ready_timeout_ms: 1000, task_timeout_ms: { value: 2000, inherited: true }, dependency_wait_timeout_ms: 3000, liveness_timeout_ms: 4000, cancel_grace_ms: 500 },
					},
					operation_evidence: { attempts: { explanation: "1" }, admission: { explanation: "1" }, bound_versions: { explanation: "1" }, capacity: { explanation: "1" }, requests: { explanation: "0" }, proposals: { explanation: "0" }, attention: { explanation: "1" } },
				},
				"/api/factories/fac_1/queue?filter=open": {
					factory_id: "fac_1",
					filter: "open",
					evidence: "available",
					explanation: "Open queue",
					entries: [{ queue_position: 1, reference: "ref-1", bound_version: "v1", bound_version_evidence: "unavailable", disposition: "queued", disposition_explanation: "Waiting", uncertain: true, accepted_at: "t0", is_head: true, receipt_url: "/?factory=fac_1&view=receipts&reference=ref-1" }],
				},
				"/api/factories/fac_1/receipts?reference=ref-1": {
					type: "receipt",
					factory_id: "fac_1",
					reference: "ref-1",
					input_id: "in-1",
					queue_position: 1,
					accepted_at: "t0",
					bound_version: "v1",
					current_version: "v2",
					disposition: "running",
					disposition_explanation: "Running",
					attempt: { attempt_id: "att-1", state: "released", state_explanation: "Released", bound_version: "v1", task_id: "task-1", request_id: "req-1", release_authorized: true, release_authorized_at: "t0", created_at: "t0", updated_at: "t1", uncertain: true },
				},
				"/api/factories/fac_1/requests": {
					factory_id: "fac_1",
					evidence: "available",
					explanation: "Requests",
					records: [{ request_id: "req-1", kind: "direction", state: "pending", uncertain: true, uncertainty: "Uncertain", question: "Proceed?", node_id: "left", node_attempt_id: "left.1", response_recorded: false, response_consumed: false, reconciliation: "pending", choices: [{ choice_id: "ok", label: "OK", route: "approve" }] }],
				},
				"/api/factories/fac_1/proposals": {
					factory_id: "fac_1",
					evidence: "available",
					explanation: "Proposals",
					records: [{ proposal_id: "prop-1", action: "add", reference: "ref-1", text: "Rule", provenance: { source: "agent", run_id: "r1", attempt_id: "a1", evidence_ref: "e1" }, outcome: "pending", outcome_explanation: "Pending", file_sync_state: { absence: "not applicable" }, uncertain: false }],
				},
			};

			// Loading state + 503 error state + narrow drawer open/close
			const appErr = bootShellApp(viewer.url, safeCode, appCode, "", async () => jsonResp(503, { error: "Down" }), { narrow: true });
			for (const c of appErr.collectRenderedClasses()) usedClasses.add(c); // loading state classes
			await flushMicrotasks();
			for (const c of appErr.collectRenderedClasses()) usedClasses.add(c); // error state classes
			for (const fn of appErr.menuToggle.listeners.get("click") ?? []) fn({});
			for (const c of appErr.collectRenderedClasses()) usedClasses.add(c); // open drawer classes
			appErr.dispatchDocKey("Escape");

			// All 7 views + graph node selection
			const app = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=live", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			for (const c of app.collectRenderedClasses()) usedClasses.add(c);
			const nodeLeft = app.content.querySelectorAll("g").find((g) => g.getAttribute("data-node-id") === "left");
			if (nodeLeft) {
				for (const fn of nodeLeft.listeners.get("click") ?? []) fn({});
			}
			for (const c of app.collectRenderedClasses()) usedClasses.add(c);

			for (const viewName of ["factories", "inspect", "queue", "requests", "proposals"]) {
				const tab = app.viewsNav.querySelectorAll("[data-view]").find((el) => el.getAttribute("data-view") === viewName)!;
				for (const fn of tab.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();
				for (const c of app.collectRenderedClasses()) usedClasses.add(c);
			}
			const appRec = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=receipts&reference=ref-1", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			for (const c of appRec.collectRenderedClasses()) usedClasses.add(c);

			// Stale live-banner state
			app.context.mountOrPatchLiveView(fixtures["/api/factories/fac_1/live"], null, {
				lastCheckedAt: "2026-11-25T12:00:00Z",
				reason: "Refresh failed",
				detail: "",
			});
			for (const c of app.collectRenderedClasses()) usedClasses.add(c);

			validateClassesAgainstAllowlist(usedClasses, materializeClasses);
			validateNoStaleTemporaryEntries(css, usedClasses);

			// 4. Negative controls: invented class & invented selector must each fail
			assert.throws(
				() => validateClassesAgainstAllowlist(["blue-grey", "fv-invented-widget"], materializeClasses),
				{ name: "AssertionError" },
				"Negative control: invented class must fail guard",
			);
			assert.throws(
				() => validateClassesAgainstAllowlist(
					extractAppStaticAndComposedClasses('el.classList.toggle("fv-invented-toggle", true);'),
					materializeClasses,
				),
				{ name: "AssertionError" },
				"Negative control: invented toggled class in app.js must fail guard",
			);
			assert.throws(
				() => validateLocalSelectorsAgainstAllowlist(".fv-invented-card { padding: 8px; }"),
				{ name: "AssertionError" },
				"Negative control: invented selector in style.css must fail guard",
			);
			assert.throws(
				() => validateLocalSelectorsAgainstAllowlist("@media (max-width: 600px) { .fv-invented-mobile { display: none; } }"),
				{ name: "AssertionError" },
				"Negative control: invented media-query selector in style.css must fail guard",
			);
			assert.throws(
				() => validateLocalSelectorsAgainstAllowlist('@charset "utf-8"; .fv-evil { color: red }'),
				{ name: "AssertionError" },
				"Negative control: @charset followed by invented selector must fail guard",
			);
			assert.throws(
				() => validateLocalSelectorsAgainstAllowlist('@font-face { font-family: "Evil"; src: local("Arial"); }'),
				{ name: "AssertionError" },
				"Negative control: @font-face block in style.css must fail guard",
			);
			assert.throws(
				() => validateLocalSelectorsAgainstAllowlist(".mono { .fv-evil {} }"),
				{ name: "AssertionError" },
				"Negative control: nested selector inside rule frame must fail guard",
			);
			assert.throws(
				() => validateLocalSelectorsAgainstAllowlist(".mono { color:red; .fv-evil { color:red } }"),
				{ name: "AssertionError" },
				"Negative control: nested selector after declaration inside rule frame must fail guard",
			);
		},
	);
});

test("Shell behaviour: tab hrefs, unavailable tabs, .active/aria-current/indicator, plain vs modified/middle click, narrow drawer inert, and tone map", async (t) => {
	const { root, statePath, coordinationPath } = emptyViewerDb(t);
	await verifyReadOnlyViewer(
		{ stateDirs: root, viewerOptions: { statePath, coordinationPath, host: "127.0.0.1", port: 0 } },
		async (viewer) => {
			const [safeCode, appCode] = await Promise.all([
				fetch(`${viewer.url}/safe.js`).then((r) => r.text()),
				fetch(`${viewer.url}/app.js`).then((r) => r.text()),
			]);

			const fetchedUrls: string[] = [];
			const apiHandler: FetchHandler = async (url) => {
				fetchedUrls.push(url);
				if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_1", name: "Alpha", current_version: "v2", management: "managed" }]);
				if (url === "/api/factories/fac_1/live") return jsonResp(200, { factory_id: "fac_1", state: "idle", run: null, graph: { evidence: "not applicable", absence: "no records", explanation: "Idle" } });
				if (url === "/api/factories/fac_1/inspect") return jsonResp(200, { factory_id: "fac_1", current_version: "v2", inspected_version: "v2", evidence: "available", attention_summary: { name: "Alpha", management: { state: "managed" }, stop_state: { state: "active" } }, definition: { version: "v2", topology: "graph", nodes: [] } });
				if (url.startsWith("/api/factories/fac_1/queue")) return jsonResp(200, { factory_id: "fac_1", filter: url.includes("all") ? "all" : "open", evidence: "available", absence: "no records", entries: [] });
				if (url.startsWith("/api/factories/fac_1/receipts")) return jsonResp(200, { type: "receipt", factory_id: "fac_1", reference: "ref:1", input_id: "i1", queue_position: 1, accepted_at: "t0", bound_version: "v2", current_version: "v2", disposition: "queued", disposition_explanation: "Queued", attempt: { absence: "no records" } });
				if (url === "/api/factories/fac_1/requests") return jsonResp(200, { factory_id: "fac_1", evidence: "available", absence: "no records", records: [] });
				if (url === "/api/factories/fac_1/proposals") return jsonResp(200, { factory_id: "fac_1", evidence: "available", absence: "no records", records: [] });
				return jsonResp(404, { error: "Not found" });
			};

			// 1. Unavailable tabs when no factory is selected
			const appNoFac = bootShellApp(viewer.url, safeCode, appCode, "?view=factories", apiHandler);
			await flushMicrotasks();
			const getTab = (app: ReturnType<typeof bootShellApp>, view: string) =>
				app.viewsNav.querySelectorAll("[data-view]").find((el) => el.getAttribute("data-view") === view)!;

			const facTab0 = getTab(appNoFac, "factories");
			assert.equal(facTab0.getAttribute("href"), "/?view=factories");
			assert.equal(facTab0.classList.contains("active"), true);
			assert.equal(facTab0.getAttribute("aria-current"), "page");
			assert.equal(facTab0.hasAttribute("aria-disabled"), false);
			assert.equal(appNoFac.tabIndicator.style.left, "0px");
			assert.equal(appNoFac.tabIndicator.style.width, "100px");

			for (const view of ["live", "inspect", "queue", "receipts", "requests", "proposals"]) {
				const tEl = getTab(appNoFac, view);
				assert.equal(tEl.hasAttribute("href"), false, `Unavailable ${view} tab must have no href`);
				assert.equal(tEl.getAttribute("aria-disabled"), "true", `Unavailable ${view} tab must carry aria-disabled="true"`);
				assert.equal(tEl.classList.contains("active"), false);
				assert.equal(tEl.hasAttribute("aria-current"), false);
				assert.equal(tEl.classList.contains("blue-grey-text"), true);
				assert.equal(tEl.classList.contains("text-lighten-2"), true);
			}

			// Plain click on unavailable tab must not navigate or fetch
			const beforeCount = fetchedUrls.length;
			let preventedUnavailable = false;
			for (const fn of getTab(appNoFac, "live").listeners.get("click") ?? []) {
				fn({ button: 0, preventDefault() { preventedUnavailable = true; } });
			}
			await flushMicrotasks();
			assert.equal(preventedUnavailable, true);
			assert.equal(appNoFac.locationObj.search, "?view=factories");
			assert.equal(appNoFac.pushHistory.length, 0);
			assert.equal(fetchedUrls.length, beforeCount);

			// 2. Tab hrefs per view, including filter=all and receipt reference
			const app = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=queue&filter=all", apiHandler);
			await flushMicrotasks();
			assert.equal(getTab(app, "factories").getAttribute("href"), "/?factory=fac_1&view=factories");
			assert.equal(getTab(app, "live").getAttribute("href"), "/?factory=fac_1&view=live");
			assert.equal(getTab(app, "inspect").getAttribute("href"), "/?factory=fac_1&view=inspect");
			assert.equal(getTab(app, "queue").getAttribute("href"), "/?factory=fac_1&view=queue&filter=all");
			assert.equal(getTab(app, "receipts").getAttribute("href"), "/?factory=fac_1&view=receipts");
			assert.equal(getTab(app, "requests").getAttribute("href"), "/?factory=fac_1&view=requests");
			assert.equal(getTab(app, "proposals").getAttribute("href"), "/?factory=fac_1&view=proposals");

			// .active and aria-current follow the view; indicator tracks active tab & resize
			assert.equal(getTab(app, "queue").classList.contains("active"), true);
			assert.equal(getTab(app, "queue").getAttribute("aria-current"), "page");
			assert.equal(getTab(app, "live").classList.contains("active"), false);
			assert.equal(getTab(app, "live").hasAttribute("aria-current"), false);
			assert.equal(app.tabIndicator.style.left, "330px");
			assert.equal(app.tabIndicator.style.width, "115px");

			app.triggerResize(false, 80);
			assert.equal(app.tabIndicator.style.left, "270px");
			assert.equal(app.tabIndicator.style.width, "80px");

			// Receipt reference reflected in receipts tab href
			const appRec = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=receipts&reference=ref%3A1", apiHandler);
			await flushMicrotasks();
			assert.equal(getTab(appRec, "receipts").getAttribute("href"), "/?factory=fac_1&view=receipts&reference=ref%3A1");
			assert.equal(getTab(appRec, "receipts").classList.contains("active"), true);
			assert.equal(getTab(appRec, "receipts").getAttribute("aria-current"), "page");

			// 3. Plain vs modified and middle clicks on an available tab
			const requestsTab = getTab(appRec, "requests");
			for (const modEvent of [
				{ button: 0, ctrlKey: true },
				{ button: 0, metaKey: true },
				{ button: 0, shiftKey: true },
				{ button: 0, altKey: true },
				{ button: 1 },
			]) {
				let modPrevented = false;
				const pushesBefore = appRec.pushHistory.length;
				for (const fn of requestsTab.listeners.get("click") ?? []) {
					fn({ ...modEvent, preventDefault() { modPrevented = true; } });
				}
				await flushMicrotasks();
				assert.equal(modPrevented, false, `Modified/middle click ${JSON.stringify(modEvent)} must fall through without preventDefault`);
				assert.equal(appRec.pushHistory.length, pushesBefore, `Modified/middle click ${JSON.stringify(modEvent)} must not pushState`);
				assert.equal(getTab(appRec, "receipts").classList.contains("active"), true);
			}

			// Plain click navigates in-page and moves .active, aria-current, and indicator
			let plainPrevented = false;
			for (const fn of requestsTab.listeners.get("click") ?? []) {
				fn({ button: 0, preventDefault() { plainPrevented = true; } });
			}
			await flushMicrotasks();
			assert.equal(plainPrevented, true);
			assert.equal(appRec.locationObj.search, "?factory=fac_1&view=requests");
			assert.equal(requestsTab.classList.contains("active"), true);
			assert.equal(requestsTab.getAttribute("aria-current"), "page");
			assert.equal(getTab(appRec, "receipts").classList.contains("active"), false);
			assert.equal(getTab(appRec, "receipts").hasAttribute("aria-current"), false);
			assert.equal(appRec.tabIndicator.style.left, "550px");

			// popstate also updates active tab & indicator
			appRec.dispatchWindowPopstate("?factory=fac_1&view=proposals");
			await flushMicrotasks();
			assert.equal(getTab(appRec, "proposals").classList.contains("active"), true);
			assert.equal(getTab(appRec, "proposals").getAttribute("aria-current"), "page");
			assert.equal(appRec.tabIndicator.style.left, "660px");

			// 4. Narrow drawer closed state is inert/not focusable; open focuses inside, Escape restores focus
			const appNarrow = bootShellApp(viewer.url, safeCode, appCode, "?view=factories", apiHandler, { narrow: true });
			await flushMicrotasks();
			assert.equal(appNarrow.sidebar.hasAttribute("inert"), true, "Closed narrow drawer must be inert (not focusable)");
			assert.equal(appNarrow.sidebar.classList.contains("open"), false);
			assert.equal(appNarrow.drawerBackdrop.hasAttribute("hidden"), true);

			for (const fn of appNarrow.menuToggle.listeners.get("click") ?? []) fn({});
			assert.equal(appNarrow.sidebar.classList.contains("open"), true);
			assert.equal(appNarrow.sidebar.hasAttribute("inert"), false, "Open narrow drawer must not be inert");
			assert.equal(appNarrow.mainContent.hasAttribute("inert"), true, "Background main must be inert while drawer is open");
			assert.equal(appNarrow.drawerBackdrop.hasAttribute("hidden"), false);
			assert.equal(appNarrow.fakeDocument.activeElement, appNarrow.drawerClose);

			appNarrow.dispatchDocKey("Escape");
			assert.equal(appNarrow.sidebar.classList.contains("open"), false);
			assert.equal(appNarrow.sidebar.hasAttribute("inert"), true);
			assert.equal(appNarrow.mainContent.hasAttribute("inert"), false);
			assert.equal(appNarrow.drawerBackdrop.hasAttribute("hidden"), true);
			assert.equal(appNarrow.fakeDocument.activeElement, appNarrow.menuToggle);

			// Resizing back to wide removes inert from sidebar
			appNarrow.triggerResize(false);
			assert.equal(appNarrow.sidebar.hasAttribute("inert"), false);

			// 5. Tone map: every tone mapped, unknown -> warn (never a reassuring colour), and wired in shell
			const { toneClasses } = appRec.context;
			assert.equal(typeof toneClasses, "function");
			assert.equal(toneClasses("ok"), "green lighten-5 green-text text-darken-4");
			assert.equal(toneClasses("warn"), "amber lighten-5 brown-text text-darken-3");
			assert.equal(toneClasses("error"), "red lighten-5 red-text text-darken-4");
			assert.equal(toneClasses("info"), "blue lighten-5 blue-text text-darken-4");
			assert.equal(toneClasses("muted"), "grey lighten-3 grey-text text-darken-3");
			assert.equal(toneClasses("stale"), "blue-grey lighten-4 blue-grey-text text-darken-4");
			assert.notEqual(toneClasses("stale"), toneClasses("warn"));
			assert.notEqual(toneClasses("stale"), toneClasses("muted"));
			assert.equal(toneClasses("warn").includes("orange"), false);
			for (const prefixed of ["tone-ok", "tone-warn", "tone-error", "tone-info", "tone-muted", "tone-stale"]) {
				assert.equal(toneClasses(prefixed), toneClasses(prefixed.slice(5)));
			}
			for (const unknown of ["bogus", "constructor", "__proto__", "toString", "", null, undefined]) {
				const mapped = toneClasses(unknown);
				assert.equal(mapped, toneClasses("warn"), `Unknown tone ${String(unknown)} must fall back to warn`);
				assert.equal(mapped.includes("green"), false);
				assert.equal(mapped.includes("blue"), false);
			}

			// Shell error wiring uses toneClasses("error") and preserves errorBanner wording & layout
			const appSidebarErr = bootShellApp(viewer.url, safeCode, appCode, "?view=factories", async () => jsonResp(503, { error: "Down" }));
			assert.ok(appSidebarErr.factoriesList.querySelector(".grey"), "Loading sidebar item uses muted palette classes");
			await flushMicrotasks();
			const errEl = appSidebarErr.factoriesList.querySelector(".red");
			assert.ok(errEl, "Error sidebar item uses error palette classes");
			assert.equal(errEl.classList.contains("collection-item"), true);
			assert.equal(errEl.classList.contains("lighten-5"), true);
			assert.equal(errEl.classList.contains("red-text"), true);
			assert.equal(errEl.classList.contains("text-darken-4"), true);
			assert.equal(errEl.getAttribute("role"), "alert");
			const errChip = errEl.querySelector(".chip");
			assert.ok(errChip && errChip.tagName === "span", "Sidebar error must render span.chip");
			assert.equal(errChip.classList.contains("red"), true);
			assert.equal(errChip.classList.contains("lighten-5"), true);
			assert.equal(errChip.classList.contains("red-text"), true);
			assert.equal(errChip.classList.contains("text-darken-4"), true);
			assert.match(errChip.textContent, /! HTTP 503/);
			const errStrong = errEl.querySelector("strong");
			assert.ok(errStrong, "Sidebar error must render strong message element");
			assert.equal(errStrong.textContent, "Down");
			const errReason = errEl.querySelector("p");
			assert.ok(errReason, "Sidebar error must render p reason element");
			assert.match(errReason.textContent, /Request to \/api\/factories failed with HTTP 503\./);

			// Empty-message fallback matches errorBanner's "Request failed" wording
			vm.runInContext('state.factoriesStatus = "error"; state.factoriesError = { status: 500, message: "", detail: "Upstream blank" }; renderSidebarFactories();', appSidebarErr.context);
			const fallbackErrEl = appSidebarErr.factoriesList.querySelector(".red");
			assert.ok(fallbackErrEl);
			const fallbackChip = fallbackErrEl.querySelector(".chip");
			assert.ok(fallbackChip && fallbackChip.tagName === "span");
			assert.match(fallbackChip.textContent, /! HTTP 500/);
			const strongEl = fallbackErrEl.querySelector("strong");
			assert.ok(strongEl);
			assert.equal(strongEl.textContent, "Request failed");
			assert.equal(fallbackErrEl.textContent.includes("Failed to load factories list."), false);
			const fallbackReason = fallbackErrEl.querySelector("p");
			assert.ok(fallbackReason);
			assert.match(fallbackReason.textContent, /Upstream blank/);

			// 6. updateChrome removes stale href and marks unavailable if safeHref rejects href
			const appRejectedHref = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=live", apiHandler);
			await flushMicrotasks();
			const liveTabBefore = getTab(appRejectedHref, "live");
			assert.equal(liveTabBefore.getAttribute("href"), "/?factory=fac_1&view=live");
			assert.equal(liveTabBefore.hasAttribute("aria-disabled"), false);
			appRejectedHref.context.location.origin = "null";
			appRejectedHref.context.updateChrome();
			assert.equal(liveTabBefore.hasAttribute("href"), false, "Rejected safeHref must remove stale href");
			assert.equal(liveTabBefore.getAttribute("aria-disabled"), "true", "Rejected safeHref must mark tab aria-disabled=\"true\"");
		},
	);
});

test("Materialize Slice 2 components: chips, card-panel banners, cards, dl.row facts, btn/btn-flat filters, collections, input-field forms, striped highlight tables, collapsible accordions", async (t) => {
	const { root, statePath, coordinationPath } = emptyViewerDb(t);
	await verifyReadOnlyViewer(
		{ stateDirs: root, viewerOptions: { statePath, coordinationPath, host: "127.0.0.1", port: 0 } },
		async (viewer) => {
			const [safeCode, appCode] = await Promise.all([
				fetch(`${viewer.url}/safe.js`).then((r) => r.text()),
				fetch(`${viewer.url}/app.js`).then((r) => r.text()),
			]);

			const fixtures: Record<string, unknown> = {
				"/api/factories": {
					factories: [{ factory_id: "fac_1", name: "Alpha", current_version: "v2", management: "managed" }],
					deleted: [{ factory_id: "fac_del", name: "Retired", current_version: "v1", management: "managed", deleted: true, deletion: { deleted_at: "2026-11-25T10:00:00Z" } }],
					damaged: [{ factory_id: "fac_dmg", name: "Damaged", current_version: "v1", damaged: true, evidence: "unavailable", status: "uncertain", explanation: "Corrupt" }],
				},
				"/api/factories/fac_1/live": {
					factory_id: "fac_1",
					current_version: "v2",
					checked_at: "2026-11-25T12:00:00Z",
					state: "running",
					reason: "Running",
					run: { run_id: "run-1", attempt_id: "att-1", bound_version: "v1" },
					outcome: "incomplete",
					settlement: "unsettled",
					capacity_release: "held",
					graph: {
						evidence: "available",
						bound_version: "v1",
						topology: "graph",
						nodes: [
							{ id: "left", kind: "agent", status: "succeeded", parked: true, current_attempt: { attempt_id: "left.1", attempt_number: 1, max_attempts: 2, instance_id: "i1", process_state: "idle", resource_state: "open", started_at: "t0", updated_at: "t1" }, configuration_link: { href: "/?factory=fac_1&view=inspect&version=v1&node=left", node_id: "left", version: "v1" } },
						],
						edges: [],
					},
				},
				"/api/factories/fac_del/live": {
					factory_id: "fac_del",
					current_version: "v1",
					checked_at: "2026-11-25T12:00:00Z",
					deleted: true,
					deletion: { deleted_at: "2026-11-25T10:00:00Z" },
					state: "deleted",
					reason: "Deleted",
					run: null,
					graph: { evidence: "not applicable", absence: "not applicable", explanation: "Deleted" },
				},
				"/api/factories/fac_1/inspect": {
					factory_id: "fac_1",
					current_version: "v2",
					inspected_version: "v1",
					evidence: "available",
					attention_summary: { name: "Alpha", management: { state: "managed" }, stop_state: { state: "active" } },
					versions: [{ version: "v1", current: false, inspected: true, restored_from: { absence: "not applicable" }, digest: "abcdef0123456789abcd", created_at: "t0", evidence: "available" }],
					definition: {
						version: "v1",
						topology: "graph",
						restored_from: { absence: "not applicable" },
						nodes: [{
							id: "left",
							anchor: "left",
							kind: "agent",
							dependencies: { items: [{ href: "/?factory=fac_1&view=inspect&version=v1&node=left", node_id: "left", version: "v1" }] },
							join: { absence: "not applicable" },
							decision: { absence: "not applicable" },
							feedback_target: { absence: "not applicable" },
							required_checks: { items: ["test"] },
						}],
						limits: { max_total_attempts: 3, max_total_attempts_source: "built-in" },
					},
				},
				"/api/factories/fac_1/queue?filter=open": {
					factory_id: "fac_1",
					filter: "open",
					evidence: "available",
					explanation: "Open queue",
					entries: [{ queue_position: 1, reference: "ref-1", bound_version: "v1", disposition: "queued", disposition_explanation: "Waiting", uncertain: false, accepted_at: "t0", is_head: true, receipt_url: "/?factory=fac_1&view=receipts&reference=ref-1" }],
				},
				"/api/factories/fac_1/queue?filter=all": {
					factory_id: "fac_1",
					filter: "all",
					evidence: "available",
					explanation: "All queue",
					entries: [],
					absence: "no records",
				},
				"/api/factories/fac_1/receipts?reference=ref-1": {
					type: "receipt",
					factory_id: "fac_1",
					reference: "ref-1",
					input_id: "in-1",
					queue_position: 1,
					accepted_at: "t0",
					bound_version: "v1",
					current_version: "v2",
					disposition: "running",
					disposition_explanation: "Running",
					attempt: { attempt_id: "att-1", state: "released", state_explanation: "Released", bound_version: "v1", task_id: "task-1", request_id: "req-1", release_authorized: true, release_authorized_at: "t0", created_at: "t0", updated_at: "t1", uncertain: true },
				},
				"/api/factories/fac_1/requests": {
					factory_id: "fac_1",
					evidence: "available",
					explanation: "Requests",
					records: [{ request_id: "req-1", kind: "direction", state: "pending", uncertain: true, uncertainty: "Uncertain", question: "Proceed?", node_id: "left", node_attempt_id: "left.1", response_recorded: false, response_consumed: false, reconciliation: "pending", choices: [{ choice_id: "ok", label: "OK", route: "approve" }] }],
				},
				"/api/factories/fac_1/proposals": {
					factory_id: "fac_1",
					evidence: "available",
					explanation: "Proposals",
					records: [{ proposal_id: "prop-1", action: "add", reference: "ref-1", text: "Rule", provenance: { source: "agent", run_id: "r1", attempt_id: "a1", evidence_ref: "e1" }, outcome: "pending", outcome_explanation: "Pending", file_sync_state: { absence: "not applicable" }, uncertain: false }],
				},
			};

			// 1. Factories view: tables (striped highlight inside .table-wrap, never responsive-table), cards, btn/btn-flat, sidebar collections & collapsible Deleted
			const appFac = bootShellApp(viewer.url, safeCode, appCode, "?view=factories", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();

			const tables = appFac.content.querySelectorAll("table");
			assert.ok(tables.length >= 3);
			for (const tbl of tables) {
				assert.equal(tbl.classList.contains("striped"), true);
				assert.equal(tbl.classList.contains("highlight"), true);
				assert.equal(tbl.classList.contains("responsive-table"), false);
				assert.equal((tbl.parentNode as FakeElement).classList.contains("table-wrap"), true);
			}
			assert.ok(appFac.content.querySelectorAll(".card").length >= 2);
			assert.ok(appFac.content.querySelectorAll(".card-content").length >= 2);
			assert.ok(appFac.content.querySelectorAll(".card-title").length >= 2);
			const primaryBtn = appFac.content.querySelector(".btn");
			assert.ok(primaryBtn && primaryBtn.classList.contains("teal") && primaryBtn.classList.contains("darken-3"));
			const flatBtn = appFac.content.querySelector(".btn-flat");
			assert.ok(flatBtn && flatBtn.classList.contains("teal-text") && flatBtn.classList.contains("text-darken-3"));

			const sidebarCollections = appFac.sidebar.querySelectorAll(".collection");
			assert.equal(sidebarCollections.length, 3, "Sidebar must use .collection for active, damaged, and deleted lists");
			const sidebarDetails = appFac.sidebar.querySelector("details");
			assert.ok(sidebarDetails && sidebarDetails.classList.contains("collapsible"));
			assert.ok(sidebarDetails.querySelector(".collapsible-header"));
			assert.ok(sidebarDetails.querySelector(".collapsible-body"));

			// 2. Live Graph: card-panel banners (including Stale), dl.row + div.col s12 m6 l4, node selection & collapsible details
			const appLive = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=live", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			const liveFacts = appLive.content.querySelector("dl");
			assert.ok(liveFacts && liveFacts.classList.contains("row"));
			const factCols = liveFacts.children.filter((c): c is FakeElement => c instanceof FakeElement);
			assert.ok(factCols.length >= 5);
			for (const col of factCols) {
				assert.equal(col.classList.contains("col"), true);
				assert.equal(col.classList.contains("s12"), true);
				assert.equal(col.classList.contains("m6"), true);
				assert.equal(col.classList.contains("l4"), true);
			}
			const nodeLeft = appLive.content.querySelectorAll("g").find((g) => g.getAttribute("data-node-id") === "left")!;
			for (const fn of nodeLeft.listeners.get("click") ?? []) fn({});
			const detailDetails = appLive.content.querySelector("details");
			assert.ok(detailDetails && detailDetails.classList.contains("collapsible"));
			assert.ok(detailDetails.querySelector(".collapsible-header"));
			assert.ok(detailDetails.querySelector(".collapsible-body"));
			assert.ok(appLive.content.querySelectorAll(".chip").length >= 4);

			// Stale banner uses card-panel + toneClasses("stale")
			appLive.context.mountOrPatchLiveView(fixtures["/api/factories/fac_1/live"], null, {
				lastCheckedAt: "2026-11-25T12:00:00Z",
				reason: "Refresh failed",
				detail: "",
			});
			const stalePanel = appLive.content.querySelectorAll(".card-panel").find((el) => el.textContent.includes("⟳ Stale"));
			assert.ok(stalePanel, "Stale banner must use card-panel");
			assert.equal(stalePanel.classList.contains("blue-grey"), true);
			assert.equal(stalePanel.classList.contains("lighten-4"), true);
			assert.equal(stalePanel.classList.contains("blue-grey-text"), true);
			assert.equal(stalePanel.classList.contains("text-darken-4"), true);

			// Deleted banner uses card-panel + toneClasses("deleted" -> muted)
			const appDel = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_del&view=live", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			const delPanel = appDel.content.querySelectorAll(".card-panel").find((el) => el.textContent.includes("⊗ Deleted"));
			assert.ok(delPanel && delPanel.classList.contains("grey") && delPanel.classList.contains("lighten-3"));

			// 3. Inspect: input-field with static active label, select.browser-default, collection link list, collapsible accordions
			const appIns = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=inspect", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			const insSelect = appIns.content.querySelector("#inspect-version-select");
			assert.ok(insSelect && insSelect.classList.contains("browser-default"));
			assert.equal((insSelect.parentNode as FakeElement).classList.contains("input-field"), true);
			const insLabel = (insSelect.parentNode as FakeElement).querySelector("label");
			assert.ok(insLabel && insLabel.classList.contains("active"));
			assert.ok(appIns.content.querySelector(".collection-item"));
			assert.ok(appIns.content.querySelectorAll(".collapsible").length >= 2);

			// 4. Queue: pressed filter is btn with aria-pressed="true", unpressed is btn-flat with aria-pressed="false"
			const appQueue = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=queue&filter=open", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			const qBtns = appQueue.content.querySelectorAll("button");
			assert.equal(qBtns.length, 2);
			assert.equal(qBtns[0].classList.contains("btn"), true);
			assert.equal(qBtns[0].classList.contains("teal"), true);
			assert.equal(qBtns[0].getAttribute("aria-pressed"), "true");
			assert.equal(qBtns[1].classList.contains("btn-flat"), true);
			assert.equal(qBtns[1].getAttribute("aria-pressed"), "false");

			for (const fn of qBtns[1].listeners.get("click") ?? []) fn({});
			await flushMicrotasks();
			const qBtnsAll = appQueue.content.querySelectorAll("button");
			assert.equal(qBtnsAll[0].classList.contains("btn-flat"), true);
			assert.equal(qBtnsAll[0].getAttribute("aria-pressed"), "false");
			assert.equal(qBtnsAll[1].classList.contains("btn"), true);
			assert.equal(qBtnsAll[1].getAttribute("aria-pressed"), "true");

			// 5. Receipts: input-field with static active label + btn submit
			const appRec = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=receipts&reference=ref-1", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			const recInput = appRec.content.querySelector("#receipt-ref-input");
			assert.ok(recInput && (recInput.parentNode as FakeElement).classList.contains("input-field"));
			const recLabel = (recInput.parentNode as FakeElement).querySelector("label");
			assert.ok(recLabel && recLabel.classList.contains("active"));
			const uncertainAttemptBanner = appRec.content.querySelectorAll(".card-panel").find((el) => el.textContent.includes("? Uncertain"));
			assert.ok(uncertainAttemptBanner && uncertainAttemptBanner.classList.contains("amber") && uncertainAttemptBanner.classList.contains("lighten-5"));

			// 6. Requests: card / card-content / card-title, collection choices, collapsible accordion
			const appReq = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=requests", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			const reqArticle = appReq.content.querySelector("article");
			assert.ok(reqArticle && reqArticle.classList.contains("card"));
			assert.ok(reqArticle.querySelector(".card-content"));
			assert.ok(reqArticle.querySelector(".card-title"));
			assert.ok(reqArticle.querySelector(".collection-item"));
			assert.ok(reqArticle.querySelector(".collapsible-body"));

			// 7. Proposals: card-panel banners, striped highlight table, chips
			const appProp = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=proposals", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			assert.ok(appProp.content.querySelectorAll(".card-panel").length >= 2);
			assert.ok(appProp.content.querySelector("table")?.classList.contains("highlight"));
			assert.ok(appProp.content.querySelectorAll(".chip").length >= 3);
		},
	);
});

const EXPECTED_TONE_CLASS_SETS: ReadonlyArray<readonly string[]> = [
	["green", "lighten-5", "green-text", "text-darken-4"],
	["amber", "lighten-5", "brown-text", "text-darken-3"],
	["red", "lighten-5", "red-text", "text-darken-4"],
	["blue", "lighten-5", "blue-text", "text-darken-4"],
	["grey", "lighten-3", "grey-text", "text-darken-3"],
	["blue-grey", "lighten-4", "blue-grey-text", "text-darken-4"],
];

function assertEveryChipAndPanelHasToneClassSet(rootEl: FakeElement, viewLabel: string): void {
	const targets = [...rootEl.querySelectorAll(".chip"), ...rootEl.querySelectorAll(".card-panel")];
	assert.ok(targets.length >= 1, `${viewLabel}: expected at least one .chip or .card-panel`);
	for (const node of targets) {
		const matches = EXPECTED_TONE_CLASS_SETS.filter((set) => set.every((cls) => node.classList.contains(cls)));
		assert.equal(
			matches.length,
			1,
			`${viewLabel}: <${node.tagName} class="${node.getAttribute("class") ?? ""}"> (${node.textContent}) must carry exactly one of the six tone class sets`,
		);
	}
}

test("Slice 3: every .chip and .card-panel across all seven views carries a tone class set, and slice 2 wording/wrapping regressions stay fixed", async (t) => {
	const { root, statePath, coordinationPath } = emptyViewerDb(t);
	await verifyReadOnlyViewer(
		{ stateDirs: root, viewerOptions: { statePath, coordinationPath, host: "127.0.0.1", port: 0 } },
		async (viewer) => {
			const [safeCode, appCode] = await Promise.all([
				fetch(`${viewer.url}/safe.js`).then((r) => r.text()),
				fetch(`${viewer.url}/app.js`).then((r) => r.text()),
			]);

			const longNodeId = "node_with_a_very_long_identifier_that_must_wrap_inside_collection_0123456789";
			const longAttentionLabel = "Direction or exhaustion request";
			const longUncertaintySentence = "Confirmed proposal has a pending durable write to .pi/constraints.json; resume or takeover in Pi completes it.";

			const fixtures: Record<string, unknown> = {
				"/api/factories": {
					factories: [{ factory_id: "fac_1", name: "Alpha Long Factory Name", current_version: "v2", management: "managed" }],
					deleted: [{ factory_id: "fac_del", name: "Retired", current_version: "v1", management: "managed", deleted: true, deletion: { deleted_at: "2026-11-25T10:00:00Z" } }],
					damaged: [{ factory_id: "fac_dmg", name: "Damaged", current_version: "v1", damaged: true, evidence: "unavailable", status: "uncertain", explanation: "Corrupt" }],
				},
				"/api/factories/fac_1/live": {
					factory_id: "fac_1",
					current_version: "v2",
					checked_at: "2026-11-25T12:00:00Z",
					state: "running",
					reason: "Running",
					run: { run_id: "run-1", attempt_id: "att-1", bound_version: "v1" },
					outcome: "incomplete",
					settlement: "unsettled",
					capacity_release: "held",
					graph: {
						evidence: "available",
						bound_version: "v1",
						topology: "graph",
						nodes: [
							{ id: "left", kind: "agent", status: "succeeded", parked: true, current_attempt: { attempt_id: "left.1", attempt_number: 1, max_attempts: 2, instance_id: "i1", process_state: "idle", resource_state: "open", started_at: "t0", updated_at: "t1" }, configuration_link: { href: "/?factory=fac_1&view=inspect&version=v1&node=left", node_id: "left", version: "v1" } },
							{ id: "merge", kind: "agent", status: "partial", join: { policy: "allow_partial", sources: ["left"] } },
						],
						edges: [{ from: "left", to: "merge", kind: "dependency", dependency_policy: "allow_partial", state: "fired" }],
					},
				},
				"/api/factories/fac_1/inspect": {
					factory_id: "fac_1",
					current_version: "v2",
					inspected_version: "v1",
					evidence: "available",
					attention_summary: {
						name: "Alpha",
						management: { state: "managed", explanation: "Managed" },
						stop_state: { state: "active", explanation: "Active" },
						capacity: { queue_used: 1, queue_limit: 4, factory_slot: { state: "held" }, checkout_slot: { state: "free" }, blocking_hold: { explanation: "Active" } },
						attention: { items: [{ kind: "intervention", label: longAttentionLabel, explanation: "Review in Pi", detail_view: "requests", detail_url: "/api/factories/fac_1/requests" }] },
					},
					damaged_records: { count: 1, explanation: "One damaged", items: [{ scope: "version", version: "v0", absence: "evidence unavailable", explanation: "Bad JSON" }] },
					versions: [{ version: "v1", current: false, inspected: true, restored_from: { absence: "not applicable" }, digest: "abcdef0123456789abcd", created_at: "t0", evidence: "available" }],
					definition: {
						version: "v1",
						topology: "graph",
						restored_from: { absence: "not applicable" },
						nodes: [
							{
								id: "empty_deps_node",
								anchor: "empty_deps_node",
								kind: "agent",
								dependencies: { items: [] },
								join: { policy: "all_success", sources: [longNodeId] },
								decision: { absence: "not applicable" },
								feedback_target: { absence: "not applicable" },
								required_checks: { items: ["test"] },
							},
							{
								id: longNodeId,
								anchor: longNodeId,
								kind: "command",
								dependencies: { items: [{ href: `/?factory=fac_1&view=inspect&version=v1&node=${longNodeId}`, node_id: longNodeId, version: "v1" }] },
								join: { absence: "not applicable" },
								decision: { absence: "not applicable" },
								feedback_target: { absence: "not applicable" },
								required_checks: { items: [] },
							},
						],
						limits: { max_total_attempts: 3, max_total_attempts_source: "built-in" },
					},
				},
				"/api/factories/fac_1/queue?filter=open": {
					factory_id: "fac_1",
					filter: "open",
					evidence: "available",
					explanation: "Open queue",
					entries: [{ queue_position: 1, reference: "ref-1", bound_version: "v1", bound_version_evidence: "unavailable", disposition: "queued", disposition_explanation: "Waiting", uncertain: false, accepted_at: "t0", is_head: true, receipt_url: "/?factory=fac_1&view=receipts&reference=ref-1" }],
				},
				"/api/factories/fac_1/receipts?reference=ref-1": {
					type: "receipt",
					factory_id: "fac_1",
					reference: "ref-1",
					input_id: "in-1",
					queue_position: 1,
					accepted_at: "t0",
					bound_version: "v1",
					current_version: "v2",
					disposition: "running",
					disposition_explanation: "Running",
					attempt: { attempt_id: "att-1", state: "released", state_explanation: "Released", bound_version: "v1", task_id: "task-1", request_id: "req-1", release_authorized: true, release_authorized_at: "t0", created_at: "t0", updated_at: "t1", uncertain: true },
				},
				"/api/factories/fac_1/requests": {
					factory_id: "fac_1",
					evidence: "available",
					explanation: "Requests",
					records: [{ request_id: "req-1", kind: "direction", state: "pending", uncertain: true, uncertainty: "Uncertain", question: "Proceed?", node_id: "left", node_attempt_id: "left.1", response_recorded: false, response_consumed: false, reconciliation: "pending", choices: [] }],
				},
				"/api/factories/fac_1/proposals": {
					factory_id: "fac_1",
					evidence: "available",
					explanation: "Proposals",
					records: [{ proposal_id: "prop-1", action: "add", reference: "ref-1", text: "Rule", provenance: { source: "agent", run_id: "r1", attempt_id: "a1", evidence_ref: "e1" }, outcome: "confirmed", outcome_explanation: "Confirmed", file_sync_state: "pending_write", file_sync_state_explanation: "Pending", uncertain: true, uncertainty: longUncertaintySentence }],
				},
			};

			// 1. Tone class sets on every .chip and .card-panel across error state and all 7 views
			const appErr = bootShellApp(viewer.url, safeCode, appCode, "?view=factories", async () => jsonResp(503, { error: "Down" }));
			await flushMicrotasks();
			assertEveryChipAndPanelHasToneClassSet(appErr.body, "error-state");

			for (const [label, search] of [
				["factories", "?view=factories"],
				["live", "?factory=fac_1&view=live"],
				["inspect", "?factory=fac_1&view=inspect"],
				["queue", "?factory=fac_1&view=queue&filter=open"],
				["receipts", "?factory=fac_1&view=receipts&reference=ref-1"],
				["requests", "?factory=fac_1&view=requests"],
				["proposals", "?factory=fac_1&view=proposals"],
			] as const) {
				const app = bootShellApp(viewer.url, safeCode, appCode, search, async (url) => jsonResp(200, fixtures[url] ?? {}));
				await flushMicrotasks();
				if (label === "live") {
					const nodeLeft = app.content.querySelectorAll("g").find((g) => g.getAttribute("data-node-id") === "left");
					for (const fn of nodeLeft?.listeners.get("click") ?? []) fn({});
					app.context.mountOrPatchLiveView(fixtures["/api/factories/fac_1/live"], null, {
						lastCheckedAt: "2026-11-25T12:00:00Z",
						reason: "Refresh failed",
						detail: "",
					});
				}
				assertEveryChipAndPanelHasToneClassSet(app.body, label);
			}

			// 2. Regression C.1: no "None" added for empty dependencies/choices; join retains trailing " — "
			const appIns = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=inspect", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			assert.equal(appIns.content.textContent.includes("None"), false, "Empty dependencies must not render 'None'");
			assert.equal(appIns.content.textContent.includes("policy: all_success — "), true, "Join policy must keep trailing ' — '");

			const appReq = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=requests", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			assert.equal(appReq.content.textContent.includes("None"), false, "Empty choices must not render 'None'");

			// 3. Regression C.2: long labels stay outside .chip as plain text, and .btn keeps exact wording
			const attnChip = appIns.content.querySelectorAll("table").flatMap((tbl) => tbl.querySelectorAll(".chip")).find((el) => el.textContent.includes("Blocked"));
			assert.ok(attnChip, "Inspect attention item must render short status chip");
			assert.equal(attnChip.textContent.includes(longAttentionLabel), false, "Long attention item.label must not be inside .chip");
			assert.equal(appIns.content.textContent.includes(longAttentionLabel), true, "Attention item.label must render beside chip");

			const appProp = bootShellApp(viewer.url, safeCode, appCode, "?factory=fac_1&view=proposals", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			const propChips = appProp.content.querySelectorAll("table").flatMap((tbl) => tbl.querySelectorAll(".chip"));
			for (const ch of propChips) {
				assert.equal(ch.textContent.includes(longUncertaintySentence), false, "Long p.uncertainty sentence must not be inside .chip");
			}
			assert.equal(appProp.content.textContent.includes(longUncertaintySentence), true, "Proposals p.uncertainty must render as plain text beside chip");

			const appFac = bootShellApp(viewer.url, safeCode, appCode, "?view=factories", async (url) => jsonResp(200, fixtures[url] ?? {}));
			await flushMicrotasks();
			const facBtn = appFac.content.querySelector(".btn");
			assert.ok(facBtn);
			assert.equal(facBtn.textContent, "Open Live Graph for Alpha Long Factory Name");

			// 4. Regression C.3: node links inside ul.collection carry .mono for wrapping
			const depLink = appIns.content
				.querySelectorAll("ul")
				.filter((ul) => ul.classList.contains("collection"))
				.flatMap((ul) => ul.querySelectorAll("a"))
				.find((a) => a.textContent === longNodeId);
			assert.ok(depLink, "Node link inside ul.collection must render");
			assert.equal(depLink.classList.contains("mono"), true, "Node link inside ul.collection must carry .mono to wrap");
		},
	);
});
