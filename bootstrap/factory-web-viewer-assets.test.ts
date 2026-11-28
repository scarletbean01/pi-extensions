import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { buildProposalRow, insertProposalRow } from "./constraint-proposals.ts";
import { createRequest, inTransaction, openRequestDatabase } from "./factory-requests.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";
import { serviceFixture } from "./test-support/chain-fixture.ts";
import { verifyReadOnlyViewer } from "./test-support/factory-viewer-fixture.ts";

const EXPECTED_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function assertNoForbiddenSinks(scriptName: string, scriptBody: string) {
	const allowlistedHrefBlock = /function setAttrs\s*\([^)]*\)\s*\{[\s\S]*?if\s*\(\s*key\s*===\s*["']href["']\s*\)\s*\{\s*const\s+checked\s*=\s*safeHref\s*\(\s*String\(value\)\s*\)\s*;\s*if\s*\(\s*!checked\s*\)\s*continue\s*;\s*node\.setAttribute\(\s*["']href["']\s*,\s*checked\s*\)\s*;\s*continue\s*;\s*\}/;
	const withoutAllowlistedSetAttrs = scriptName === "app.js"
		? scriptBody.replace(allowlistedHrefBlock, "/* allowlisted setAttrs href */")
		: scriptBody;

	for (const [label, pattern] of [
		["innerHTML", /\binnerHTML\b/],
		["outerHTML", /\bouterHTML\b/],
		["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
		["createContextualFragment", /\bcreateContextualFragment\b/],
		["DOMParser", /\bDOMParser\b/],
		["parseFromString", /\bparseFromString\b/],
		["bracket-concatenated HTML/eval sink", /\[\s*['"`][A-Za-z0-9_]+['"`]\s*\+\s*['"`][A-Za-z0-9_]+['"`]\s*\]|\[\s*['"`](?:innerHTML|outerHTML|insertAdjacentHTML|eval|Function|write|writeln|createContextualFragment|parseFromString)['"`]\s*\]/i],
		["setAttribute('style', ...)", /setAttribute\s*\(\s*['"`]style['"`]/i],
		["setAttribute('on*', ...)", /setAttribute\s*\(\s*['"`]on[a-z]+['"`]/i],
		["setAttribute('src'/'srcdoc', ...)", /setAttribute\s*\(\s*['"`](?:src|srcdoc)['"`]/i],
		["direct .href/.src/.srcdoc assignment", /\.(?:href|src|srcdoc)\s*=(?!=)/],
		["document.write/writeln", /\bdocument\.write(?:ln)?\b/],
		["eval", /\beval\s*\(/],
		["Function constructor (with or without new)", /\bFunction\s*\(/],
		["string or non-function setTimeout/setInterval", /\b(?:setTimeout|setInterval)\s*\(\s*(?!(?:\([^)]*\)\s*=>|[A-Za-z_$][A-Za-z0-9_$]*\s*=>|async\s+(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>|function\b))/],
		["location.assign/replace with non-literal", /(?:\b(?:window|globalThis|self)\.)?location\.(?:assign|replace)\s*\(\s*(?!['"`])/],
		["window.open with non-literal", /\b(?:window|globalThis|self)\.open\s*\(\s*(?!['"`])/],
		["location = assignment with non-literal", /(?:^|[^.\w$])(?:(?:window|globalThis|self)\.)?location\s*=(?!=)\s*(?!['"`])/],
		["setAttributeNS", /\bsetAttributeNS\s*\(/],
		["Object.assign(<node>, { href: ... })", /\bObject\.assign\s*\([^;)]*,\s*\{[^}]*\bhref\s*:/],
		["inline event attribute", /\bon[a-z]+\s*=/i],
	] as const) {
		assert.doesNotMatch(scriptBody, pattern, `${scriptName} must not contain ${label}`);
	}
	assert.doesNotMatch(
		withoutAllowlistedSetAttrs,
		/setAttribute\s*\(\s*['"`]href['"`]/i,
		`${scriptName} must not call setAttribute("href", ...) outside the allowlisted setAttrs helper`,
	);
}

function rawGet(urlString: string, requestTarget: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
	const parsed = new URL(urlString);
	return new Promise((resolve, reject) => {
		const req = httpRequest({
			hostname: parsed.hostname,
			port: Number(parsed.port),
			method: "GET",
			path: requestTarget,
		}, res => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", chunk => { body += chunk; });
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
		});
		req.on("error", reject);
		req.end();
	});
}

function emptyViewerDb(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "fwv-assets-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const statePath = join(root, "factories.sqlite");
	const coordinationPath = join(root, "factory-coordination.sqlite");
	const db = new DatabaseSync(statePath);
	db.exec("PRAGMA user_version = 1; CREATE TABLE factories(factory_id TEXT, name TEXT, definition TEXT, digest TEXT);");
	db.close();
	return { root, statePath, coordinationPath };
}

test("vendored Materialize CSS is served on exact allowlist route with strict CSP and traversal paths are rejected", async t => {
	const { root, statePath, coordinationPath } = emptyViewerDb(t);
	await verifyReadOnlyViewer(
		{ stateDirs: root, viewerOptions: { statePath, coordinationPath, host: "127.0.0.1", port: 0 } },
		async viewer => {
			for (const [assetPath, expectedType] of [
				["/", "text/html; charset=utf-8"],
				["/index.html", "text/html; charset=utf-8"],
				["/style.css", "text/css; charset=utf-8"],
				["/safe.js", "text/javascript; charset=utf-8"],
				["/app.js", "text/javascript; charset=utf-8"],
				["/vendor/materialize/materialize.min.css", "text/css; charset=utf-8"],
			] as const) {
				const res = await fetch(`${viewer.url}${assetPath}`);
				assert.equal(res.status, 200, `expected 200 for ${assetPath}`);
				assert.equal(res.headers.get("content-type"), expectedType, `content-type for ${assetPath}`);
				assert.equal(res.headers.get("x-content-type-options"), "nosniff", `nosniff for ${assetPath}`);
				assert.equal(res.headers.get("cache-control"), "no-store", `cache-control for ${assetPath}`);
				assert.equal(res.headers.get("content-security-policy"), EXPECTED_CSP, `CSP for ${assetPath}`);
			}

			for (const badPath of [
				"/vendor/materialize/",
				"/vendor/materialize",
				"/vendor/materialize/LICENSE",
				"/vendor/materialize/README.md",
				"/vendor/materialize/materialize.min.js",
				"/vendor/../app.js",
				"/vendor/%2e%2e/app.js",
				"/vendor/..%2fapp.js",
				"/vendor/materialize/../../app.js",
				"/vendor/%2E%2E/app.js",
				"/%2E%2E/index.html",
				"/vendor\\..\\app.js",
				"/vendor/%2E%2E%5Capp.js",
				"/../index.html",
				"/does-not-exist.css",
				"/constructor",
				"/toString",
				"/app.js?x=1",
				"/app.js?",
				"/safe.js?x=1",
				"/style.css?v=1",
				"/vendor/materialize/materialize.min.css?x=1",
			]) {
				const res = await rawGet(viewer.url, badPath);
				assert.ok(res.status === 404 || res.status === 400, `expected 404 or 400 for ${badPath}, got ${res.status}`);
			}

			const pageWithQuery = await fetch(`${viewer.url}/?factory=fac_test&view=live`);
			assert.equal(pageWithQuery.status, 200, "page shell / must still accept query parameters for view routing");
			assert.equal(pageWithQuery.headers.get("content-type"), "text/html; charset=utf-8");

			const indexHtmlWithQuery = await fetch(`${viewer.url}/index.html?factory=fac_test&view=live`);
			assert.equal(indexHtmlWithQuery.status, 200, "page shell /index.html must still accept query parameters for view routing");
			assert.equal(indexHtmlWithQuery.headers.get("content-type"), "text/html; charset=utf-8");
		},
	);
});

test("served HTML shell, stylesheets, and app.js have strict local-only hygiene, accessibility landmarks, and zero unsafe DOM sinks", async t => {
	const { root, statePath, coordinationPath } = emptyViewerDb(t);
	await verifyReadOnlyViewer(
		{ stateDirs: root, viewerOptions: { statePath, coordinationPath, host: "127.0.0.1", port: 0 } },
		async viewer => {
			const htmlRes = await fetch(`${viewer.url}/`);
			const html = await htmlRes.text();
			const cssRes = await fetch(`${viewer.url}/style.css`);
			const css = await cssRes.text();
			const matRes = await fetch(`${viewer.url}/vendor/materialize/materialize.min.css`);
			const matCss = await matRes.text();
			const safeRes = await fetch(`${viewer.url}/safe.js`);
			const safeJs = await safeRes.text();
			const jsRes = await fetch(`${viewer.url}/app.js`);
			const js = await jsRes.text();

			// HTML shell accessibility and local asset references
			assert.match(html, /<html[^>]*\blang="en"/i);
			assert.match(html, /<meta[^>]*\bname="viewport"[^>]*>/i);
			assert.match(html, /<a[^>]*href="#main-content"[^>]*>Skip to main content<\/a>/i);
			assert.match(html, /<header\b/);
			assert.match(html, /<aside\b[^>]*\bid="sidebar"/);
			assert.match(html, /<main\b[^>]*\bid="main-content"/);
			assert.match(html, /<div\b[^>]*\brole="navigation"[^>]*\baria-label="Factories"|<div\b[^>]*\baria-label="Factories"[^>]*\brole="navigation"/);
			assert.match(html, /<nav\b[^>]*\baria-label="Views"/);
			assert.equal((html.match(/<h1\b/gi) ?? []).length, 1, "HTML must contain exactly one <h1>");
			assert.match(html, /aria-expanded="false"[^>]*aria-controls="sidebar"|aria-controls="sidebar"[^>]*aria-expanded="false"/);
			assert.match(html, /<link[^>]*href="\/vendor\/materialize\/materialize\.min\.css"/);
			assert.match(html, /<link[^>]*href="\/style\.css"/);
			assert.match(html, /<script[^>]*src="\/safe\.js"/);
			assert.match(html, /<script[^>]*src="\/app\.js"/);
			for (const viewLabel of ["Factories", "Live Graph", "Inspect", "Queue", "Receipts", "Requests", "Proposals"]) {
				assert.ok(html.includes(viewLabel), `HTML missing view navigation label "${viewLabel}"`);
			}

			// Local-only asset checks (no CDN, no external URLs, no @import, no @font-face, no preconnect)
			// Only allowlisted spec URI: SVG namespace "http://www.w3.org/2000/svg".
			for (const [name, body] of [
				["index.html", html],
				["style.css", css],
				["vendor/materialize/materialize.min.css", matCss],
				["safe.js", safeJs],
				["app.js", js],
			] as const) {
				const withoutAllowedNs = body.replaceAll("http://www.w3.org/2000/svg", "");
				assert.doesNotMatch(withoutAllowedNs, /https?:\/\//i, `external http(s) URL found in ${name}`);
				assert.doesNotMatch(withoutAllowedNs, /(?:^|[\s'"(=])\/\/[a-z0-9.-]/i, `protocol-relative URL found in ${name}`);
				assert.doesNotMatch(body, /@import\b/i, `@import found in ${name}`);
				assert.doesNotMatch(body, /@font-face\b/i, `@font-face found in ${name}`);
				assert.doesNotMatch(body, /rel\s*=\s*['"]?preconnect/i, `preconnect found in ${name}`);
				assert.doesNotMatch(body, /fonts\.googleapis\.com|fonts\.gstatic\.com|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com|materializecss\.com\/.*css/i, `CDN host found in ${name}`);
			}

			// Reduced motion must be honoured in style.css
			assert.match(css, /@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);

			// No inline <script> or <style> in HTML
			assert.doesNotMatch(html, /<style\b/i, "inline <style> is forbidden");
			assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc="\/(?:safe|app)\.js")/i, "inline <script> is forbidden");

			// Forbidden DOM/eval sinks in safe.js and app.js
			for (const [scriptName, scriptBody] of [["safe.js", safeJs], ["app.js", js]] as const) {
				assertNoForbiddenSinks(scriptName, scriptBody);
			}

			// Explicit allowlist check on SAFE_HTML_ATTRS (no on*/srcdoc/style/src, and href only in the explicit set)
			const htmlAttrsMatch = /const SAFE_HTML_ATTRS = new Set\(\[([\s\S]*?)\]\);/.exec(js);
			assert.ok(htmlAttrsMatch, "app.js must define SAFE_HTML_ATTRS");
			const parsedHtmlAttrs = [...htmlAttrsMatch[1].matchAll(/"([^"]+)"/g)].map(m => m[1]);
			assert.deepEqual(
				parsedHtmlAttrs.filter(a => /^on|^(?:srcdoc|style|src)$/i.test(a) || !["class", "id", "href", "type", "name", "value", "required", "disabled", "open", "for", "scope", "role", "tabindex", "aria-label", "aria-labelledby", "aria-current", "aria-pressed", "aria-expanded", "aria-controls", "aria-live", "aria-busy", "data-view", "data-factory-id", "data-node-id", "data-focus-key"].includes(a)),
				[],
				"SAFE_HTML_ATTRS must stay strictly within the explicit safe attribute allowlist",
			);
		},
	);
});

test("multi-version fixture with restored and damaged versions, angle-bracket operator text, typed absence, and hot-journal stays read-only", async t => {
	const f = serviceFixture(t, ["builder", "reviewer"]);
	const statePath = join(f.root, "factories.sqlite");
	const coordinationPath = join(f.root, "factory-coordination.sqlite");
	const viewerEnv = { PATH: join(f.root, "bin") };
	const ops = factoryOperations(statePath, f.service, { coordinationPath });
	const sessionModel = { provider: "test-provider", id: "test-model", thinkingLevel: "medium" as const };

	const draftV1: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "SENTINEL_T08_PROMPT_V1",
		agents: [
			{ node_id: "left", persona: "builder", sub_task: "SENTINEL_T08_SUB_LEFT" },
			{ node_id: "right", persona: "builder", sub_task: "SENTINEL_T08_SUB_RIGHT" },
			{
				node_id: "review",
				persona: "reviewer",
				depends_on: ["left"],
				sub_task: "SENTINEL_T08_SUB_REVIEW",
				output_contract: { required_fields: ["verdict"], properties: { verdict: { type: "string", enum: ["approve", "changes_requested"] } } },
				decision: { field: "verdict", approve: "approve", reject: "changes_requested", on_reject: "left", max_revisions: 2, on_exhausted: "needs_attention" },
			},
			{
				node_id: "merge",
				persona: "builder",
				depends_on: ["review", "right"],
				join_policy: "allow_partial",
				sub_task: "SENTINEL_T08_SUB_MERGE",
				intervention: { choices: [{ choice_id: "keep", label: "Keep <tag> & \"quotes\"" }] },
			},
		],
	};

	const alpha = ops({ action: "publish", name: "alpha-t08", draft: draftV1, sessionModel });
	const beta = ops({ action: "publish", name: "beta-unmanaged", draft: draftV1, sessionModel });
	const auth = createManagerAuthority({ pi_session_id: "sess-t08" });
	ops({ action: "resume", factory_id: alpha.factory_id, authority: auth });
	// v2 (will be damaged), v3 restored from v1, v4 current
	ops({ action: "update", factory_id: alpha.factory_id, authority: auth, draft: { ...draftV1, task: "SENTINEL_T08_PROMPT_V2" }, sessionModel });
	ops({ action: "restore", factory_id: alpha.factory_id, authority: auth, from_version: "v1" });
	ops({ action: "submit", factory_id: alpha.factory_id, authority: auth, reference: "t08:run-v3", brief: "SENTINEL_T08_BRIEF_V3" });
	const run = await ops({ action: "launch", factory_id: alpha.factory_id, authority: auth });
	ops({ action: "update", factory_id: alpha.factory_id, authority: auth, draft: { ...draftV1, task: "SENTINEL_T08_PROMPT_V4", agents: [{ node_id: "only_v4", persona: "builder", sub_task: "SENTINEL_T08_SUB_V4" }] }, sessionModel });
	revokeManagerAuthority(auth);

	// Seed a request and proposal containing angle brackets and quotes, and damage v2 definition JSON.
	const mergeCfg = run.manifest.pane_manifest.find(m => m.node_id === "merge")!;
	const reqDb = openRequestDatabase(statePath);
	try {
		inTransaction(reqDb, () => {
			createRequest(reqDb, {
				request_id: "req-xss-t08",
				factory_id: alpha.factory_id,
				input_id: run.input_id,
				attempt_id: run.attempt_id,
				task_id: run.task_id,
				node_id: "merge",
				node_attempt_id: `${mergeCfg.instance_id}.1`,
				question: "Should <script>alert(\"xss\")</script> be treated as 'plain text'?",
				reason: "Operator text safety check",
				evidence: ["Observed operator text"],
				choices: ["keep"],
				created_at: new Date().toISOString(),
			});
			insertProposalRow(reqDb, buildProposalRow({
				proposal_id: "prop-xss-t08",
				factory_id: alpha.factory_id,
				reference: "prop-ref-t08",
				proposal_action: "add",
				source: "agent",
				target_constraint_id: null,
				assigned_constraint_id: null,
				text: "Never emit <script>alert('1')</script> or \"raw\" HTML",
				run_id: run.task_id,
				attempt_id: `${mergeCfg.instance_id}.1`,
				evidence_ref: "run:merge",
				note: null,
				conflicting_ids: "[]",
				canonical_checkout: f.cwd,
				outcome: "pending",
				duplicate_of: null,
				rejection_reason: null,
				proposed_at: new Date().toISOString(),
				decided_at: null,
				decided_by: null,
				file_sync_state: null,
				expected_before_digest: null,
				expected_after_digest: null,
				committed_entry_json: null,
				sync_error: null,
				eligibility_json: JSON.stringify({
					kind: "intervention",
					factory_attempt_id: run.attempt_id,
					attempt_id: `${mergeCfg.instance_id}.1`,
					evidence_ref: "run:merge",
					verified_at: new Date().toISOString(),
				}),
			}));
		});
		reqDb.prepare("UPDATE factory_versions SET definition = '{damaged' WHERE factory_id = ? AND version = 'v2'").run(alpha.factory_id);
	} finally {
		reqDb.close();
	}

	const sentinels = [
		"SENTINEL_T08_PROMPT_V1",
		"SENTINEL_T08_PROMPT_V2",
		"SENTINEL_T08_PROMPT_V4",
		"SENTINEL_T08_SUB_LEFT",
		"SENTINEL_T08_SUB_RIGHT",
		"SENTINEL_T08_SUB_REVIEW",
		"SENTINEL_T08_SUB_MERGE",
		"SENTINEL_T08_SUB_V4",
		"SENTINEL_T08_BRIEF_V3",
		f.root,
		f.cwd,
		f.home,
	];

	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath, coordinationPath, env: viewerEnv, home: f.home } },
		async viewer => {
			async function getChecked(path: string, expectedStatus = 200) {
				const res = await fetch(`${viewer.url}${path}`);
				const text = await res.text();
				assert.equal(res.status, expectedStatus, `${path} -> ${res.status}: ${text}`);
				for (const s of sentinels) {
					assert.equal(text.includes(s), false, `${path} leaked sentinel ${JSON.stringify(s)}`);
				}
				return JSON.parse(text) as any;
			}

			const live = await getChecked(`/api/factories/${alpha.factory_id}/live`);
			assert.equal(live.state, "running");
			assert.equal(live.run.bound_version, "v3");
			assert.equal(live.current_version, "v4");
			assert.equal(live.graph.evidence, "available");
			assert.equal(live.graph.joins.length, 1);
			assert.equal(live.graph.feedback_edges.length, 1);

			// Restored version v3 shows restored_from v1 and resolves node links in v3.
			const inspV3 = await getChecked(`/api/factories/${alpha.factory_id}/inspect?version=v3&node=merge`);
			assert.equal(inspV3.inspected_version, "v3");
			assert.equal(inspV3.current_version, "v4");
			assert.equal(inspV3.definition.restored_from.version, "v1");
			assert.equal(inspV3.target_node.verified, true);
			assert.equal(inspV3.target_node.node.id, "merge");

			// Damaged version v2 must fail closed to evidence unavailable without defaulting to current v4.
			const inspV2 = await getChecked(`/api/factories/${alpha.factory_id}/inspect?version=v2`);
			assert.equal(inspV2.inspected_version, "v2");
			assert.equal(inspV2.current_version, "v4");
			assert.equal(inspV2.definition.evidence, "unavailable");
			assert.equal(inspV2.definition.absence, "evidence unavailable");

			// Typed absence distinct on unmanaged beta vs managed alpha.
			const betaInspect = await getChecked(`/api/factories/${beta.factory_id}/inspect`);
			assert.equal(betaInspect.attention_summary.stop_state.absence, "not applicable");
			assert.equal(betaInspect.damaged_records.absence, "no records");
			const betaQueue = await getChecked(`/api/factories/${beta.factory_id}/queue?filter=open`);
			assert.equal(betaQueue.absence, "not applicable");
			const betaRequests = await getChecked(`/api/factories/${beta.factory_id}/requests`);
			assert.equal(betaRequests.absence, "not applicable");

			// Queue, Receipts (known + unknown), Requests & Proposals (preserving angle brackets/quotes safely in JSON).
			const queueAll = await getChecked(`/api/factories/${alpha.factory_id}/queue?filter=all`);
			assert.equal(queueAll.entries.length, 1);
			assert.equal(queueAll.entries[0].receipt_url, `/?factory=${alpha.factory_id}&view=receipts&reference=t08%3Arun-v3`);
			const receiptOk = await getChecked(`/api/factories/${alpha.factory_id}/receipts?reference=t08%3Arun-v3`);
			assert.equal(receiptOk.is_run_report, false);
			assert.equal(receiptOk.bound_version, "v3");
			await getChecked(`/api/factories/${alpha.factory_id}/receipts?reference=unknown-ref`, 404);

			const reqs = await getChecked(`/api/factories/${alpha.factory_id}/requests`);
			assert.equal(reqs.records[0].question, "Should <script>alert(\"xss\")</script> be treated as 'plain text'?");
			assert.equal(reqs.records[0].choices[0].label, "Keep <tag> & \"quotes\"");

			const props = await getChecked(`/api/factories/${alpha.factory_id}/proposals`);
			assert.equal(props.is_active_constraints_file, false);
			assert.equal(props.records[0].text, "Never emit <script>alert('1')</script> or \"raw\" HTML");
		},
	);
});

test("hot-journal store fails closed across inspect/queue/requests/proposals without recovery", async t => {
	const f = serviceFixture(t, ["first"]);
	const iso = isolatedPiEnvironment();
	t.after(() => iso.cleanup());
	mkdirSync(join(iso.agentDir, "agents"), { recursive: true });
	writeFileSync(join(iso.agentDir, "agents", "first.md"), "---\ntools: read,bash\nmodel: test-provider/test-model\n---\nExact persona first\n");
	const dbPath = join(f.root, "factories.sqlite");
	const draftFile = join(f.root, "draft.json");
	const draft: GenerateRequest = {
		project_cwd: f.cwd,
		topology: "graph",
		task: "Hot journal test",
		agents: [{ persona: "first", node_id: "build", sub_task: "x".repeat(3 * 1024 * 1024) }],
	};
	writeFileSync(draftFile, JSON.stringify(draft));
	const child = fileURLToPath(new URL("./test-support/factory-publish-child.ts", import.meta.url));
	const killed = await runSupervised(process.execPath, [child, dbPath, draftFile, "hot-factory", "before_commit"], {
		env: { ...iso.env, PATH: join(f.root, "bin") },
		timeoutMs: 10_000,
	});
	assert.equal(killed.signal, "SIGKILL", killed.stderr);
	assert.equal(existsSync(`${dbPath}-journal`), true);

	const coordPath = join(f.root, "factory-coordination.sqlite");
	await verifyReadOnlyViewer(
		{ stateDirs: f.root, viewerOptions: { statePath: dbPath, coordinationPath: coordPath, env: { PATH: join(f.root, "bin") }, home: f.home } },
		async viewer => {
			assert.equal((await fetch(`${viewer.url}/api/factories`)).status, 503);
			for (const route of ["inspect", "queue", "requests", "proposals"]) {
				const res = await fetch(`${viewer.url}/api/factories/fac_any/${route}`);
				assert.equal(res.status, 200);
				const body = await res.json() as { evidence: string; absence: string };
				assert.equal(body.evidence, "unavailable");
				assert.equal(body.absence, "evidence unavailable");
			}
			assert.equal((await fetch(`${viewer.url}/api/factories/fac_any/live`)).status, 503);
			assert.equal((await fetch(`${viewer.url}/api/factories/fac_any/receipts?reference=r1`)).status, 503);
		},
	);
	assert.equal(existsSync(`${dbPath}-journal`), true);
});

test("served safe.js pure client logic enforces safeHref, typed live absence, null-proto status/view maps, non-healthy fallbacks, safe node ids, and factory match checks", async t => {
	const { root, statePath, coordinationPath } = emptyViewerDb(t);
	await verifyReadOnlyViewer(
		{ stateDirs: root, viewerOptions: { statePath, coordinationPath, host: "127.0.0.1", port: 0 } },
		async viewer => {
			const res = await fetch(`${viewer.url}/safe.js`);
			assert.equal(res.status, 200);
			const code = await res.text();
			const context: Record<string, any> = {
				URL,
				URLSearchParams,
				Object,
				Set,
				Array,
				String,
				Boolean,
				location: { origin: viewer.url },
			};
			context.globalThis = context;
			vm.runInNewContext(code, context);
			const safe = context.FactoryViewerSafe;
			assert.ok(safe, "FactoryViewerSafe must be exported on globalThis");

			// 1. safeHref
			assert.equal(safe.safeHref("/?factory=fac_1&view=live", viewer.url), "/?factory=fac_1&view=live");
			assert.equal(safe.safeHref("/api/factories/fac_1/inspect?version=v2", viewer.url), "/api/factories/fac_1/inspect?version=v2");
			assert.equal(safe.safeHref("?factory=fac_1&view=queue", viewer.url), "/?factory=fac_1&view=queue");
			assert.equal(safe.safeHref("/a/./b?x=1#y", viewer.url), "/a/b?x=1#y");
			assert.equal(safe.safeHref("/a/b/../c", viewer.url), "/a/c");
			for (const badHref of [
				"javascript:alert(1)",
				"JaVaScRiPt:alert(1)",
				"  javascript:alert(1)",
				"\u0000javascript:alert(1)",
				"\u0007javascript:alert(1)",
				"java\tscript:alert(1)",
				"java\nscript:alert(1)",
				"data:text/html,<script>alert(1)</script>",
				"//evil.example/path",
				"///evil.example/path",
				"/.//evil.com",
				"/..//evil.com/x?y#z",
				"/a/..//evil.com",
				"/a/b/../..//evil.com",
				"/././/evil.com",
				"/%2e//evil.com",
				"/%2e%2e//evil.com",
				"/%2E//evil.com",
				"/%2E%2E//evil.com",
				"/.%2e//evil.com",
				"/%2e.//evil.com",
				"/a/%2e%2e//evil.com",
				"/a/%2e%2e/%2e%2e//evil.com/x?y#z",
				"/\\evil.example",
				"\\\\evil.example",
				"/path\\subpath",
				"/path\tcontrol",
				"https://evil.example/path",
				"http://evil.example/path",
				"",
				"   ",
			]) {
				assert.equal(safe.safeHref(badHref, viewer.url), null, `safeHref must reject ${JSON.stringify(badHref)}`);
			}

			// 1b. pageUrl and pageUrlFromApiOrHref (S29/S29b/S29c)
			assert.equal(safe.pageUrl({ factory: "fac_1" }), "/?factory=fac_1&view=live");
			assert.equal(safe.pageUrl({ view: "bogus" }), "/?view=factories");
			assert.equal(safe.pageUrl({ factory: "../bad", view: "live" }), "/?view=live");
			assert.equal(safe.pageUrl({ factory: "fac_1", view: "inspect", version: "v2", node: "merge" }), "/?factory=fac_1&view=inspect&version=v2&node=merge");
			assert.equal(safe.pageUrl({ factory: "fac_1", view: "inspect", version: "bad", node: "bad/node" }), "/?factory=fac_1&view=inspect");
			assert.equal(safe.pageUrl({ factory: "fac_1", view: "queue", filter: "all" }), "/?factory=fac_1&view=queue&filter=all");
			assert.equal(safe.pageUrl({ factory: "fac_1", view: "queue", filter: "other" }), "/?factory=fac_1&view=queue&filter=open");
			assert.equal(safe.pageUrl({ factory: "fac_1", view: "receipts", reference: "  t08:run-v3  " }), "/?factory=fac_1&view=receipts&reference=t08%3Arun-v3");
			assert.equal(safe.pageUrl({ factory: "fac_1", view: "receipts", reference: "   " }), "/?factory=fac_1&view=receipts");

			assert.equal(safe.pageUrlFromApiOrHref("/?factory=fac_1&view=live", viewer.url), "/?factory=fac_1&view=live");
			assert.equal(safe.pageUrlFromApiOrHref("/index.html?factory=fac_1&view=inspect&version=v2", viewer.url), "/index.html?factory=fac_1&view=inspect&version=v2");
			assert.equal(safe.pageUrlFromApiOrHref("/api/factories/fac_1/inspect?version=v3&node=merge", viewer.url), "/?factory=fac_1&view=inspect&version=v3&node=merge");
			assert.equal(safe.pageUrlFromApiOrHref("/api/factories/fac_1/queue?filter=all", viewer.url), "/?factory=fac_1&view=queue&filter=all");
			assert.equal(safe.pageUrlFromApiOrHref("/api/factories/fac_1/receipts?reference=t08%3Arun-v3", viewer.url), "/?factory=fac_1&view=receipts&reference=t08%3Arun-v3");
			assert.equal(safe.pageUrlFromApiOrHref("/api/factories/fac_1/requests", viewer.url), "/?factory=fac_1&view=requests");
			assert.equal(safe.pageUrlFromApiOrHref("/api/factories/fac_1/proposals", viewer.url), "/?factory=fac_1&view=proposals");
			assert.equal(safe.pageUrlFromApiOrHref("/api/factories/fac_1/live", viewer.url), "/?factory=fac_1&view=live");
			for (const badApiOrHref of [
				"javascript:alert(1)",
				"/.//evil.com",
				"https://evil.example/?factory=fac_1&view=live",
				"/api/factories/fac_1/unknown",
				"/api/other",
				"/api/factories/%E0%A4%A/live",
			]) {
				assert.equal(safe.pageUrlFromApiOrHref(badApiOrHref, viewer.url), null, `pageUrlFromApiOrHref must reject ${badApiOrHref}`);
			}

			// 2. Live typed absence mapping
			assert.equal(
				safe.resolveLiveRunIdentityAbsence({ state: "uncertain", graph: { evidence: "unavailable", absence: "evidence unavailable", explanation: "Missing release" }, run: null }).absence,
				"evidence unavailable",
			);
			assert.equal(
				safe.resolveLiveBoundVersionAbsence({ state: "uncertain", graph: { evidence: "unavailable", absence: "evidence unavailable", explanation: "Missing release" }, run: null }).absence,
				"evidence unavailable",
			);
			// Uncertain with omitted absence must render evidence unavailable, NEVER no records
			assert.equal(
				safe.resolveLiveRunIdentityAbsence({ state: "uncertain", run: null }).absence,
				"evidence unavailable",
			);
			assert.equal(
				safe.resolveLiveBoundVersionAbsence({ state: "uncertain", run: null }).absence,
				"evidence unavailable",
			);
			// S6: non-uncertain body with omitted absence must render evidence unavailable, NEVER no records
			for (const nonUncertainState of ["idle", "waiting", "blocked", "ended"]) {
				assert.equal(
					safe.resolveLiveAbsence({ state: nonUncertainState, run: null }),
					"evidence unavailable",
					`resolveLiveAbsence for ${nonUncertainState} without absence must not default to no records`,
				);
				assert.equal(
					safe.resolveLiveRunIdentityAbsence({ state: nonUncertainState, run: null }).absence,
					"evidence unavailable",
				);
				assert.equal(
					safe.resolveLiveBoundVersionAbsence({ state: nonUncertainState, run: null }).absence,
					"evidence unavailable",
				);
			}
			// S12 / S12b: bound_version absence-object branches on run and graph
			const runBvAbsence = safe.resolveLiveBoundVersionAbsence({
				state: "blocked",
				run: { bound_version: { absence: "not applicable", explanation: "Run has no bound version" } },
				graph: { absence: "no records" },
			});
			assert.equal(runBvAbsence.absence, "not applicable");
			assert.equal(runBvAbsence.explanation, "Run has no bound version");
			const graphBvAbsence = safe.resolveLiveBoundVersionAbsence({
				state: "blocked",
				run: null,
				graph: { bound_version: { absence: "no records", explanation: "Graph has no bound version" }, absence: "not applicable" },
			});
			assert.equal(graphBvAbsence.absence, "no records");
			assert.equal(graphBvAbsence.explanation, "Graph has no bound version");
			// Unmanaged factory
			assert.equal(
				safe.resolveLiveRunIdentityAbsence({ state: "idle", graph: { absence: "not applicable", explanation: "Unmanaged" }, run: null }).absence,
				"not applicable",
			);
			assert.equal(
				safe.resolveLiveBoundVersionAbsence({ state: "idle", graph: { absence: "not applicable", explanation: "Unmanaged" }, run: null }).absence,
				"not applicable",
			);
			// Managed with no release
			assert.equal(
				safe.resolveLiveRunIdentityAbsence({ state: "idle", graph: { absence: "no records", explanation: "No released run" }, run: null }).absence,
				"no records",
			);
			// Run's own absence field takes precedence
			assert.equal(
				safe.resolveLiveRunIdentityAbsence({ state: "blocked", run: { absence: "not applicable", explanation: "Unreleased" }, graph: { absence: "no records" } }).absence,
				"not applicable",
			);

			// 3. Prototype-key lookups and missing/unknown values
			for (const protoKey of ["constructor", "__proto__", "toString", "valueOf", "hasOwnProperty", "bogus_state"]) {
				const statusMeta = safe.resolveStatusMeta(protoKey);
				assert.equal(statusMeta.tone, "tone-warn", `status ${protoKey} must use uncertain cue`);
				assert.equal(statusMeta.symbol, "?");
				assert.equal(statusMeta.label, `Unknown: ${protoKey}`);
				assert.equal(statusMeta.label.includes("undefined"), false);

				const absenceMeta = safe.resolveAbsenceMeta(protoKey);
				assert.equal(absenceMeta.tone, "tone-warn", `absence ${protoKey} must use uncertain cue`);
				assert.equal(absenceMeta.symbol, "?");
				assert.equal(absenceMeta.label, `Unknown: ${protoKey}`);

				const bannerMeta = safe.resolveBannerMeta(protoKey);
				assert.equal(bannerMeta.tone, "tone-warn", `banner ${protoKey} must use uncertain cue`);
				assert.equal(bannerMeta.label, `Unknown: ${protoKey}`);

				const viewLabel = safe.getViewLabel(protoKey);
				assert.equal(viewLabel, `Unknown: ${protoKey}`);
			}

			for (const emptyVal of [undefined, null, "", "   "]) {
				const statusMeta = safe.resolveStatusMeta(emptyVal);
				assert.equal(statusMeta.tone, "tone-warn");
				assert.equal(statusMeta.symbol, "?");
				assert.equal(statusMeta.label, "Unknown (not provided)");

				// S13: missing/empty resolveAbsenceMeta must fail closed to Evidence unavailable, NEVER No records
				const absenceMeta = safe.resolveAbsenceMeta(emptyVal);
				assert.equal(absenceMeta.tone, "tone-error");
				assert.equal(absenceMeta.symbol, "!");
				assert.equal(absenceMeta.label, "Evidence unavailable");
			}
			assert.equal(safe.resolveAbsenceMeta("no records").label, "No records");
			assert.equal(safe.resolveAbsenceMeta("not applicable").label, "Not applicable");
			assert.equal(safe.resolveAbsenceMeta("evidence unavailable").label, "Evidence unavailable");

			// S25 / S25b: resolveHeadEligibility unknown/missing must not default to Eligible or None
			for (const unknownHead of [undefined, null, {}]) {
				const elig = safe.resolveHeadEligibility(unknownHead);
				assert.equal(elig.eligibleStatus, undefined);
				assert.equal(elig.eligibleLabel, undefined);
				assert.equal(elig.blockingKind, "status");
				assert.equal(elig.blockingStatus, undefined);
				assert.equal(elig.blockingLabel, undefined);
				assert.equal(elig.blockingText, null);
			}
			assert.deepEqual(
				{ ...safe.resolveHeadEligibility({ eligible: true }) },
				{ eligibleStatus: "available", eligibleLabel: "Eligible", blockingKind: "text", blockingStatus: undefined, blockingLabel: undefined, blockingText: "None" },
			);
			assert.deepEqual(
				{ ...safe.resolveHeadEligibility({ eligible: false, blocking_kind: "stopped" }) },
				{ eligibleStatus: "blocked", eligibleLabel: "Not eligible", blockingKind: "status", blockingStatus: "blocked", blockingLabel: "stopped", blockingText: null },
			);
			assert.deepEqual(
				{ ...safe.resolveHeadEligibility({ eligible: false, blocking_kind: "empty" }) },
				{ eligibleStatus: "blocked", eligibleLabel: "Not eligible", blockingKind: "status", blockingStatus: "idle", blockingLabel: "empty", blockingText: null },
			);
			assert.deepEqual(
				{ ...safe.resolveHeadEligibility({ eligible: false }) },
				{ eligibleStatus: "blocked", eligibleLabel: "Not eligible", blockingKind: "status", blockingStatus: undefined, blockingLabel: undefined, blockingText: null },
			);

			// 4. Fallback labels never default missing fields to healthy/active/verified/available
			assert.equal(safe.resolveInspectOverallEvidence({}), undefined);
			assert.equal(safe.resolveStatusMeta(safe.resolveInspectOverallEvidence({})).label, "Unknown (not provided)");
			assert.equal(safe.resolveStatusMeta(safe.resolveInspectOverallEvidence({})).tone, "tone-warn");

			const missingStop = safe.resolveStopStateValue({});
			assert.equal(missingStop.kind, "status");
			assert.equal(missingStop.value, undefined);
			assert.equal(safe.resolveStatusMeta(missingStop.value).label, "Unknown (not provided)");

			const missingUncertain = safe.resolveBooleanVerification(undefined);
			assert.equal(missingUncertain.status, undefined);
			assert.equal(safe.resolveStatusMeta(missingUncertain.status, missingUncertain.label).label, "Unknown (not provided)");

			assert.equal(safe.resolveSnapshotEvidence({}), undefined);
			assert.equal(safe.resolveBannerMeta(safe.resolveSnapshotEvidence({})).label, "Unknown (not provided)");
			assert.equal(safe.resolveBannerMeta(safe.resolveSnapshotEvidence({})).tone, "tone-warn");

			assert.match(safe.resolveSidebarManagementLabel(undefined), /Unknown \(not provided\)/);
			assert.match(safe.resolveSidebarManagementLabel("constructor"), /Unknown: constructor/);

			// Unguarded dereference helpers return labelled absence
			const missingRestored = safe.resolveRestoredFromDisplay(undefined);
			assert.equal(missingRestored.kind, "absence");
			assert.equal(missingRestored.value.absence, "evidence unavailable");

			const missingHold = safe.resolveBlockingHoldDisplay(null);
			assert.equal(missingHold.kind, "absence");
			assert.equal(missingHold.value.absence, "evidence unavailable");

			// 5. ID sanitiser never yields a page-owned id and is collision-free across distinct inputs
			for (const pageId of ["main-content", "content", "sidebar", "menu-toggle", "drawer-close", "drawer-backdrop", "factories-list", "view-heading", "factory-subtitle", "header-scope", "inspect-version-select", "receipt-ref-input"]) {
				const domId = safe.safeNodeDomId(pageId, pageId);
				assert.notEqual(domId, pageId, `safeNodeDomId must never collide with page-owned id ${pageId}`);
				assert.equal(safe.PAGE_OWNED_IDS.has(domId), false);
				assert.match(domId, /^n-[A-Za-z0-9_-]+$/);
			}
			assert.match(safe.safeNodeDomId("<script>alert(1)</script>", "node_1"), /^n-[A-Za-z0-9_-]+$/);
			assert.notEqual(safe.safeNodeDomId("a.b", "a.b"), safe.safeNodeDomId("a_b", "a_b"));
			assert.notEqual(safe.safeNodeDomId("a.b", "a.b"), safe.safeNodeDomId("a_2e_b", "a_2e_b"));
			assert.notEqual(safe.safeNodeDomId("a/b", "a/b"), safe.safeNodeDomId("a:b", "a:b"));
			assert.notEqual(
				safe.safeNodeDomId(`${"x".repeat(125)}_1`, `${"x".repeat(125)}_1`),
				safe.safeNodeDomId(`${"x".repeat(125)}_2`, `${"x".repeat(125)}_2`),
			);
			assert.notEqual(safe.safeNodeDomId(undefined, undefined), safe.safeNodeDomId("node", "node"));
			// Ticket 08 review low items: no trimming, anchor vs id namespace separation, N4 hex without terminator, N5 case-folding
			assert.notEqual(safe.safeNodeDomId(undefined, "  pad  "), safe.safeNodeDomId(undefined, "pad"));
			assert.notEqual(safe.safeNodeDomId("  pad  ", "  pad  "), safe.safeNodeDomId("pad", "pad"));
			assert.notEqual(safe.safeNodeDomId(undefined, "   "), safe.safeNodeDomId(undefined, undefined));
			assert.notEqual(safe.safeNodeDomId("q", "p"), safe.safeNodeDomId(undefined, "q"));
			assert.notEqual(safe.safeNodeDomId(undefined, "\x0eb"), safe.safeNodeDomId(undefined, "\xeb"));
			assert.notEqual(safe.safeNodeDomId(undefined, "\x010"), safe.safeNodeDomId(undefined, "\x10"));
			assert.notEqual(safe.safeNodeDomId(undefined, "NodeA"), safe.safeNodeDomId(undefined, "nodea"));
			assert.match(safe.safeNodeDomId("q", "p"), /^n-[A-Za-z0-9_-]+$/);
			assert.match(safe.safeNodeDomId(undefined, "\x0eb"), /^n-[A-Za-z0-9_-]+$/);

			// S11: typed run absence object on Live snapshot
			const runTypedNotApplicable = safe.resolveLiveRunIdentityAbsence({
				state: "blocked",
				run: { absence: "not applicable", explanation: "Unreleased launch attempt" },
				graph: { absence: "evidence unavailable" },
			});
			assert.equal(runTypedNotApplicable.absence, "not applicable");
			assert.equal(runTypedNotApplicable.explanation, "Unreleased launch attempt");
			const runTypedUnavailable = safe.resolveLiveRunIdentityAbsence({
				state: "uncertain",
				run: { absence: "evidence unavailable", explanation: "Missing release manifest" },
			});
			assert.equal(runTypedUnavailable.absence, "evidence unavailable");
			assert.equal(runTypedUnavailable.explanation, "Missing release manifest");

			// 6. Factory ID match check
			assert.equal(safe.matchesSelectedFactory({ factory_id: "fac_a" }, "fac_a"), true);
			assert.equal(safe.matchesSelectedFactory({ factory_id: "fac_b" }, "fac_a"), false);
			assert.equal(safe.matchesSelectedFactory({}, "fac_a"), false);
			assert.equal(safe.matchesSelectedFactory(null, "fac_a"), false);

			assert.equal(safe.outputApiUrl("fac_1", "build_1"), "/api/factories/fac_1/output?node=build_1");
			assert.equal(safe.outputApiUrl("../bad", "build_1"), null);
			assert.equal(safe.outputApiUrl("fac_1", "../bad"), null);
			assert.equal(safe.outputApiUrl("fac_1", ""), null);
			assert.equal(safe.matchesSelectedOutputTarget({ factory_id: "fac_a", node_id: "n1" }, "fac_a", "n1"), true);
			assert.equal(safe.matchesSelectedOutputTarget({ factory_id: "fac_a", node_id: "n2" }, "fac_a", "n1"), false);
			assert.equal(safe.matchesSelectedOutputTarget({ factory_id: "fac_b", node_id: "n1" }, "fac_a", "n1"), false);
			assert.equal(safe.matchesSelectedOutputTarget({ factory_id: "fac_a" }, "fac_a", "n1"), false);

			// 7. Frozen export and maps (hardening)
			assert.equal(Object.isFrozen(safe), true, "FactoryViewerSafe must be frozen");
			assert.equal(Object.isFrozen(safe.VIEW_LABELS), true, "VIEW_LABELS must be frozen");
			assert.equal(Object.isFrozen(safe.STATUS_META), true, "STATUS_META must be frozen");
			assert.equal(Object.isFrozen(safe.STATUS_META.running), true, "STATUS_META entries must be frozen");
			assert.equal(Object.isFrozen(safe.ABSENCE_META), true, "ABSENCE_META must be frozen");
			assert.equal(Object.isFrozen(safe.ABSENCE_META["no records"]), true, "ABSENCE_META entries must be frozen");
			assert.equal(Object.isFrozen(safe.PAGE_OWNED_IDS), true, "PAGE_OWNED_IDS must be frozen");
			assert.equal(Object.isFrozen(safe.VALID_VIEWS), true, "VALID_VIEWS must be frozen");
			assert.throws(() => safe.PAGE_OWNED_IDS.add("tamper"), { name: "TypeError" });
			assert.throws(() => safe.VALID_VIEWS.add("tamper"), { name: "TypeError" });

			// 8. Reassuring fallback elimination helpers (Item 4)
			const emptyNoAbsence = safe.resolveEmptyCollectionBanner({ entries: [] }, undefined, "No queue entries.");
			assert.equal(emptyNoAbsence.pillKey, undefined);
			assert.equal(safe.resolveBannerMeta(emptyNoAbsence.pillKey).tone, "tone-warn");
			assert.equal(safe.resolveBannerMeta(emptyNoAbsence.pillKey).label, "Unknown (not provided)");
			assert.equal(emptyNoAbsence.reason, "Unknown (not provided)");

			const emptyWithNoRecords = safe.resolveEmptyCollectionBanner({ absence: "no records", entries: [] }, "available", "No queue entries.");
			assert.equal(emptyWithNoRecords.pillKey, "no records");
			assert.equal(emptyWithNoRecords.reason, "No queue entries.");

			const emptyUnavailable = safe.resolveEmptyCollectionBanner({ records: [] }, "unavailable", "No requests recorded.");
			assert.equal(emptyUnavailable.pillKey, "evidence unavailable");

			const availEmptyNodes = safe.resolveLiveGraphBanner({ state: "running", graph: { evidence: "available", nodes: [] } }, "running");
			assert.equal(availEmptyNodes.pillKey, undefined);
			assert.equal(safe.resolveBannerMeta(availEmptyNodes.pillKey).tone, "tone-warn");
			assert.equal(availEmptyNodes.reason, "Unknown (not provided)");

			const omittedGraphRunning = safe.resolveLiveGraphBanner({ state: "running" }, "running");
			assert.equal(omittedGraphRunning.pillKey, undefined);
			assert.equal(omittedGraphRunning.reason, "Unknown (not provided)");

			const omittedGraphUncertain = safe.resolveLiveGraphBanner({ state: "uncertain" }, "uncertain");
			assert.equal(omittedGraphUncertain.pillKey, "evidence unavailable");

			const notApplicableGraph = safe.resolveLiveGraphBanner({ state: "idle", graph: { evidence: "not applicable", absence: "not applicable", explanation: "Unmanaged" } }, "idle");
			assert.equal(notApplicableGraph.pillKey, "not applicable");
			assert.equal(notApplicableGraph.reason, "Unmanaged");

			const badReceipt = safe.resolveUnexpectedReceiptBanner({ factory_id: "fac_1" });
			assert.equal(badReceipt.pillKey, undefined);
			assert.equal(badReceipt.reason, "Unknown (not provided)");

			// 9. Ticket 09 pure decision functions: stale vs uncertain, run identity, transitions, poll scheduler, keyed diff
			assert.equal(safe.LIVE_POLL_INTERVAL_MS, 2000);
			assert.notEqual(safe.STALE_META.symbol, safe.STATUS_META.uncertain.symbol);
			assert.notEqual(safe.STALE_META.tone, safe.STATUS_META.uncertain.tone);
			assert.notEqual(safe.STALE_META.label, safe.STATUS_META.uncertain.label);
			assert.equal(safe.resolveBannerMeta("stale").symbol, "⟳");
			assert.equal(safe.resolveBannerMeta("stale").tone, "tone-stale");

			assert.equal(safe.hasVerifiedRunIdentity({ state: "running", run: {} }), false);
			assert.equal(safe.hasVerifiedRunIdentity({ state: "running", run: null }), false);
			assert.equal(safe.hasVerifiedRunIdentity({ state: "blocked", run: { absence: "not applicable" } }), false);
			assert.equal(safe.hasVerifiedRunIdentity({ state: "running", run: { run_id: "run-1", attempt_id: "att-1", bound_version: "v1" } }), true);
			assert.equal(safe.getLiveRunKey({ run: { run_id: "r1", attempt_id: "a1", bound_version: "v1" } }), "r1\u0000a1\u0000v1");
			assert.equal(safe.getLiveRunKey({ run: {} }), null);

			const run1Running = {
				factory_id: "fac_1",
				state: "running",
				current_version: "v1",
				checked_at: "2026-11-24T12:00:00Z",
				run: { run_id: "r1", attempt_id: "a1", bound_version: "v1" },
				graph: { evidence: "available", nodes: [{ id: "n1", status: "running" }], edges: [] },
			};
			const run1Updated = {
				...run1Running,
				checked_at: "2026-11-24T12:00:02Z",
				graph: { evidence: "available", nodes: [{ id: "n1", status: "succeeded" }], edges: [] },
			};
			const run1EndedSettled = {
				factory_id: "fac_1",
				state: "ended",
				current_version: "v1",
				checked_at: "2026-11-24T12:00:04Z",
				run: { run_id: "r1", attempt_id: "a1", bound_version: "v1" },
				outcome: "passed",
				settlement: "settled",
				capacity_release: "released",
				graph: { evidence: "not applicable", absence: "not applicable", explanation: "Settled" },
			};
			const run2Running = {
				factory_id: "fac_1",
				state: "running",
				current_version: "v1",
				checked_at: "2026-11-24T12:00:06Z",
				run: { run_id: "r2", attempt_id: "a2", bound_version: "v1" },
				graph: { evidence: "available", nodes: [{ id: "n1", status: "running" }], edges: [] },
			};
			const uncertainSnap = {
				factory_id: "fac_1",
				state: "uncertain",
				reason: "Missing release record",
				checked_at: "2026-11-24T12:00:08Z",
				run: null,
				graph: { evidence: "unavailable", absence: "evidence unavailable", explanation: "Missing release record" },
			};

			assert.equal(safe.classifyLiveTransition(run1Running, run1Updated).mode, "patch-graph");
			assert.equal(safe.classifyLiveTransition(run1Running, run1Updated).resetGraphState, false);
			assert.equal(safe.classifyLiveTransition(run1Running, run1EndedSettled).mode, "patch-summary");
			assert.equal(safe.classifyLiveTransition(run1EndedSettled, run2Running).mode, "next-run");
			assert.equal(safe.classifyLiveTransition(run1EndedSettled, run2Running).resetGraphState, true);
			assert.equal(safe.classifyLiveTransition(run1EndedSettled, run2Running).clearSelection, true);

			// Ended outcome stays visible if subsequent read reports idle/waiting without a new run, but uncertain replaces it
			const retainedEnded = safe.classifyLiveTransition(run1EndedSettled, {
				factory_id: "fac_1",
				state: "idle",
				checked_at: "2026-11-24T12:00:05Z",
				run: null,
				head_status: { eligible: false, blocking_kind: "empty", explanation: "No queued inputs." },
			});
			assert.equal(retainedEnded.effectiveSnapshot.state, "ended");
			assert.equal(retainedEnded.effectiveSnapshot.outcome, "passed");
			assert.equal(retainedEnded.effectiveSnapshot.checked_at, "2026-11-24T12:00:05Z");
			const uncertainAfterEnded = safe.classifyLiveTransition(run1EndedSettled, uncertainSnap);
			assert.equal(uncertainAfterEnded.mode, "replace");
			assert.equal(uncertainAfterEnded.effectiveSnapshot.state, "uncertain");

			// Stale / fresh state machine
			let sess = safe.createLiveSessionState("fac_1");
			let step = safe.reduceLiveFetchOutcome(sess, { kind: "success", data: run1Running, receivedAt: "t0" });
			sess = step.session;
			assert.equal(sess.stale, null);
			assert.equal(sess.lastGood.checked_at, "2026-11-24T12:00:00Z");

			// Failed refresh -> Stale with lastCheckedAt & reason; lastGood preserved
			step = safe.reduceLiveFetchOutcome(sess, { kind: "error", status: 503, message: "Evidence unavailable", detail: "HTTP 503", receivedAt: "t1" });
			sess = step.session;
			assert.equal(sess.lastGood.checked_at, "2026-11-24T12:00:00Z");
			assert.equal(sess.stale.lastCheckedAt, "2026-11-24T12:00:00Z");
			assert.equal(sess.stale.reason, "Evidence unavailable");

			// Factory mismatch on refresh while lastGood exists -> Stale (never shows foreign factory)
			step = safe.reduceLiveFetchOutcome(sess, { kind: "success", data: { ...run1Running, factory_id: "fac_other" }, receivedAt: "t2" });
			sess = step.session;
			assert.equal(sess.lastGood.factory_id, "fac_1");
			assert.match(sess.stale.reason, /did not match/i);

			// Recovery clears Stale
			step = safe.reduceLiveFetchOutcome(sess, { kind: "success", data: run1Updated, receivedAt: "t3" });
			sess = step.session;
			assert.equal(sess.stale, null);
			assert.equal(sess.lastGood.checked_at, "2026-11-24T12:00:02Z");

			// Fresh uncertain snapshot replaces lastGood without Stale
			step = safe.reduceLiveFetchOutcome(sess, { kind: "success", data: uncertainSnap, receivedAt: "t4" });
			sess = step.session;
			assert.equal(sess.stale, null);
			assert.equal(sess.lastGood.state, "uncertain");

			// 404 unknown factory is an error state, not Stale
			step = safe.reduceLiveFetchOutcome(sess, { kind: "error", status: 404, message: "Factory not found", detail: "Unknown factory", receivedAt: "t5" });
			assert.equal(step.session.lastGood, null);
			assert.equal(step.session.stale, null);
			assert.equal(step.session.error.status, 404);

			// Poll scheduler
			assert.equal(safe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: false, inFlight: false, hasPendingTimer: false }, { type: "timer-fired" }).action, "fetch-now");
			const inFlightTick = safe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: false, inFlight: true, hasPendingTimer: false }, { type: "timer-fired" });
			assert.equal(inFlightTick.action, "schedule-timer");
			assert.equal(inFlightTick.skippedInFlight, true);
			assert.equal(safe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: true, inFlight: false, hasPendingTimer: true }, { type: "visibility-change", hidden: true }).action, "cancel-timer");
			assert.equal(safe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: true, inFlight: false, hasPendingTimer: false }, { type: "sync" }).action, "cancel-timer");
			assert.equal(safe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: true, inFlight: false, hasPendingTimer: false }, { type: "fetch-finished" }).action, "cancel-timer");
			assert.equal(safe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: true, inFlight: false, hasPendingTimer: false }, { type: "timer-fired" }).action, "cancel-timer");
			assert.equal(safe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: true, inFlight: false, hasPendingTimer: false }, { type: "visibility-change", hidden: false }).action, "fetch-now");
			assert.equal(safe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: true, inFlight: true, hasPendingTimer: false }, { type: "visibility-change", hidden: false }).action, "noop");
			assert.equal(safe.computeNextPollAction({ activeView: "inspect", selectedFactoryId: "fac_1", hidden: false, inFlight: false, hasPendingTimer: false }, { type: "sync" }).action, "cancel-timer");

			// Keyed diff planner
			const sameOrderDiff = safe.planKeyedDiff(["a", "b"], [{ id: "a" }, { id: "b" }, { id: "c" }], (n) => n.id);
			assert.equal(sameOrderDiff.orderChanged, false);
			assert.deepEqual(sameOrderDiff.removedKeys, []);
			assert.equal(sameOrderDiff.kept.length, 2);
			assert.equal(sameOrderDiff.added.length, 1);
			const reorderedDiff = safe.planKeyedDiff(["a", "b"], [{ id: "b" }, { id: "a" }], (n) => n.id);
			assert.equal(reorderedDiff.orderChanged, true);

			// 10. Ticket 04 pure output refetch decision helper
			const baseRunningNode = {
				id: "build",
				status: "running",
				current_attempt: { attempt_id: "build.1", attempt_number: 1, max_attempts: 3, status: "running", updated_at: "2026-11-28T12:00:00Z" },
			};
			const baseFinishedNode = {
				id: "build",
				status: "succeeded",
				current_attempt: {
					attempt_id: "build.1",
					attempt_number: 1,
					max_attempts: 3,
					status: "succeeded",
					result_status: "success",
					completed_at: "2026-11-28T12:00:02Z",
					updated_at: "2026-11-28T12:00:02Z",
				},
			};
			const refetchCases: Array<{
				name: string;
				prev: unknown;
				next: unknown;
				opts?: { prevFactoryId?: string; nextFactoryId?: string };
				want: boolean;
			}> = [
				{
					name: "no change while running (only updated_at bumped)",
					prev: baseRunningNode,
					next: {
						...baseRunningNode,
						current_attempt: { ...baseRunningNode.current_attempt, updated_at: "2026-11-28T12:00:02Z" },
					},
					opts: { prevFactoryId: "fac_1", nextFactoryId: "fac_1" },
					want: false,
				},
				{
					name: "pending to running (unfinished)",
					prev: { id: "build", status: "pending", current_attempt: { attempt_id: "build.1", attempt_number: 1, status: "pending" } },
					next: baseRunningNode,
					want: false,
				},
				{
					name: "running to finished (succeeded)",
					prev: baseRunningNode,
					next: baseFinishedNode,
					opts: { prevFactoryId: "fac_1", nextFactoryId: "fac_1" },
					want: true,
				},
				{
					name: "running to finished (failed)",
					prev: baseRunningNode,
					next: { id: "build", status: "failed", current_attempt: { attempt_id: "build.1", attempt_number: 1, status: "failed", completed_at: "2026-11-28T12:00:03Z" } },
					want: true,
				},
				{
					name: "running to finished (needs_attention)",
					prev: baseRunningNode,
					next: { id: "build", status: "needs_attention", current_attempt: { attempt_id: "build.1", attempt_number: 1, status: "needs_attention" } },
					want: true,
				},
				{
					name: "running to parked (finished attempt waiting in review loop)",
					prev: baseRunningNode,
					next: {
						id: "build",
						status: "waiting",
						parked: true,
						current_attempt: { attempt_id: "build.1", attempt_number: 1, status: "waiting", result_status: "success", completed_at: "2026-11-28T12:00:02Z" },
					},
					want: true,
				},
				{
					name: "same finished across polls",
					prev: baseFinishedNode,
					next: { ...baseFinishedNode },
					opts: { prevFactoryId: "fac_1", nextFactoryId: "fac_1" },
					want: false,
				},
				{
					name: "same parked across polls",
					prev: { id: "build", status: "waiting", parked: true, current_attempt: { attempt_id: "build.1", attempt_number: 1, status: "waiting", result_status: "success", completed_at: "2026-11-28T12:00:02Z" } },
					next: { id: "build", status: "waiting", parked: true, current_attempt: { attempt_id: "build.1", attempt_number: 1, status: "waiting", result_status: "success", completed_at: "2026-11-28T12:00:02Z" } },
					want: false,
				},
				{
					name: "new attempt number (finished 1 -> running 2)",
					prev: baseFinishedNode,
					next: {
						id: "build",
						status: "running",
						current_attempt: { attempt_id: "build.2", attempt_number: 2, max_attempts: 3, status: "running" },
					},
					want: true,
				},
				{
					name: "new attempt number without attempt_id change",
					prev: { id: "build", status: "running", current_attempt: { attempt_number: 1, status: "running" } },
					next: { id: "build", status: "running", current_attempt: { attempt_number: 2, status: "running" } },
					want: true,
				},
				{
					name: "new attempt id with same attempt number",
					prev: { id: "build", status: "running", current_attempt: { attempt_id: "build.1a", attempt_number: 1, status: "running" } },
					next: { id: "build", status: "running", current_attempt: { attempt_id: "build.1b", attempt_number: 1, status: "running" } },
					want: true,
				},
				{
					name: "attempt id became unverified absence",
					prev: baseRunningNode,
					next: {
						id: "build",
						status: "needs_attention",
						current_attempt: { attempt_id: { absence: "evidence unavailable" }, attempt_number: 1, status: "needs_attention" },
					},
					want: true,
				},
				{
					name: "node switched",
					prev: baseFinishedNode,
					next: { id: "review", status: "succeeded", current_attempt: { attempt_id: "build.1", attempt_number: 1, status: "succeeded", completed_at: "2026-11-28T12:00:02Z" } },
					opts: { prevFactoryId: "fac_1", nextFactoryId: "fac_1" },
					want: true,
				},
				{
					name: "factory switched",
					prev: baseFinishedNode,
					next: baseFinishedNode,
					opts: { prevFactoryId: "fac_1", nextFactoryId: "fac_2" },
					want: true,
				},
				{
					name: "missing prev node (initial selection)",
					prev: null,
					next: { id: "build" },
					want: true,
				},
				{
					name: "missing fields unchanged",
					prev: {},
					next: {},
					want: false,
				},
				{
					name: "missing current_attempt running to finished",
					prev: { id: "build", status: "running" },
					next: { id: "build", status: "succeeded" },
					want: true,
				},
				{
					name: "selected node vanished (null next)",
					prev: baseFinishedNode,
					next: null,
					opts: { prevFactoryId: "fac_1", nextFactoryId: "fac_1" },
					want: false,
				},
				{
					name: "selected node vanished (undefined next)",
					prev: baseRunningNode,
					next: undefined,
					want: false,
				},
			];
			for (const tc of refetchCases) {
				assert.equal(safe.shouldRefetchNodeOutput(tc.prev, tc.next, tc.opts), tc.want, `shouldRefetchNodeOutput failed for: ${tc.name}`);
			}

			// 11. resolveFinishedOutputAnnouncement
			assert.equal(
				safe.resolveFinishedOutputAnnouncement("node_a", { attempts: [{ attempt_number: 1, status: "running" }] }, { id: "node_a", status: "running" }),
				"",
			);
			assert.equal(
				safe.resolveFinishedOutputAnnouncement("node_a", { attempts: [{ attempt_number: 1, status: "succeeded", status_text: "Succeeded" }] }, { id: "node_a", status: "succeeded" }),
				"Attempt 1 of node node_a finished: Succeeded",
			);
			assert.equal(
				safe.resolveFinishedOutputAnnouncement("node_a", { attempts: [{ attempt_number: 2, status: "failed" }] }, { id: "node_a", status: "failed" }),
				"Attempt 2 of node node_a finished: Failed",
			);
			assert.equal(
				safe.resolveFinishedOutputAnnouncement("node_a", { attempts: [] }, { id: "node_a", status: "needs_attention", current_attempt: { attempt_number: 3, status: "needs_attention" } }),
				"Attempt 3 of node node_a finished: Uncertain",
			);
		},
	);
});

test("sink scanner flags Function(), string timer eval, createContextualFragment, DOMParser/parseFromString, raw href/src, and bracket-concatenated sinks", () => {
	for (const [name, snippet] of [
		["X3 Function() without new", `const fn = Function("return 1");`],
		["X4 setTimeout string", `setTimeout("alert(1)", 10);`],
		["X4b setInterval string", `setInterval("alert(1)", 10);`],
		["X4c setTimeout variable", `setTimeout(cb, 10);`],
		["X4d setInterval variable", `setInterval(cb, 10);`],
		["X5 createContextualFragment", `document.createRange().createContextualFragment(x);`],
		["X6 DOMParser", `new DOMParser();`],
		["X6b parseFromString", `parser.parseFromString(x, "text/html");`],
		["X7 raw setAttribute href", `el.setAttribute("href", raw);`],
		["X7b raw setAttribute src", `el.setAttribute("src", raw);`],
		["X7c direct .href assignment", `el.href = raw;`],
		["X7d setAttributeNS", `el.setAttributeNS("http://www.w3.org/1999/xhtml", "href", raw);`],
		["X7e Object.assign href", `Object.assign(el, { href: raw });`],
		["X7f location.assign non-literal", `location.assign(nextUrl);`],
		["X7g window.location.assign non-literal", `window.location.assign(nextUrl);`],
		["X7h window.open non-literal", `window.open(nextUrl);`],
		["X7i location = non-literal", `location = nextUrl;`],
		["X7j window.location = non-literal", `window.location = nextUrl;`],
		["X8 bracket-concatenated eval", `window["ev" + "al"]("1");`],
		["X8b bracket-concatenated innerHTML", `el["in" + "nerHTML"] = x;`],
		["X8c bracket-concatenated Function", `globalThis["Func" + "tion"]("1");`],
		["X8d bracket eval lookup", `globalThis["eval"]("1");`],
		["X9 document.writeln", `document.writeln(x);`],
	] as const) {
		assert.throws(() => assertNoForbiddenSinks(`fixture:${name}`, snippet), { name: "AssertionError" }, `Expected sink scanner to reject ${name}`);
	}
});

test("served app.js wiring renders loading/timeout/error states, live absences, factory mismatch, collision-free node ids, safe hrefs, and zero reassuring fallbacks", async t => {
	const { root, statePath, coordinationPath } = emptyViewerDb(t);
	await verifyReadOnlyViewer(
		{ stateDirs: root, viewerOptions: { statePath, coordinationPath, host: "127.0.0.1", port: 0 } },
		async viewer => {
			const [safeCode, appCode] = await Promise.all([
				fetch(`${viewer.url}/safe.js`).then(r => r.text()),
				fetch(`${viewer.url}/app.js`).then(r => r.text()),
			]);

			class FakeNode {
				parentNode: FakeNode | null = null;
				#ownerDoc: { activeElement: FakeNode; body: FakeNode } | null = null;
				constructor(ownerDoc: { activeElement: FakeNode; body: FakeNode } | null = null) {
					this.#ownerDoc = ownerDoc;
				}
				protected getOwnerDoc() { return this.#ownerDoc; }
				contains(other: FakeNode | null): boolean {
					return other === this;
				}
				remove() {
					if (this.parentNode && "children" in this.parentNode) {
						const parent = this.parentNode as FakeElement;
						parent.children = parent.children.filter(c => c !== this);
						this.parentNode = null;
						const doc = this.#ownerDoc;
						if (doc && this.contains(doc.activeElement)) {
							doc.activeElement = doc.body;
						}
					}
				}
			}
			class FakeTextNode extends FakeNode {
				nodeType = 3;
				#text: string;
				constructor(text: string, ownerDoc: { activeElement: FakeNode; body: FakeNode } | null = null) {
					super(ownerDoc);
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
				value = "";
				disabled = false;
				selected = false;
				open = false;
				inert = false;
				clientWidth = 800;
				lastFocusOptions: unknown = undefined;
				focusCalls: Array<{ options?: unknown }> = [];
				classList: {
					add: (...cls: string[]) => void;
					remove: (...cls: string[]) => void;
					toggle: (cls: string, force?: boolean) => boolean;
					contains: (cls: string) => boolean;
				};
				dataset: Record<string, string>;
				constructor(tagName: string, namespaceURI: string | null = null, ownerDoc: { activeElement: FakeNode; body: FakeNode } | null = null) {
					super(ownerDoc);
					this.tagName = tagName.toLowerCase();
					this.namespaceURI = namespaceURI;
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
							setClasses(getClasses().filter(c => !drop.has(c)));
						},
						toggle: (cls, force) => {
							const set = new Set(getClasses());
							const next = force === undefined ? !set.has(cls) : Boolean(force);
							if (next) set.add(cls);
							else set.delete(cls);
							setClasses([...set]);
							return next;
						},
						contains: cls => getClasses().includes(cls),
					};
					this.dataset = new Proxy({}, {
						get(_t, prop) {
							if (typeof prop !== "string") return undefined;
							return attrs.get(`data-${prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`);
						},
						set(_t, prop, val) {
							if (typeof prop !== "string") return false;
							attrs.set(`data-${prop.replace(/[A-Z]/g, m => `-${m.toLowerCase()}`)}`, String(val));
							return true;
						},
					});
				}
				get id() { return this.attributes.get("id") ?? ""; }
				set id(v: string) { this.attributes.set("id", String(v)); }
				get firstChild() { return this.children[0] ?? null; }
				get lastChild() { return this.children[this.children.length - 1] ?? null; }
				get textContent(): string {
					return this.children.map(c => (c as FakeTextNode | FakeElement).textContent).join("");
				}
				set textContent(v: string) {
					const oldChildren = this.children;
					for (const ch of oldChildren) ch.parentNode = null;
					this.children = v === "" ? [] : [new FakeTextNode(String(v), this.getOwnerDoc())];
					for (const ch of this.children) ch.parentNode = this;
					const doc = this.getOwnerDoc();
					if (doc && oldChildren.some(ch => ch.contains(doc.activeElement))) {
						doc.activeElement = doc.body;
					}
				}
				setAttribute(k: string, v: string) {
					this.attributes.set(k, String(v));
					if (k === "value") this.value = String(v);
					if (k === "open") this.open = true;
				}
				getAttribute(k: string) { return this.attributes.has(k) ? this.attributes.get(k)! : null; }
				removeAttribute(k: string) {
					this.attributes.delete(k);
					if (k === "open") this.open = false;
				}
				hasAttribute(k: string) { return this.attributes.has(k); }
				append(...nodes: Array<FakeNode | string>) {
					const doc = this.getOwnerDoc();
					for (const n of nodes) {
						const child = typeof n === "string" ? new FakeTextNode(n, doc) : n;
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
					const oldChildren = this.children;
					for (const ch of oldChildren) ch.parentNode = null;
					this.children = [];
					const doc = this.getOwnerDoc();
					if (doc && oldChildren.some(ch => ch.contains(doc.activeElement))) {
						doc.activeElement = doc.body;
					}
					this.append(...nodes);
				}
				addEventListener(type: string, fn: (e: any) => void) {
					const list = this.listeners.get(type) ?? [];
					list.push(fn);
					this.listeners.set(type, list);
				}
				removeEventListener(type: string, fn: (e: any) => void) {
					const list = this.listeners.get(type);
					if (list) this.listeners.set(type, list.filter(f => f !== fn));
				}
				contains(other: FakeNode | null): boolean {
					let cur = other;
					while (cur) {
						if (cur === this) return true;
						cur = cur.parentNode;
					}
					return false;
				}
				focus(options?: { preventScroll?: boolean }) {
					this.lastFocusOptions = options;
					this.focusCalls.push({ options });
					const doc = this.getOwnerDoc();
					if (doc) doc.activeElement = this;
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

			function collectTextNodes(rootEl: FakeElement): string[] {
				const out: string[] = [];
				const walk = (n: FakeNode) => {
					if (n instanceof FakeTextNode) out.push(n.textContent);
					else if (n instanceof FakeElement) {
						for (const ch of n.children) walk(ch);
					}
				};
				walk(rootEl);
				return out;
			}

			type FetchHandler = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

			function bootApp(initialSearch: string, fetchHandler: FetchHandler) {
				const docListeners = new Map<string, Array<(e: any) => void>>();
				const fakeDocument: any = {
					body: null as any,
					documentElement: null as any,
					activeElement: null as any,
					hidden: false,
					createElement: (tag: string) => new FakeElement(tag, null, fakeDocument),
					createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns, fakeDocument),
					createTextNode: (txt: string) => new FakeTextNode(txt, fakeDocument),
					getElementById: (id: string) => collectAllElements(fakeDocument.body).find(e => e.id === id) ?? null,
					querySelector: (sel: string) => fakeDocument.body.querySelector(sel),
					querySelectorAll: (sel: string) => fakeDocument.body.querySelectorAll(sel),
					addEventListener: (type: string, fn: (e: any) => void) => {
						const list = docListeners.get(type) ?? [];
						list.push(fn);
						docListeners.set(type, list);
					},
				};
				const body = new FakeElement("body", null, fakeDocument);
				const documentElement = new FakeElement("html", null, fakeDocument);
				fakeDocument.body = body;
				fakeDocument.documentElement = documentElement;
				fakeDocument.activeElement = body;
				const skipLink = new FakeElement("a", null, fakeDocument);
				skipLink.setAttribute("class", "skip-link");
				skipLink.setAttribute("href", "#main-content");
				const header = new FakeElement("header", null, fakeDocument);
				const viewsNav = new FakeElement("nav", null, fakeDocument);
				viewsNav.setAttribute("class", "nav-extended blue-grey darken-3");
				viewsNav.setAttribute("aria-label", "Views");
				const menuToggle = new FakeElement("button", null, fakeDocument);
				menuToggle.id = "menu-toggle";
				const headerScope = new FakeElement("span", null, fakeDocument);
				headerScope.id = "header-scope";
				const tabsList = new FakeElement("ul", null, fakeDocument);
				tabsList.setAttribute("class", "tabs tabs-transparent");
				for (const v of ["factories", "live", "inspect", "queue", "receipts", "requests", "proposals"]) {
					const li = new FakeElement("li", null, fakeDocument);
					li.setAttribute("class", "tab");
					const tab = new FakeElement("a", null, fakeDocument);
					tab.setAttribute("data-view", v);
					li.append(tab);
					tabsList.append(li);
				}
				const tabIndicator = new FakeElement("li", null, fakeDocument);
				tabIndicator.setAttribute("class", "indicator");
				tabsList.append(tabIndicator);
				viewsNav.append(menuToggle, headerScope, tabsList);
				header.append(viewsNav);

				const drawerBackdrop = new FakeElement("div", null, fakeDocument);
				drawerBackdrop.id = "drawer-backdrop";
				drawerBackdrop.setAttribute("class", "sidenav-overlay");
				const sidebar = new FakeElement("aside", null, fakeDocument);
				sidebar.id = "sidebar";
				sidebar.setAttribute("class", "sidenav sidenav-fixed");
				const drawerClose = new FakeElement("button", null, fakeDocument);
				drawerClose.id = "drawer-close";
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

				let activeSignalListeners = 0;
				class TrackedAbortController extends AbortController {
					constructor() {
						super();
						const sig = this.signal;
						const origAdd = sig.addEventListener.bind(sig);
						const origRem = sig.removeEventListener.bind(sig);
						const tracked = new Set<EventListenerOrEventListenerObject>();
						sig.addEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | AddEventListenerOptions) => {
							if (listener && !tracked.has(listener)) {
								tracked.add(listener);
								activeSignalListeners++;
							}
							return origAdd(type, listener, {
								...(typeof opts === "object" && opts ? opts : {}),
								once: false,
							});
						};
						sig.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, opts?: boolean | EventListenerOptions) => {
							if (listener && tracked.delete(listener)) {
								activeSignalListeners--;
							}
							return origRem(type, listener, opts);
						};
					}
				}

				let nowMs = 0;
				let nextTimerId = 1;
				const timers = new Map<number, { fireAt: number; fn: () => void }>();
				const fakeSetTimeout = (fn: () => void, ms = 0) => {
					const id = nextTimerId++;
					timers.set(id, { fireAt: nowMs + Number(ms), fn });
					return id;
				};
				const fakeClearTimeout = (id: number) => {
					timers.delete(id);
				};
				const advanceTimers = async (ms: number) => {
					const targetMs = nowMs + ms;
					while (true) {
						let earliest: { id: number; fireAt: number; fn: () => void } | null = null;
						for (const [id, entry] of timers.entries()) {
							if (entry.fireAt <= targetMs && (!earliest || entry.fireAt < earliest.fireAt)) {
								earliest = { id, ...entry };
							}
						}
						if (!earliest) break;
						nowMs = earliest.fireAt;
						timers.delete(earliest.id);
						earliest.fn();
						for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
					}
					nowMs = targetMs;
					for (let i = 0; i < 4; i++) await new Promise(r => setTimeout(r, 0));
				};

				const setVisibility = async (hidden: boolean) => {
					fakeDocument.hidden = hidden;
					for (const fn of docListeners.get("visibilitychange") ?? []) fn({});
					for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
				};

				const locationObj = { origin: viewer.url, pathname: "/", search: initialSearch };
				const winListeners = new Map<string, Array<(e: any) => void>>();
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
					AbortController: TrackedAbortController,
					Node: FakeNode,
					Element: FakeElement,
					document: fakeDocument,
					location: locationObj,
					history: {
						pushState(_s: unknown, _t: string, nextUrl: string) {
							const parsed = new URL(nextUrl, viewer.url);
							locationObj.pathname = parsed.pathname;
							locationObj.search = parsed.search;
						},
					},
					fetch: (url: string, init?: { signal?: AbortSignal }) => fetchHandler(url, init),
					setTimeout: fakeSetTimeout,
					clearTimeout: fakeClearTimeout,
					matchMedia: () => ({ matches: false, addEventListener() {} }),
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

				const assertSafeDom = () => {
					const safe = context.FactoryViewerSafe;
					for (const el of collectAllElements(body)) {
						if (el === skipLink) continue;
						if (el.tagName === "a" && el.hasAttribute("href")) {
							const href = el.getAttribute("href")!;
							assert.equal(safe.safeHref(href, viewer.url), href, `Every rendered <a> href must pass safeHref: ${href}`);
						}
						for (const [k, v] of el.attributes.entries()) {
							assert.equal(k.toLowerCase().startsWith("on"), false, `Unexpected event attribute ${k}`);
							if (k !== "href") {
								assert.equal(v.includes("<script>"), false, `Hostile script tag leaked into attribute ${k}=${v}`);
							}
						}
					}
				};

				return {
					context,
					body,
					sidebar,
					factoriesList,
					content,
					viewsNav,
					fakeDocument,
					advanceTimers,
					setVisibility,
					activeTimers: () => timers.size,
					activeSignalListeners: () => activeSignalListeners,
					assertSafeDom,
				};
			}

			const jsonResp = (status: number, bodyObj: unknown) => ({
				ok: status >= 200 && status < 300,
				status,
				text: async () => JSON.stringify(bodyObj),
			});

			const flushMicrotasks = async () => {
				for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0));
			};

			// A. Loading state before /api/factories resolves (on "/" and "/?factory=fac_1&view=live")
			{
				let resolveFactories!: (r: any) => void;
				const app = bootApp("", () => new Promise(res => { resolveFactories = res; }));
				assert.equal(app.factoriesList.getAttribute("aria-busy"), "true");
				assert.match(app.factoriesList.textContent, /Loading factories\.\.\./);
				assert.equal(app.factoriesList.textContent.includes("No records"), false);
				assert.equal(app.factoriesList.textContent.includes("No published factories"), false);
				assert.equal(app.content.getAttribute("aria-busy"), "true");
				assert.match(app.content.textContent, /Loading factories\.\.\./);
				assert.equal(app.content.textContent.includes("No published factories"), false);

				resolveFactories(jsonResp(200, []));
				await flushMicrotasks();
				assert.equal(app.factoriesList.getAttribute("aria-busy"), "false");
				assert.equal(app.content.getAttribute("aria-busy"), "false");
				assert.match(app.factoriesList.textContent, /No records/);
				assert.match(app.content.textContent, /No published factories/);
				app.assertSafeDom();

				// /api/factories with typed absence object uses the API's typed absence
				const appAbs = bootApp("", async () => jsonResp(200, {
					absence: "evidence unavailable",
					explanation: "Store index is locked",
					factories: [],
				}));
				await flushMicrotasks();
				assert.match(appAbs.factoriesList.textContent, /Evidence unavailable/);
				assert.match(appAbs.factoriesList.textContent, /Store index is locked/);
				assert.match(appAbs.content.textContent, /Evidence unavailable/);
				assert.match(appAbs.content.textContent, /Store index is locked/);
				assert.equal(appAbs.content.textContent.includes("No records"), false);
			}

			// B. Delayed /api/factories on ?factory=fac_1&view=live must show Loading factories... in sidebar while live resolves
			{
				let resolveFactories!: (r: any) => void;
				const app = bootApp("?factory=fac_1&view=live", async (url) => {
					if (url === "/api/factories") return new Promise(res => { resolveFactories = res; });
					if (url === "/api/factories/fac_1/live") {
						return jsonResp(200, {
							factory_id: "fac_1",
							current_version: "v2",
							checked_at: "2026-11-24T12:00:00Z",
							state: "running",
							reason: "Running v1",
							run: { run_id: "run-100", attempt_id: "att-100", bound_version: "v1" },
							outcome: "incomplete",
							settlement: "unsettled",
							capacity_release: "held",
							graph: { evidence: "available", bound_version: "v1", topology: "graph", nodes: [{ id: "n1", status: "running", kind: "agent" }], edges: [] },
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();
				assert.equal(app.factoriesList.getAttribute("aria-busy"), "true");
				assert.match(app.factoriesList.textContent, /Loading factories\.\.\./);
				assert.equal(app.factoriesList.textContent.includes("No published factories"), false);
				assert.match(app.content.textContent, /run-100/);
				assert.match(app.content.textContent, /v1 \(differs from current v2\)/);

				resolveFactories(jsonResp(200, [{ factory_id: "fac_1", name: "Alpha", current_version: "v2", management: "managed" }]));
				await flushMicrotasks();
				assert.equal(app.factoriesList.getAttribute("aria-busy"), "false");
				assert.match(app.factoriesList.textContent, /Alpha/);
				app.assertSafeDom();
			}

			// C. Failed /api/factories (HTTP 503) renders visible error with status, never "No published factories"
			{
				const app = bootApp("", async () => jsonResp(503, { error: "Evidence unavailable" }));
				await flushMicrotasks();
				assert.equal(app.factoriesList.getAttribute("aria-busy"), "false");
				assert.equal(app.content.getAttribute("aria-busy"), "false");
				assert.match(app.factoriesList.textContent, /! HTTP 503/);
				assert.match(app.factoriesList.textContent, /Evidence unavailable/);
				assert.match(app.content.textContent, /! HTTP 503/);
				assert.match(app.content.textContent, /Evidence unavailable/);
				assert.equal(app.content.textContent.includes("No published factories"), false);
			}

			// D. Request timeout (15s via AbortController) turns into visible "Request timed out" error on factories, live, and receipts
			{
				const hangingFetch: FetchHandler = (_url, init) => new Promise((_res, rej) => {
					init?.signal?.addEventListener("abort", () => {
						const err = new Error("The operation was aborted");
						err.name = "AbortError";
						rej(err);
					});
				});
				const appHome = bootApp("", hangingFetch);
				await appHome.advanceTimers(15_000);
				assert.equal(appHome.factoriesList.getAttribute("aria-busy"), "false");
				assert.equal(appHome.content.getAttribute("aria-busy"), "false");
				assert.match(appHome.factoriesList.textContent, /Request timed out/i);
				assert.match(appHome.content.textContent, /Request timed out/i);
				assert.equal(appHome.content.textContent.includes("No published factories"), false);

				const appLive = bootApp("?factory=fac_1&view=live", async (url, init) => {
					if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_1", name: "F1", current_version: "v1", management: "managed" }]);
					return hangingFetch(url, init);
				});
				await flushMicrotasks();
				assert.equal(appLive.content.getAttribute("aria-busy"), "true");
				assert.match(appLive.content.textContent, /Loading Live Graph/);
				await appLive.advanceTimers(15_000);
				assert.equal(appLive.content.getAttribute("aria-busy"), "false");
				assert.match(appLive.content.textContent, /Request timed out/i);

				const appReceipts = bootApp("?factory=fac_1&view=receipts&reference=ref1", async (url, init) => {
					if (url === "/api/factories") return jsonResp(200, []);
					return hangingFetch(url, init);
				});
				await flushMicrotasks();
				await appReceipts.advanceTimers(15_000);
				assert.match(appReceipts.content.textContent, /Request timed out/i);
			}

			// E. Live view absence labels (A1-A6), factory mismatch, omitted/empty graph, reassuring fallbacks, node id collisions, hostile XSS
			{
				const fixtures: Record<string, unknown> = {
					"/api/factories": [{ factory_id: "fac_1", name: "<script>alert(1)</script>", current_version: "v2", management: "managed" }],
					"/api/factories/fac_1/live": {
						factory_id: "fac_1",
						current_version: "v2",
						checked_at: "2026-11-24T12:00:00Z",
						state: "uncertain",
						reason: "Release missing",
						run: null,
					},
					"/api/factories/fac_1/queue?filter=open": {
						factory_id: "fac_1",
						filter: "open",
						entries: [],
					},
					"/api/factories/fac_1/requests": {
						factory_id: "fac_1",
						records: [{
							request_id: "req-1",
							kind: "direction",
							state: "pending",
							question: "<script>alert('xss')</script>",
							node_id: "merge",
							node_attempt_id: "merge.1",
							response_recorded: false,
							response_consumed: false,
							reconciliation: "pending",
							choices: [],
						}],
					},
					"/api/factories/fac_1/proposals": {
						factory_id: "fac_1",
						is_active_constraints_file: false,
						records: [],
					},
					"/api/factories/fac_1/receipts?reference=bad": {
						factory_id: "fac_1",
					},
					"/api/factories/fac_1/inspect": {
						factory_id: "fac_1",
						current_version: "v2",
						inspected_version: "v2",
						evidence: "available",
						attention_summary: { name: "F1", management: { state: "managed" }, stop_state: { state: "active" } },
						definition: {
							version: "v2",
							topology: "graph",
							nodes: [
								{ id: "a.b", anchor: "a.b", kind: "agent", persona: { name: "p1" }, model: { id: "m1" }, dependencies: { items: [{ href: "/.//evil.com", node_id: "evil" }] } },
								{ id: "a_b", anchor: "a_b", kind: "command", command: { executable: "echo" } },
								{ id: "content", anchor: "content", kind: "command", command: { executable: "echo" } },
							],
						},
					},
				};
				const app = bootApp("?factory=fac_1&view=live", async url => jsonResp(200, fixtures[url] ?? {}));
				await flushMicrotasks();
				// Uncertain live body with omitted graph and run:null -> Evidence unavailable, NOT No records or Not applicable
				assert.match(app.content.textContent, /Evidence unavailable/);
				assert.equal(app.content.textContent.includes("No records"), false);
				assert.equal(app.content.textContent.includes("Not applicable"), false);
				app.assertSafeDom();

				// Switch to queue (empty without absence/explanation) -> Unknown (not provided), NEVER "No queue entries."
				const clickTab = async (viewName: string) => {
					const tab = app.viewsNav.querySelectorAll("[data-view]").find(t => t.getAttribute("data-view") === viewName)!;
					for (const fn of tab.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
					await flushMicrotasks();
				};

				await clickTab("queue");
				assert.match(app.content.textContent, /Unknown \(not provided\)/);
				assert.equal(app.content.textContent.includes("No queue entries."), false);

				// Switch to proposals (empty without absence/explanation) -> Unknown (not provided), NEVER "No proposals recorded."
				await clickTab("proposals");
				assert.match(app.content.textContent, /Unknown \(not provided\)/);
				assert.equal(app.content.textContent.includes("No proposals recorded."), false);

				// Switch to requests (contains hostile <script> string) -> lands only in text nodes
				await clickTab("requests");
				assert.ok(collectTextNodes(app.content).some(t => t.includes("<script>alert('xss')</script>")));
				app.assertSafeDom();

				// Switch to inspect -> a.b and a_b have distinct DOM IDs, and node "content" never collides with PAGE_OWNED_IDS; unsafe /.//evil.com link is rejected
				await clickTab("inspect");
				const articles = collectAllElements(app.content).filter(e => e.tagName === "article");
				assert.equal(articles.length, 3);
				assert.notEqual(articles[0].id, articles[1].id);
				for (const art of articles) {
					assert.match(art.id, /^n-[A-Za-z0-9_-]+$/);
					assert.equal(app.context.FactoryViewerSafe.PAGE_OWNED_IDS.has(art.id), false);
				}
				assert.match(app.content.textContent, /\(link unavailable\)/);
				app.assertSafeDom();

				// Receipt body without type:"receipt" renders Receipt unavailable + Unknown (not provided)
				const appBadReceipt = bootApp("?factory=fac_1&view=receipts&reference=bad", async url => jsonResp(200, fixtures[url] ?? {}));
				await flushMicrotasks();
				assert.match(appBadReceipt.content.textContent, /Receipt unavailable/);
				assert.match(appBadReceipt.content.textContent, /Unknown \(not provided\)/);

				// Factory mismatch alert
				const appMismatch = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					return jsonResp(200, { factory_id: "fac_other", state: "running" });
				});
				await flushMicrotasks();
				assert.match(appMismatch.content.textContent, /Response did not match the selected factory/);
				const alertEl = collectAllElements(appMismatch.content).find(e => e.getAttribute("role") === "alert");
				assert.ok(alertEl, "Mismatch must render role=alert error banner");

				// Running body with graph evidence:"available" & nodes:[] -> Unknown (not provided), NOT No records
				const appEmptyGraph = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					return jsonResp(200, {
						factory_id: "fac_1",
						state: "running",
						current_version: "v1",
						run: { run_id: "r1", attempt_id: "a1", bound_version: "v1" },
						graph: { evidence: "available", nodes: [] },
					});
				});
				await flushMicrotasks();
				assert.match(appEmptyGraph.content.textContent, /Unknown \(not provided\)/);
				assert.equal(appEmptyGraph.content.textContent.includes("No records"), false);

				// Running body with omitted graph -> Run graph banner with Unknown (not provided)
				const appOmittedGraph = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					return jsonResp(200, {
						factory_id: "fac_1",
						state: "running",
						current_version: "v1",
						run: { run_id: "r1", attempt_id: "a1", bound_version: "v1" },
					});
				});
				await flushMicrotasks();
				assert.match(appOmittedGraph.content.textContent, /Run graph/);
				assert.match(appOmittedGraph.content.textContent, /Unknown \(not provided\)/);

				// Unmanaged live body -> Not applicable
				const appUnmanaged = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					return jsonResp(200, {
						factory_id: "fac_1",
						state: "idle",
						run: null,
						graph: { evidence: "not applicable", absence: "not applicable", explanation: "Unmanaged" },
					});
				});
				await flushMicrotasks();
				assert.match(appUnmanaged.content.textContent, /Not applicable/);

				// Empty requests body without absence/explanation -> Unknown (not provided), NEVER "No requests recorded."
				const appEmptyReqs = bootApp("?factory=fac_1&view=requests", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					return jsonResp(200, { factory_id: "fac_1", records: [] });
				});
				await flushMicrotasks();
				assert.match(appEmptyReqs.content.textContent, /Unknown \(not provided\)/);
				assert.equal(appEmptyReqs.content.textContent.includes("No requests recorded."), false);
			}

			// F. Ticket 08 review low items: B17, S11, running with run:{}, B11/B12 stale-response & abort forwarding, B7/B8 timer/listener cleanup
			{
				// B17: 200 non-array non-absence body on /api/factories must error, never "No records"
				for (const badBody of [{ unexpected: true }, "not-an-array", 42]) {
					const appB17 = bootApp("", async () => jsonResp(200, badBody));
					await flushMicrotasks();
					assert.match(appB17.factoriesList.textContent, /Invalid factories list/);
					assert.match(appB17.content.textContent, /Invalid factories list/);
					assert.equal(appB17.content.textContent.includes("No records"), false);
					assert.equal(appB17.content.textContent.includes("No published factories"), false);
				}

				// S11 + low item (b): running with run:{} must NOT say "Verified released run", and typed run absence object renders cleanly
				const appRunEmptyObj = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					return jsonResp(200, {
						factory_id: "fac_1",
						current_version: "v1",
						checked_at: "2026-11-24T12:00:00Z",
						state: "running",
						run: {},
						graph: { evidence: "not applicable", absence: "not applicable", explanation: "Missing run identity" },
					});
				});
				await flushMicrotasks();
				assert.equal(appRunEmptyObj.content.textContent.includes("Verified released run"), false);
				assert.match(appRunEmptyObj.content.textContent, /Factory live state: running/);

				const appRunTypedAbsence = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					return jsonResp(200, {
						factory_id: "fac_1",
						current_version: "v1",
						checked_at: "2026-11-24T12:00:00Z",
						state: "blocked",
						run: { absence: "not applicable", explanation: "Launch not released yet" },
						graph: { evidence: "not applicable", absence: "not applicable", explanation: "Blocked before release" },
					});
				});
				await flushMicrotasks();
				assert.match(appRunTypedAbsence.content.textContent, /Not applicable/);
				assert.match(appRunTypedAbsence.content.textContent, /Launch not released yet/);

				// B7/B8: non-polling view clears all fake timers and removes AbortSignal listeners after success
				const appCleanup = bootApp("?factory=fac_1&view=inspect", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					return jsonResp(200, {
						factory_id: "fac_1",
						current_version: "v1",
						inspected_version: "v1",
						evidence: "available",
						attention_summary: { name: "F1", management: { state: "managed" }, stop_state: { state: "active" } },
						definition: { version: "v1", topology: "graph", nodes: [] },
					});
				});
				await flushMicrotasks();
				assert.equal(appCleanup.activeTimers(), 0, "Fake timer map must be empty after non-live request succeeds");
				assert.equal(appCleanup.activeSignalListeners(), 0, "AbortSignal listeners must be removed after request succeeds");

				// B11/B12: cancellation forwarding + stale-response guard when switching views/factories mid-flight
				let resolveStale!: (r: any) => void;
				let staleSignal: AbortSignal | undefined;
				const appRace = bootApp("?factory=fac_1&view=inspect", (url, init) => {
					if (url === "/api/factories") return Promise.resolve(jsonResp(200, [{ factory_id: "fac_1", name: "F1", current_version: "v1", management: "managed" }]));
					if (url.includes("/inspect")) {
						staleSignal = init?.signal;
						return new Promise(res => { resolveStale = res; });
					}
					if (url.includes("/queue")) {
						return Promise.resolve(jsonResp(200, {
							factory_id: "fac_1",
							filter: "open",
							evidence: "available",
							explanation: "Queue loaded",
							absence: "no records",
							entries: [],
						}));
					}
					throw new Error(`Unexpected ${url}`);
				});
				await flushMicrotasks();
				assert.ok(staleSignal, "fetch must receive AbortSignal");
				assert.equal(staleSignal.aborted, false);
				// Switch to Queue before Inspect resolves -> must abort Inspect signal
				const queueTab = appRace.viewsNav.querySelectorAll("[data-view]").find(t => t.getAttribute("data-view") === "queue")!;
				for (const fn of queueTab.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();
				assert.equal(staleSignal.aborted, true, "Switching view must abort in-flight request signal (B12)");
				assert.match(appRace.content.textContent, /Queue loaded/);
				// Resolve the old Inspect promise anyway (ignoring abort) -> must be discarded by stale-response guard (B11)
				resolveStale(jsonResp(200, {
					factory_id: "fac_1",
					current_version: "v1",
					inspected_version: "v1",
					evidence: "available",
					attention_summary: { name: "STALE_INSPECT_LEAK", management: { state: "managed" }, stop_state: { state: "active" } },
					definition: { version: "v1", topology: "graph", nodes: [] },
				}));
				await flushMicrotasks();
				assert.equal(appRace.content.textContent.includes("STALE_INSPECT_LEAK"), false, "Stale late response must be discarded (B11)");
				assert.match(appRace.content.textContent, /Queue loaded/);
				assert.equal(appRace.activeTimers(), 0);
				assert.equal(appRace.activeSignalListeners(), 0);

				// B11/B12 on Live view: late fac_1 live response ignoring abort must be discarded after switching to fac_2
				let resolveLiveStale!: (r: any) => void;
				let liveStaleSignal: AbortSignal | undefined;
				const appLiveRace = bootApp("?factory=fac_1&view=live", (url, init) => {
					if (url === "/api/factories") {
						return Promise.resolve(jsonResp(200, [
							{ factory_id: "fac_1", name: "F1", current_version: "v1", management: "managed" },
							{ factory_id: "fac_2", name: "F2", current_version: "v1", management: "managed" },
						]));
					}
					if (url === "/api/factories/fac_1/live") {
						liveStaleSignal = init?.signal;
						return new Promise(res => { resolveLiveStale = res; });
					}
					if (url === "/api/factories/fac_2/live") {
						return Promise.resolve(jsonResp(200, {
							factory_id: "fac_2",
							current_version: "v1",
							checked_at: "2026-11-24T12:00:00Z",
							state: "idle",
							reason: "Fac2 idle",
							run: null,
							graph: { evidence: "not applicable", absence: "no records", explanation: "Idle" },
						}));
					}
					throw new Error(`Unexpected ${url}`);
				});
				await flushMicrotasks();
				assert.ok(liveStaleSignal);
				assert.equal(liveStaleSignal.aborted, false);
				const f2Link = collectAllElements(appLiveRace.sidebar).find(e => e.tagName === "a" && (e.getAttribute("href") ?? "").includes("fac_2"))!;
				for (const fn of f2Link.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();
				assert.equal(liveStaleSignal.aborted, true);
				assert.match(appLiveRace.content.textContent, /Fac2 idle/);
				resolveLiveStale(jsonResp(200, {
					factory_id: "fac_1",
					current_version: "v1",
					checked_at: "2026-11-24T12:00:01Z",
					state: "running",
					reason: "STALE_LIVE_LEAK",
					run: { run_id: "stale-run", attempt_id: "stale-att", bound_version: "v1" },
				}));
				await flushMicrotasks();
				assert.equal(appLiveRace.content.textContent.includes("STALE_LIVE_LEAK"), false, "Late live response for fac_1 must be discarded");
				assert.equal(appLiveRace.content.textContent.includes("Stale"), false, "Late live response for fac_1 must not mark fac_2 as Stale");
				assert.match(appLiveRace.content.textContent, /Fac2 idle/);
			}

			// G. Ticket 09: live polling (~2s incl. idle), no overlap, visibility pause/resume, in-place DOM preservation, next run, ended persistence, stale vs uncertain & 404 & switch
			{
				const makeRunSnap = (
					factoryId: string,
					runId: string,
					attemptId: string,
					stateName: string,
					checkedAt: string,
					nodeStatuses: Record<string, string>,
					extra: Record<string, unknown> = {},
				) => ({
					factory_id: factoryId,
					current_version: "v2",
					checked_at: checkedAt,
					state: stateName,
					reason: stateName === "ended" ? "All nodes have recorded terminal outcomes." : "Verified release.",
					run: { run_id: runId, attempt_id: attemptId, bound_version: "v1" },
					outcome: stateName === "ended" ? "passed" : "incomplete",
					settlement: extra.settlement ?? "unsettled",
					capacity_release: extra.capacity_release ?? "held",
					graph: extra.noGraph
						? { evidence: "not applicable", absence: "not applicable", explanation: "Historical settled run topology is not mounted as a live graph." }
						: {
							evidence: "available",
							bound_version: "v1",
							topology: "graph",
							nodes: [
								{
									id: "build",
									kind: "agent",
									status: nodeStatuses.build ?? "running",
									status_text: (nodeStatuses.build ?? "running") === "succeeded" ? "Succeeded" : "Running",
									current_attempt: {
										attempt_id: "build.1",
										attempt_number: 1,
										max_attempts: 2,
										instance_id: "inst-build",
										process_state: "alive",
										resource_state: "open",
										started_at: "2026-11-24T12:00:00Z",
										updated_at: checkedAt,
									},
									configuration_link: { href: `/?factory=${factoryId}&view=inspect&version=v1&node=build`, node_id: "build", version: "v1" },
								},
								{
									id: "review",
									kind: "agent",
									status: nodeStatuses.review ?? "waiting",
									status_text: (nodeStatuses.review ?? "waiting") === "running" ? "Running" : ((nodeStatuses.review ?? "waiting") === "succeeded" ? "Succeeded" : "Waiting"),
									current_attempt: {
										attempt_id: "review.1",
										attempt_number: 1,
										max_attempts: 2,
										instance_id: "inst-review",
										process_state: "alive",
										resource_state: "open",
									},
								},
							],
							edges: [{ from: "build", to: "review", kind: "dependency", dependency_policy: "require_success", state: nodeStatuses.build === "succeeded" ? "fired" : "pending" }],
						},
					...extra,
				});

				// G1. Idle polling every ~2s, visibility pause/resume, and no polling on Inspect
				let idlePolls = 0;
				let inspectPolls = 0;
				const appIdle = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_1", name: "F1", current_version: "v1", management: "managed" }]);
					if (url === "/api/factories/fac_1/live") {
						idlePolls++;
						return jsonResp(200, {
							factory_id: "fac_1",
							current_version: "v1",
							checked_at: `2026-11-24T12:00:0${idlePolls}Z`,
							state: "idle",
							reason: "No queued inputs.",
							run: null,
							graph: { evidence: "not applicable", absence: "no records", explanation: "Idle" },
						});
					}
					if (url === "/api/factories/fac_1/inspect") {
						inspectPolls++;
						return jsonResp(200, {
							factory_id: "fac_1",
							current_version: "v1",
							inspected_version: "v1",
							evidence: "available",
							attention_summary: { name: "F1", management: { state: "managed" }, stop_state: { state: "active" } },
							definition: { version: "v1", topology: "graph", nodes: [] },
						});
					}
					throw new Error(`Unexpected ${url}`);
				});
				await flushMicrotasks();
				assert.equal(idlePolls, 1);
				await appIdle.advanceTimers(2000);
				assert.equal(idlePolls, 2, "Idle live view must poll every 2s");
				await appIdle.advanceTimers(2000);
				assert.equal(idlePolls, 3);

				// Pause on document.hidden (and do not re-arm timer if a fetch finishes while hidden)
				await appIdle.setVisibility(true);
				assert.equal(appIdle.activeTimers(), 0, "Poll timer must cancel when hidden");
				await appIdle.advanceTimers(6000);
				assert.equal(idlePolls, 3, "Must not poll while document.hidden is true");
				assert.equal(appIdle.context.FactoryViewerSafe.computeNextPollAction({ activeView: "live", selectedFactoryId: "fac_1", hidden: true, inFlight: false, hasPendingTimer: false }, { type: "fetch-finished" }).action, "cancel-timer");

				// Resume with immediate refresh on visible
				await appIdle.setVisibility(false);
				assert.equal(idlePolls, 4, "Becoming visible must trigger an immediate refresh");
				await appIdle.advanceTimers(2000);
				assert.equal(idlePolls, 5);

				// Switching to Inspect stops polling completely
				const inspectTab = appIdle.viewsNav.querySelectorAll("[data-view]").find(t => t.getAttribute("data-view") === "inspect")!;
				for (const fn of inspectTab.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();
				assert.equal(inspectPolls, 1);
				assert.equal(appIdle.activeTimers(), 0);
				await appIdle.advanceTimers(10_000);
				assert.equal(inspectPolls, 1, "Non-live views must not poll");
				assert.equal(idlePolls, 5, "Live polling must stop when leaving Live view");

				// G2. No overlapping requests when a poll takes >2s
				let concurrentCount = 0;
				let maxConcurrent = 0;
				let totalLiveCalls = 0;
				let resolveSlow!: (r: any) => void;
				const appNoOverlap = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					totalLiveCalls++;
					if (totalLiveCalls === 1) {
						return jsonResp(200, makeRunSnap("fac_1", "r1", "a1", "running", "2026-11-24T12:00:00Z", { build: "running", review: "waiting" }));
					}
					concurrentCount++;
					maxConcurrent = Math.max(maxConcurrent, concurrentCount);
					return new Promise(res => { resolveSlow = res; });
				});
				await flushMicrotasks();
				assert.equal(totalLiveCalls, 1);
				await appNoOverlap.advanceTimers(2000);
				assert.equal(totalLiveCalls, 2);
				assert.equal(concurrentCount, 1);
				// Advance another 4s while request #2 is still in flight -> ticks must be skipped
				await appNoOverlap.advanceTimers(4000);
				assert.equal(totalLiveCalls, 2, "Must skip poll ticks while a request is in flight");
				assert.equal(maxConcurrent, 1);
				resolveSlow(jsonResp(200, makeRunSnap("fac_1", "r1", "a1", "running", "2026-11-24T12:00:05Z", { build: "running", review: "waiting" })));
				concurrentCount--;
				await flushMicrotasks();

				// G3. Same-run in-place DOM patching preserves pan/zoom (viewBox), selected node, expanded <details>, and focus;
				//     next verified run rebuilds & resets; ended run persists; Stale/recovery/uncertain/404/factory switch
				let phase = 0;
				let resolveBeta!: (r: any) => void;
				let outputFetchCount = 0;
				const appLiveFlow = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") {
						return jsonResp(200, [
							{ factory_id: "fac_1", name: "Alpha", current_version: "v2", management: "managed" },
							{ factory_id: "fac_2", name: "Beta", current_version: "v1", management: "managed" },
						]);
					}
					if (url === "/api/factories/fac_2/live") {
						return new Promise(res => { resolveBeta = res; });
					}
					if (url === "/api/factories/fac_1/output?node=build") {
						outputFetchCount++;
						if (phase >= 2) {
							return jsonResp(200, {
								factory_id: "fac_1",
								node_id: "build",
								run_id: "run-1",
								bound_version: "v1",
								evidence: "available",
								total_attempts: 1,
								omitted_attempts: 0,
								attempts: [
									{
										attempt_id: "build.1",
										attempt_number: 1,
										max_attempts: 2,
										status: "succeeded",
										status_text: "Succeeded",
										evidence: "available",
										summary: "Build finished summary",
										detail: "Build finished detail",
										outputs_text: "{\n  \"ok\": true\n}",
									},
								],
							});
						}
						return jsonResp(200, {
							factory_id: "fac_1",
							node_id: "build",
							run_id: "run-1",
							bound_version: "v1",
							evidence: "not applicable",
							total_attempts: 1,
							omitted_attempts: 0,
							attempts: [
								{
									attempt_id: "build.1",
									attempt_number: 1,
									max_attempts: 2,
									status: "running",
									status_text: "Running",
									evidence: "not applicable",
									absence: "not applicable",
									explanation: "Attempt output is recorded when the attempt finishes.",
								},
							],
						});
					}
					phase++;
					if (phase === 1) return jsonResp(200, makeRunSnap("fac_1", "run-1", "att-1", "running", "2026-11-24T12:00:00Z", { build: "running", review: "waiting" }));
					if (phase === 2) return jsonResp(200, makeRunSnap("fac_1", "run-1", "att-1", "running", "2026-11-24T12:00:02Z", { build: "succeeded", review: "running" }));
					if (phase === 3) return jsonResp(200, makeRunSnap("fac_1", "run-1", "att-1", "running", "2026-11-24T12:00:04Z", { build: "succeeded", review: "running" }));
					if (phase === 4) return jsonResp(200, makeRunSnap("fac_1", "run-1", "att-1", "running", "2026-11-24T12:00:06Z", { build: "succeeded", review: "succeeded" }));
					if (phase === 5) throw new Error("ECONNREFUSED");
					if (phase === 6) return jsonResp(503, { error: "Evidence unavailable" });
					if (phase === 7) return { ok: true, status: 200, text: async () => "{invalid-json" };
					if (phase === 8) return jsonResp(200, makeRunSnap("fac_other", "run-9", "att-9", "running", "2026-11-24T12:00:10Z", { build: "running", review: "waiting" }));
					if (phase === 9) return jsonResp(200, makeRunSnap("fac_1", "run-1", "att-1", "ended", "2026-11-24T12:00:12Z", { build: "succeeded", review: "succeeded" }, { settlement: "settled", capacity_release: "released", noGraph: true }));
					if (phase === 10) return jsonResp(200, { factory_id: "fac_1", current_version: "v2", checked_at: "2026-11-24T12:00:14Z", state: "idle", reason: "No queued inputs", run: null });
					if (phase === 11) return jsonResp(200, makeRunSnap("fac_1", "run-2", "att-2", "running", "2026-11-24T12:00:16Z", { build: "running", review: "waiting" }));
					if (phase === 12) return jsonResp(200, { factory_id: "fac_1", current_version: "v2", checked_at: "2026-11-24T12:00:18Z", state: "uncertain", reason: "Release manifest damaged", run: null, graph: { evidence: "unavailable", absence: "evidence unavailable", explanation: "Damaged" } });
					if (phase === 13) throw new Error("Connection lost");
					if (phase === 14) return jsonResp(404, { error: "Factory not found" });
					return jsonResp(404, { error: "Factory not found" });
				});
				await flushMicrotasks();

				// Capture references to SVG, node <g>s, select node "build", focus it, zoom via wheel, open <details>
				const svgBefore = collectAllElements(appLiveFlow.content).find(e => e.tagName === "svg")!;
				const nodeBuildBefore = collectAllElements(svgBefore).find(e => e.getAttribute("data-node-id") === "build")!;
				const nodeReviewBefore = collectAllElements(svgBefore).find(e => e.getAttribute("data-node-id") === "review")!;
				assert.ok(svgBefore && nodeBuildBefore && nodeReviewBefore);
				// Wheel zoom
				for (const fn of svgBefore.listeners.get("wheel") ?? []) fn({ deltaY: -100, preventDefault() {} });
				const zoomedViewBox = svgBefore.getAttribute("viewBox");
				assert.notEqual(zoomedViewBox, "0 0 890 390");
				// Focus & select node "build" via Enter
				nodeBuildBefore.focus();
				for (const fn of nodeBuildBefore.listeners.get("keydown") ?? []) fn({ key: "Enter", preventDefault() {} });
				assert.equal(nodeBuildBefore.getAttribute("aria-pressed"), "true");
				assert.equal(appLiveFlow.fakeDocument.activeElement, nodeBuildBefore);
				// Expand <details> in detail panel
				await flushMicrotasks();
				assert.equal(outputFetchCount, 1, "Selecting a node must fetch /output once");
				const detailsBefore = collectAllElements(appLiveFlow.content).find(e => e.tagName === "details" && e.textContent.includes("Optional attempt timestamps"))!;
				assert.ok(detailsBefore);
				detailsBefore.open = true;
				const attemptDetailsBefore = collectAllElements(appLiveFlow.content).find(e => e.tagName === "details" && e.textContent.includes("Attempt 1 of 2"))!;
				assert.ok(attemptDetailsBefore);
				assert.equal(attemptDetailsBefore.open, true);

				// Poll 2 (build transitions running -> succeeded -> refetches /output once), Poll 3 & 4 (build stays succeeded -> no extra /output fetch):
				// SVG, nodes, viewBox, selection, open disclosures, and activeElement MUST survive!
				for (const expectedChecked of ["2026-11-24T12:00:02Z", "2026-11-24T12:00:04Z", "2026-11-24T12:00:06Z"]) {
					await appLiveFlow.advanceTimers(2000);
					assert.equal(outputFetchCount, 2, "Poll must re-fetch /output once on running->succeeded and never on unchanged polls");
					const svgNow = collectAllElements(appLiveFlow.content).find(e => e.tagName === "svg")!;
					const nodeBuildNow = collectAllElements(svgNow).find(e => e.getAttribute("data-node-id") === "build")!;
					const nodeReviewNow = collectAllElements(svgNow).find(e => e.getAttribute("data-node-id") === "review")!;
					const allDetails = collectAllElements(appLiveFlow.content).filter(e => e.tagName === "details");
					assert.equal(allDetails.length, 3, "Same-run poll must keep Attempt output, Structured outputs, and timestamps <details>");
					const detailsNow = allDetails.find(e => e.children[0]?.textContent.includes("Optional attempt timestamps"))!;
					const attemptDetailsNow = allDetails.find(e => e.children[0]?.textContent.includes("Attempt 1 of 2"))!;
					const outputsDetailsNow = allDetails.find(e => e.children[0]?.textContent.includes("Structured outputs"))!;
					assert.equal(svgNow, svgBefore, "Same-run poll must NOT recreate <svg>");
					assert.equal(nodeBuildNow, nodeBuildBefore, "Same-run poll must NOT recreate node <g>");
					assert.equal(nodeReviewNow, nodeReviewBefore, "Same-run poll must NOT recreate untouched node <g>");
					assert.equal(detailsNow, detailsBefore, "Same-run poll must NOT recreate <details>");
					assert.equal(attemptDetailsNow, attemptDetailsBefore, "Output refetch must patch attempt <details> in place");
					assert.equal(detailsNow.open, true, "<details>.open must survive same-run refresh");
					assert.equal(attemptDetailsNow.open, true, "Attempt disclosure open state must survive output refetch and subsequent polls");
					assert.equal(outputsDetailsNow.open, false, "Structured outputs disclosure must start collapsed");
					assert.match(attemptDetailsNow.textContent, /Build finished summary/);
					assert.ok(detailsNow.textContent.includes(expectedChecked), "<details> timestamps must update in place");
					assert.equal(svgNow.getAttribute("viewBox"), zoomedViewBox, "viewBox pan/zoom must survive same-run refresh");
					assert.equal(nodeBuildNow.getAttribute("aria-pressed"), "true", "Selected node must survive same-run refresh");
					assert.equal(appLiveFlow.fakeDocument.activeElement, nodeBuildNow, "Keyboard focus must survive same-run refresh");
					assert.ok(appLiveFlow.content.textContent.includes(expectedChecked));
				}

				// Poll 5, 6, 7, 8: network error, HTTP 503, invalid JSON, and factory mismatch -> Stale appears with lastCheckedAt=2026-11-24T12:00:06Z & failure reason; graph stays
				await appLiveFlow.advanceTimers(2000);
				assert.match(appLiveFlow.content.textContent, /⟳ Stale/);
				assert.match(appLiveFlow.content.textContent, /Last successful check: 2026-11-24T12:00:06Z/);
				assert.match(appLiveFlow.content.textContent, /ECONNREFUSED/);
				assert.equal(collectAllElements(appLiveFlow.content).find(e => e.tagName === "svg"), svgBefore, "Stale keeps last good graph");

				await appLiveFlow.advanceTimers(2000);
				assert.match(appLiveFlow.content.textContent, /⟳ Stale/);
				assert.match(appLiveFlow.content.textContent, /Evidence unavailable/);

				await appLiveFlow.advanceTimers(2000);
				assert.match(appLiveFlow.content.textContent, /⟳ Stale/);
				assert.match(appLiveFlow.content.textContent, /Invalid JSON response/);

				await appLiveFlow.advanceTimers(2000);
				assert.match(appLiveFlow.content.textContent, /⟳ Stale/);
				assert.match(appLiveFlow.content.textContent, /did not match/i);
				assert.equal(appLiveFlow.content.textContent.includes("run-9"), false, "Foreign factory run data must never render");

				// Poll 9: recovery -> Stale clears, ended run shows settled outcome & capacity release, never "Verified released run"
				await appLiveFlow.advanceTimers(2000);
				assert.equal(appLiveFlow.content.textContent.includes("⟳ Stale"), false, "Recovery must clear Stale");
				assert.match(appLiveFlow.content.textContent, /Ended run \(not active\)/);
				assert.match(appLiveFlow.content.textContent, /Passed/);
				assert.match(appLiveFlow.content.textContent, /Settled/);
				assert.match(appLiveFlow.content.textContent, /Released/);
				assert.equal(appLiveFlow.content.textContent.includes("Verified released run"), false);

				// Poll 10: idle without new run keeps ended outcome visible
				await appLiveFlow.advanceTimers(2000);
				assert.match(appLiveFlow.content.textContent, /Ended run \(not active\)/);
				assert.match(appLiveFlow.content.textContent, /Passed/);

				// Poll 11: next verified run (run-2) replaces ended state, rebuilds SVG, resets pan/zoom & selection
				await appLiveFlow.advanceTimers(2000);
				const svgRun2 = collectAllElements(appLiveFlow.content).find(e => e.tagName === "svg")!;
				assert.notEqual(svgRun2, svgBefore, "Next verified run must rebuild SVG");
				assert.match(appLiveFlow.content.textContent, /run-2/);
				assert.notEqual(svgRun2.getAttribute("viewBox"), zoomedViewBox, "Next run must reset viewBox");
				assert.equal(collectAllElements(svgRun2).some(e => e.getAttribute("aria-pressed") === "true"), false, "Next run must reset selection");

				// Poll 12: fresh uncertain snapshot replaces run-2 WITHOUT Stale
				await appLiveFlow.advanceTimers(2000);
				assert.match(appLiveFlow.content.textContent, /\? Uncertain/);
				assert.match(appLiveFlow.content.textContent, /Release manifest damaged/);
				assert.equal(appLiveFlow.content.textContent.includes("⟳ Stale"), false, "Fresh uncertain must not show Stale");

				// Poll 13: network failure while uncertain -> Stale overlay + Uncertain stays separate
				await appLiveFlow.advanceTimers(2000);
				assert.match(appLiveFlow.content.textContent, /⟳ Stale/);
				assert.match(appLiveFlow.content.textContent, /\? Uncertain/);

				// Factory switch during Stale period -> clears Stale and previous factory immediately (even while fac_2 is loading), shows Beta only
				const betaLink = collectAllElements(appLiveFlow.sidebar).find(e => e.tagName === "a" && (e.getAttribute("href") ?? "").includes("fac_2"))!;
				assert.ok(betaLink);
				for (const fn of betaLink.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				assert.equal(appLiveFlow.content.textContent.includes("⟳ Stale"), false, "Factory switch must discard Stale immediately");
				assert.equal(appLiveFlow.content.textContent.includes("Release manifest damaged"), false, "Factory switch must discard previous factory data immediately");
				assert.match(appLiveFlow.content.textContent, /Loading Live Graph/);
				resolveBeta(jsonResp(503, { error: "Beta unavailable" }));
				await flushMicrotasks();
				assert.match(appLiveFlow.content.textContent, /! HTTP 503/);
				assert.equal(appLiveFlow.content.textContent.includes("⟳ Stale"), false, "Failed initial load of new factory must not show previous factory as Stale");
				assert.equal(appLiveFlow.content.textContent.includes("Release manifest damaged"), false);

				// Switch back to fac_1 where phase 14 returns 404 -> error state, NOT Stale
				const alphaLink = collectAllElements(appLiveFlow.sidebar).find(e => e.tagName === "a" && (e.getAttribute("href") ?? "").includes("fac_1"))!;
				for (const fn of alphaLink.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();
				assert.match(appLiveFlow.content.textContent, /! HTTP 404/);
				assert.equal(appLiveFlow.content.textContent.includes("⟳ Stale"), false, "404 must be an error state, not Stale");

				// Also verify 404 arriving on a poll AFTER a good snapshot clears lastGood and shows error (NOT Stale)
				let poll404Phase = 0;
				const app404Poll = bootApp("?factory=fac_1&view=live", async url => {
					if (url === "/api/factories") return jsonResp(200, []);
					poll404Phase++;
					if (poll404Phase === 1) return jsonResp(200, makeRunSnap("fac_1", "run-1", "att-1", "running", "2026-11-24T12:00:00Z", { build: "running", review: "waiting" }));
					return jsonResp(404, { error: "Factory not found" });
				});
				await flushMicrotasks();
				assert.match(app404Poll.content.textContent, /run-1/);
				await app404Poll.advanceTimers(2000);
				assert.match(app404Poll.content.textContent, /! HTTP 404/);
				assert.equal(app404Poll.content.textContent.includes("⟳ Stale"), false, "404 during refresh must be an error state, not Stale");
				assert.equal(app404Poll.content.textContent.includes("run-1"), false, "404 during refresh must clear lastGood");
			}

			// H. Factory deletion UI: collapsed sidebar Deleted section, damaged uncertain section, deleted Live state, and deleted banner on Inspect/Queue/Receipts/Requests/Proposals
			{
				const deletedAt = "2026-11-25T15:30:00.000Z";
				const delFixtures: Record<string, unknown> = {
					"/api/factories": {
						factories: [{ factory_id: "fac_active", name: "ActiveFac", current_version: "v1", management: "managed" }],
						deleted: [{
							factory_id: "fac_del",
							name: "RetiredFac",
							current_version: "v2",
							management: "managed",
							deleted: true,
							deletion: { deleted_at: deletedAt, deleted_by: { incarnation_id: "inc-1", pi_session_id: "sess-1" } },
						}],
						damaged: [{
							factory_id: "fac_dmg",
							name: "<script>alert('dmg')</script>",
							current_version: "v1",
							evidence: "unavailable",
							status: "uncertain",
							damaged: true,
							explanation: "Factory deletion evidence mismatch",
						}],
					},
					"/api/factories/fac_del/live": {
						factory_id: "fac_del",
						current_version: "v2",
						checked_at: "2026-11-25T15:31:00.000Z",
						deleted: true,
						deletion: { deleted_at: deletedAt, deleted_by: { incarnation_id: "inc-1", pi_session_id: "sess-1" } },
						state: "deleted",
						reason: `Factory was permanently deleted at ${deletedAt}.`,
						run: null,
						graph: { evidence: "not applicable", absence: "not applicable", explanation: "This factory is deleted; no live run graph is active." },
					},
					"/api/factories/fac_del/inspect": {
						factory_id: "fac_del",
						name: "RetiredFac",
						deleted: true,
						deletion: { deleted_at: deletedAt, deleted_by: { incarnation_id: "inc-1", pi_session_id: "sess-1" } },
						current_version: "v2",
						inspected_version: "v2",
						evidence: "available",
						attention_summary: { name: "RetiredFac", management: { state: "managed" }, stop_state: { state: "active" } },
						definition: { version: "v2", topology: "graph", nodes: [] },
					},
					"/api/factories/fac_del/queue?filter=open": {
						factory_id: "fac_del",
						deleted: true,
						deletion: { deleted_at: deletedAt, deleted_by: { incarnation_id: "inc-1", pi_session_id: "sess-1" } },
						filter: "open",
						evidence: "available",
						absence: "no records",
						explanation: "No open inputs.",
						entries: [],
					},
					"/api/factories/fac_del/receipts?reference=ref-del": {
						type: "receipt",
						is_run_report: false,
						note: "Receipt evidence is not a run report.",
						factory_id: "fac_del",
						deleted: true,
						deletion: { deleted_at: deletedAt, deleted_by: { incarnation_id: "inc-1", pi_session_id: "sess-1" } },
						input_id: "in_1",
						reference: "ref-del",
						queue_position: 1,
						accepted_at: "2026-11-25T15:00:00.000Z",
						bound_version: "v2",
						current_version: "v2",
						disposition: "settled",
						disposition_explanation: "Finished and settled.",
						attempt: { absence: "no records", explanation: "Settled" },
					},
					"/api/factories/fac_del/requests": {
						factory_id: "fac_del",
						deleted: true,
						deletion: { deleted_at: deletedAt, deleted_by: { incarnation_id: "inc-1", pi_session_id: "sess-1" } },
						evidence: "available",
						records: [],
						absence: "no records",
						explanation: "No requests recorded.",
					},
					"/api/factories/fac_del/proposals": {
						factory_id: "fac_del",
						deleted: true,
						deletion: { deleted_at: deletedAt, deleted_by: { incarnation_id: "inc-1", pi_session_id: "sess-1" } },
						is_active_constraints_file: false,
						note: "Proposals are not the active constraints file.",
						evidence: "available",
						records: [],
						absence: "no records",
						explanation: "No proposals recorded.",
					},
				};

				const appHome = bootApp("", async url => jsonResp(200, delFixtures[url] ?? {}));
				await flushMicrotasks();

				// Active list has ActiveFac only; Deleted section in sidebar is collapsed (<details> without open); Damaged section marks fac_dmg uncertain/damaged
				assert.match(appHome.factoriesList.textContent, /ActiveFac/);
				assert.equal(appHome.factoriesList.textContent.includes("RetiredFac"), false, "Active sidebar list must exclude deleted factory");
				assert.equal(appHome.factoriesList.textContent.includes("fac_dmg"), false, "Active sidebar list must exclude damaged factory");

				const sidebarDetails = collectAllElements(appHome.sidebar).find(e => e.tagName === "details");
				assert.ok(sidebarDetails, "Sidebar must render a <details> Deleted section");
				assert.equal(sidebarDetails.open, false, "Sidebar Deleted section must be collapsed by default");
				assert.match(sidebarDetails.textContent, /Deleted/);
				assert.match(sidebarDetails.textContent, /RetiredFac/);

				assert.match(appHome.sidebar.textContent, /Damaged|Uncertain/);
				assert.ok(collectTextNodes(appHome.sidebar).some(t => t.includes("<script>alert('dmg')</script>")));
				appHome.assertSafeDom();

				// Main Factories view keeps RetiredFac out of active list, shows Deleted and Damaged groups
				assert.match(appHome.content.textContent, /ActiveFac/);
				assert.match(appHome.content.textContent, /Deleted/);
				assert.match(appHome.content.textContent, /RetiredFac/);
				assert.match(appHome.content.textContent, /Damaged|Uncertain/);

				// Deleted factory Live Graph never implies activity (never Idle/Waiting/Running) and shows deletion time
				const appDel = bootApp("?factory=fac_del&view=live", async url => jsonResp(200, delFixtures[url] ?? {}));
				await flushMicrotasks();
				assert.match(appDel.content.textContent, /Deleted/);
				assert.ok(appDel.content.textContent.includes(deletedAt), "Deleted Live Graph must show deletion time");
				for (const forbidden of ["Idle", "Waiting", "Running"]) {
					assert.equal(appDel.content.textContent.includes(forbidden), false, `Deleted Live Graph must not imply ${forbidden}`);
				}

				const clickDelTab = async (viewName: string) => {
					const tab = appDel.viewsNav.querySelectorAll("[data-view]").find(t => t.getAttribute("data-view") === viewName)!;
					for (const fn of tab.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
					await flushMicrotasks();
				};

				for (const viewName of ["inspect", "queue", "requests", "proposals"]) {
					await clickDelTab(viewName);
					assert.match(appDel.content.textContent, /Deleted/i, `${viewName} must show deleted banner`);
					assert.ok(appDel.content.textContent.includes(deletedAt), `${viewName} must show deletion time`);
				}
				// Receipts without reference still shows deleted banner from factory list metadata, and with reference shows deleted banner from receipt snapshot
				await clickDelTab("receipts");
				assert.match(appDel.content.textContent, /Deleted/i);
				assert.ok(appDel.content.textContent.includes(deletedAt));

				const appDelRec = bootApp("?factory=fac_del&view=receipts&reference=ref-del", async url => jsonResp(200, delFixtures[url] ?? {}));
				await flushMicrotasks();
				assert.match(appDelRec.content.textContent, /Deleted/i);
				assert.ok(appDelRec.content.textContent.includes(deletedAt));
				assert.match(appDelRec.content.textContent, /ref-del/);
				appDelRec.assertSafeDom();

				// Ended -> Deleted transition in safe.js must not retain Ended
				const endedSnap = {
					factory_id: "fac_del",
					state: "ended",
					current_version: "v2",
					checked_at: "2026-11-25T15:29:00Z",
					run: { run_id: "r1", attempt_id: "a1", bound_version: "v2" },
					outcome: "passed",
				};
				const deletedTrans = appDel.context.FactoryViewerSafe.classifyLiveTransition(endedSnap, delFixtures["/api/factories/fac_del/live"]);
				assert.equal(deletedTrans.effectiveSnapshot.state, "deleted");
			}

			// I. Ticket 01 Attempt output section: plain text + preserved whitespace, typed absence, abort & stale discard on node/factory switch, mismatch discard, and in-section error
			{
				const makeSnap = (factoryId: string) => ({
					factory_id: factoryId,
					current_version: "v1",
					checked_at: "2026-11-28T12:00:00Z",
					state: "running",
					reason: "Running",
					run: { run_id: `run-${factoryId}`, attempt_id: `att-${factoryId}`, bound_version: "v1" },
					outcome: "incomplete",
					settlement: "unsettled",
					capacity_release: "held",
					graph: {
						evidence: "available",
						bound_version: "v1",
						topology: "graph",
						nodes: [
							{ id: "node_a", kind: "agent", status: "succeeded", status_text: "Succeeded", current_attempt: { attempt_id: "a.1", attempt_number: 1, max_attempts: 1, instance_id: "i-a", process_state: "exited", resource_state: "closed" } },
							{ id: "node_b", kind: "agent", status: "running", status_text: "Running", current_attempt: { attempt_id: "b.1", attempt_number: 1, max_attempts: 1, instance_id: "i-b", process_state: "alive", resource_state: "open" } },
							{ id: "node_c", kind: "agent", status: "needs_attention", status_text: "Uncertain", current_attempt: { attempt_id: "c.1", attempt_number: 1, max_attempts: 1, instance_id: "i-c", process_state: "exited", resource_state: "closed" } },
							{ id: "node_err", kind: "agent", status: "failed", status_text: "Failed", current_attempt: { attempt_id: "e.1", attempt_number: 1, max_attempts: 1, instance_id: "i-e", process_state: "exited", resource_state: "closed" } },
							{ id: "node_mis", kind: "agent", status: "succeeded", status_text: "Succeeded", current_attempt: { attempt_id: "m.1", attempt_number: 1, max_attempts: 1, instance_id: "i-m", process_state: "exited", resource_state: "closed" } },
						],
						edges: [],
					},
				});

				let resolveA!: (r: any) => void;
				let signalA: AbortSignal | undefined;
				let resolveB!: (r: any) => void;
				let signalB: AbortSignal | undefined;

				const appOut = bootApp("?factory=fac_1&view=live", async (url, init) => {
					if (url === "/api/factories") {
						return jsonResp(200, [
							{ factory_id: "fac_1", name: "Fac1", current_version: "v1", management: "managed" },
							{ factory_id: "fac_2", name: "Fac2", current_version: "v1", management: "managed" },
						]);
					}
					if (url === "/api/factories/fac_1/live") return jsonResp(200, makeSnap("fac_1"));
					if (url === "/api/factories/fac_2/live") return jsonResp(200, makeSnap("fac_2"));
					if (url === "/api/factories/fac_1/output?node=node_a") {
						signalA = init?.signal;
						return new Promise(res => { resolveA = res; });
					}
					if (url === "/api/factories/fac_1/output?node=node_b") {
						signalB = init?.signal;
						return new Promise(res => { resolveB = res; });
					}
					if (url === "/api/factories/fac_1/output?node=node_c") {
						return jsonResp(200, {
							factory_id: "fac_1",
							node_id: "node_c",
							evidence: "unavailable",
							latest_attempt: {
								attempt_id: "c.1",
								attempt_number: 1,
								max_attempts: 1,
								status: "needs_attention",
								status_text: "Uncertain",
								evidence: "unavailable",
								absence: "evidence unavailable",
								explanation: "Result record is damaged.",
							},
						});
					}
					if (url === "/api/factories/fac_1/output?node=node_err") {
						return jsonResp(503, { error: "Evidence unavailable" });
					}
					if (url === "/api/factories/fac_1/output?node=node_mis") {
						return jsonResp(200, {
							factory_id: "fac_1",
							node_id: "wrong_node",
							evidence: "available",
							latest_attempt: {
								attempt_id: "w.1",
								attempt_number: 1,
								max_attempts: 1,
								status: "succeeded",
								status_text: "Succeeded",
								evidence: "available",
								summary: "MISMATCHED_OUTPUT_LEAK",
								detail: "MISMATCHED_DETAIL",
							},
						});
					}
					if (url === "/api/factories/fac_2/output?node=node_a") {
						return jsonResp(200, {
							factory_id: "fac_2",
							node_id: "node_a",
							evidence: "available",
							latest_attempt: {
								attempt_id: "a.1",
								attempt_number: 1,
								max_attempts: 1,
								status: "succeeded",
								status_text: "Succeeded",
								evidence: "available",
								summary: "Fac2 summary\nLine 2",
								detail: "Fac2 <script>alert('xss')</script>\n  indented",
							},
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();

				const clickNode = async (id: string) => {
					const g = collectAllElements(appOut.content).find(e => e.getAttribute("data-node-id") === id)!;
					for (const fn of g.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
				};

				// 1. Select node_a, then switch to node_b before node_a resolves -> aborts A & discards late A response
				await clickNode("node_a");
				assert.ok(signalA && !signalA.aborted);
				assert.match(appOut.content.textContent, /Attempt output/);
				assert.match(appOut.content.textContent, /Loading attempt output/);

				await clickNode("node_b");
				assert.equal(signalA.aborted, true, "Selecting another node must abort in-flight output request");
				assert.ok(signalB && !signalB.aborted);
				resolveA(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_a",
					evidence: "available",
					latest_attempt: {
						attempt_id: "a.1",
						attempt_number: 1,
						max_attempts: 1,
						status: "succeeded",
						status_text: "Succeeded",
						evidence: "available",
						summary: "STALE_NODE_A_LEAK",
						detail: "STALE_NODE_A_DETAIL",
					},
				}));
				await flushMicrotasks();
				assert.equal(appOut.content.textContent.includes("STALE_NODE_A_LEAK"), false, "Late stale response for node_a must be discarded");

				// Now resolve node_b with Not applicable
				resolveB(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_b",
					evidence: "not applicable",
					latest_attempt: {
						attempt_id: "b.1",
						attempt_number: 1,
						max_attempts: 1,
						status: "running",
						status_text: "Running",
						evidence: "not applicable",
						absence: "not applicable",
						explanation: "Attempt output is recorded when the attempt finishes.",
					},
				}));
				await flushMicrotasks();
				assert.match(appOut.content.textContent, /— Not applicable/);
				assert.match(appOut.content.textContent, /Attempt output is recorded when the attempt finishes\./);

				// 2. node_c -> Evidence unavailable
				await clickNode("node_c");
				assert.match(appOut.content.textContent, /! Evidence unavailable/);
				assert.match(appOut.content.textContent, /Result record is damaged\./);

				// 3. node_err -> error inside Attempt output section only; SVG graph & selected-node header stay intact
				await clickNode("node_err");
				assert.ok(collectAllElements(appOut.content).find(e => e.tagName === "svg"), "Graph must stay visible on output error");
				assert.match(appOut.content.textContent, /Selected node/);
				assert.match(appOut.content.textContent, /node_err/);
				assert.match(appOut.content.textContent, /! HTTP 503/);

				// 4. node_mis -> mismatched node_id discarded, shows error inside section only
				await clickNode("node_mis");
				assert.equal(appOut.content.textContent.includes("MISMATCHED_OUTPUT_LEAK"), false);
				assert.match(appOut.content.textContent, /did not match/i);

				// 5. Switch back to node_a (in-flight), then switch factory to fac_2 -> aborts node_a & discards stale response
				await clickNode("node_a");
				assert.ok(signalA && !signalA.aborted);
				const fac2Link = collectAllElements(appOut.sidebar).find(e => e.tagName === "a" && (e.getAttribute("href") ?? "").includes("fac_2"))!;
				for (const fn of fac2Link.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();
				assert.equal(signalA.aborted, true, "Switching factory must abort in-flight output request");
				resolveA(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_a",
					evidence: "available",
					latest_attempt: {
						attempt_id: "a.1",
						attempt_number: 1,
						max_attempts: 1,
						status: "succeeded",
						status_text: "Succeeded",
						evidence: "available",
						summary: "STALE_FAC1_OUTPUT_LEAK",
						detail: "STALE_FAC1_DETAIL",
					},
				}));
				await flushMicrotasks();
				assert.equal(appOut.content.textContent.includes("STALE_FAC1_OUTPUT_LEAK"), false);

				// 6. Select node_a in fac_2 -> renders plain text with preserved whitespace & .output-text, no injected markup
				await clickNode("node_a");
				assert.ok(collectTextNodes(appOut.content).some(t => t.includes("Fac2 <script>alert('xss')</script>\n  indented")));
				const outBlocks = collectAllElements(appOut.content).filter(e => e.classList.contains("output-text"));
				assert.equal(outBlocks.length, 2, "Summary and detail must use .output-text");

				// N5/N6: Attempt output card sets aria-live="off" so large output is never announced inside detailPanel, no nested polite/assertive aria-live inside outputSection, and status chip renders once (in <summary>, not in body facts <dl>)
				const outputHeading = collectAllElements(appOut.content).find(e => e.tagName === "h4" && e.textContent === "Attempt output")!;
				assert.ok(outputHeading, "Expected Attempt output heading");
				const outputSection = collectAllElements(appOut.content).find(e => e.tagName === "section" && e.children.some(c => c.children.includes(outputHeading)))!;
				assert.ok(outputSection, "Expected Attempt output section");
				assert.equal(outputSection.getAttribute("aria-live"), "off", "Attempt output card must set aria-live='off'");
				const activeNestedAriaLive = collectAllElements(outputSection).filter(e => e !== outputSection && e.hasAttribute("aria-live"));
				assert.equal(activeNestedAriaLive.length, 0, "Attempt output section must not nest aria-live inside Attempt output card");
				const outputDetails = collectAllElements(outputSection).find(e => e.tagName === "details")!;
				assert.ok(outputDetails);
				const statusChipsInDetails = collectAllElements(outputDetails).filter(e => e.classList.contains("chip"));
				assert.equal(statusChipsInDetails.length, 1, "Status chip must render once (in <summary>), not duplicated in body facts");
				assert.equal(collectAllElements(outputDetails).some(e => e.tagName === "dt" && e.textContent === "Status"), false, "Body facts must not duplicate Status");
				appOut.assertSafeDom();
			}

			// J. N1: same-factory reload while /output is in flight must not leave Attempt output stuck on "Loading attempt output…"
			{
				let outputCalls = 0;
				let resolveOutput!: (r: any) => void;
				let resolveLiveReload!: (r: any) => void;
				let liveCalls = 0;

				const snap = {
					factory_id: "fac_1",
					current_version: "v1",
					checked_at: "2026-11-28T12:00:00Z",
					state: "running",
					reason: "Running",
					run: { run_id: "run-n1", attempt_id: "att-n1", bound_version: "v1" },
					outcome: "incomplete",
					settlement: "unsettled",
					capacity_release: "held",
					graph: {
						evidence: "available",
						bound_version: "v1",
						topology: "graph",
						nodes: [
							{ id: "node_a", kind: "agent", status: "succeeded", status_text: "Succeeded", current_attempt: { attempt_id: "a.1", attempt_number: 1, max_attempts: 1, instance_id: "i-a", process_state: "exited", resource_state: "closed" } },
						],
						edges: [],
					},
				};

				const appN1 = bootApp("?factory=fac_1&view=live", async (url, init) => {
					if (url === "/api/factories") {
						return jsonResp(200, [{ factory_id: "fac_1", name: "Fac1", current_version: "v1", management: "managed" }]);
					}
					if (url === "/api/factories/fac_1/live") {
						liveCalls++;
						if (liveCalls === 1) return jsonResp(200, snap);
						return new Promise(res => { resolveLiveReload = res; });
					}
					if (url === "/api/factories/fac_1/output?node=node_a") {
						outputCalls++;
						return new Promise((res, rej) => {
							resolveOutput = res;
							init?.signal?.addEventListener("abort", () => {
								const err = new Error("The operation was aborted");
								err.name = "AbortError";
								rej(err);
							});
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();

				const gNode = collectAllElements(appN1.content).find(e => e.getAttribute("data-node-id") === "node_a")!;
				for (const fn of gNode.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();
				assert.equal(outputCalls, 1);
				assert.match(appN1.content.textContent, /Loading attempt output/);

				// Trigger same-factory reload (click Live Graph tab) while output request is in flight
				const liveTab = appN1.viewsNav.querySelectorAll("[data-view]").find(t => t.getAttribute("data-view") === "live")!;
				for (const fn of liveTab.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();

				resolveLiveReload(jsonResp(200, snap));
				await flushMicrotasks();

				// Resolve whichever output request is active (original if preserved, or re-issued if aborted)
				resolveOutput(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_a",
					evidence: "available",
					latest_attempt: {
						attempt_id: "a.1",
						attempt_number: 1,
						max_attempts: 1,
						status: "succeeded",
						status_text: "Succeeded",
						evidence: "available",
						summary: "Recovered summary after reload",
						detail: "Recovered detail after reload",
					},
				}));
				await flushMicrotasks();

				assert.equal(appN1.content.textContent.includes("Loading attempt output"), false, "Attempt output must not stay stuck loading after same-factory reload");
				assert.match(appN1.content.textContent, /Recovered summary after reload/);
				assert.match(appN1.content.textContent, /Recovered detail after reload/);
				appN1.assertSafeDom();

				// Also verify AbortError recovery: if an output request aborts without rendering, the next live patch re-issues /output
				let abortPhaseCalls = 0;
				let abortPhaseLiveCalls = 0;
				const appN1Abort = bootApp("?factory=fac_1&view=live", async (url) => {
					if (url === "/api/factories") {
						return jsonResp(200, [{ factory_id: "fac_1", name: "Fac1", current_version: "v1", management: "managed" }]);
					}
					if (url === "/api/factories/fac_1/live") {
						abortPhaseLiveCalls++;
						return jsonResp(200, snap);
					}
					if (url === "/api/factories/fac_1/output?node=node_a") {
						abortPhaseCalls++;
						if (abortPhaseCalls === 1) {
							const err = new Error("The operation was aborted");
							err.name = "AbortError";
							throw err;
						}
						return jsonResp(200, {
							factory_id: "fac_1",
							node_id: "node_a",
							evidence: "available",
							latest_attempt: {
								attempt_id: "a.1",
								attempt_number: 1,
								max_attempts: 1,
								status: "succeeded",
								status_text: "Succeeded",
								evidence: "available",
								summary: "Re-fetched after abort",
								detail: "Re-fetched detail",
							},
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();

				const gNodeAbort = collectAllElements(appN1Abort.content).find(e => e.getAttribute("data-node-id") === "node_a")!;
				for (const fn of gNodeAbort.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();
				assert.equal(abortPhaseCalls, 1);
				assert.match(appN1Abort.content.textContent, /Loading attempt output/);

				const liveTabAbort = appN1Abort.viewsNav.querySelectorAll("[data-view]").find(t => t.getAttribute("data-view") === "live")!;
				for (const fn of liveTabAbort.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();
				assert.ok(abortPhaseLiveCalls >= 2);
				assert.equal(abortPhaseCalls, 2, "Next live patch must re-issue /output after an aborted request");
				assert.equal(appN1Abort.content.textContent.includes("Loading attempt output"), false);
				assert.match(appN1Abort.content.textContent, /Re-fetched after abort/);
				appN1Abort.assertSafeDom();
			}

			// K. Ticket 02 Attempt output UI: verification/warnings/next_steps + omitted markers, command exit/signal/stdout/stderr side by side, collapsed structured outputs & artifacts without paths, disposition reason & recorded error, real headings & native disclosures
			{
				const snap = {
					factory_id: "fac_t02",
					current_version: "v1",
					checked_at: "2026-11-28T12:00:00Z",
					state: "running",
					reason: "Running",
					run: { run_id: "run-t02", attempt_id: "att-t02", bound_version: "v1" },
					outcome: "incomplete",
					settlement: "unsettled",
					capacity_release: "held",
					graph: {
						evidence: "available",
						bound_version: "v1",
						topology: "graph",
						nodes: [
							{ id: "rich", kind: "agent", status: "succeeded", status_text: "Succeeded", current_attempt: { attempt_id: "r.1", attempt_number: 1, max_attempts: 1, instance_id: "i-r", process_state: "exited", resource_state: "closed" } },
							{ id: "cmd", kind: "command", status: "failed", status_text: "Failed", current_attempt: { attempt_id: "c.1", attempt_number: 1, max_attempts: 1, instance_id: "i-c", process_state: "exited", resource_state: "closed" } },
							{ id: "blk", kind: "agent", status: "blocked", status_text: "Blocked", current_attempt: { attempt_id: "b.1", attempt_number: 1, max_attempts: 1, instance_id: "i-b", process_state: "not_started", resource_state: "open" } },
							{ id: "err", kind: "agent", status: "needs_attention", status_text: "Uncertain", current_attempt: { attempt_id: "e.1", attempt_number: 1, max_attempts: 1, instance_id: "i-e", process_state: "exited", resource_state: "closed" } },
						],
						edges: [],
					},
				};

				const appT02 = bootApp("?factory=fac_t02&view=live", async (url) => {
					if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_t02", name: "FacT02", current_version: "v1", management: "managed" }]);
					if (url === "/api/factories/fac_t02/live") return jsonResp(200, snap);
					if (url === "/api/factories/fac_t02/output?node=rich") {
						return jsonResp(200, {
							factory_id: "fac_t02",
							node_id: "rich",
							evidence: "available",
							latest_attempt: {
								attempt_id: "r.1",
								attempt_number: 1,
								max_attempts: 1,
								status: "succeeded",
								status_text: "Succeeded",
								evidence: "available",
								summary: "Rich summary",
								detail: "Rich detail",
								verification: {
									items: [
										{ check_id: "unit-tests", result: "pass", applicability: "current", scope_kind: "declared", reason: "All green" },
										{ check_id: "lint", result: "fail", applicability: "stale", scope_kind: "declared", reason: "Lint <script>xss</script>" },
										{ check_id: "audit", result: "error", applicability: "unknown", scope_kind: "conservative" },
									],
									total_count: 22,
									omitted_count: 19,
									omitted_marker: "… [truncated, 19 items omitted]",
								},
								warnings: {
									items: ["Warn <img src=x>", "Warn 2"],
									total_count: 21,
									omitted_count: 19,
									omitted_marker: "… [truncated, 19 items omitted]",
								},
								next_steps: {
									items: ["Step 1\nindented"],
									total_count: 21,
									omitted_count: 20,
									omitted_marker: "… [truncated, 20 items omitted]",
								},
								outputs_text: "{\n  \"verdict\": \"ok\",\n  \"raw\": \"<b>not html</b>\"\n}",
								artifacts: {
									items: [
										{ type: "file", action: "created", description: "Bundle description without path" },
										{ type: "file", action: "modified", description: "Missing file", missing: true },
									],
									total_count: 2,
									omitted_count: 0,
								},
							},
						});
					}
					if (url === "/api/factories/fac_t02/output?node=cmd") {
						return jsonResp(200, {
							factory_id: "fac_t02",
							node_id: "cmd",
							evidence: "available",
							latest_attempt: {
								attempt_id: "c.1",
								attempt_number: 1,
								max_attempts: 1,
								status: "failed",
								status_text: "Failed",
								evidence: "available",
								summary: "Cmd failed",
								detail: "Exit 2",
								command: {
									exit_code: 2,
									signal: "SIGTERM",
									duration_ms: 420,
									stdout_bytes: 10,
									stderr_bytes: 20,
									stdout_excerpt: "stdout line 1\nstdout line 2",
									stderr_excerpt: "stderr line 1\n<script>bad()</script>",
								},
							},
						});
					}
					if (url === "/api/factories/fac_t02/output?node=blk") {
						return jsonResp(200, {
							factory_id: "fac_t02",
							node_id: "blk",
							evidence: "not applicable",
							latest_attempt: {
								attempt_id: "b.1",
								attempt_number: 1,
								max_attempts: 1,
								status: "blocked",
								status_text: "Blocked",
								evidence: "not applicable",
								absence: "not applicable",
								explanation: "No attempt result was recorded (blocked).",
								disposition_reason: "Upstream node cmd failed",
								causes: {
									items: [{ node_id: "cmd", state: "failed", reason: "Exit code 2" }],
									total_count: 1,
									omitted_count: 0,
								},
							},
						});
					}
					if (url === "/api/factories/fac_t02/output?node=err") {
						return jsonResp(200, {
							factory_id: "fac_t02",
							node_id: "err",
							evidence: "unavailable",
							latest_attempt: {
								attempt_id: "e.1",
								attempt_number: 1,
								max_attempts: 1,
								status: "needs_attention",
								status_text: "Uncertain",
								evidence: "unavailable",
								absence: "evidence unavailable",
								explanation: "The attempt recorded an execution error without a verified result.",
								error_message: "Worker crashed <err>",
							},
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();

				const clickNode = async (id: string) => {
					const g = collectAllElements(appT02.content).find(e => e.getAttribute("data-node-id") === id)!;
					for (const fn of g.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
				};

				// 1. Rich node: verification, warnings, next_steps, collapsed structured outputs & artifacts with real headings
				const getOutputSection = () => {
					const h = collectAllElements(appT02.content).find(e => e.tagName === "h4" && e.textContent === "Attempt output")!;
					return collectAllElements(appT02.content).find(e => e.tagName === "section" && e.children.some(c => c.children.includes(h)))!;
				};

				await clickNode("rich");
				const outSection = getOutputSection();
				const detailsEls = collectAllElements(outSection).filter(e => e.tagName === "details");
				assert.equal(detailsEls.length, 3, "Expected attempt, structured outputs, and artifacts disclosures");
				assert.equal(detailsEls[0]!.hasAttribute("open"), true, "Latest attempt disclosure must be open");
				assert.equal(detailsEls[1]!.hasAttribute("open"), false, "Structured outputs disclosure must start collapsed");
				assert.equal(detailsEls[2]!.hasAttribute("open"), false, "Artifacts disclosure must start collapsed");
				assert.ok(collectAllElements(detailsEls[0]!.children[0] as FakeElement).some(e => e.tagName === "h5"), "Attempt summary must contain real h5 heading");
				assert.ok(collectAllElements(detailsEls[1]!.children[0] as FakeElement).some(e => e.tagName === "h6"), "Structured outputs summary must contain real h6 heading");
				assert.ok(collectAllElements(detailsEls[2]!.children[0] as FakeElement).some(e => e.tagName === "h6"), "Artifacts summary must contain real h6 heading");
				assert.match(outSection.textContent, /… \[truncated, 19 items omitted\]/);
				assert.match(outSection.textContent, /… \[truncated, 20 items omitted\]/);
				assert.match(outSection.textContent, /"verdict": "ok"/);
				assert.match(outSection.textContent, /Bundle description without path/);
				assert.ok(collectTextNodes(outSection).some(t => t.includes("Lint <script>xss</script>")));
				assert.ok(collectTextNodes(outSection).some(t => t.includes("Warn <img src=x>")));
				appT02.assertSafeDom();

				// 2. Command node: exit code, signal, stdout & stderr side by side
				await clickNode("cmd");
				const cmdOutSection = getOutputSection();
				assert.match(cmdOutSection.textContent, /Command output/);
				assert.match(cmdOutSection.textContent, /Exit code2/);
				assert.match(cmdOutSection.textContent, /SignalSIGTERM/);
				assert.match(cmdOutSection.textContent, /stdout line 1\nstdout line 2/);
				assert.ok(collectTextNodes(cmdOutSection).some(t => t.includes("stderr line 1\n<script>bad()</script>")));
				appT02.assertSafeDom();

				// 3. Blocked disposition node: disposition_reason and causes
				await clickNode("blk");
				const blkOutSection = getOutputSection();
				assert.match(blkOutSection.textContent, /— Not applicable/);
				assert.match(blkOutSection.textContent, /Disposition reason/);
				assert.match(blkOutSection.textContent, /Upstream node cmd failed/);
				assert.match(blkOutSection.textContent, /Exit code 2/);
				appT02.assertSafeDom();

				// 4. Error node: recorded error message
				await clickNode("err");
				const errOutSection = getOutputSection();
				assert.match(errOutSection.textContent, /! Evidence unavailable/);
				assert.match(errOutSection.textContent, /Recorded error/);
				assert.ok(collectTextNodes(errOutSection).some(t => t.includes("Worker crashed <err>")));
				appT02.assertSafeDom();
			}

			// L. Ticket 03 Attempt output multi-attempt UI: newest first, only newest open, others collapsed & one click away, real headings, tone classes, omitted marker, mixed finished/unfinished/damaged attempts
			{
				const snap = {
					factory_id: "fac_t03",
					current_version: "v1",
					checked_at: "2026-11-28T12:00:00Z",
					state: "running",
					reason: "Running",
					run: { run_id: "run-t03", attempt_id: "att-t03", bound_version: "v1" },
					outcome: "incomplete",
					settlement: "unsettled",
					capacity_release: "held",
					graph: {
						evidence: "available",
						bound_version: "v1",
						topology: "graph",
						nodes: [
							{ id: "loop_node", kind: "agent", status: "succeeded", status_text: "Succeeded", current_attempt: { attempt_id: "l.3", attempt_number: 3, max_attempts: 5, instance_id: "i-l", process_state: "exited", resource_state: "closed" } },
							{ id: "single_node", kind: "agent", status: "succeeded", status_text: "Succeeded", current_attempt: { attempt_id: "s.1", attempt_number: 1, max_attempts: 1, instance_id: "i-s", process_state: "exited", resource_state: "closed" } },
							{ id: "mixed_node", kind: "agent", status: "running", status_text: "Running", current_attempt: { attempt_id: "m.3", attempt_number: 3, max_attempts: 4, instance_id: "i-m", process_state: "alive", resource_state: "released" } },
						],
						edges: [],
					},
				};

				const appT03 = bootApp("?factory=fac_t03&view=live", async (url) => {
					if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_t03", name: "FacT03", current_version: "v1", management: "managed" }]);
					if (url === "/api/factories/fac_t03/live") return jsonResp(200, snap);
					if (url === "/api/factories/fac_t03/output?node=loop_node") {
						return jsonResp(200, {
							factory_id: "fac_t03",
							node_id: "loop_node",
							evidence: "available",
							total_attempts: 22,
							omitted_attempts: 2,
							omitted_marker: "… [truncated, 2 attempts omitted]",
							attempts: [
								{
									attempt_id: "l.22",
									attempt_number: 22,
									max_attempts: 25,
									status: "succeeded",
									status_text: "Succeeded",
									evidence: "available",
									summary: "Attempt 22 newest summary",
									detail: "Attempt 22 detail",
								},
								{
									attempt_id: "l.21",
									attempt_number: 21,
									max_attempts: 25,
									status: "partial",
									status_text: "Partial",
									evidence: "available",
									summary: "Attempt 21 older summary",
									detail: "Attempt 21 detail",
								},
								{
									attempt_id: "l.20",
									attempt_number: 20,
									max_attempts: 25,
									status: "failed",
									status_text: "Failed",
									evidence: "available",
									summary: "Attempt 20 oldest shown",
									detail: "Attempt 20 detail",
								},
							],
						});
					}
					if (url === "/api/factories/fac_t03/output?node=single_node") {
						return jsonResp(200, {
							factory_id: "fac_t03",
							node_id: "single_node",
							evidence: "available",
							total_attempts: 1,
							omitted_attempts: 0,
							attempts: [
								{
									attempt_id: "s.1",
									attempt_number: 1,
									max_attempts: 1,
									status: "succeeded",
									status_text: "Succeeded",
									evidence: "available",
									summary: "Single attempt summary",
									detail: "Single attempt detail",
								},
							],
						});
					}
					if (url === "/api/factories/fac_t03/output?node=mixed_node") {
						return jsonResp(200, {
							factory_id: "fac_t03",
							node_id: "mixed_node",
							evidence: "not applicable",
							total_attempts: 3,
							omitted_attempts: 0,
							attempts: [
								{
									attempt_id: "m.3",
									attempt_number: 3,
									max_attempts: 4,
									status: "running",
									status_text: "Running",
									evidence: "not applicable",
									absence: "not applicable",
									explanation: "Attempt output is recorded when the attempt finishes.",
								},
								{
									attempt_id: { absence: "evidence unavailable", explanation: "Attempt identity could not be verified." },
									attempt_number: 1,
									max_attempts: 4,
									status: "needs_attention",
									status_text: "Uncertain",
									evidence: "unavailable",
									absence: "evidence unavailable",
									explanation: "Attempt 2 result record is damaged.",
								},
								{
									attempt_id: "m.1",
									attempt_number: 1,
									max_attempts: 4,
									status: "succeeded",
									status_text: "Succeeded",
									evidence: "available",
									summary: "Attempt 1 survived",
									detail: "Attempt 1 detail survived",
								},
							],
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();

				const clickNode = async (id: string) => {
					const g = collectAllElements(appT03.content).find(e => e.getAttribute("data-node-id") === id)!;
					for (const fn of g.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
				};
				const getOutputSection = () => {
					const h = collectAllElements(appT03.content).find(e => e.tagName === "h4" && e.textContent === "Attempt output")!;
					return collectAllElements(appT03.content).find(e => e.tagName === "section" && e.children.some(c => c.children.includes(h)))!;
				};

				// 1. Multi-attempt node: 3 disclosures newest first, only newest open, older collapsed & keyboard-reachable summaries with h5 + tone chips + omitted marker
				await clickNode("loop_node");
				const loopSec = getOutputSection();
				const loopDetails = collectAllElements(loopSec).filter(e => e.tagName === "details");
				assert.equal(loopDetails.length, 3);
				assert.equal(loopDetails[0]!.hasAttribute("open"), true, "Newest attempt disclosure must be open");
				assert.equal(loopDetails[1]!.hasAttribute("open"), false, "Older attempt 21 must start collapsed");
				assert.equal(loopDetails[2]!.hasAttribute("open"), false, "Older attempt 20 must start collapsed");
				const headings = loopDetails.map(d => d.children[0] as FakeElement);
				assert.match(headings[0]!.textContent, /Attempt 22 of 25.*✓ Succeeded/);
				assert.match(headings[1]!.textContent, /Attempt 21 of 25.*◐ Partial/);
				assert.match(headings[2]!.textContent, /Attempt 20 of 25.*✕ Failed/);
				for (const summaryEl of headings) {
					assert.equal(summaryEl.tagName, "summary");
					assert.ok(collectAllElements(summaryEl).some(e => e.tagName === "h5"));
					const chip = collectAllElements(summaryEl).find(e => e.classList.contains("chip"))!;
					assert.ok(chip);
					assert.ok(chip.classList.contains("lighten-5") || chip.classList.contains("lighten-4") || chip.classList.contains("lighten-3"));
				}
				assert.match(loopSec.textContent, /… \[truncated, 2 attempts omitted\]/);
				// Older attempt body is present inside its collapsed <details> (one click away)
				assert.match(loopDetails[1]!.textContent, /Attempt 21 older summary/);
				loopDetails[1]!.setAttribute("open", "");
				assert.equal(loopDetails[1]!.hasAttribute("open"), true);
				appT03.assertSafeDom();

				// 2. Single-attempt node: 1 disclosure, open
				await clickNode("single_node");
				const singleSec = getOutputSection();
				const singleDetails = collectAllElements(singleSec).filter(e => e.tagName === "details");
				assert.equal(singleDetails.length, 1);
				assert.equal(singleDetails[0]!.hasAttribute("open"), true);
				assert.equal(singleSec.textContent.includes("attempts omitted"), false);
				appT03.assertSafeDom();

				// 3. Mixed finished / unfinished / damaged attempts: each renders its own independent typed state
				await clickNode("mixed_node");
				const mixedSec = getOutputSection();
				const mixedDetails = collectAllElements(mixedSec).filter(e => e.tagName === "details");
				assert.equal(mixedDetails.length, 3);
				assert.equal(mixedDetails[0]!.hasAttribute("open"), true);
				assert.equal(mixedDetails[1]!.hasAttribute("open"), false);
				assert.equal(mixedDetails[2]!.hasAttribute("open"), false);
				assert.match(mixedDetails[0]!.textContent, /— Not applicable/);
				assert.match(mixedDetails[0]!.textContent, /Attempt output is recorded when the attempt finishes\./);
				assert.match(mixedDetails[1]!.textContent, /! Evidence unavailable/);
				assert.match(mixedDetails[1]!.textContent, /Attempt 2 result record is damaged\./);
				assert.match(mixedDetails[2]!.textContent, /Attempt 1 survived/);
				appT03.assertSafeDom();

				// 4. Unverified attempt number & total_attempts typed absence + omitted_characters rendering (B2/B3)
				const appUnv = bootApp("?factory=fac_t03&view=live", async (url) => {
					if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_t03", name: "FacT03", current_version: "v1", management: "managed" }]);
					if (url === "/api/factories/fac_t03/live") return jsonResp(200, snap);
					if (url === "/api/factories/fac_t03/output?node=mixed_node") {
						return jsonResp(200, {
							factory_id: "fac_t03",
							node_id: "mixed_node",
							evidence: "unavailable",
							total_attempts: { absence: "evidence unavailable", explanation: "Total attempt count could not be verified because node-level context failed." },
							omitted_attempts: 0,
							attempts: [
								{
									attempt_id: { absence: "evidence unavailable", explanation: "Attempt identity could not be verified." },
									attempt_number: { absence: "evidence unavailable", explanation: "Attempt number unverified; node-level context could not be verified." },
									max_attempts: 4,
									status: "needs_attention",
									status_text: "Uncertain",
									evidence: "unavailable",
									absence: "evidence unavailable",
									explanation: "Node evidence is missing, damaged or contradictory.",
								},
								{
									attempt_id: "m.2",
									attempt_number: 2,
									max_attempts: 4,
									status: "succeeded",
									status_text: "Succeeded",
									evidence: "available",
									summary: "Attempt 2 survived",
									omitted_characters: 500,
								},
							],
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();
				const gMixedUnv = collectAllElements(appUnv.content).find(e => e.getAttribute("data-node-id") === "mixed_node")!;
				for (const fn of gMixedUnv.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();
				const unvH = collectAllElements(appUnv.content).find(e => e.tagName === "h4" && e.textContent === "Attempt output")!;
				const unvSec = collectAllElements(appUnv.content).find(e => e.tagName === "section" && e.children.some(c => c.children.includes(unvH)))!;
				const unvDetails = collectAllElements(unvSec).filter(e => e.tagName === "details");
				assert.equal(unvDetails.length, 2);
				assert.match(unvDetails[0]!.children[0]!.textContent, /Attempt \(number unverified\) of 4/);
				assert.match(unvDetails[0]!.textContent, /Attempt number unverified/);
				assert.match(unvDetails[1]!.children[0]!.textContent, /Attempt 2 of 4/);
				assert.match(unvDetails[1]!.textContent, /… \[truncated, 500 characters omitted\]/);
				assert.match(unvSec.textContent, /Total attempt count could not be verified/);
				appUnv.assertSafeDom();
			}

			// M. Ticket 04 Live output refetch, abort & stale discard across poll-triggered refetch, in-section error, open-disclosure & focus preservation (Scenario 5)
			{
				const makeLive = (checkedAt: string, nodeA: Record<string, unknown>, extraNodes: Array<Record<string, unknown>> = []) => ({
					factory_id: "fac_t04",
					current_version: "v1",
					checked_at: checkedAt,
					state: "running",
					reason: "Running",
					run: { run_id: "run-t04", attempt_id: "att-t04", bound_version: "v1" },
					outcome: "incomplete",
					settlement: "unsettled",
					capacity_release: "held",
					graph: {
						evidence: "available",
						bound_version: "v1",
						topology: "graph",
						nodes: [
							nodeA,
							{ id: "node_b", kind: "agent", status: "waiting", status_text: "Waiting", current_attempt: { attempt_id: "b.1", attempt_number: 1, max_attempts: 3, instance_id: "i-b", process_state: "alive", resource_state: "open" } },
							...extraNodes,
						],
						edges: [],
					},
				});

				// M1 + M4: Node finishing during poll, plain poll issues 0 requests, new attempt opens by default while user's open/closed choices & focus survive
				let liveStep = 0;
				let outACalls = 0;
				const appM1 = bootApp("?factory=fac_t04&view=live", async (url) => {
					if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_t04", name: "FacT04", current_version: "v1", management: "managed" }]);
					if (url === "/api/factories/fac_t04/live") {
						liveStep++;
						// 1: initial running att 1; 2: plain running poll; 3: att 1 succeeded; 4: plain succeeded poll; 5: att 2 running; 6: att 2 succeeded
						if (liveStep <= 2) {
							return jsonResp(200, makeLive(`2026-11-28T12:00:0${liveStep}Z`, {
								id: "node_a",
								kind: "agent",
								status: "running",
								status_text: "Running",
								current_attempt: { attempt_id: "a.1", attempt_number: 1, max_attempts: 3, instance_id: "i-a", process_state: "alive", resource_state: "open", updated_at: `2026-11-28T12:00:0${liveStep}Z` },
							}));
						}
						if (liveStep <= 4) {
							return jsonResp(200, makeLive(`2026-11-28T12:00:0${liveStep}Z`, {
								id: "node_a",
								kind: "agent",
								status: "succeeded",
								status_text: "Succeeded",
								current_attempt: { attempt_id: "a.1", attempt_number: 1, max_attempts: 3, instance_id: "i-a", process_state: "exited", resource_state: "closed", result_status: "success", completed_at: "2026-11-28T12:00:03Z" },
							}));
						}
						if (liveStep === 5) {
							return jsonResp(200, makeLive("2026-11-28T12:00:05Z", {
								id: "node_a",
								kind: "agent",
								status: "running",
								status_text: "Running",
								current_attempt: { attempt_id: "a.2", attempt_number: 2, max_attempts: 3, instance_id: "i-a", process_state: "alive", resource_state: "open" },
							}));
						}
						return jsonResp(200, makeLive("2026-11-28T12:00:06Z", {
							id: "node_a",
							kind: "agent",
							status: "succeeded",
							status_text: "Succeeded",
							current_attempt: { attempt_id: "a.2", attempt_number: 2, max_attempts: 3, instance_id: "i-a", process_state: "exited", resource_state: "closed", result_status: "success", completed_at: "2026-11-28T12:00:06Z" },
						}));
					}
					if (url === "/api/factories/fac_t04/output?node=node_a") {
						outACalls++;
						if (liveStep <= 2) {
							return jsonResp(200, {
								factory_id: "fac_t04",
								node_id: "node_a",
								evidence: "not applicable",
								total_attempts: 1,
								omitted_attempts: 0,
								attempts: [{
									attempt_id: "a.1",
									attempt_number: 1,
									max_attempts: 3,
									status: "running",
									status_text: "Running",
									evidence: "not applicable",
									absence: "not applicable",
									explanation: "Attempt output is recorded when the attempt finishes.",
								}],
							});
						}
						const att1Finished = {
							attempt_id: "a.1",
							attempt_number: 1,
							max_attempts: 3,
							status: "succeeded",
							status_text: "Succeeded",
							evidence: "available",
							summary: "Attempt 1 completed summary",
							detail: "Attempt 1 completed detail",
							outputs_text: "{\n  \"attempt\": 1\n}",
							artifacts: {
								items: [{ type: "file", action: "created", description: "Artifact 1 desc" }],
								total_count: 1,
								omitted_count: 0,
							},
						};
						if (liveStep <= 4) {
							return jsonResp(200, {
								factory_id: "fac_t04",
								node_id: "node_a",
								evidence: "available",
								total_attempts: 1,
								omitted_attempts: 0,
								attempts: [att1Finished],
							});
						}
						if (liveStep === 5) {
							return jsonResp(200, {
								factory_id: "fac_t04",
								node_id: "node_a",
								evidence: "not applicable",
								total_attempts: 2,
								omitted_attempts: 0,
								attempts: [
									{
										attempt_id: "a.2",
										attempt_number: 2,
										max_attempts: 3,
										status: "running",
										status_text: "Running",
										evidence: "not applicable",
										absence: "not applicable",
										explanation: "Attempt output is recorded when the attempt finishes.",
									},
									att1Finished,
								],
							});
						}
						return jsonResp(200, {
							factory_id: "fac_t04",
							node_id: "node_a",
							evidence: "available",
							total_attempts: 2,
							omitted_attempts: 0,
							attempts: [
								{
									attempt_id: "a.2",
									attempt_number: 2,
									max_attempts: 3,
									status: "succeeded",
									status_text: "Succeeded",
									evidence: "available",
									summary: "Attempt 2 completed summary",
									detail: "Attempt 2 completed detail",
								},
								att1Finished,
							],
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();

				// Zoom + select node_a + focus Attempt 1 <summary>
				const svgM1 = collectAllElements(appM1.content).find(e => e.tagName === "svg")!;
				for (const fn of svgM1.listeners.get("wheel") ?? []) fn({ deltaY: -100, preventDefault() {} });
				const zoomedM1 = svgM1.getAttribute("viewBox");
				const gNodeAM1 = collectAllElements(svgM1).find(e => e.getAttribute("data-node-id") === "node_a")!;
				for (const fn of gNodeAM1.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();
				assert.equal(outACalls, 1);
				assert.match(appM1.content.textContent, /Attempt output is recorded when the attempt finishes\./);

				const att1Details0 = collectAllElements(appM1.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 1 of 3"))!;
				const att1Summary0 = att1Details0.children[0] as FakeElement;
				att1Summary0.focus();
				assert.equal(appM1.fakeDocument.activeElement, att1Summary0);

				// Poll 2 (plain poll while running) -> NO output refetch; focus & pan/zoom & selection preserved
				await appM1.advanceTimers(2000);
				assert.equal(outACalls, 1, "Plain poll with no status/attempt change must not refetch /output");
				assert.equal(svgM1.getAttribute("viewBox"), zoomedM1);
				assert.equal(gNodeAM1.getAttribute("aria-pressed"), "true");
				assert.equal(appM1.fakeDocument.activeElement, att1Summary0);

				// Poll 3 (att 1 transitions running -> succeeded) -> triggers refetch without page reload; focus & open disclosure survive
				await appM1.advanceTimers(2000);
				assert.equal(outACalls, 2, "Finishing attempt during poll must refetch /output");
				assert.match(appM1.content.textContent, /Attempt 1 completed summary/);
				assert.match(appM1.content.textContent, /Attempt 1 completed detail/);
				const att1DetailsAfterFinish = collectAllElements(appM1.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 1 of 3"))!;
				assert.equal(att1DetailsAfterFinish, att1Details0, "Same attempt disclosure must patch in place");
				assert.equal(att1DetailsAfterFinish.hasAttribute("open"), true);
				assert.equal(att1DetailsAfterFinish.open, true);
				assert.equal(appM1.fakeDocument.activeElement, att1Summary0, "Keyboard focus on Attempt 1 summary must survive output refetch");
				assert.equal(svgM1.getAttribute("viewBox"), zoomedM1);

				// User opens Structured outputs, leaves Artifacts closed, and moves focus to Structured outputs <summary>
				const outSubDetails = collectAllElements(att1DetailsAfterFinish).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Structured outputs"))!;
				const artSubDetails = collectAllElements(att1DetailsAfterFinish).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Artifacts"))!;
				assert.equal(outSubDetails.open, false);
				assert.equal(artSubDetails.open, false);
				outSubDetails.setAttribute("open", "");
				const outSubSummary = outSubDetails.children[0] as FakeElement;
				outSubSummary.focus();

				// Poll 4 (same finished att 1) -> NO output refetch; open Structured outputs & focus survive
				await appM1.advanceTimers(2000);
				assert.equal(outACalls, 2, "Unchanged finished poll must not refetch /output");
				assert.equal(outSubDetails.open, true);
				assert.equal(artSubDetails.open, false);
				assert.equal(appM1.fakeDocument.activeElement, outSubSummary);

				// Poll 5 (new attempt 2 arrives as running) -> refetches /output; NEW newest attempt 2 opens by default, previously newest Attempt 1 (untouched) returns to default collapsed while Structured outputs explicit open & focus survive!
				await appM1.advanceTimers(2000);
				assert.equal(outACalls, 3, "New attempt appearing during poll must refetch /output");
				const att2Details = collectAllElements(appM1.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 2 of 3"))!;
				const att1DetailsAfterAtt2 = collectAllElements(appM1.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 1 of 3"))!;
				assert.equal(att2Details.open, true, "New newest attempt must open by default");
				assert.equal(att2Details.hasAttribute("open"), true);
				assert.equal(att1DetailsAfterAtt2, att1Details0);
				assert.equal(att1DetailsAfterAtt2.open, false, "Previously newest attempt must return to default collapsed unless user toggled it");
				assert.equal(outSubDetails.open, true, "Structured outputs open state must survive new attempt refetch");
				assert.equal(artSubDetails.open, false, "Artifacts collapsed state must survive new attempt refetch");
				assert.equal(appM1.fakeDocument.activeElement, outSubSummary, "Focus on Structured outputs summary must survive new attempt refetch");
				assert.equal(svgM1.getAttribute("viewBox"), zoomedM1);
				assert.equal(gNodeAM1.getAttribute("aria-pressed"), "true");

				// Now user explicitly opens Attempt 1, explicitly closes Attempt 2 (newest), and focuses Attempt 2's <summary> before Poll 6 (Attempt 2 finishes!)
				att1DetailsAfterAtt2.open = true;
				att2Details.open = false;
				const att2Summary = att2Details.children[0] as FakeElement;
				att2Summary.focus();

				// Poll 6 (Attempt 2 running -> succeeded) -> refetches /output; user's closed choice on Attempt 2 and open choice on Attempt 1 BOTH win, and focus stays on Attempt 2 <summary>!
				await appM1.advanceTimers(2000);
				assert.equal(outACalls, 4);
				assert.match(appM1.content.textContent, /Attempt 2 completed summary/);
				assert.equal(att2Details.open, false, "User closing newest attempt must win over default-open after refetch");
				assert.equal(att2Details.hasAttribute("open"), false);
				assert.equal(att1DetailsAfterAtt2.open, true, "User explicitly opening older attempt must survive refetch");
				assert.equal(outSubDetails.open, true);
				assert.equal(appM1.fakeDocument.activeElement, att2Summary, "Keyboard focus must stay on Attempt 2 summary across refetch");
				appM1.assertSafeDom();

				// M2: Abort & stale-response discard including stale response arriving after poll-triggered refetch, node switch, factory switch, and mismatch
				let m2LiveStep = 0;
				let outCallIdx = 0;
				const outSignals: AbortSignal[] = [];
				const outResolvers: Array<(r: any) => void> = [];
				const appM2 = bootApp("?factory=fac_1&view=live", async (url, init) => {
					if (url === "/api/factories") {
						return jsonResp(200, [
							{ factory_id: "fac_1", name: "F1", current_version: "v1", management: "managed" },
							{ factory_id: "fac_2", name: "F2", current_version: "v1", management: "managed" },
						]);
					}
					if (url === "/api/factories/fac_1/live") {
						m2LiveStep++;
						const isFinished = m2LiveStep >= 2;
						return jsonResp(200, {
							factory_id: "fac_1",
							current_version: "v1",
							checked_at: `2026-11-28T12:00:0${m2LiveStep}Z`,
							state: "running",
							reason: "Running",
							run: { run_id: "r-m2", attempt_id: "a-m2", bound_version: "v1" },
							outcome: "incomplete",
							settlement: "unsettled",
							capacity_release: "held",
							graph: {
								evidence: "available",
								bound_version: "v1",
								topology: "graph",
								nodes: [
									{
										id: "node_a",
										kind: "agent",
										status: isFinished ? "succeeded" : "running",
										status_text: isFinished ? "Succeeded" : "Running",
										current_attempt: {
											attempt_id: m2LiveStep >= 3 ? "a.2" : "a.1",
											attempt_number: m2LiveStep >= 3 ? 2 : 1,
											max_attempts: 3,
											instance_id: "i-a",
											process_state: isFinished ? "exited" : "alive",
											resource_state: isFinished ? "closed" : "open",
											...(isFinished ? { result_status: "success", completed_at: "2026-11-28T12:00:02Z" } : {}),
										},
									},
									{
										id: "node_b",
										kind: "agent",
										status: "succeeded",
										status_text: "Succeeded",
										current_attempt: { attempt_id: "b.1", attempt_number: 1, max_attempts: 1, instance_id: "i-b", process_state: "exited", resource_state: "closed" },
									},
								],
								edges: [],
							},
						});
					}
					if (url === "/api/factories/fac_2/live") {
						return jsonResp(200, {
							factory_id: "fac_2",
							current_version: "v1",
							checked_at: "2026-11-28T12:00:10Z",
							state: "idle",
							reason: "Fac2 idle",
							run: null,
							graph: { evidence: "not applicable", absence: "no records", explanation: "Idle" },
						});
					}
					if (url.startsWith("/api/factories/fac_1/output")) {
						const idx = outCallIdx++;
						if (init?.signal) outSignals[idx] = init.signal;
						return new Promise(res => { outResolvers[idx] = res; });
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();

				// 1. Select node_a (call 0 in-flight), then poll finishes node_a -> aborts call 0 & starts call 1
				const gM2A = collectAllElements(appM2.content).find(e => e.getAttribute("data-node-id") === "node_a")!;
				for (const fn of gM2A.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();
				assert.equal(outCallIdx, 1);
				assert.equal(outSignals[0]!.aborted, false);

				await appM2.advanceTimers(2000);
				assert.equal(outCallIdx, 2, "Poll transition must start refetch even while initial request was in flight");
				assert.equal(outSignals[0]!.aborted, true, "Initial output request must be aborted when poll-triggered refetch starts");
				assert.equal(outSignals[1]!.aborted, false);

				// Stale call 0 resolves late ignoring abort -> must be discarded!
				outResolvers[0]!(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_a",
					evidence: "available",
					attempts: [{ attempt_id: "a.1", attempt_number: 1, max_attempts: 3, status: "succeeded", status_text: "Succeeded", evidence: "available", summary: "STALE_PRE_POLL_LEAK" }],
				}));
				await flushMicrotasks();
				assert.equal(appM2.content.textContent.includes("STALE_PRE_POLL_LEAK"), false, "Response arriving after poll-triggered refetch started must be discarded");

				// Resolve call 1 -> renders fresh finished output
				outResolvers[1]!(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_a",
					evidence: "available",
					attempts: [{ attempt_id: "a.1", attempt_number: 1, max_attempts: 3, status: "succeeded", status_text: "Succeeded", evidence: "available", summary: "Fresh poll output" }],
				}));
				await flushMicrotasks();
				assert.match(appM2.content.textContent, /Fresh poll output/);

				// 2. Poll 3 introduces attempt 2 -> starts poll-triggered refetch (call 2); switch to node_b before it resolves -> aborts call 2 & discards late response
				await appM2.advanceTimers(2000);
				assert.equal(outCallIdx, 3);
				assert.equal(outSignals[2]!.aborted, false);
				const gM2B = collectAllElements(appM2.content).find(e => e.getAttribute("data-node-id") === "node_b")!;
				for (const fn of gM2B.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();
				assert.equal(outSignals[2]!.aborted, true, "Switching node must abort in-flight poll-triggered refetch");
				assert.equal(outCallIdx, 4);
				outResolvers[2]!(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_a",
					evidence: "available",
					attempts: [{ attempt_id: "a.2", attempt_number: 2, max_attempts: 3, status: "succeeded", status_text: "Succeeded", evidence: "available", summary: "STALE_AFTER_NODE_SWITCH" }],
				}));
				outResolvers[3]!(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_b",
					evidence: "available",
					attempts: [{ attempt_id: "b.1", attempt_number: 1, max_attempts: 1, status: "succeeded", status_text: "Succeeded", evidence: "available", summary: "Node B clean output" }],
				}));
				await flushMicrotasks();
				assert.equal(appM2.content.textContent.includes("STALE_AFTER_NODE_SWITCH"), false);
				assert.match(appM2.content.textContent, /Node B clean output/);

				// 3. Switch back to node_a (call 4 in-flight), then switch factory to fac_2 -> aborts call 4 & discards late response
				for (const fn of gM2A.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();
				assert.equal(outCallIdx, 5);
				assert.equal(outSignals[4]!.aborted, false);
				const fac2LinkM2 = collectAllElements(appM2.sidebar).find(e => e.tagName === "a" && (e.getAttribute("href") ?? "").includes("fac_2"))!;
				for (const fn of fac2LinkM2.listeners.get("click") ?? []) fn({ button: 0, preventDefault() {} });
				await flushMicrotasks();
				assert.equal(outSignals[4]!.aborted, true, "Switching factory must abort in-flight output request");
				outResolvers[4]!(jsonResp(200, {
					factory_id: "fac_1",
					node_id: "node_a",
					evidence: "available",
					attempts: [{ attempt_id: "a.2", attempt_number: 2, max_attempts: 3, status: "succeeded", status_text: "Succeeded", evidence: "available", summary: "STALE_AFTER_FACTORY_SWITCH" }],
				}));
				await flushMicrotasks();
				assert.equal(appM2.content.textContent.includes("STALE_AFTER_FACTORY_SWITCH"), false);
				assert.match(appM2.content.textContent, /Fac2 idle/);

				// M3: Failed poll-triggered refetch shows error inside Attempt output section only, leaving graph and rest of panel untouched
				let m3LiveStep = 0;
				const appM3 = bootApp("?factory=fac_err&view=live", async (url) => {
					if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_err", name: "FacErr", current_version: "v1", management: "managed" }]);
					if (url === "/api/factories/fac_err/live") {
						m3LiveStep++;
						const finished = m3LiveStep >= 2;
						return jsonResp(200, {
							factory_id: "fac_err",
							current_version: "v1",
							checked_at: `2026-11-28T12:00:0${m3LiveStep}Z`,
							state: "running",
							reason: "Running",
							run: { run_id: "r-m3", attempt_id: "a-m3", bound_version: "v1" },
							outcome: "incomplete",
							settlement: "unsettled",
							capacity_release: "held",
							graph: {
								evidence: "available",
								bound_version: "v1",
								topology: "graph",
								nodes: [{
									id: "node_a",
									kind: "agent",
									status: finished ? "succeeded" : "running",
									status_text: finished ? "Succeeded" : "Running",
									current_attempt: {
										attempt_id: "a.1",
										attempt_number: 1,
										max_attempts: 2,
										instance_id: "i-a",
										process_state: finished ? "exited" : "alive",
										resource_state: finished ? "closed" : "open",
										started_at: "2026-11-28T12:00:00Z",
										...(finished ? { completed_at: "2026-11-28T12:00:02Z" } : {}),
									},
								}],
								edges: [],
							},
						});
					}
					if (url === "/api/factories/fac_err/output?node=node_a") {
						if (m3LiveStep === 1) {
							return jsonResp(200, {
								factory_id: "fac_err",
								node_id: "node_a",
								evidence: "not applicable",
								attempts: [{ attempt_id: "a.1", attempt_number: 1, max_attempts: 2, status: "running", status_text: "Running", evidence: "not applicable", absence: "not applicable", explanation: "Attempt output is recorded when the attempt finishes." }],
							});
						}
						return jsonResp(503, { error: "Evidence unavailable" });
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();
				const svgM3Before = collectAllElements(appM3.content).find(e => e.tagName === "svg")!;
				const gM3A = collectAllElements(svgM3Before).find(e => e.getAttribute("data-node-id") === "node_a")!;
				for (const fn of gM3A.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();
				const tsDetailsM3 = collectAllElements(appM3.content).find(e => e.tagName === "details" && e.textContent.includes("Optional attempt timestamps"))!;
				tsDetailsM3.open = true;

				// Poll 2 finishes node_a, refetch fails with 503 -> error appears inside Attempt output section only; SVG & timestamps stay intact!
				await appM3.advanceTimers(2000);
				const svgM3After = collectAllElements(appM3.content).find(e => e.tagName === "svg")!;
				assert.equal(svgM3After, svgM3Before, "Failed output refetch must not disturb the SVG graph");
				assert.equal(gM3A.getAttribute("aria-pressed"), "true");
				assert.equal(tsDetailsM3.open, true, "Failed output refetch must leave the rest of the detail panel untouched");
				assert.match(tsDetailsM3.textContent, /2026-11-28T12:00:02Z/);
				const m3OutHeading = collectAllElements(appM3.content).find(e => e.tagName === "h4" && e.textContent === "Attempt output")!;
				const m3OutSection = collectAllElements(appM3.content).find(e => e.tagName === "section" && e.children.some(c => c.children.includes(m3OutHeading)))!;
				assert.match(m3OutSection.textContent, /! HTTP 503/);
				const topLevelAlerts = collectAllElements(appM3.content).filter(e => e.getAttribute("role") === "alert");
				assert.equal(topLevelAlerts.length, 1);
				assert.ok(m3OutSection.contains(topLevelAlerts[0]!), "Failed refetch alert must stay inside Attempt output section only");
				appM3.assertSafeDom();

				// M4 (NB2 + NB3): Harness detaching a focused subtree resets activeElement to body; focusing a sub-disclosure summary
				// then refetching with changed content for that same attempt restores focus with { preventScroll: true }
				{
					// Direct harness checks for remove, replaceChildren, and insertBefore moving a focused node
					const docHost = appM3.fakeDocument;
					const holderA = docHost.createElement("div");
					const holderB = docHost.createElement("div");
					const focusChild = docHost.createElement("button");
					docHost.body.append(holderA, holderB);
					holderA.append(focusChild);
					focusChild.focus();
					assert.equal(docHost.activeElement, focusChild);
					holderB.insertBefore(focusChild, null);
					assert.equal(docHost.activeElement, docHost.body, "insertBefore moving a focused attached node must reset activeElement to body");
					focusChild.focus();
					holderB.replaceChildren();
					assert.equal(docHost.activeElement, docHost.body, "replaceChildren detaching focused child must reset activeElement to body");
					holderA.append(focusChild);
					focusChild.focus();
					holderA.remove();
					assert.equal(docHost.activeElement, docHost.body, "remove() detaching focused subtree must reset activeElement to body");
				}

				let m4LiveStep = 0;
				const appM4 = bootApp("?factory=fac_m4&view=live", async (url) => {
					if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_m4", name: "FacM4", current_version: "v1", management: "managed" }]);
					if (url === "/api/factories/fac_m4/live") {
						m4LiveStep++;
						const isFinal = m4LiveStep >= 2;
						return jsonResp(200, {
							factory_id: "fac_m4",
							current_version: "v1",
							checked_at: `2026-11-28T12:00:0${m4LiveStep}Z`,
							state: "running",
							reason: "Running",
							run: { run_id: "r-m4", attempt_id: "a-m4", bound_version: "v1" },
							outcome: "incomplete",
							settlement: "unsettled",
							capacity_release: "held",
							graph: {
								evidence: "available",
								bound_version: "v1",
								topology: "graph",
								nodes: [{
									id: "node_a",
									kind: "agent",
									status: isFinal ? "succeeded" : "partial",
									status_text: isFinal ? "Succeeded" : "Partial",
									current_attempt: {
										attempt_id: "a.1",
										attempt_number: 1,
										max_attempts: 2,
										instance_id: "i-a",
										process_state: "exited",
										resource_state: "closed",
										...(isFinal ? { result_status: "success", completed_at: "2026-11-28T12:00:02Z" } : {}),
									},
								}],
								edges: [],
							},
						});
					}
					if (url === "/api/factories/fac_m4/output?node=node_a") {
						if (m4LiveStep === 1) {
							return jsonResp(200, {
								factory_id: "fac_m4",
								node_id: "node_a",
								evidence: "available",
								attempts: [{
									attempt_id: "a.1",
									attempt_number: 1,
									max_attempts: 2,
									status: "partial",
									status_text: "Partial",
									evidence: "available",
									summary: "Initial partial summary",
									detail: "Initial partial detail",
									outputs_text: "{\"step\": 1}",
									artifacts: { items: [{ type: "file", action: "created", description: "Initial artifact" }], total_count: 1, omitted_count: 0 },
								}],
							});
						}
						return jsonResp(200, {
							factory_id: "fac_m4",
							node_id: "node_a",
							evidence: "available",
							attempts: [{
								attempt_id: "a.1",
								attempt_number: 1,
								max_attempts: 2,
								status: "succeeded",
								status_text: "Succeeded",
								evidence: "available",
								summary: "Updated final summary",
								detail: "Updated final detail",
								outputs_text: "{\"step\": 2}",
								artifacts: { items: [{ type: "file", action: "updated", description: "Updated artifact" }], total_count: 1, omitted_count: 0 },
							}],
						});
					}
					throw new Error(`Unexpected URL ${url}`);
				});
				await flushMicrotasks();
				const gM4A = collectAllElements(appM4.content).find(e => e.getAttribute("data-node-id") === "node_a")!;
				for (const fn of gM4A.listeners.get("click") ?? []) fn({});
				await flushMicrotasks();

				const outSubBefore = collectAllElements(appM4.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Structured outputs"))!;
				const outSubSummaryBefore = outSubBefore.children[0] as FakeElement;
				outSubSummaryBefore.focus();
				assert.equal(appM4.fakeDocument.activeElement, outSubSummaryBefore);
				const focusCallsBefore = outSubSummaryBefore.focusCalls.length;

				// Poll 2 changes attempt 1 content (partial -> succeeded with new summary/detail/outputs_text), forcing entry.body.replaceChildren!
				await appM4.advanceTimers(2000);
				assert.match(appM4.content.textContent, /Updated final summary/);
				assert.match(appM4.content.textContent, /"step": 2/);
				const outSubSummaryAfter = collectAllElements(appM4.content).find(e => e.getAttribute("data-focus-key") === outSubSummaryBefore.getAttribute("data-focus-key"))!;
				assert.ok(outSubSummaryAfter);
				assert.equal(appM4.fakeDocument.activeElement, outSubSummaryAfter, "Focus must be restored to Structured outputs summary after body re-render");
				assert.ok(outSubSummaryAfter.focusCalls.length > focusCallsBefore || outSubSummaryAfter !== outSubSummaryBefore, "Focus restoration must actively call focus() after body replaceChildren");
				assert.deepStrictEqual({ ...(outSubSummaryAfter.lastFocusOptions as Record<string, unknown>) }, { preventScroll: true }, "Focus restoration must pass { preventScroll: true }");
				appM4.assertSafeDom();

				// M5 (NB4): Last seen live node updates on every poll (not just at fetch time):
				// (a) Flap: running -> transient needs_attention (no completed_at) -> running -> needs_attention again must refetch on each entry into finished state and never storm
				{
					let m5Step = 0;
					let m5OutCalls = 0;
					const appM5Flap = bootApp("?factory=fac_m5&view=live", async (url) => {
						if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_m5", name: "FacM5", current_version: "v1", management: "managed" }]);
						if (url === "/api/factories/fac_m5/live") {
							m5Step++;
							// 1,2: running; 3: transient needs_attention (no completed_at/result_status); 4,5: running; 6,7,8: real needs_attention (no completed_at/result_status)
							const isNeedsAtt = m5Step === 3 || m5Step >= 6;
							return jsonResp(200, {
								factory_id: "fac_m5",
								current_version: "v1",
								checked_at: `2026-11-28T12:00:0${m5Step}Z`,
								state: "running",
								reason: "Running",
								run: { run_id: "r-m5", attempt_id: "a-m5", bound_version: "v1" },
								outcome: "incomplete",
								settlement: "unsettled",
								capacity_release: "held",
								graph: {
									evidence: "available",
									bound_version: "v1",
									topology: "graph",
									nodes: [{
										id: "node_a",
										kind: "agent",
										status: isNeedsAtt ? "needs_attention" : "running",
										status_text: isNeedsAtt ? "Uncertain" : "Running",
										current_attempt: {
											attempt_id: "a.1",
											attempt_number: 1,
											max_attempts: 2,
											instance_id: "i-a",
											process_state: isNeedsAtt ? "exited" : "alive",
											resource_state: isNeedsAtt ? "closed" : "open",
										},
									}],
									edges: [],
								},
							});
						}
						if (url === "/api/factories/fac_m5/output?node=node_a") {
							m5OutCalls++;
							if (m5Step <= 2 || m5Step === 4 || m5Step === 5) {
								return jsonResp(200, {
									factory_id: "fac_m5",
									node_id: "node_a",
									evidence: "not applicable",
									attempts: [{ attempt_id: "a.1", attempt_number: 1, max_attempts: 2, status: "running", status_text: "Running", evidence: "not applicable", absence: "not applicable", explanation: "Running" }],
								});
							}
							if (m5Step === 3) {
								return jsonResp(200, {
									factory_id: "fac_m5",
									node_id: "node_a",
									evidence: "unavailable",
									attempts: [{ attempt_id: "a.1", attempt_number: 1, max_attempts: 2, status: "needs_attention", status_text: "Uncertain", evidence: "unavailable", absence: "evidence unavailable", explanation: "Transient mid-write evidence unavailable" }],
								});
							}
							return jsonResp(200, {
								factory_id: "fac_m5",
								node_id: "node_a",
								evidence: "available",
								attempts: [{ attempt_id: "a.1", attempt_number: 1, max_attempts: 2, status: "needs_attention", status_text: "Uncertain", evidence: "available", summary: "Real needs_attention summary", detail: "Real needs_attention detail" }],
							});
						}
						throw new Error(`Unexpected URL ${url}`);
					});
					await flushMicrotasks();
					const gM5 = collectAllElements(appM5Flap.content).find(e => e.getAttribute("data-node-id") === "node_a")!;
					for (const fn of gM5.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
					assert.equal(m5OutCalls, 1);

					// Poll 2 (still running) -> 1
					await appM5Flap.advanceTimers(2000);
					assert.equal(m5OutCalls, 1);
					// Poll 3 (transient needs_attention) -> 2
					await appM5Flap.advanceTimers(2000);
					assert.equal(m5OutCalls, 2);
					assert.match(appM5Flap.content.textContent, /Transient mid-write evidence unavailable/);
					// Poll 4 & 5 (back to running) -> still 2 (no storm)
					await appM5Flap.advanceTimers(2000);
					assert.equal(m5OutCalls, 2);
					await appM5Flap.advanceTimers(2000);
					assert.equal(m5OutCalls, 2);
					// Poll 6 (real needs_attention without completed_at/result_status) -> MUST refetch (3)
					await appM5Flap.advanceTimers(2000);
					assert.equal(m5OutCalls, 3, "Real needs_attention after returning to running must refetch even without completed_at or result_status");
					assert.match(appM5Flap.content.textContent, /Real needs_attention summary/);
					// Poll 7 & 8 (unchanged needs_attention) -> still 3 (no storm)
					await appM5Flap.advanceTimers(2000);
					assert.equal(m5OutCalls, 3);
					await appM5Flap.advanceTimers(2000);
					assert.equal(m5OutCalls, 3);
					appM5Flap.assertSafeDom();
				}

				// (b) 12-poll review-loop sequence: running x3, parked waiting x3, att 2 running x3, att 2 succeeded x3 -> counts 1,1,1,2,2,2,3,3,3,4,4,4
				{
					let seqStep = 0;
					let seqOutCalls = 0;
					const appSeq = bootApp("?factory=fac_seq&view=live", async (url) => {
						if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_seq", name: "FacSeq", current_version: "v1", management: "managed" }]);
						if (url === "/api/factories/fac_seq/live") {
							seqStep++;
							let nodeA: Record<string, unknown>;
							if (seqStep <= 3) {
								nodeA = { id: "node_a", kind: "agent", status: "running", status_text: "Running", current_attempt: { attempt_id: "a.1", attempt_number: 1, max_attempts: 3, instance_id: "i-a", process_state: "alive", resource_state: "open" } };
							} else if (seqStep <= 6) {
								nodeA = { id: "node_a", kind: "agent", status: "waiting", status_text: "Waiting", parked: true, current_attempt: { attempt_id: "a.1", attempt_number: 1, max_attempts: 3, instance_id: "i-a", process_state: "exited", resource_state: "closed", result_status: "reject", completed_at: "2026-11-28T12:00:04Z", loop: { attempt: 1, max_attempts: 3, finalized: false, parked: true } } };
							} else if (seqStep <= 9) {
								nodeA = { id: "node_a", kind: "agent", status: "running", status_text: "Running", current_attempt: { attempt_id: "a.2", attempt_number: 2, max_attempts: 3, instance_id: "i-a", process_state: "alive", resource_state: "open", loop: { attempt: 2, max_attempts: 3, finalized: false, parked: false } } };
							} else {
								nodeA = { id: "node_a", kind: "agent", status: "succeeded", status_text: "Succeeded", current_attempt: { attempt_id: "a.2", attempt_number: 2, max_attempts: 3, instance_id: "i-a", process_state: "exited", resource_state: "closed", result_status: "success", completed_at: "2026-11-28T12:00:10Z", loop: { attempt: 2, max_attempts: 3, finalized: true, parked: false } } };
							}
							return jsonResp(200, {
								factory_id: "fac_seq",
								current_version: "v1",
								checked_at: `2026-11-28T12:00:${String(seqStep).padStart(2, "0")}Z`,
								state: "running",
								reason: "Running",
								run: { run_id: "r-seq", attempt_id: "a-seq", bound_version: "v1" },
								outcome: "incomplete",
								settlement: "unsettled",
								capacity_release: "held",
								graph: { evidence: "available", bound_version: "v1", topology: "graph", nodes: [nodeA], edges: [] },
							});
						}
						if (url === "/api/factories/fac_seq/output?node=node_a") {
							seqOutCalls++;
							return jsonResp(200, {
								factory_id: "fac_seq",
								node_id: "node_a",
								evidence: "available",
								attempts: [{ attempt_id: seqStep >= 7 ? "a.2" : "a.1", attempt_number: seqStep >= 7 ? 2 : 1, max_attempts: 3, status: seqStep >= 10 ? "succeeded" : "running", status_text: seqStep >= 10 ? "Succeeded" : "Running", evidence: "available", summary: `Step ${seqStep}` }],
							});
						}
						throw new Error(`Unexpected URL ${url}`);
					});
					await flushMicrotasks();
					const gSeq = collectAllElements(appSeq.content).find(e => e.getAttribute("data-node-id") === "node_a")!;
					for (const fn of gSeq.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
					const counts = [seqOutCalls];
					for (let i = 2; i <= 12; i++) {
						await appSeq.advanceTimers(2000);
						counts.push(seqOutCalls);
					}
					assert.deepStrictEqual(counts, [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4], "Review-loop sequence must issue exactly one refetch per transition");
					appSeq.assertSafeDom();
				}

				// M6 (NB1): Attempt output card has aria-live="off"; short polite announcement fires once per finished transition, never on selection or unchanged polls
				{
					let m6Step = 0;
					const appM6 = bootApp("?factory=fac_m6&view=live", async (url) => {
						if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_m6", name: "FacM6", current_version: "v1", management: "managed" }]);
						if (url === "/api/factories/fac_m6/live") {
							m6Step++;
							const att = m6Step === 1
								? { attempt_id: "a.1", attempt_number: 1, max_attempts: 2, instance_id: "i-a", process_state: "alive", resource_state: "open" }
								: (m6Step <= 3
									? { attempt_id: "a.1", attempt_number: 1, max_attempts: 2, instance_id: "i-a", process_state: "exited", resource_state: "closed", result_status: "success", completed_at: "2026-11-28T12:00:02Z" }
									: (m6Step === 4
										? { attempt_id: "a.2", attempt_number: 2, max_attempts: 2, instance_id: "i-a", process_state: "alive", resource_state: "open" }
										: { attempt_id: "a.2", attempt_number: 2, max_attempts: 2, instance_id: "i-a", process_state: "exited", resource_state: "closed", result_status: "success", completed_at: "2026-11-28T12:00:05Z" }));
							const nodeStatus = (m6Step === 1 || m6Step === 4) ? "running" : "succeeded";
							return jsonResp(200, {
								factory_id: "fac_m6",
								current_version: "v1",
								checked_at: `2026-11-28T12:00:0${m6Step}Z`,
								state: "running",
								reason: "Running",
								run: { run_id: "r-m6", attempt_id: "a-m6", bound_version: "v1" },
								outcome: "incomplete",
								settlement: "unsettled",
								capacity_release: "held",
								graph: {
									evidence: "available",
									bound_version: "v1",
									topology: "graph",
									nodes: [
										{ id: "node_a", kind: "agent", status: nodeStatus, status_text: nodeStatus === "running" ? "Running" : "Succeeded", current_attempt: att },
										{ id: "node_b", kind: "agent", status: "succeeded", status_text: "Succeeded", current_attempt: { attempt_id: "b.1", attempt_number: 1, max_attempts: 1, instance_id: "i-b", process_state: "exited", resource_state: "closed", result_status: "success", completed_at: "2026-11-28T12:00:00Z" } },
									],
									edges: [],
								},
							});
						}
						if (url === "/api/factories/fac_m6/output?node=node_b") {
							return jsonResp(200, {
								factory_id: "fac_m6",
								node_id: "node_b",
								evidence: "available",
								attempts: [{ attempt_id: "b.1", attempt_number: 1, max_attempts: 1, status: "succeeded", status_text: "Succeeded", evidence: "available", summary: "B done" }],
							});
						}
						if (url === "/api/factories/fac_m6/output?node=node_a") {
							const isRun = m6Step === 1 || m6Step === 4;
							const num = m6Step >= 4 ? 2 : 1;
							return jsonResp(200, {
								factory_id: "fac_m6",
								node_id: "node_a",
								evidence: isRun ? "not applicable" : "available",
								attempts: [{
									attempt_id: `a.${num}`,
									attempt_number: num,
									max_attempts: 2,
									status: isRun ? "running" : "succeeded",
									status_text: isRun ? "Running" : "Succeeded",
									evidence: isRun ? "not applicable" : "available",
									...(isRun ? { absence: "not applicable", explanation: "Running" } : { summary: `A.${num} summary` }),
								}],
							});
						}
						throw new Error(`Unexpected URL ${url}`);
					});
					await flushMicrotasks();

					const announcer = collectAllElements(appM6.content).find(e => e.classList.contains("sr-only") && e.getAttribute("aria-live") === "polite")!;
					assert.ok(announcer, "Expected polite sr-only announcer");

					// 1. Selecting an already-finished node (node_b) must NOT announce
					const gM6B = collectAllElements(appM6.content).find(e => e.getAttribute("data-node-id") === "node_b")!;
					for (const fn of gM6B.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
					assert.equal(announcer.textContent, "", "Selecting an already-finished node must not announce");

					// 2. Selecting running node_a must NOT announce; verify Attempt output card has aria-live="off"
					const gM6A = collectAllElements(appM6.content).find(e => e.getAttribute("data-node-id") === "node_a")!;
					for (const fn of gM6A.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
					assert.equal(announcer.textContent, "", "Selecting a running node must not announce");
					const outHeadingM6 = collectAllElements(appM6.content).find(e => e.tagName === "h4" && e.textContent === "Attempt output")!;
					const outSecM6 = collectAllElements(appM6.content).find(e => e.tagName === "section" && e.children.some(c => c.children.includes(outHeadingM6)))!;
					assert.equal(outSecM6.getAttribute("aria-live"), "off", "Attempt output card must have aria-live='off'");

					// 3. Poll 2 finishes attempt 1 -> short polite announcement
					await appM6.advanceTimers(2000);
					assert.equal(announcer.textContent, "Attempt 1 of node node_a finished: Succeeded");

					// 4. Unchanged Poll 3 -> must NOT re-announce
					announcer.textContent = "";
					await appM6.advanceTimers(2000);
					assert.equal(announcer.textContent, "", "Unchanged poll must not announce");

					// 5. Poll 4 starts attempt 2 (running) -> must NOT announce
					await appM6.advanceTimers(2000);
					assert.equal(announcer.textContent, "", "Starting a running attempt must not announce finished");

					// 6. Poll 5 finishes attempt 2 -> announces Attempt 2 finished
					await appM6.advanceTimers(2000);
					assert.equal(announcer.textContent, "Attempt 2 of node node_a finished: Succeeded");
					appM6.assertSafeDom();
				}

				// M7 (NB5): (a) Only explicit user toggles are remembered across 3 attempts; (b) Re-selecting same node (click or Enter/Space) retries after error
				{
					let m7Step = 0;
					let m7OutACalls = 0;
					let m7OutBCalls = 0;
					const appM7 = bootApp("?factory=fac_m7&view=live", async (url) => {
						if (url === "/api/factories") return jsonResp(200, [{ factory_id: "fac_m7", name: "FacM7", current_version: "v1", management: "managed" }]);
						if (url === "/api/factories/fac_m7/live") {
							m7Step++;
							const attNum = m7Step === 1 ? 1 : (m7Step === 2 ? 2 : 3);
							return jsonResp(200, {
								factory_id: "fac_m7",
								current_version: "v1",
								checked_at: `2026-11-28T12:00:0${m7Step}Z`,
								state: "running",
								reason: "Running",
								run: { run_id: "r-m7", attempt_id: "a-m7", bound_version: "v1" },
								outcome: "incomplete",
								settlement: "unsettled",
								capacity_release: "held",
								graph: {
									evidence: "available",
									bound_version: "v1",
									topology: "graph",
									nodes: [
										{
											id: "node_a",
											kind: "agent",
											status: "succeeded",
											status_text: "Succeeded",
											current_attempt: { attempt_id: `a.${attNum}`, attempt_number: attNum, max_attempts: 4, instance_id: "i-a", process_state: "exited", resource_state: "closed", result_status: "success", completed_at: `2026-11-28T12:00:0${m7Step}Z` },
										},
										{
											id: "node_b",
											kind: "agent",
											status: "failed",
											status_text: "Failed",
											current_attempt: { attempt_id: "b.1", attempt_number: 1, max_attempts: 1, instance_id: "i-b", process_state: "exited", resource_state: "closed", result_status: "fail", completed_at: "2026-11-28T12:00:01Z" },
										},
									],
									edges: [],
								},
							});
						}
						if (url === "/api/factories/fac_m7/output?node=node_a") {
							m7OutACalls++;
							if (m7OutACalls === 1) return jsonResp(503, { error: "Temporary 503" });
							const maxNum = m7Step === 1 ? 1 : (m7Step === 2 ? 2 : 3);
							const attempts = [];
							for (let n = maxNum; n >= 1; n--) {
								attempts.push({ attempt_id: `a.${n}`, attempt_number: n, max_attempts: 4, status: "succeeded", status_text: "Succeeded", evidence: "available", summary: `A.${n} summary` });
							}
							return jsonResp(200, { factory_id: "fac_m7", node_id: "node_a", evidence: "available", attempts });
						}
						if (url === "/api/factories/fac_m7/output?node=node_b") {
							m7OutBCalls++;
							if (m7OutBCalls === 1) throw new Error("ECONNRESET");
							if (m7OutBCalls === 2) return jsonResp(503, { error: "Still unavailable" });
							return jsonResp(200, {
								factory_id: "fac_m7",
								node_id: "node_b",
								evidence: "available",
								attempts: [{ attempt_id: "b.1", attempt_number: 1, max_attempts: 1, status: "failed", status_text: "Failed", evidence: "available", summary: "Recovered B summary" }],
							});
						}
						throw new Error(`Unexpected URL ${url}`);
					});
					await flushMicrotasks();

					// (b) Select node_a -> 503 error; plain poll does NOT retry; re-clicking node_a DOES retry and recovers; clicking again when healthy does NOT refetch
					const gM7A = collectAllElements(appM7.content).find(e => e.getAttribute("data-node-id") === "node_a")!;
					for (const fn of gM7A.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
					assert.equal(m7OutACalls, 1);
					assert.match(appM7.content.textContent, /! HTTP 503/);

					// Click node_a again while error is shown -> retries and succeeds with Attempt 1 open by default
					for (const fn of gM7A.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
					assert.equal(m7OutACalls, 2, "Re-clicking same node after output error must retry /output");
					assert.match(appM7.content.textContent, /A\.1 summary/);
					assert.equal(appM7.content.textContent.includes("! HTTP 503"), false);

					// Click node_a again when last result was NOT an error -> no refetch
					for (const fn of gM7A.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
					assert.equal(m7OutACalls, 2, "Re-clicking same node without prior error must not refetch");

					// (a) Attempt 1 is open by default; Poll 2 adds Attempt 2 -> Attempt 2 opens by default, Attempt 1 (untouched) collapses!
					const d1Before = collectAllElements(appM7.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 1 of 4"))!;
					assert.equal(d1Before.open, true);
					await appM7.advanceTimers(2000);
					const d2At2 = collectAllElements(appM7.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 2 of 4"))!;
					const d1At2 = collectAllElements(appM7.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 1 of 4"))!;
					assert.equal(d2At2.open, true, "Newest attempt 2 must open by default");
					assert.equal(d1At2.open, false, "Untouched attempt 1 must collapse when no longer newest");

					// User explicitly opens Attempt 1; leaves Attempt 2 untouched; Poll 3 adds Attempt 3 -> Attempt 3 open, Attempt 2 collapsed, Attempt 1 (user-opened) stays open!
					d1At2.open = true;
					await appM7.advanceTimers(2000);
					const d3At3 = collectAllElements(appM7.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 3 of 4"))!;
					const d2At3 = collectAllElements(appM7.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 2 of 4"))!;
					const d1At3 = collectAllElements(appM7.content).find(e => e.tagName === "details" && e.children[0]?.textContent.includes("Attempt 1 of 4"))!;
					assert.equal(d3At3.open, true, "Newest attempt 3 must open by default");
					assert.equal(d2At3.open, false, "Untouched attempt 2 must collapse when attempt 3 arrives");
					assert.equal(d1At3.open, true, "Explicitly opened attempt 1 must remain open when attempt 3 arrives");

					// (b) Keyboard retry (Enter and Space) on node_b after errors
					const gM7B = collectAllElements(appM7.content).find(e => e.getAttribute("data-node-id") === "node_b")!;
					for (const fn of gM7B.listeners.get("click") ?? []) fn({});
					await flushMicrotasks();
					assert.equal(m7OutBCalls, 1);
					assert.match(appM7.content.textContent, /ECONNRESET/);

					for (const fn of gM7B.listeners.get("keydown") ?? []) fn({ key: "Enter", preventDefault() {} });
					await flushMicrotasks();
					assert.equal(m7OutBCalls, 2, "Pressing Enter on same node after error must retry /output");
					assert.match(appM7.content.textContent, /! HTTP 503/);

					for (const fn of gM7B.listeners.get("keydown") ?? []) fn({ key: " ", preventDefault() {} });
					await flushMicrotasks();
					assert.equal(m7OutBCalls, 3, "Pressing Space on same node after error must retry /output");
					assert.match(appM7.content.textContent, /Recovered B summary/);
					appM7.assertSafeDom();
				}
			}
		},
	);
});
