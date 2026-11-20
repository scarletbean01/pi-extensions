import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	assertNoSymlinkPath,
	coordAnchorPath,
	coordMetaRecordDigest,
	errorMessage,
	factoryRunPath,
	parseCoordAnchor,
	parseFactoryManagedInfo,
	parseFactoryReleaseMarker,
	readJson,
	type FactoryManagedInfo,
} from "./session-store.ts";

export const FACTORY_TASK_ID_PREFIX = "factory_run_";
export const FACTORY_REQUEST_ID_PREFIX = "factory_run_req_";

const FACTORY_MANAGED_KEYS = [
	"factory_id",
	"factory_name",
	"input_id",
	"attempt_id",
	"request_id",
	"canonical_checkout",
	"state_db_path",
	"coord_db_path",
] as const;

export function isFactoryTaskId(taskId: string): boolean {
	return taskId.startsWith(FACTORY_TASK_ID_PREFIX);
}

export function generateFactoryTaskId(task: string): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 28)
		.replace(/-+$/g, "") || "task";
	return `${FACTORY_TASK_ID_PREFIX}${slug}-${cryptoRandomUuid()}`;
}

function cryptoRandomUuid(): string {
	return globalThis.crypto.randomUUID();
}

export function generateFactoryRequestId(factoryId: string, attemptId: string): string {
	return `${FACTORY_REQUEST_ID_PREFIX}${factoryId}_${attemptId}`;
}

export function isFactoryRequestId(requestId: string): boolean {
	return requestId.startsWith(FACTORY_REQUEST_ID_PREFIX);
}

export interface FactoryReleaseCheckResult {
	kind: "released" | "held" | "uncertain";
	reason?: string;
	release_authorized?: boolean;
	attempt_state?: string;
	release_marker_present: boolean;
}

function sha256Hex(value: string): string {
	return createHash("sha256").update(value, "utf8").digest("hex");
}

function metadataMismatch(a: FactoryManagedInfo, b: FactoryManagedInfo, sourceLabel: string): string | undefined {
	for (const key of FACTORY_MANAGED_KEYS) {
		if (a[key] !== b[key]) return `Factory metadata mismatch in ${sourceLabel} (${key})`;
	}
	return undefined;
}

/**
 * Read-only validation of factory release proof across manifest/sidecar metadata, release.json,
 * and durable SQLite factory + coordination databases. Never mutates files or databases.
 */
export function inspectFactoryReleaseState(params: {
	taskId: string;
	token: string;
	sessionDir: string;
	sessionDirRemoved?: boolean;
	primaryMeta: unknown;
	indexRunPath?: string;
	releaseMarker?: unknown;
}): FactoryReleaseCheckResult {
	const { taskId, token, sessionDir, sessionDirRemoved, primaryMeta, indexRunPath, releaseMarker } = params;
	const releasePath = join(sessionDir, "release.json");
	const releaseMarkerPresent = releaseMarker !== undefined || (!sessionDirRemoved && existsSync(releasePath));
	const fail = (reason: string, extra?: { release_authorized?: boolean; attempt_state?: string }): FactoryReleaseCheckResult => ({
		kind: "uncertain",
		reason,
		release_marker_present: releaseMarkerPresent,
		...extra,
	});

	if (primaryMeta === undefined) {
		return fail("Missing factory_managed metadata on run");
	}
	let meta: FactoryManagedInfo;
	try {
		meta = parseFactoryManagedInfo(primaryMeta);
	} catch (error) {
		return fail(errorMessage(error));
	}

	if (!sessionDirRemoved) {
		const sidecarPath = factoryRunPath(sessionDir);
		if (!existsSync(sidecarPath)) {
			return fail("Missing factory-run.json sidecar");
		}
		try {
			assertNoSymlinkPath(sidecarPath);
			const rawSidecar = readJson<Record<string, unknown>>(sidecarPath);
			const sidecarMeta = parseFactoryManagedInfo(rawSidecar);
			if (rawSidecar.task_id !== undefined && rawSidecar.task_id !== taskId) {
				return fail("factory-run.json task_id mismatch");
			}
			const mismatch = metadataMismatch(meta, sidecarMeta, "factory-run.json");
			if (mismatch) return fail(mismatch);
		} catch (error) {
			return fail(`Invalid factory-run.json sidecar: ${errorMessage(error)}`);
		}
	}

	if (indexRunPath && existsSync(indexRunPath)) {
		try {
			assertNoSymlinkPath(indexRunPath);
			const rawIndexRun = readJson<Record<string, unknown>>(indexRunPath);
			const indexMeta = parseFactoryManagedInfo(rawIndexRun);
			if (rawIndexRun.task_id !== undefined && rawIndexRun.task_id !== taskId) {
				return fail("Factory run index task_id mismatch");
			}
			const mismatch = metadataMismatch(meta, indexMeta, "factory run index");
			if (mismatch) return fail(mismatch);
		} catch (error) {
			return fail(`Invalid factory run index metadata: ${errorMessage(error)}`);
		}
	}

	let markerValid = false;
	let markerError: string | undefined;
	if (releaseMarkerPresent) {
		try {
			let rawRelease = releaseMarker;
			if (rawRelease === undefined) {
				assertNoSymlinkPath(releasePath);
				rawRelease = readJson<unknown>(releasePath);
			}
			parseFactoryReleaseMarker(rawRelease, {
				task_id: taskId,
				token,
				factory_managed: meta,
			});
			markerValid = true;
		} catch (error) {
			markerError = errorMessage(error);
		}
	}

	try {
		assertNoSymlinkPath(meta.state_db_path);
		assertNoSymlinkPath(meta.coord_db_path);
		const anchorPath = coordAnchorPath(meta.coord_db_path);
		assertNoSymlinkPath(anchorPath);
		if (!existsSync(meta.state_db_path) || !statSync(meta.state_db_path).isFile()) {
			return fail("Factory state database is missing");
		}
		if (!existsSync(meta.coord_db_path) || !statSync(meta.coord_db_path).isFile()) {
			return fail("Factory coordination database is missing");
		}
		if (!existsSync(anchorPath) || !statSync(anchorPath).isFile()) {
			return fail("Factory coordination continuity anchor is missing");
		}
		const anchor = parseCoordAnchor(readJson<unknown>(anchorPath));
		if (anchor.state !== "committed") {
			return fail(`Factory coordination continuity anchor is not committed (${anchor.state})`);
		}

		const tokenDigest = sha256Hex(token);
		const requestIdDigest = sha256Hex(meta.request_id);
		const db = new DatabaseSync(meta.state_db_path);
		try {
			db.exec("PRAGMA busy_timeout = 5000;");
			db.prepare("ATTACH DATABASE ? AS coord").run(meta.coord_db_path);
			db.exec("PRAGMA query_only = ON; BEGIN");
			const version = db.prepare("PRAGMA main.user_version").get()?.user_version;
			const coordVersion = db.prepare("PRAGMA coord.user_version").get()?.user_version;
			if (version !== 3 || coordVersion !== 1) {
				return fail(`Unsupported factory storage version (main=${version}, coord=${coordVersion})`);
			}
			const coordMeta = db.prepare("SELECT id, anchor_id, created_at, record_digest FROM coord.coord_meta WHERE id = 1").get() as
				| { id: number; anchor_id: string; created_at: string; record_digest: string }
				| undefined;
			if (!coordMeta || coordMetaRecordDigest(coordMeta.id, coordMeta.anchor_id, coordMeta.created_at) !== coordMeta.record_digest || coordMeta.anchor_id !== anchor.anchor_id) {
				return fail("Factory coordination continuity anchor mismatch");
			}

			const attempt = db.prepare(
				"SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, state, release_authorized, release_token_digest FROM main.factory_attempts WHERE attempt_id = ?",
			).get(meta.attempt_id) as {
				attempt_id: string; factory_id: string; input_id: string; bound_version: string; request_id: string;
				task_id: string; canonical_checkout: string; state: string; release_authorized: number; release_token_digest: string | null;
			} | undefined;
			if (
				!attempt
				|| attempt.factory_id !== meta.factory_id
				|| attempt.input_id !== meta.input_id
				|| attempt.bound_version !== "v1"
				|| attempt.request_id !== meta.request_id
				|| attempt.task_id !== taskId
				|| attempt.canonical_checkout !== meta.canonical_checkout
			) {
				return fail("Factory attempt record is missing or mismatched");
			}

			const inputRow = db.prepare(
				"SELECT input_id, factory_id, bound_version, disposition FROM main.factory_inputs WHERE input_id = ?",
			).get(meta.input_id) as { input_id: string; factory_id: string; bound_version: string; disposition: string } | undefined;
			if (!inputRow || inputRow.factory_id !== meta.factory_id || inputRow.bound_version !== "v1") {
				return fail("Factory input record is missing or mismatched", {
					release_authorized: attempt.release_authorized === 1,
					attempt_state: attempt.state,
				});
			}

			const fHold = db.prepare(
				"SELECT factory_id, attempt_id, input_id, request_id, task_id, state FROM main.factory_holds WHERE factory_id = ?",
			).get(meta.factory_id) as { attempt_id: string; input_id: string; request_id: string; task_id: string; state: string } | undefined;
			if (!fHold || fHold.attempt_id !== meta.attempt_id || fHold.input_id !== meta.input_id || fHold.request_id !== meta.request_id || fHold.task_id !== taskId) {
				return fail("Factory slot hold is missing or mismatched", {
					release_authorized: attempt.release_authorized === 1,
					attempt_state: attempt.state,
				});
			}

			const cHold = db.prepare(
				"SELECT canonical_checkout, factory_id, factory_db_path, attempt_id, input_id, request_id, task_id, state FROM coord.checkout_holds WHERE canonical_checkout = ?",
			).get(meta.canonical_checkout) as {
				factory_id: string; factory_db_path: string; attempt_id: string; input_id: string; request_id: string; task_id: string; state: string;
			} | undefined;
			if (
				!cHold
				|| cHold.factory_id !== meta.factory_id
				|| cHold.factory_db_path !== meta.state_db_path
				|| cHold.attempt_id !== meta.attempt_id
				|| cHold.input_id !== meta.input_id
				|| cHold.request_id !== meta.request_id
				|| cHold.task_id !== taskId
			) {
				return fail("Checkout hold is missing or mismatched", {
					release_authorized: attempt.release_authorized === 1,
					attempt_state: attempt.state,
				});
			}

			const managedRun = db.prepare(
				"SELECT task_id, request_id_digest, factory_id, factory_db_path, input_id, attempt_id, canonical_checkout FROM coord.managed_runs WHERE task_id = ?",
			).get(taskId) as {
				request_id_digest: string; factory_id: string; factory_db_path: string; input_id: string; attempt_id: string; canonical_checkout: string;
			} | undefined;
			if (
				!managedRun
				|| managedRun.request_id_digest !== requestIdDigest
				|| managedRun.factory_id !== meta.factory_id
				|| managedRun.factory_db_path !== meta.state_db_path
				|| managedRun.input_id !== meta.input_id
				|| managedRun.attempt_id !== meta.attempt_id
				|| managedRun.canonical_checkout !== meta.canonical_checkout
			) {
				return fail("Managed run association is missing or mismatched", {
					release_authorized: attempt.release_authorized === 1,
					attempt_state: attempt.state,
				});
			}

			if (attempt.release_authorized === 1) {
				if (
					attempt.state !== "released"
					|| attempt.release_token_digest !== tokenDigest
					|| inputRow.disposition !== "running"
					|| fHold.state !== "released"
					|| cHold.state !== "released"
				) {
					return fail(
						`Contradictory SQLite release state (attempt=${attempt.state}, input=${inputRow.disposition}, factory_hold=${fHold.state}, checkout_hold=${cHold.state})`,
						{ release_authorized: true, attempt_state: attempt.state },
					);
				}
				if (sessionDirRemoved) {
					return fail("Session directory is unavailable to verify release.json", {
						release_authorized: true,
						attempt_state: attempt.state,
					});
				}
				if (!releaseMarkerPresent) {
					return fail("Release authorization was committed in SQLite without a release.json marker", {
						release_authorized: true,
						attempt_state: attempt.state,
					});
				}
				if (!markerValid) {
					return fail(markerError ?? "Invalid release.json marker", {
						release_authorized: true,
						attempt_state: attempt.state,
					});
				}
				return {
					kind: "released",
					release_authorized: true,
					attempt_state: attempt.state,
					release_marker_present: true,
				};
			}

			if (attempt.release_authorized === 0) {
				if (releaseMarkerPresent) {
					return fail(
						markerValid
							? "Contradictory release state: release.json exists without SQLite release authorization"
							: `Invalid release.json exists without SQLite release authorization (${markerError})`,
						{ release_authorized: false, attempt_state: attempt.state },
					);
				}
				if (
					(attempt.state !== "reserved" && attempt.state !== "failed_before_release")
					|| attempt.release_token_digest !== null
					|| inputRow.disposition !== "launching"
					|| fHold.state !== attempt.state
					|| cHold.state !== attempt.state
				) {
					return fail(
						`Contradictory pre-release SQLite state (attempt=${attempt.state}, input=${inputRow.disposition}, factory_hold=${fHold.state}, checkout_hold=${cHold.state})`,
						{ release_authorized: false, attempt_state: attempt.state },
					);
				}
				return {
					kind: "held",
					release_authorized: false,
					attempt_state: attempt.state,
					release_marker_present: false,
				};
			}

			return fail(`Invalid SQLite release_authorized value (${attempt.release_authorized})`, {
				attempt_state: attempt.state,
			});
		} finally {
			db.close();
		}
	} catch (error) {
		return fail(errorMessage(error));
	}
}
