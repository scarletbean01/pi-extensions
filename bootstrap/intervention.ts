/** A node's opt-in to human direction: the plan choices a person may be offered. */
import { isRecord } from "./session-store.ts";

export interface InterventionChoice { choice_id: string; label: string; route?: "approve" }
export interface InterventionPolicy { choices: InterventionChoice[]; required?: string[]; require_route?: true }

const CHOICE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
export const MAX_INTERVENTION_CHOICES = 16;

function only(value: Record<string, unknown>, keys: string[], label: string): void {
	for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${label}: unknown setting ${JSON.stringify(key)}`);
}

/** Validate and normalize a node's `intervention` setting, naming the node and setting on failure. */
export function validateInterventionPolicy(raw: unknown, nodeId: string): InterventionPolicy {
	const label = `Node ${nodeId} intervention`;
	if (!isRecord(raw)) throw new Error(`${label} must be an object`);
	only(raw, ["choices", "required", "require_route"], label);
	if (raw.require_route !== undefined && typeof raw.require_route !== "boolean") throw new Error(`${label}.require_route must be a boolean`);
	if (!Array.isArray(raw.choices) || raw.choices.length < 1 || raw.choices.length > MAX_INTERVENTION_CHOICES) {
		throw new Error(`${label}.choices must list 1 to ${MAX_INTERVENTION_CHOICES} choices`);
	}
	const seen = new Set<string>();
	const choices = raw.choices.map((entry: unknown, index: number): InterventionChoice => {
		if (!isRecord(entry)) throw new Error(`${label}.choices[${index}] must be an object`);
		only(entry, ["choice_id", "label", "route"], `${label}.choices[${index}]`);
		if (entry.route !== undefined && entry.route !== "approve") throw new Error(`${label}.choices[${index}].route must be "approve"`);
		if (typeof entry.choice_id !== "string" || !CHOICE_ID.test(entry.choice_id)) throw new Error(`${label}.choices[${index}].choice_id must be 1-64 letters, digits, dots, dashes or underscores`);
		if (typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 200) throw new Error(`${label}.choices[${index}].label must be 1-200 characters`);
		if (seen.has(entry.choice_id)) throw new Error(`${label}.choices has a duplicate choice_id ${JSON.stringify(entry.choice_id)}`);
		seen.add(entry.choice_id);
		return { choice_id: entry.choice_id, label: entry.label, ...(entry.route === "approve" ? { route: entry.route } : {}) };
	});
	let required: string[] | undefined;
	if (raw.required !== undefined) {
		if (!Array.isArray(raw.required) || raw.required.some(id => typeof id !== "string")) throw new Error(`${label}.required must be a list of choice IDs`);
		for (const id of raw.required as string[]) if (!seen.has(id)) throw new Error(`${label}.required names ${JSON.stringify(id)}, which is not one of its choices`);
		if (raw.required.length) required = [...new Set(raw.required as string[])];
	}
	if (raw.require_route && !choices.some(choice => choice.route)) throw new Error(`${label}.require_route requires a routing choice`);
	return { choices, ...(required ? { required } : {}), ...(raw.require_route ? { require_route: true } : {}) };
}
