/**
 * One command per bootstrap test suite, run on isolated Pi state:
 *
 *   node bootstrap/run-tests.ts deterministic   # unit/service/worker tests: temp files, fake Herdr, no real Pi
 *   node bootstrap/run-tests.ts runtime         # installed Pi/Coms in RPC mode, isolated state, fake local provider
 *   node bootstrap/run-tests.ts live            # independent opt-ins: real Herdr or an isolated hc core
 *   node bootstrap/run-tests.ts all             # deterministic + runtime (never live)
 *
 * Flags: --strict (same as PI_BOOTSTRAP_TEST_STRICT=1: missing capabilities fail instead of being skipped), --timeout-ms <n>.
 * Files are assigned to suites by name: `live-*.test.ts`, `runtime-*.test.ts`, everything else `*.test.ts` is deterministic.
 * Exit status 0 means every selected test passed; skipped tests are printed as UNVERIFIED and are not coverage.
 */
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedPiEnvironment, spawnGroup } from "./test-harness.ts";
import { HC_LIVE_FILE, HC_LIVE_FINDINGS_DIR, HC_LIVE_GATE, HC_LIVE_ONLY, hcLiveEnabled } from "./test-support/hc-live-env.ts";

export const SUITES = ["deterministic", "runtime", "live"] as const;
export type Suite = typeof SUITES[number];

const DEFAULT_TIMEOUT_MS: Record<Suite, number> = { deterministic: 180_000, runtime: 300_000, live: 600_000 };

export function classifyTestFile(name: string): Suite | undefined {
	if (!name.endsWith(".test.ts")) return undefined;
	if (name.startsWith("live-")) return "live";
	if (name.startsWith("runtime-")) return "runtime";
	return "deterministic";
}

export function suiteFiles(dir: string, suite: Suite): string[] {
	return readdirSync(dir).filter(name => classifyTestFile(name) === suite).sort();
}

export interface SuiteOptions {
	suite: Suite;
	dir: string;
	env?: NodeJS.ProcessEnv;
	timeoutMs?: number;
	graceMs?: number;
	strict?: boolean;
	out?: { write(text: string): unknown };
}
export interface SuiteResult {
	exitCode: number;
	/** False when the suite was not started (missing opt-in or prerequisites). */
	ran: boolean;
	timedOut: boolean;
	files: string[];
	skipped: number;
	/** Files created under the fake HOME, i.e. user-level state the code under test tried to write. */
	leaks: string[];
	isolatedRoot: string;
	output: string;
	summary: string;
}

function notRun(options: SuiteOptions, files: string[], reason: string): SuiteResult {
	const summary = `UNVERIFIED: ${options.suite} suite not run: ${reason}`;
	options.out?.write(`${summary}\n`);
	return { exitCode: options.strict ? 1 : 0, ran: false, timedOut: false, files, skipped: 0, leaks: [], isolatedRoot: "", output: "", summary: options.strict ? `${summary} (strict mode: infrastructure failure)` : summary };
}

export async function runSuite(options: SuiteOptions): Promise<SuiteResult> {
	const parent = options.env ?? process.env;
	const strict = options.strict ?? parent.PI_BOOTSTRAP_TEST_STRICT === "1";
	let files = suiteFiles(options.dir, options.suite);
	if (files.length === 0) return notRun({ ...options, strict }, files, "no test files match this suite");
	let runHerdr = false;
	let runHc = false;
	if (options.suite === "live") {
		const herdrReason = parent.PI_BOOTSTRAP_LIVE_HERDR !== "1"
			? "live Herdr tests require an explicit opt-in: set PI_BOOTSTRAP_LIVE_HERDR=1 and run inside Herdr"
			: parent.HERDR_ENV !== "1" || !parent.HERDR_PANE_ID
				? "live Herdr tests must run inside a Herdr pane (HERDR_ENV=1 and HERDR_PANE_ID)" : undefined;
		const hcReason = `live hc tests require an explicit opt-in: set ${HC_LIVE_GATE}=1`;
		const reasons: string[] = [];
		if (files.some(name => name !== HC_LIVE_FILE)) {
			runHerdr = !herdrReason;
			if (herdrReason) reasons.push(herdrReason);
		}
		if (files.includes(HC_LIVE_FILE)) {
			runHc = hcLiveEnabled(parent);
			if (!runHc) reasons.push(hcReason);
		}
		const selected = files.filter(name => name === HC_LIVE_FILE ? runHc : runHerdr);
		if (selected.length === 0 || (strict && reasons.length > 0)) return notRun({ ...options, strict }, files, reasons.join(". "));
		for (const reason of reasons) options.out?.write(`UNVERIFIED: ${reason}\n`);
		files = selected;
	}
	const iso = isolatedPiEnvironment(parent);
	const env = { ...iso.env, ...(strict ? { PI_BOOTSTRAP_TEST_STRICT: "1" } : {}) };
	delete env.NODE_TEST_CONTEXT; // a nested `node --test` must act as a top-level runner
	if (runHerdr) {
		env.PI_BOOTSTRAP_LIVE_HERDR = "1";
		env.PI_BOOTSTRAP_HOST = "herdr";
		for (const [key, value] of Object.entries(parent)) if (/^(HERDR_|HC_)/.test(key) && value !== undefined) env[key] = value;
	}
	if (runHc) {
		env[HC_LIVE_GATE] = "1";
		env[HC_LIVE_FINDINGS_DIR] = parent[HC_LIVE_FINDINGS_DIR] === undefined
			? undefined : resolve(parent[HC_LIVE_FINDINGS_DIR]);
		if (parent[HC_LIVE_ONLY] !== undefined) env[HC_LIVE_ONLY] = parent[HC_LIVE_ONLY];
	}
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS[options.suite];
	let output = "";
	let timedOut = false;
	try {
		const group = spawnGroup(process.execPath, ["--test", ...files.map(name => join(options.dir, name))], { cwd: options.dir, env });
		const collect = (data: Buffer) => { const text = data.toString(); output += text; options.out?.write(text); };
		group.child.stdout.on("data", collect);
		group.child.stderr.on("data", collect);
		group.child.stdin.end();
		const timer = setTimeout(() => { timedOut = true; void group.stop(options.graceMs); }, timeoutMs);
		let code: number | null;
		try { ({ code } = await group.closed); } finally { clearTimeout(timer); }
		const skipped = Number(/^ℹ skipped (\d+)/m.exec(output)?.[1] ?? 0);
		const leaks = iso.homeLeaks();
		const lines: string[] = [];
		let exitCode = timedOut ? 124 : code ?? 1;
		if (timedOut) lines.push(`FAILED: ${options.suite} suite timed out after ${timeoutMs} ms; its process group was killed`);
		if (leaks.length) { lines.push(`FAILED: user-level state leak: tests wrote under HOME: ${leaks.join(", ")}`); exitCode ||= 1; }
		if (skipped > 0) {
			lines.push(`UNVERIFIED: ${skipped} test(s) skipped (missing capability or sandbox restriction); skipped tests are not coverage`);
			if (strict) { lines.push("FAILED: strict mode treats skipped capabilities as infrastructure failures"); exitCode ||= 1; }
		}
		const summary = lines.join("\n");
		if (summary) options.out?.write(`${summary}\n`);
		return { exitCode, ran: true, timedOut, files, skipped, leaks, isolatedRoot: iso.root, output, summary };
	} finally {
		iso.cleanup();
	}
}

async function main(argv: string[]): Promise<number> {
	const args = argv.filter(arg => !arg.startsWith("--"));
	const requested = args[0];
	const timeoutIndex = argv.indexOf("--timeout-ms");
	const timeoutMs = timeoutIndex >= 0 ? Number(argv[timeoutIndex + 1]) : undefined;
	if (timeoutIndex >= 0 && args.includes(argv[timeoutIndex + 1])) args.splice(args.indexOf(argv[timeoutIndex + 1]), 1);
	const suites: Suite[] | undefined = requested === "all" ? ["deterministic", "runtime"] : (SUITES as readonly string[]).includes(requested) ? [requested as Suite] : undefined;
	if (!suites || (timeoutMs !== undefined && !(timeoutMs > 0))) {
		process.stderr.write("usage: node bootstrap/run-tests.ts <deterministic|runtime|live|all> [--strict] [--timeout-ms <n>]\n");
		return 2;
	}
	let status = 0;
	for (const suite of suites) {
		process.stdout.write(`\n== bootstrap ${suite} suite ==\n`);
		const result = await runSuite({ suite, dir: dirname(fileURLToPath(import.meta.url)), strict: argv.includes("--strict") || undefined, timeoutMs, out: process.stdout });
		status ||= result.exitCode;
	}
	return status;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
