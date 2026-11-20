import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	sha256Hex,
	validateAttemptRow,
	validateCheckoutHoldRow,
	validateFactoryHoldRow,
	validateInputRow,
	validateManagedRunRow,
	type StoredAttempt,
	type StoredCheckoutHold,
	type StoredFactoryHold,
	type StoredInput,
	type StoredManagedRun,
} from "./factory-records.ts";
import {
	assertNoSymlinkPath,
	coordAnchorPath,
	coordMetaRecordDigest,
	errorMessage,
	factoryRunPath,
	parseCoordAnchor,
	parseFactoryManagedInfo,
	parseFactoryReleaseMarker,
	pathEntryExists,
	readJson,
	readRegularJsonNoSymlink,
	type FactoryManagedInfo,
	type FactoryReleaseMarker,
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
	"checkout_key",
	"state_db_path",
	"coord_db_path",
] as const;

export function resolveCheckoutIdentity(checkoutPath: string): { canonical_checkout: string; checkout_key: string } {
	const canonical_checkout = realpathSync(checkoutPath);
	const st = statSync(canonical_checkout, { bigint: true });
	if (!st.isDirectory()) {
		throw new Error(`Canonical checkout is not a directory: ${canonical_checkout}`);
	}
	return {
		canonical_checkout,
		checkout_key: `dev:${st.dev.toString()}:ino:${st.ino.toString()}`,
	};
}

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
	submitted_brief?: string;
	submitted_brief_digest?: string;
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
	let releaseMarkerPresent = releaseMarker !== undefined;
	if (!releaseMarkerPresent && !sessionDirRemoved) {
		try {
			releaseMarkerPresent = pathEntryExists(releasePath);
		} catch (error) {
			return {
				kind: "uncertain",
				reason: `Unable to inspect release.json marker: ${errorMessage(error)}`,
				release_marker_present: true,
			};
		}
	}
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
		if (!pathEntryExists(sidecarPath)) {
			return fail("Missing factory-run.json sidecar");
		}
		try {
			const rawSidecar = readRegularJsonNoSymlink<Record<string, unknown>>(sidecarPath, "factory-run.json");
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

	if (indexRunPath && pathEntryExists(indexRunPath)) {
		try {
			const rawIndexRun = readRegularJsonNoSymlink<Record<string, unknown>>(indexRunPath, "factory run index");
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

	let parsedMarker: FactoryReleaseMarker | undefined;
	let markerValid = false;
	let markerError: string | undefined;
	if (releaseMarkerPresent) {
		try {
			const rawRelease = releaseMarker !== undefined
				? releaseMarker
				: readRegularJsonNoSymlink<unknown>(releasePath, "release.json");
			parsedMarker = parseFactoryReleaseMarker(rawRelease, {
				task_id: taskId,
				token,
				factory_managed: meta,
			});
			markerValid = true;
		} catch (error) {
			markerError = `Invalid release.json marker: ${errorMessage(error)}`;
		}
	}

	try {
		assertNoSymlinkPath(meta.state_db_path);
		assertNoSymlinkPath(meta.coord_db_path);
		const anchorPath = coordAnchorPath(meta.coord_db_path);
		if (!pathEntryExists(meta.state_db_path) || !lstatSync(meta.state_db_path).isFile()) {
			return fail("Factory state database is missing");
		}
		if (!pathEntryExists(meta.coord_db_path) || !lstatSync(meta.coord_db_path).isFile()) {
			return fail("Factory coordination database is missing");
		}
		if (!pathEntryExists(anchorPath) || !lstatSync(anchorPath).isFile()) {
			return fail("Factory coordination continuity anchor is missing");
		}
		const anchor = parseCoordAnchor(readRegularJsonNoSymlink<unknown>(anchorPath, "coordination continuity anchor"));
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
			if (version !== 4 || coordVersion !== 2) {
				return fail(`Unsupported factory storage version (main=${version}, coord=${coordVersion})`);
			}
			const coordMeta = db.prepare("SELECT id, anchor_id, created_at, record_digest FROM coord.coord_meta WHERE id = 1").get() as
				| { id: number; anchor_id: string; created_at: string; record_digest: string }
				| undefined;
			if (!coordMeta || coordMetaRecordDigest(coordMeta.id, coordMeta.anchor_id, coordMeta.created_at) !== coordMeta.record_digest || coordMeta.anchor_id !== anchor.anchor_id) {
				return fail("Factory coordination continuity anchor mismatch");
			}

			const rawAttempt = db.prepare(
				`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state,
					release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest
				FROM main.factory_attempts WHERE attempt_id = ?`,
			).get(meta.attempt_id) as StoredAttempt | undefined;
			if (!rawAttempt) {
				return fail("Factory attempt record is missing or mismatched");
			}
			const attempt = validateAttemptRow(rawAttempt);
			if (
				attempt.factory_id !== meta.factory_id
				|| attempt.input_id !== meta.input_id
				|| attempt.bound_version !== "v1"
				|| attempt.request_id !== meta.request_id
				|| attempt.task_id !== taskId
				|| attempt.canonical_checkout !== meta.canonical_checkout
				|| attempt.checkout_key !== meta.checkout_key
			) {
				return fail("Factory attempt record is missing or mismatched");
			}

			const attemptFailExtra = {
				release_authorized: attempt.release_authorized === 1,
				attempt_state: attempt.state,
			};
			const rawInputRow = db.prepare(
				`SELECT input_id, factory_id, reference, queue_position, bound_version, disposition,
					brief, brief_bytes, brief_digest, accepted_at, record_digest
				FROM main.factory_inputs WHERE input_id = ?`,
			).get(meta.input_id) as StoredInput | undefined;
			if (!rawInputRow) {
				return fail("Factory input record is missing or mismatched", attemptFailExtra);
			}
			let inputRow: StoredInput;
			try {
				inputRow = validateInputRow(rawInputRow);
			} catch (error) {
				return fail(errorMessage(error), attemptFailExtra);
			}
			if (inputRow.factory_id !== meta.factory_id || inputRow.bound_version !== "v1") {
				return fail("Factory input record is missing or mismatched", attemptFailExtra);
			}

			const rawFHold = db.prepare(
				"SELECT factory_id, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest FROM main.factory_holds WHERE factory_id = ?",
			).get(meta.factory_id) as StoredFactoryHold | undefined;
			if (!rawFHold) {
				return fail("Factory slot hold is missing or mismatched", attemptFailExtra);
			}
			let fHold: StoredFactoryHold;
			try {
				fHold = validateFactoryHoldRow(rawFHold);
			} catch (error) {
				return fail(errorMessage(error), attemptFailExtra);
			}
			if (fHold.attempt_id !== meta.attempt_id || fHold.input_id !== meta.input_id || fHold.request_id !== meta.request_id || fHold.task_id !== taskId) {
				return fail("Factory slot hold is missing or mismatched", attemptFailExtra);
			}

			const rawCHold = db.prepare(
				`SELECT canonical_checkout, checkout_key, factory_id, factory_name, factory_db_path, attempt_id, input_id, request_id, task_id, state, held_at, updated_at, record_digest
				FROM coord.checkout_holds WHERE canonical_checkout = ?`,
			).get(meta.canonical_checkout) as StoredCheckoutHold | undefined;
			if (!rawCHold) {
				return fail("Checkout hold is missing or mismatched", attemptFailExtra);
			}
			let cHold: StoredCheckoutHold;
			try {
				cHold = validateCheckoutHoldRow(rawCHold);
			} catch (error) {
				return fail(errorMessage(error), attemptFailExtra);
			}
			if (
				cHold.checkout_key !== meta.checkout_key
				|| cHold.factory_id !== meta.factory_id
				|| cHold.factory_name !== meta.factory_name
				|| cHold.factory_db_path !== meta.state_db_path
				|| cHold.attempt_id !== meta.attempt_id
				|| cHold.input_id !== meta.input_id
				|| cHold.request_id !== meta.request_id
				|| cHold.task_id !== taskId
			) {
				return fail("Checkout hold is missing or mismatched", attemptFailExtra);
			}

			const rawManagedRun = db.prepare(
				`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest
				FROM coord.managed_runs WHERE task_id = ?`,
			).get(taskId) as StoredManagedRun | undefined;
			if (!rawManagedRun) {
				return fail("Managed run association is missing or mismatched", attemptFailExtra);
			}
			let managedRun: StoredManagedRun;
			try {
				managedRun = validateManagedRunRow(rawManagedRun);
			} catch (error) {
				return fail(errorMessage(error), attemptFailExtra);
			}
			if (
				managedRun.request_id_digest !== requestIdDigest
				|| managedRun.factory_id !== meta.factory_id
				|| managedRun.factory_name !== meta.factory_name
				|| managedRun.factory_db_path !== meta.state_db_path
				|| managedRun.input_id !== meta.input_id
				|| managedRun.attempt_id !== meta.attempt_id
				|| managedRun.canonical_checkout !== meta.canonical_checkout
				|| managedRun.checkout_key !== meta.checkout_key
			) {
				return fail("Managed run association is missing or mismatched", attemptFailExtra);
			}

			if (attempt.release_authorized === 1) {
				if (
					attempt.state !== "released"
					|| attempt.release_token_digest !== tokenDigest
					|| !attempt.release_nonce_digest
					|| !/^[a-f0-9]{64}$/.test(attempt.release_nonce_digest)
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
					return fail("Release authorization was committed in SQLite without release.json marker", {
						release_authorized: true,
						attempt_state: attempt.state,
					});
				}
				if (!markerValid || !parsedMarker) {
					return fail(markerError ?? "Invalid release.json marker", {
						release_authorized: true,
						attempt_state: attempt.state,
					});
				}
				if (sha256Hex(parsedMarker.factory_managed.release_nonce) !== attempt.release_nonce_digest) {
					return fail("Invalid release.json marker: Release marker nonce digest mismatch", {
						release_authorized: true,
						attempt_state: attempt.state,
					});
				}
				return {
					kind: "released",
					release_authorized: true,
					attempt_state: attempt.state,
					release_marker_present: true,
					submitted_brief: inputRow.brief,
					submitted_brief_digest: inputRow.brief_digest,
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
					|| attempt.release_nonce_digest !== null
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
