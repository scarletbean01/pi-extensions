import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createManagerAuthority, factoryOperations, revokeManagerAuthority } from "../factory/operations.ts";
import { buildProposalRow, insertProposalRow } from "./constraint-proposals.ts";
import { createRequest, inTransaction, openRequestDatabase } from "./factory-requests.ts";
import type { GenerateRequest } from "./lifecycle.ts";
import { isolatedPiEnvironment, runSupervised } from "./test-harness.ts";
import { serviceFixture } from "./test-support/chain-fixture.ts";
import { verifyReadOnlyViewer } from "./test-support/factory-viewer-fixture.ts";

const EXPECTED_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

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
				"/../index.html",
				"/does-not-exist.css",
				"/constructor",
				"/toString",
			]) {
				const res = await rawGet(viewer.url, badPath);
				assert.ok(res.status === 404 || res.status === 400, `expected 404 or 400 for ${badPath}, got ${res.status}`);
			}
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

			// No inline <script> or <style> in HTML
			assert.doesNotMatch(html, /<style\b/i, "inline <style> is forbidden");
			assert.doesNotMatch(html, /<script\b(?![^>]*\bsrc="\/app\.js")/i, "inline <script> is forbidden");

			// Forbidden DOM/eval sinks and forbidden ticket-09 polling in app.js
			for (const [label, pattern] of [
				["innerHTML", /\binnerHTML\b/],
				["outerHTML", /\bouterHTML\b/],
				["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
				["document.write", /\bdocument\.write\b/],
				["eval", /\beval\s*\(/],
				["new Function", /\bnew\s+Function\b/],
				["inline event attribute", /\bon[a-z]+\s*=/i],
				["setInterval polling (belongs to ticket 09)", /\bsetInterval\b/],
			] as const) {
				assert.doesNotMatch(js, pattern, `app.js must not contain ${label}`);
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
