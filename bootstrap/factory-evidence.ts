import { lstatSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
	sha256Hex,
	validateAttemptRow,
	validateCheckoutHoldRow,
	validateFactoryHoldRow,
	validateFactoryVersionRow,
	validateInputRow,
	validateManagedRunRow,
	type StoredAttempt,
	type StoredCheckoutHold,
	type StoredFactoryHold,
	type StoredFactoryVersion,
	type StoredInput,
	type StoredManagedRun,
} from "./factory-records.ts";
import {
	assertNoSymlinkPath,
	assertTaskId,
	coordAnchorPath,
	coordMetaRecordDigest,
	errorMessage,
	factoryRunPath,
	parseCoordAnchor,
	parseFactoryManagedInfo,
	parseFactoryReleaseMarker,
	parseManifest,
	pathEntryExists,
	readRegularJsonNoSymlink,
	type BootstrapManifest,
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
	"bound_version",
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
	kind: "released" | "held" | "historical_non_release" | "uncertain";
	reason?: string;
	release_authorized?: boolean;
	attempt_state?: string;
	release_marker_present: boolean;
	marker_publication_pending?: boolean;
	submitted_brief?: string;
	submitted_brief_digest?: string;
	/**
	 * The run's definitive version binding, present only once the run-local manifest, sidecar and run index agree with the claimed metadata and the
	 * durable attempt and input records at the claimed state database independently record the same identity and bound version. It can accompany
	 * `uncertain` (for example when the bound version's payload or the release marker is damaged); absent means the claimed binding is unverified.
	 */
	verified_binding?: { factory_id: string; bound_version: string; state_db_path: string };
}

export function metadataMismatch(a: FactoryManagedInfo, b: FactoryManagedInfo, sourceLabel: string): string | undefined {
	for (const key of FACTORY_MANAGED_KEYS) {
		if (a[key] !== b[key]) return `Factory metadata mismatch in ${sourceLabel} (${key})`;
	}
	return undefined;
}

function isNonEmptySecretFreeToken(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !value.includes("\0");
}

function isNormalizedAbsolutePath(value: string): boolean {
	return isAbsolute(value) && resolve(value) === value;
}

/**
 * Parse and validate normalized `factory_managed` identity metadata, ensuring absolute normalized
 * checkout and database paths alongside `checkout_key` and version invariants.
 */
export function parseNormalizedFactoryManagedInfo(raw: unknown, sourceLabel = "factory_managed"): FactoryManagedInfo {
	const info = parseFactoryManagedInfo(raw);
	for (const field of ["canonical_checkout", "state_db_path", "coord_db_path"] as const) {
		if (!isNormalizedAbsolutePath(info[field])) {
			throw new Error(`Invalid normalized path in ${sourceLabel} (${field})`);
		}
	}
	return info;
}

export class ManagedManifestContradictionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ManagedManifestContradictionError";
	}
}

/**
 * Validate a run-local `manifest.json` against concrete `task_id`, non-empty matching `token`,
 * canonical project/session directory identity, and normalized `factory_managed` identity.
 * Deliberately ignores mutable publication fields (`status`, `phase`, `pane_manifest` statuses).
 */
export function validateManagedManifestIdentity(params: {
	rawManifest: unknown;
	taskId: string;
	expectedToken?: string;
	expectedSessionDir: string;
	expectedMeta: FactoryManagedInfo;
	sourceLabel?: string;
}): BootstrapManifest {
	const label = params.sourceLabel ?? "run manifest.json";
	assertTaskId(params.taskId);
	const expectedMeta = parseNormalizedFactoryManagedInfo(params.expectedMeta, "expected factory_managed");
	const manifest = parseManifest(params.rawManifest, params.taskId);
	if (manifest.factory_managed === undefined) {
		throw new Error(`Missing factory_managed metadata in ${label}`);
	}
	if (!isNonEmptySecretFreeToken(manifest.token)) {
		throw new Error(`Missing or invalid token in ${label}`);
	}
	if (params.expectedToken !== undefined) {
		if (!isNonEmptySecretFreeToken(params.expectedToken)) {
			throw new Error("Missing or empty expected run token");
		}
		if (manifest.token !== params.expectedToken) {
			throw new Error(`${label} token mismatch`);
		}
	}
	if (manifest.session_dir_removed) {
		throw new Error(`Contradictory session_dir_removed flag in ${label}`);
	}
	const canonicalSessionDir = join(expectedMeta.canonical_checkout, ".pi", "agent-sessions", params.taskId);
	if (params.expectedSessionDir !== canonicalSessionDir) {
		throw new Error(`Session directory mismatch for run "${params.taskId}"`);
	}
	if (manifest.project_cwd !== expectedMeta.canonical_checkout) {
		throw new Error(`Project checkout mismatch in ${label}`);
	}
	if (manifest.session_dir !== canonicalSessionDir) {
		throw new Error(`Session directory mismatch in ${label}`);
	}
	const manifestMeta = parseNormalizedFactoryManagedInfo(manifest.factory_managed, label);
	const mismatch = metadataMismatch(expectedMeta, manifestMeta, label);
	if (mismatch) {
		throw new Error(mismatch);
	}
	return manifest;
}

/**
 * Read and validate a run-local `manifest.json` from a symlink-free regular file, throwing
 * `ManagedManifestContradictionError` on missing/non-regular/malformed/contradictory evidence
 * without leaking raw JSON document snippets on syntax errors.
 */
export function readAndValidateManagedManifest(params: {
	manifestPath: string;
	taskId: string;
	expectedToken?: string;
	expectedSessionDir: string;
	expectedMeta: FactoryManagedInfo;
	sourceLabel?: string;
}): BootstrapManifest {
	const label = params.sourceLabel ?? "run manifest.json";
	let exists = false;
	try {
		assertNoSymlinkPath(params.manifestPath);
		exists = pathEntryExists(params.manifestPath);
	} catch (error) {
		throw new ManagedManifestContradictionError(`Unable to inspect ${label}: ${errorMessage(error)}`);
	}
	if (!exists) {
		throw new ManagedManifestContradictionError(`Missing ${label}`);
	}
	let rawManifest: unknown;
	try {
		rawManifest = readRegularJsonNoSymlink<unknown>(params.manifestPath, label);
	} catch (error) {
		if (error instanceof SyntaxError) {
			throw new ManagedManifestContradictionError(`Malformed JSON in ${label}`);
		}
		throw new ManagedManifestContradictionError(errorMessage(error));
	}
	try {
		return validateManagedManifestIdentity({
			rawManifest,
			taskId: params.taskId,
			expectedToken: params.expectedToken,
			expectedSessionDir: params.expectedSessionDir,
			expectedMeta: params.expectedMeta,
			sourceLabel: label,
		});
	} catch (error) {
		throw new ManagedManifestContradictionError(errorMessage(error));
	}
}

/**
 * Read-only validation of factory release proof across run-local manifest.json, sidecar metadata,
 * release.json, and durable SQLite factory + coordination databases. Never mutates files or databases.
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
	try {
		assertTaskId(taskId);
	} catch (error) {
		return {
			kind: "uncertain",
			reason: errorMessage(error),
			release_marker_present: releaseMarker !== undefined,
		};
	}
	const releasePath = join(sessionDir, "release.json");
	let releaseMarkerPresent = releaseMarker !== undefined;
	let sessionExists = false;
	try {
		assertNoSymlinkPath(sessionDir);
		sessionExists = pathEntryExists(sessionDir);
		if (sessionExists && !lstatSync(sessionDir).isDirectory()) {
			return {
				kind: "uncertain",
				reason: "Session directory path is not a directory",
				release_marker_present: releaseMarkerPresent || releaseMarker !== undefined,
			};
		}
		if (!releaseMarkerPresent) {
			releaseMarkerPresent = pathEntryExists(releasePath);
		}
	} catch (error) {
		return {
			kind: "uncertain",
			reason: `Unable to inspect release.json marker: ${errorMessage(error)}`,
			release_marker_present: releaseMarkerPresent || releaseMarker !== undefined,
		};
	}
	const fail = (
		reason: string,
		extra?: { release_authorized?: boolean; attempt_state?: string; marker_publication_pending?: boolean; verified_binding?: FactoryReleaseCheckResult["verified_binding"] },
	): FactoryReleaseCheckResult => ({
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
		meta = parseNormalizedFactoryManagedInfo(primaryMeta, "factory_managed");
	} catch (error) {
		return fail(errorMessage(error));
	}
	const expectedSessionDir = join(meta.canonical_checkout, ".pi", "agent-sessions", taskId);
	if (sessionDir !== expectedSessionDir) {
		return fail("Session directory does not match factory_managed canonical_checkout");
	}

	const requireLocalEvidence = sessionExists || !sessionDirRemoved;
	if (requireLocalEvidence) {
		const localManifestPath = join(sessionDir, "manifest.json");
		try {
			readAndValidateManagedManifest({
				manifestPath: localManifestPath,
				taskId,
				expectedToken: token,
				expectedSessionDir: sessionDir,
				expectedMeta: meta,
				sourceLabel: "run manifest.json",
			});
		} catch (error) {
			const msg = errorMessage(error);
			return fail(msg.startsWith("Missing ") ? msg : `Invalid run manifest.json: ${msg}`);
		}
		if (sessionDirRemoved) {
			return fail("Contradictory session_dir_removed flag while session directory exists");
		}

		const sidecarPath = factoryRunPath(sessionDir);
		try {
			if (!pathEntryExists(sidecarPath)) {
				return fail("Missing factory-run.json sidecar");
			}
			const rawSidecar = readRegularJsonNoSymlink<Record<string, unknown>>(sidecarPath, "factory-run.json");
			const sidecarMeta = parseNormalizedFactoryManagedInfo(rawSidecar, "factory-run.json");
			if (rawSidecar.task_id !== undefined && rawSidecar.task_id !== taskId) {
				return fail("factory-run.json task_id mismatch");
			}
			const mismatch = metadataMismatch(meta, sidecarMeta, "factory-run.json");
			if (mismatch) return fail(mismatch);
		} catch (error) {
			return fail(`Invalid factory-run.json sidecar: ${errorMessage(error)}`);
		}
	}

	if (indexRunPath) {
		try {
			if (pathEntryExists(indexRunPath)) {
				const rawIndexRun = readRegularJsonNoSymlink<Record<string, unknown>>(indexRunPath, "factory run index");
				const indexMeta = parseNormalizedFactoryManagedInfo(rawIndexRun, "factory run index");
				if (rawIndexRun.task_id !== undefined && rawIndexRun.task_id !== taskId) {
					return fail("Factory run index task_id mismatch");
				}
				const mismatch = metadataMismatch(meta, indexMeta, "factory run index");
				if (mismatch) return fail(mismatch);
			}
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
				factory_managed: { ...meta, bound_version: meta.bound_version },
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
			if ((version !== 4 && version !== 5) || coordVersion !== 2) {
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
				|| attempt.bound_version !== meta.bound_version
				|| attempt.request_id !== meta.request_id
				|| attempt.task_id !== taskId
				|| attempt.canonical_checkout !== meta.canonical_checkout
				|| attempt.checkout_key !== meta.checkout_key
			) {
				return fail("Factory attempt record is missing or mismatched");
			}

			// The durable input must record the same bound version as the attempt: together they independently verify the claimed binding.
			let verified_binding: FactoryReleaseCheckResult["verified_binding"];
			try {
				const boundInput = db.prepare("SELECT input_id, factory_id, reference, queue_position, bound_version, disposition, brief, brief_bytes, brief_digest, accepted_at, record_digest FROM main.factory_inputs WHERE input_id = ?").get(meta.input_id) as StoredInput | undefined;
				const verifiedInput = boundInput ? validateInputRow(boundInput) : undefined;
				if (verifiedInput && verifiedInput.factory_id === meta.factory_id && verifiedInput.bound_version === meta.bound_version) {
					verified_binding = { factory_id: meta.factory_id, bound_version: meta.bound_version, state_db_path: meta.state_db_path };
				}
			} catch { /* an unverifiable input record leaves the binding unverified */ }
			const attemptFailExtra = {
				release_authorized: attempt.release_authorized === 1,
				attempt_state: attempt.state,
				...(verified_binding ? { verified_binding } : {}),
			};
			if (version === 4) {
				if (meta.bound_version !== "v1") {
					return fail(`Factory bound_version ${meta.bound_version} is incompatible with schema version 4`, attemptFailExtra);
				}
				const rawFactory = db.prepare(
					"SELECT factory_id, name, definition, digest FROM main.factories WHERE factory_id = ?",
				).get(meta.factory_id) as { factory_id: string; name: string; definition: string; digest: string } | undefined;
				if (!rawFactory || sha256Hex(rawFactory.definition) !== rawFactory.digest) {
					return fail(`Factory definition evidence is missing or corrupt for ${meta.factory_id} (v1)`, attemptFailExtra);
				}
				let parsedDef: unknown;
				try { parsedDef = JSON.parse(rawFactory.definition); } catch {
					return fail(`Factory definition JSON is corrupt for ${meta.factory_id} (v1)`, attemptFailExtra);
				}
				if (!parsedDef || typeof parsedDef !== "object" || (parsedDef as { project_cwd?: unknown }).project_cwd !== meta.canonical_checkout) {
					return fail(`Factory bound definition v1 checkout contradicts attempt metadata`, attemptFailExtra);
				}
			} else {
				const rawVer = db.prepare(
					"SELECT factory_id, version, version_num, definition, digest, restored_from_version, created_at, record_digest FROM main.factory_versions WHERE factory_id = ? AND version = ?",
				).get(meta.factory_id, meta.bound_version) as StoredFactoryVersion | undefined;
				if (!rawVer) {
					return fail(`Factory bound version ${meta.bound_version} is missing for ${meta.factory_id}`, attemptFailExtra);
				}
				let verifiedVer: StoredFactoryVersion;
				try {
					verifiedVer = validateFactoryVersionRow(rawVer);
				} catch (error) {
					return fail(errorMessage(error), attemptFailExtra);
				}
				let parsedDef: unknown;
				try { parsedDef = JSON.parse(verifiedVer.definition); } catch {
					return fail(`Factory definition JSON is corrupt for ${meta.factory_id} (${meta.bound_version})`, attemptFailExtra);
				}
				if (!parsedDef || typeof parsedDef !== "object" || (parsedDef as { project_cwd?: unknown }).project_cwd !== meta.canonical_checkout) {
					return fail(`Factory bound definition ${meta.bound_version} checkout contradicts attempt metadata`, attemptFailExtra);
				}
			}
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
			if (inputRow.factory_id !== meta.factory_id || inputRow.bound_version !== meta.bound_version) {
				return fail("Factory input record is missing or mismatched", attemptFailExtra);
			}

			// A settled or operator-cleared attempt no longer owns either hold: its release proof is the attempt, input and run association plus the release marker.
			if (attempt.state === "settled" || attempt.state === "cleared") {
				if (
					attempt.release_authorized !== 1 || inputRow.disposition !== attempt.state
					|| attempt.release_token_digest !== tokenDigest
					|| !attempt.release_nonce_digest || !/^[a-f0-9]{64}$/.test(attempt.release_nonce_digest)
				) return fail(`Contradictory settled or cleared state (attempt=${attempt.state}, input=${inputRow.disposition})`, attemptFailExtra);
				const settledHolds = [
					db.prepare("SELECT 1 AS x FROM main.factory_holds WHERE attempt_id = ?").get(meta.attempt_id),
					db.prepare("SELECT 1 AS x FROM coord.checkout_holds WHERE attempt_id = ?").get(meta.attempt_id),
				];
				if (settledHolds.some(Boolean)) return fail("A settled or cleared attempt still owns a capacity hold", attemptFailExtra);
				const settledRunRaw = db.prepare(
					`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest
					FROM coord.managed_runs WHERE task_id = ?`,
				).get(taskId) as StoredManagedRun | undefined;
				let settledRun: StoredManagedRun | undefined;
				try { settledRun = settledRunRaw ? validateManagedRunRow(settledRunRaw) : undefined; } catch (error) { return fail(errorMessage(error), attemptFailExtra); }
				if (settledRun && (settledRun.request_id_digest !== requestIdDigest || settledRun.factory_id !== meta.factory_id || settledRun.attempt_id !== meta.attempt_id || settledRun.input_id !== meta.input_id || settledRun.canonical_checkout !== meta.canonical_checkout || settledRun.checkout_key !== meta.checkout_key)) {
					return fail("Settled run association is mismatched", attemptFailExtra);
				}
				if (sessionDirRemoved) return fail("Session directory is unavailable to verify release.json", { release_authorized: true, attempt_state: attempt.state });
				if (!releaseMarkerPresent || !markerValid || !parsedMarker) return fail(markerError ?? "Release marker is missing or invalid for a settled attempt", { release_authorized: true, attempt_state: attempt.state });
				if (sha256Hex(parsedMarker.factory_managed.release_nonce) !== attempt.release_nonce_digest) return fail("Invalid release.json marker: Release marker nonce digest mismatch", { release_authorized: true, attempt_state: attempt.state });
				return { kind: "released", release_authorized: true, attempt_state: attempt.state, release_marker_present: true, submitted_brief: inputRow.brief, submitted_brief_digest: inputRow.brief_digest, ...(verified_binding ? { verified_binding } : {}) };
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
			const historicalProof = attempt.state === "proven_not_released" && attempt.release_authorized === 0 && attempt.error === "release permission was never committed" && attempt.release_token_digest === null && attempt.release_nonce_digest === null;
			const historicalAttempt = historicalProof && (fHold.attempt_id !== meta.attempt_id || fHold.input_id !== meta.input_id || fHold.request_id !== meta.request_id || fHold.task_id !== taskId);
			if (!historicalAttempt && (fHold.attempt_id !== meta.attempt_id || fHold.input_id !== meta.input_id || fHold.request_id !== meta.request_id || fHold.task_id !== taskId)) {
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
				|| (!historicalAttempt && (cHold.attempt_id !== meta.attempt_id || cHold.input_id !== meta.input_id || cHold.request_id !== meta.request_id || cHold.task_id !== taskId))
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

			if (historicalAttempt) {
				if (fHold.attempt_id !== cHold.attempt_id || fHold.input_id !== cHold.input_id || fHold.request_id !== cHold.request_id || fHold.task_id !== cHold.task_id || fHold.state !== cHold.state) return fail("Historical non-release proof has no matching current holds", attemptFailExtra);
				const currentRaw = db.prepare(`SELECT attempt_id, factory_id, input_id, bound_version, request_id, task_id, canonical_checkout, checkout_key, state, release_authorized, release_authorized_at, release_token_digest, release_nonce_digest, error, created_at, updated_at, record_digest FROM main.factory_attempts WHERE attempt_id = ?`).get(fHold.attempt_id) as StoredAttempt | undefined;
				if (!currentRaw) return fail("Historical non-release proof has no current attempt", attemptFailExtra);
				let current: StoredAttempt;
				try { current = validateAttemptRow(currentRaw); } catch (error) { return fail(errorMessage(error), attemptFailExtra); }
				const currentIsUnreleased = currentRaw && current.release_authorized === 0 && (current.state === fHold.state || (current.state === "proven_not_released" && fHold.state === "failed_before_release")) && ["reserved", "failed_before_release", "proven_not_released"].includes(current.state);
				const currentIsReleased = currentRaw && current.release_authorized === 1 && current.state === "released" && fHold.state === "released" && cHold.state === "released" && inputRow.disposition === "running";
				if (current.input_id !== meta.input_id || current.factory_id !== meta.factory_id || current.bound_version !== meta.bound_version || current.canonical_checkout !== meta.canonical_checkout || current.checkout_key !== meta.checkout_key || current.request_id !== fHold.request_id || current.task_id !== fHold.task_id || (!currentIsUnreleased && !currentIsReleased) || (!currentIsReleased && inputRow.disposition !== "launching")) return fail("Historical non-release proof conflicts with the current attempt", attemptFailExtra);
				const currentManagedRaw = db.prepare(`SELECT task_id, request_id_digest, factory_id, factory_name, factory_db_path, input_id, attempt_id, canonical_checkout, checkout_key, created_at, record_digest FROM coord.managed_runs WHERE task_id = ?`).get(current.task_id) as StoredManagedRun | undefined;
				if (!currentManagedRaw) return fail("Historical non-release proof has no current managed-run association", attemptFailExtra);
				let currentManaged: StoredManagedRun;
				try { currentManaged = validateManagedRunRow(currentManagedRaw); } catch (error) { return fail(errorMessage(error), attemptFailExtra); }
				if (currentManaged.factory_id !== meta.factory_id || currentManaged.factory_name !== meta.factory_name || currentManaged.factory_db_path !== meta.state_db_path || currentManaged.input_id !== meta.input_id || currentManaged.attempt_id !== current.attempt_id || currentManaged.request_id_digest !== sha256Hex(current.request_id) || currentManaged.canonical_checkout !== meta.canonical_checkout || currentManaged.checkout_key !== meta.checkout_key) return fail("Historical non-release proof has a mismatched current managed-run association", attemptFailExtra);
				if (!releaseMarkerPresent) return { kind: "historical_non_release", release_authorized: false, attempt_state: attempt.state, release_marker_present: false, submitted_brief: inputRow.brief, submitted_brief_digest: inputRow.brief_digest, ...(verified_binding ? { verified_binding } : {}) };
				return fail("Contradictory release marker exists for historical proven non-release", attemptFailExtra);
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
						marker_publication_pending: true,
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
					...(verified_binding ? { verified_binding } : {}),
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
					(attempt.state !== "reserved" && attempt.state !== "failed_before_release" && attempt.state !== "proven_not_released")
					|| attempt.release_token_digest !== null
					|| attempt.release_nonce_digest !== null
					|| inputRow.disposition !== "launching"
					|| fHold.state !== (attempt.state === "proven_not_released" ? "failed_before_release" : attempt.state)
					|| cHold.state !== (attempt.state === "proven_not_released" ? "failed_before_release" : attempt.state)
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
					...(verified_binding ? { verified_binding } : {}),
				};
			}

			return fail(`Invalid SQLite release_authorized value (${attempt.release_authorized})`, {
				attempt_state: attempt.state,
				...(verified_binding ? { verified_binding } : {}),
			});
		} finally {
			db.close();
		}
	} catch (error) {
		return fail(errorMessage(error));
	}
}
