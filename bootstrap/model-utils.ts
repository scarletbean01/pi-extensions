// Shared per-agent model resolution utilities for bootstrap launches.

import { readFileSync } from "node:fs";
import { isRecord } from "./session-store.ts";

export interface ResolvedModel {
	model: string;
	thinking?: string;
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const THINKING_CHOICES = [...THINKING_LEVELS].join(", ");
const FULL_MODEL_ID = /^[^\s/:]+\/[^\s/]+(?:\/[^\s/]+)*$/;

/** Read and validate one optional alias file, normalizing alias names to lowercase. */
export function readModelAliases(path: string): Map<string, ResolvedModel> {
	const invalid = (key: string, reason: string) => new Error(`${path}: "${key}" ${reason}`);
	const aliases = new Map<string, ResolvedModel>();
	let contents: string;
	try {
		contents = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return aliases;
		throw invalid("modelAliases", `could not be read (${(error as Error).message})`);
	}

	let config: unknown;
	try {
		config = JSON.parse(contents);
	} catch (error) {
		throw invalid("modelAliases", `could not be loaded from invalid JSON (${(error as Error).message})`);
	}
	if (!isRecord(config)) throw invalid("modelAliases", "must be inside a JSON object");
	if (config.modelAliases === undefined) return aliases;
	if (!isRecord(config.modelAliases)) throw invalid("modelAliases", "must be an object");

	for (const [name, alias] of Object.entries(config.modelAliases)) {
		const key = `modelAliases.${name}`;
		const normalized = name.toLowerCase();
		if (aliases.has(normalized)) throw invalid(key, "duplicates another alias (names are case-insensitive)");
		if (!isRecord(alias)) throw invalid(key, "must be an object");
		const { model, thinking } = alias;
		if (typeof model !== "string" || !FULL_MODEL_ID.test(model)) throw invalid(`${key}.model`, "must be a full provider/model ID");
		if (thinking !== undefined && (typeof thinking !== "string" || !THINKING_LEVELS.has(thinking))) {
			throw invalid(`${key}.thinking`, `must be one of ${THINKING_CHOICES}`);
		}
		aliases.set(normalized, { model, thinking });
	}
	return aliases;
}

/** Split an optional `:thinking` suffix (as accepted by `pi --model`) from a model spec. */
export function splitModelSpec(spec: string): { model: string; thinking?: string } {
	const index = spec.lastIndexOf(":");
	if (index > 0 && THINKING_LEVELS.has(spec.slice(index + 1).toLowerCase())) return { model: spec.slice(0, index), thinking: spec.slice(index + 1) };
	return { model: spec };
}

/**
 * Whether the model Pi actually selected satisfies the planned spec.
 * Ignores a thinking suffix and accepts a dated snapshot of an undated ID
 * (`claude-haiku-4-5` → `claude-haiku-4-5-20251001`); anything else is a mismatch.
 */
export function modelMatches(expected: string, actual: string): boolean {
	const want = splitModelSpec(expected).model.toLowerCase();
	const got = actual.toLowerCase();
	return got === want || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}$`).test(got);
}

/** Resolve the persona's model and thinking level, inheriting the session model when omitted. */
export function resolveModel(
	persona: { name: string; file: string; model?: string; thinking?: string },
	ctxModel: { provider: string; id: string } | undefined,
	aliases: ReadonlyMap<string, ResolvedModel>,
): ResolvedModel {
	if (persona.thinking !== undefined && !THINKING_LEVELS.has(persona.thinking)) {
		throw new Error(`${persona.file} ("thinking"): expected one of ${THINKING_CHOICES}, got "${persona.thinking}".`);
	}
	const raw = persona.model?.trim();
	if (raw) {
		const { model, thinking: suffix } = splitModelSpec(raw);
		const colon = raw.lastIndexOf(":");
		if (!model.includes("/") && colon >= 0 && suffix === undefined) {
			throw new Error(`${persona.file} ("model"): expected a thinking suffix of ${THINKING_CHOICES}, got "${raw.slice(colon + 1)}".`);
		}
		const thinking = suffix?.toLowerCase() ?? persona.thinking;
		if (model.includes("/")) return { model, thinking };
		const aliased = aliases.get(model.toLowerCase());
		if (aliased) return { model: aliased.model, thinking: thinking ?? aliased.thinking };
		// A typo in an explicit model choice must not silently select another model.
		throw new Error(`${persona.file} ("model"): Unknown model alias "${raw}". Define it in bootstrap.json or use a full provider/model ID.`);
	}
	if (ctxModel) return { model: `${ctxModel.provider}/${ctxModel.id}`, thinking: persona.thinking };
	throw new Error(`${persona.file}: "model" is missing for persona "${persona.name}" and there is no session model to inherit.`);
}
