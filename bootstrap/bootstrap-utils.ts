/**
 * Bootstrap utils — Helpers for persona discovery, frontmatter parsing,
 * session directory setup, and extension path resolution.
 *
 * This is a utility module, NOT a Pi extension. It has no default export
 * and does not register tools. All exports are named.
 *
 * Extension to AgentDef:
 *   - extensions?: string[]   parsed from the `extensions:` CSV frontmatter field
 *   - color?: string          parsed from the `color:` frontmatter field
 * Bootstrap loads the declared extensions into each launched child.
 */

import { readdirSync, readFileSync, existsSync, mkdirSync, lstatSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parsed representation of an agent persona markdown file.
 */
export interface AgentDef {
	name: string;
	description: string;
	/** Raw CSV from `tools:`; empty means no tool restriction. */
	tools: string;
	/** Markdown body of the agent file, with frontmatter stripped. */
	systemPrompt: string;
	/** Absolute path to the source .md file. */
	file: string;
	/** Discovery source label, ".pi" or "~/.pi". */
	source?: string;
	/** Raw frontmatter value for `model:` — alias (e.g. "opus") or provider/id. */
	model?: string;
	/** Raw frontmatter value for `thinking:`. */
	thinking?: string;
	/** Additional extension names or paths from CSV frontmatter. */
	extensions?: string[];
	/** NEW: optional hex color string for coms identity. */
	color?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Frontmatter parsing
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Split a markdown document into its YAML-style frontmatter fields and body.
 *
 * The parser is intentionally minimal: scalar `key: value` lines only. It does
 * NOT support YAML lists or nesting — the agent frontmatter is
 * designed to be flat (with the single exception of CSV values like `tools:`
 * and `extensions:`, which are kept as strings and split by callers).
 * CRLF is normalized and matching enclosing scalar quotes are stripped.
 *
 * If the document has no frontmatter delimiters, the entire input is
 * returned as `body` with empty `fields`.
 */
export function parseFrontmatter(raw: string): { fields: Record<string, string>; body: string } {
	raw = raw.replace(/\r\n/g, "\n");
	const match = raw.match(/^---[ \t]*\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/);
	if (!match) return { fields: {}, body: raw };
	const fields: Record<string, string> = {};
	for (const line of match[1].split("\n")) {
		const idx = line.indexOf(":");
		if (idx > 0) {
			let value = line.slice(idx + 1).trim();
			if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
				value = value.slice(1, -1);
			}
			fields[line.slice(0, idx).trim()] = value;
		}
	}
	return { fields, body: match[2].trim() };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent file scanning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Parse a single agent .md file. Returns null on I/O errors.
 * Missing or empty names fall back to the filename without `.md`.
 */
export function parseAgentFile(filePath: string): AgentDef | null {
	try {
		const raw = readFileSync(filePath, "utf-8");
		const { fields: frontmatter, body } = parseFrontmatter(raw);

		return {
			name: frontmatter.name || basename(filePath, ".md"),
			description: frontmatter.description || "",
			tools: frontmatter.tools || "",
			systemPrompt: body.trim(),
			file: resolve(filePath),
			model: frontmatter.model || undefined,
			...(frontmatter.thinking !== undefined ? { thinking: frontmatter.thinking } : {}),
			color: frontmatter.color || undefined,
			extensions: frontmatter.extensions
				? frontmatter.extensions.split(",").map(s => s.trim()).filter(Boolean)
				: undefined,
		};
	} catch {
		return null;
	}
}

/**
 * Discover personas in deterministic precedence order, first lowercase name wins.
 * Project: .pi/agents. Global: ~/.pi/agent/agents.
 * Filenames within each directory are sorted by code unit, independent of locale.
 */
export function scanAgents(cwd: string, home: string = homedir()): AgentDef[] {
	const dirs: [string, string][] = [
		[join(cwd, ".pi", "agents"), ".pi"],
		[join(home, ".pi", "agent", "agents"), "~/.pi"],
	];

	const agents: AgentDef[] = [];
	const seen = new Set<string>();
	for (const [dir, source] of dirs) {
		try {
			for (const file of readdirSync(dir).sort()) {
				if (!file.endsWith(".md")) continue;
				const def = parseAgentFile(resolve(dir, file));
				if (def && !seen.has(def.name.toLowerCase())) {
					seen.add(def.name.toLowerCase());
					agents.push({ ...def, source });
				}
			}
		} catch {
			// Directory missing or unreadable — skip silently.
		}
	}
	return agents;
}

// ─────────────────────────────────────────────────────────────────────────────
// teams.yaml
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal line-by-line parser for a teams.yaml file of the form:
 *
 *   team-alpha:
 *     - agent1
 *     - agent2
 *   team-beta:
 *     - agent3
 *
 * Returns a flat { teamName: [agentName, ...] } map. Lines that don't match
 * either pattern are ignored (so comments and blank lines are tolerated).
 */
export function parseTeamsYaml(raw: string): Record<string, string[]> {
	const teams: Record<string, string[]> = {};
	let current: string | null = null;
	for (const line of raw.split("\n")) {
		const teamMatch = line.match(/^(\S[^:]*):$/);
		if (teamMatch) {
			current = teamMatch[1].trim();
			teams[current] = [];
			continue;
		}
		const itemMatch = line.match(/^\s+-\s+(.+)$/);
		if (itemMatch && current) {
			teams[current].push(itemMatch[1].trim());
		}
	}
	return teams;
}

/**
 * Load `.pi/agents/teams.yaml` from the project root. Returns an empty object
 * if the file is missing or unreadable.
 */
export function loadTeamsYaml(cwd: string): Record<string, string[]> {
	const teamsPath = join(cwd, ".pi", "agents", "teams.yaml");
	if (!existsSync(teamsPath)) return {};
	try {
		return parseTeamsYaml(readFileSync(teamsPath, "utf-8"));
	} catch {
		return {};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Task IDs and session directories
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a human-readable task id: a slug (max 40 chars) plus a random UUID.
 * The random suffix avoids collisions for simultaneous boots of the same task.
 */
export function generateTaskId(task: string): string {
	const slug = task
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 40)
		.replace(/-+$/g, "") || "task";
	return `${slug}-${randomUUID()}`;
}

/** Task IDs must be a single, nonempty path component on POSIX and Windows. */
function isValidTaskId(taskId: string): boolean {
	return typeof taskId === "string" && taskId.length > 0 && taskId.trim() === taskId
		&& taskId !== "." && taskId !== ".." && !/[/\\:\x00-\x1f\x7f]/.test(taskId);
}

/** lstat deliberately rejects symlinks, including dangling ones. */
function isRealDirectory(dir: string): boolean {
	try {
		return lstatSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Create `.pi/agent-sessions/<taskId>/` and return its absolute path.
 * Idempotent for real directories; rejects unsafe IDs, files, and symlinks.
 * Check each managed parent before creating anything beneath it.
 */
export function ensureSessionDir(cwd: string, taskId: string): string {
	if (!isValidTaskId(taskId)) throw new Error(`Invalid task ID: ${JSON.stringify(taskId)}`);
	const configDir = resolve(cwd, ".pi");
	const sessionsRoot = join(configDir, "agent-sessions");
	const sessionDir = join(sessionsRoot, taskId);
	for (const dir of [configDir, sessionsRoot, sessionDir]) {
		// The run directory holds tokens, personas and task text: keep it private to the user.
		mkdirSync(dir, dir === sessionDir ? { recursive: true, mode: 0o700 } : { recursive: true });
		if (!isRealDirectory(dir)) throw new Error(`Session path is not a real directory: ${dir}`);
	}
	return sessionDir;
}

// ─────────────────────────────────────────────────────────────────────────────
// Session directory resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve an existing real session directory without creating it.
 * Invalid IDs and missing/unsafe directories retain the callers' error shape.
 * Available IDs include only real directories and are sorted deterministically.
 */
export function resolveSessionDir(
	cwd: string,
	taskId: string,
): { sessionDir: string } | { error: string; available: string[]; sessionsRoot: string } {
	const configDir = resolve(cwd, ".pi");
	const sessionsRoot = join(configDir, "agent-sessions");
	const notFound = { error: "session directory not found", available: [] as string[], sessionsRoot };
	if (!isValidTaskId(taskId) || !isRealDirectory(configDir) || !isRealDirectory(sessionsRoot)) {
		return notFound;
	}

	const sessionDir = join(sessionsRoot, taskId);
	if (isRealDirectory(sessionDir)) return { sessionDir };
	try {
		notFound.available = readdirSync(sessionsRoot)
			.filter(id => isValidTaskId(id) && isRealDirectory(join(sessionsRoot, id)))
			.sort();
	} catch {
		// Parent directory unreadable — degrade to an empty list.
	}
	return notFound;
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension path resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve declared extension files, throwing if any declaration cannot be found.
 * Bare/nested names and `./name` resolve under `<cwd>/extensions/`;
 * `extensions/name` (also with `./`) resolves relative to cwd. Absolute paths
 * are honored. Existing suffixes are kept; extensionless names try `.ts` first.
 * Relative names that are not found in the project are then tried, in order,
 * under each `fallbackDirs` entry (e.g. the extensions directory beside a
 * global persona), with any leading `extensions/` segment removed.
 */
export function resolveExtensionPaths(cwd: string, names: string[], fallbackDirs: string[] = []): string[] {
	const extDir = resolve(cwd, "extensions");
	return names.map(name => {
		if (!name.trim()) throw new Error("[bootstrap-utils] empty extension declaration");
		const declared = normalize(name.trim());
		const bases = isAbsolute(declared)
			? [resolve(declared)]
			: [
				resolve(declared.startsWith(`extensions${sep}`) ? cwd : extDir, declared),
				...fallbackDirs.map(dir => resolve(dir, declared.startsWith(`extensions${sep}`) ? declared.slice(`extensions${sep}`.length) : declared)),
			];
		const candidates = [...new Set(bases.flatMap(base => extname(base) ? [base] : [`${base}.ts`, base]))];
		const file = candidates.find(candidate => {
			try {
				return statSync(candidate).isFile();
			} catch {
				return false;
			}
		});
		if (!file) throw new Error(`[bootstrap-utils] extension not found: ${name} (tried ${candidates.join(", ")})`);
		return file;
	});
}
