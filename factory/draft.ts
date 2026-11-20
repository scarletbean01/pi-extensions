import type { GenerateRequest } from "../bootstrap/lifecycle.ts";
import { isRecord } from "../bootstrap/session-store.ts";

// Unlike bootstrap_generate, a draft reaches the planner directly from JSON, not Pi's tool schema.
// Reject unrecognized settings instead of publishing a definition that silently omits them.
const PLAN_KEYS = "topology task goal acceptance_criteria constraints agents project_cwd workspace_strategy collaboration_mode failure_policy coms_extension cleanup cleanup_settle_ms max_total_attempts ready_timeout_ms task_timeout_ms dependency_wait_timeout_ms liveness_timeout_ms cancel_grace_ms";
const NODE_KEYS = "name persona node_id sub_task role ownership read_paths write_paths acceptance_criteria constraints output_contract required_checks step predecessor successor depends_on join_policy dependency_policy task_timeout_ms dependency_wait_timeout_ms decision intervention";
const DECISION_KEYS = "field approve reject on_reject max_revisions on_exhausted";
const CONTRACT_KEYS = "required_fields properties require_artifacts required_artifact_paths required_checks";
const PROPERTY_KEYS = "type required description min_length max_length enum";

function settings(value: unknown, keys: string, label: string): Record<string, unknown> {
	if (!isRecord(value)) throw new Error(`${label} must be an object`);
	const allowed = new Set(keys.split(" "));
	for (const [key, setting] of Object.entries(value)) {
		if (!allowed.has(key)) throw new Error(`${label}: unknown setting ${JSON.stringify(key)}`);
		if (setting === null) throw new Error(`${label}.${key} cannot be null; omit it to use the default`);
	}
	return value;
}

export function validateDraftShape(draft: unknown): asserts draft is GenerateRequest {
	const plan = settings(draft, PLAN_KEYS, "Factory draft");
	if (plan.coms_extension !== undefined && (typeof plan.coms_extension !== "string" || !plan.coms_extension.trim())) {
		throw new Error("coms_extension must be a non-empty path");
	}
	if (!Array.isArray(plan.agents)) throw new Error("Factory draft agents must be an array");
	for (const [index, entry] of plan.agents.entries()) {
		const label = `Node ${isRecord(entry) ? (entry.node_id ?? entry.persona ?? entry.name ?? index + 1) : index + 1}`;
		const node = settings(entry, NODE_KEYS, label);
		for (const field of ["predecessor", "successor"] as const) {
			if (node[field] !== undefined && typeof node[field] !== "string") throw new Error(`${label}.${field} must be a string`);
		}
		if (node.decision !== undefined) settings(node.decision, DECISION_KEYS, `${label}.decision`);
		if (node.output_contract === undefined) continue;
		const contract = settings(node.output_contract, CONTRACT_KEYS, `${label}.output_contract`);
		if (!isRecord(contract.properties)) continue; // Bootstrap validates required types and contract limits.
		for (const [name, field] of Object.entries(contract.properties)) {
			const fieldLabel = `${label}.output_contract.properties.${name}`;
			if (name === "__proto__") throw new Error(`${fieldLabel}: reserved property name`);
			const property = settings(field, PROPERTY_KEYS, fieldLabel);
			if (property.required !== undefined && typeof property.required !== "boolean") throw new Error(`${fieldLabel}.required must be a boolean`);
			if (property.description !== undefined && typeof property.description !== "string") throw new Error(`${fieldLabel}.description must be a string`);
			if (Array.isArray(property.enum) && property.enum.some(value => !(typeof value === "string" || typeof value === "boolean" || Number.isFinite(value)))) {
				throw new Error(`${fieldLabel}.enum must contain strings, booleans or finite numbers`);
			}
		}
	}
}
