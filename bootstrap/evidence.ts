/**
 * Verification evidence as a dependency sees it. Verification records (see verification.ts) say what a check did and what the project
 * looked like around it; this module turns the latest record for each required check into the one status a dependency decision needs:
 * `passing`, `missing`, `failed`, `unverified` or `stale` (see outcomes.ts).
 */
import type { EvidenceStatus } from "./outcomes.ts";
import type { WorkerConfig } from "./session-store.ts";
import { evaluateApplicability, readVerificationRecords, type VerificationRecord } from "./verification.ts";

/** Verification checks a node must pass: its own `required_checks` and those of its output contract. */
export function requiredChecksOf(node: { required_checks?: string[]; output_contract?: { required_checks?: string[] } }): string[] {
	return [...new Set([...(node.required_checks ?? []), ...(node.output_contract?.required_checks ?? [])])];
}

/** The checks a chain node's predecessor must have passing, as declared in the plan the worker was launched with. */
export function upstreamRequiredChecks(config: Pick<WorkerConfig, "predecessor" | "upstream_contracts">): string[] {
	const upstream = config.predecessor ? config.upstream_contracts?.[config.predecessor] : undefined;
	return upstream ? requiredChecksOf({ required_checks: upstream.required_checks, output_contract: upstream.output_contract }) : [];
}

/**
 * The status of each check, judged against the project as it is now. Only the latest record for a check decides; earlier records are history.
 * - missing: no record for the check. failed: its latest run did not pass.
 * - unverified: relevance cannot be established (the scope or a snapshot is unknown, or the evidence file is unreadable), or the project
 *   changed while the check was running, so the run says nothing about any single state.
 * - stale: it passed on a consistent state, but the relevant files have changed since. passing: it passed and nothing relevant changed.
 */
export function verifyEvidence(sessionDir: string, instanceId: string, projectCwd: string, checks: string[], runId?: string, recordKey = instanceId): Array<{ check: string; status: EvidenceStatus; reason?: string }> {
	let records: VerificationRecord[];
	try { records = readVerificationRecords(sessionDir, instanceId, runId, recordKey); }
	catch (error) { return checks.map(check => ({ check, status: "unverified" as const, reason: error instanceof Error ? error.message : String(error) })); }
	return checks.map(check => {
		const latest = records.filter(record => record.check_id === check).at(-1);
		if (!latest) return { check, status: "missing" as const };
		if (latest.result !== "pass") return { check, status: "failed" as const, reason: latest.detail };
		if (latest.changed_during_check?.length) return { check, status: "unverified" as const, reason: `the project changed while the check ran (${latest.changed_during_check.slice(0, 5).join(", ")})` };
		const { applicability, reason } = evaluateApplicability(latest, projectCwd);
		return { check, status: applicability === "current" ? "passing" as const : applicability === "stale" ? "stale" as const : "unverified" as const, ...(reason ? { reason } : {}) };
	});
}
