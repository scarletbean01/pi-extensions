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
		["string-evaluated setTimeout/setInterval", /\b(?:setTimeout|setInterval)\s*\(\s*(?:['"`]|String\b)/],
		["inline event attribute", /\bon[a-z]+\s*=/i],
		["setInterval polling (belongs to ticket 09)", /\bsetInterval\b/],
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
			assert.match(html, /<nav\b[^>]*\baria-label="Factories"/);
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

			// Forbidden DOM/eval sinks and forbidden ticket-09 polling in safe.js and app.js
			for (const [scriptName, scriptBody] of [["safe.js", safeJs], ["app.js", js]] as const) {
				assertNoForbiddenSinks(scriptName, scriptBody);
			}
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

			// 6. Factory ID match check
			assert.equal(safe.matchesSelectedFactory({ factory_id: "fac_a" }, "fac_a"), true);
			assert.equal(safe.matchesSelectedFactory({ factory_id: "fac_b" }, "fac_a"), false);
			assert.equal(safe.matchesSelectedFactory({}, "fac_a"), false);
			assert.equal(safe.matchesSelectedFactory(null, "fac_a"), false);

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
		},
	);
});

test("sink scanner flags Function(), string timer eval, createContextualFragment, DOMParser/parseFromString, raw href/src, and bracket-concatenated sinks", () => {
	for (const [name, snippet] of [
		["X3 Function() without new", `const fn = Function("return 1");`],
		["X4 setTimeout string", `setTimeout("alert(1)", 10);`],
		["X4b setInterval string", `setInterval("alert(1)", 10);`],
		["X5 createContextualFragment", `document.createRange().createContextualFragment(x);`],
		["X6 DOMParser", `new DOMParser();`],
		["X6b parseFromString", `parser.parseFromString(x, "text/html");`],
		["X7 raw setAttribute href", `el.setAttribute("href", raw);`],
		["X7b raw setAttribute src", `el.setAttribute("src", raw);`],
		["X7c direct .href assignment", `el.href = raw;`],
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
				value = "";
				disabled = false;
				selected = false;
				inert = false;
				clientWidth = 800;
				classList: {
					add: (...cls: string[]) => void;
					remove: (...cls: string[]) => void;
					toggle: (cls: string, force?: boolean) => boolean;
					contains: (cls: string) => boolean;
				};
				dataset: Record<string, string>;
				constructor(tagName: string, namespaceURI: string | null = null) {
					super();
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
					this.children = v === "" ? [] : [new FakeTextNode(String(v))];
				}
				setAttribute(k: string, v: string) {
					this.attributes.set(k, String(v));
					if (k === "value") this.value = String(v);
				}
				getAttribute(k: string) { return this.attributes.has(k) ? this.attributes.get(k)! : null; }
				removeAttribute(k: string) { this.attributes.delete(k); }
				hasAttribute(k: string) { return this.attributes.has(k); }
				append(...nodes: Array<FakeNode | string>) {
					for (const n of nodes) {
						const child = typeof n === "string" ? new FakeTextNode(n) : n;
						child.parentNode = this;
						this.children.push(child);
					}
				}
				replaceChildren(...nodes: Array<FakeNode | string>) {
					this.children = [];
					this.append(...nodes);
				}
				addEventListener(type: string, fn: (e: any) => void) {
					const list = this.listeners.get(type) ?? [];
					list.push(fn);
					this.listeners.set(type, list);
				}
				contains(other: FakeNode | null): boolean {
					let cur = other;
					while (cur) {
						if (cur === this) return true;
						cur = cur.parentNode;
					}
					return false;
				}
				focus() {}
				scrollIntoView() {}
				closest() { return null; }
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
					if (s === "a" && el.tagName === "a") return true;
					if (s === "a[href]" && el.tagName === "a" && el.hasAttribute("href")) return true;
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
				const body = new FakeElement("body");
				const documentElement = new FakeElement("html");
				const skipLink = new FakeElement("a");
				skipLink.setAttribute("class", "skip-link");
				skipLink.setAttribute("href", "#main-content");
				const header = new FakeElement("header");
				header.setAttribute("class", "viewer-header");
				const menuToggle = new FakeElement("button");
				menuToggle.id = "menu-toggle";
				const headerScope = new FakeElement("span");
				headerScope.id = "header-scope";
				header.append(menuToggle, headerScope);

				const drawerBackdrop = new FakeElement("div");
				drawerBackdrop.id = "drawer-backdrop";
				const sidebar = new FakeElement("aside");
				sidebar.id = "sidebar";
				const drawerClose = new FakeElement("button");
				drawerClose.id = "drawer-close";
				const factoriesList = new FakeElement("ul");
				factoriesList.id = "factories-list";
				sidebar.append(drawerClose, factoriesList);

				const mainContent = new FakeElement("main");
				mainContent.id = "main-content";
				const viewHeading = new FakeElement("h2");
				viewHeading.id = "view-heading";
				const factorySubtitle = new FakeElement("p");
				factorySubtitle.id = "factory-subtitle";
				const viewsNav = new FakeElement("nav");
				for (const v of ["factories", "live", "inspect", "queue", "receipts", "requests", "proposals"]) {
					const tab = new FakeElement("button");
					tab.setAttribute("data-view", v);
					viewsNav.append(tab);
				}
				const content = new FakeElement("section");
				content.id = "content";
				content.setAttribute("aria-busy", "false");
				mainContent.append(viewHeading, factorySubtitle, viewsNav, content);
				body.append(skipLink, header, drawerBackdrop, sidebar, mainContent);

				const docListeners = new Map<string, Array<(e: any) => void>>();
				const fakeDocument = {
					body,
					documentElement,
					activeElement: body,
					createElement: (tag: string) => new FakeElement(tag),
					createElementNS: (ns: string, tag: string) => new FakeElement(tag, ns),
					createTextNode: (txt: string) => new FakeTextNode(txt),
					getElementById: (id: string) => collectAllElements(body).find(e => e.id === id) ?? null,
					querySelector: (sel: string) => body.querySelector(sel),
					querySelectorAll: (sel: string) => body.querySelectorAll(sel),
					addEventListener: (type: string, fn: (e: any) => void) => {
						const list = docListeners.get(type) ?? [];
						list.push(fn);
						docListeners.set(type, list);
					},
				};

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
					nowMs += ms;
					for (const [id, entry] of [...timers.entries()]) {
						if (entry.fireAt <= nowMs) {
							timers.delete(id);
							entry.fn();
						}
					}
					await new Promise(r => setTimeout(r, 0));
					await new Promise(r => setTimeout(r, 0));
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
					AbortController,
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

				return { context, body, sidebar, factoriesList, content, viewsNav, advanceTimers, assertSafeDom };
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
					for (const fn of tab.listeners.get("click") ?? []) fn({});
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
		},
	);
});
