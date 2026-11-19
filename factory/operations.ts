import { randomUUID } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BootstrapService } from "../bootstrap/lifecycle.ts";
import { validateDraftShape } from "./draft.ts";

type Definition = ReturnType<BootstrapService["prepareDefinition"]>;
type SessionModel = Parameters<BootstrapService["prepareDefinition"]>[1];
type List = { action: "list" };
type Inspect = { action: "inspect"; factory_id: string };
type Publish = { action: "publish"; name: string; draft: unknown; sessionModel?: SessionModel };
export type FactoryRead = List | Inspect;

type Identity = { factory_id: string; name: string };
type Factory = Identity & { current_version: "v1"; management: "unmanaged" };
type Inspection = { factory: Factory; definition: Definition };
type CommitBoundary = (phase: "before_commit" | "after_commit") => void;

function summary(identity: Identity): Factory {
	return { factory_id: identity.factory_id, name: identity.name, current_version: "v1", management: "unmanaged" };
}

function schemaVersion(db: DatabaseSync): number {
	const version = db.prepare("PRAGMA user_version").get()?.user_version;
	if (version !== 0 && version !== 1) throw new Error(`Unsupported factory storage version ${version}`);
	return version;
}

function databaseExists(path: string): boolean {
	try {
		if (!statSync(path).isFile()) throw new Error(`Not a factory database file: ${path}`);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Shared operation boundary. This slice can only create a factory and read its first version. */
export function factoryOperations(path: string, bootstrap: Pick<BootstrapService, "prepareDefinition">, atCommit?: CommitBoundary) {
	function operate(request: List): Factory[];
	function operate(request: Inspect): Inspection;
	function operate(request: Publish): Factory;
	function operate(request: FactoryRead): Factory[] | Inspection;
	function operate(request: FactoryRead | Publish): Factory[] | Inspection | Factory {
		if (request.action === "publish") {
			const name = request.name.trim();
			if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(name)) throw new Error("Factory name must be 1–64 letters, digits, dots, dashes or underscores, starting with a letter or digit");
			validateDraftShape(request.draft);
			const definition = JSON.stringify(bootstrap.prepareDefinition(request.draft, request.sessionModel));
			const identity = { factory_id: randomUUID(), name };
			// Do not depend on the umask for definitions containing private project instructions.
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			try { closeSync(openSync(path, "wx", 0o600)); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !databaseExists(path)) throw error; }
			const directory = openSync(dirname(path), "r");
			try { fsyncSync(directory); } finally { closeSync(directory); }
			const db = new DatabaseSync(path);
			try {
				db.exec("PRAGMA busy_timeout = 5000; PRAGMA synchronous = EXTRA");
				if (db.prepare("PRAGMA journal_mode").get()?.journal_mode !== "delete") throw new Error("Factory storage requires SQLite DELETE journal mode");
				if (db.prepare("PRAGMA synchronous").get()?.synchronous !== 3) throw new Error("Factory storage requires SQLite synchronous=EXTRA");
				db.exec("BEGIN IMMEDIATE");
				if (schemaVersion(db) === 0) db.exec(`
					CREATE TABLE factories (factory_id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE, definition TEXT NOT NULL) STRICT;
					PRAGMA user_version = 1;
				`);
				if (db.prepare("SELECT 1 FROM factories WHERE name = ?").get(name)) throw new Error(`Factory "${name}" is already published; its v1 is unchanged`);
				db.prepare("INSERT INTO factories (factory_id, name, definition) VALUES (?, ?, ?)").run(identity.factory_id, name, definition);
				atCommit?.("before_commit");
				try {
					db.exec("COMMIT");
					atCommit?.("after_commit");
				} catch (error) {
					throw new Error(`Publication outcome uncertain for "${name}" (${identity.factory_id}); inspect with /factory list before retrying: ${error}`);
				}
				return summary(identity);
			} finally { db.close(); }
		}
		if (request.action !== "list" && request.action !== "inspect") throw new Error("Unknown factory operation");
		const missing = () => new Error(`Factory not found: ${request.action === "inspect" ? request.factory_id : ""}`);
		if (!databaseExists(path)) {
			if (request.action === "list") return [];
			throw missing();
		}
		// SQLite may roll back a hot journal after a crash. SQL in this connection cannot mutate factory records.
		const db = new DatabaseSync(path);
		try {
			db.exec("PRAGMA busy_timeout = 5000; PRAGMA query_only = ON; BEGIN");
			if (schemaVersion(db) === 0) {
				if (request.action === "list") return [];
				throw missing();
			}
			if (request.action === "list") return (db.prepare("SELECT factory_id, name FROM factories ORDER BY name").all() as Identity[]).map(summary);
			const row = db.prepare("SELECT factory_id, name, definition FROM factories WHERE factory_id = ?").get(request.factory_id) as (Identity & { definition: string }) | undefined;
			if (!row) throw missing();
			return { factory: summary(row), definition: JSON.parse(row.definition) };
		} finally { db.close(); }
	}
	return operate;
}
