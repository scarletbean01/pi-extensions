import { realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { sha256Hex } from "./factory-records.ts";
import { assertNoSymlinkPath, createDurableDirectoryPath, type FactoryManagedInfo } from "./session-store.ts";

// Additive to factory schemas v4/v5: old release readers and standalone runs need
// no migration. Legacy attempts are never backfilled from an observer's index.
const TABLE_SQL = `CREATE TABLE IF NOT EXISTS factory_run_indexes (
	task_id TEXT PRIMARY KEY NOT NULL REFERENCES factory_attempts(task_id),
	binding_digest TEXT NOT NULL,
	index_root TEXT NOT NULL,
	record_digest TEXT NOT NULL
) STRICT`;

function bindingDigest(taskId: string, meta: FactoryManagedInfo): string {
	return sha256Hex(JSON.stringify([
		"factory-run-index-v1", taskId, meta.factory_id, meta.factory_name,
		meta.input_id, meta.attempt_id, meta.request_id, meta.bound_version,
		meta.canonical_checkout, meta.checkout_key, meta.state_db_path, meta.coord_db_path,
	]));
}

function recordDigest(taskId: string, binding: string, root: string): string {
	return sha256Hex(JSON.stringify(["factory-run-index-v1", taskId, binding, root]));
}

/** Only called inside the atomic attempt/hold reservation transaction. */
export function reserveFactoryRunIndex(db: DatabaseSync, taskId: string, meta: FactoryManagedInfo, indexRoot: string): void {
	assertNoSymlinkPath(indexRoot);
	createDurableDirectoryPath(indexRoot);
	const root = realpathSync(indexRoot);
	const binding = bindingDigest(taskId, meta);
	db.exec(TABLE_SQL);
	db.prepare("INSERT INTO factory_run_indexes (task_id, binding_digest, index_root, record_digest) VALUES (?, ?, ?, ?)")
		.run(taskId, binding, root, recordDigest(taskId, binding, root));
}

/** Read-only durable route check using an already-open read-only/transaction SQLite handle on `state_db_path`. */
export function readFactoryRunIndexFromDb(db: DatabaseSync, taskId: string, meta: FactoryManagedInfo): string {
	if (!db.prepare("SELECT 1 FROM main.sqlite_schema WHERE type = 'table' AND name = 'factory_run_indexes'").get()) {
		throw new Error("Missing authoritative factory run index association (legacy history cannot prove non-release)");
	}
	const row = db.prepare("SELECT task_id, binding_digest, index_root, record_digest FROM main.factory_run_indexes WHERE task_id = ?").get(taskId) as
		| { task_id: string; binding_digest: string; index_root: string; record_digest: string }
		| undefined;
	if (!row || row.binding_digest !== bindingDigest(taskId, meta)
		|| typeof row.index_root !== "string" || !isAbsolute(row.index_root)
		|| row.record_digest !== recordDigest(taskId, row.binding_digest, row.index_root)) {
		throw new Error("Missing or damaged authoritative factory run index association");
	}
	assertNoSymlinkPath(row.index_root);
	if (realpathSync(row.index_root) !== row.index_root) throw new Error("Noncanonical authoritative factory run index association");
	return row.index_root;
}

/** Exact, read-only durable route; no cwd, dirname, sidecar or observer fallback. */
export function readFactoryRunIndex(taskId: string, meta: FactoryManagedInfo): string {
	assertNoSymlinkPath(meta.state_db_path);
	const db = new DatabaseSync(meta.state_db_path, { readOnly: true });
	try {
		db.exec("PRAGMA query_only = ON; BEGIN");
		return readFactoryRunIndexFromDb(db, taskId, meta);
	} finally { db.close(); }
}
