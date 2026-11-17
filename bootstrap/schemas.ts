import { Type } from "@sinclair/typebox";

export const resultFields = {
	status: Type.Union([Type.Literal("success"), Type.Literal("partial"), Type.Literal("failure")]),
	summary: Type.String({ minLength: 1 }),
	detail: Type.String(),
	artifacts: Type.Optional(Type.Array(Type.Object({
		type: Type.Union([Type.Literal("file"), Type.Literal("reference"), Type.Literal("output")]),
		path: Type.Optional(Type.String()),
		action: Type.Optional(Type.Union([Type.Literal("created"), Type.Literal("modified"), Type.Literal("deleted")])),
		description: Type.Optional(Type.String()),
	}))),
	outputs: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "Structured output fields matching any declared stage output_contract" })),
	metrics: Type.Optional(Type.Object({
		files_changed: Type.Optional(Type.Integer({ minimum: 0 })),
		issues_found: Type.Optional(Type.Integer({ minimum: 0 })),
		tests_run: Type.Optional(Type.Integer({ minimum: 0 })),
		tests_passed: Type.Optional(Type.Integer({ minimum: 0 })),
	})),
	warnings: Type.Optional(Type.Array(Type.String())),
	next_steps: Type.Optional(Type.Array(Type.String())),
};

export const outputContractSchema = Type.Object({
	required_fields: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Required property keys inside result.outputs" })),
	properties: Type.Optional(Type.Record(Type.String(), Type.Object({
		type: Type.Union([
			Type.Literal("string"), Type.Literal("number"), Type.Literal("integer"),
			Type.Literal("boolean"), Type.Literal("array"), Type.Literal("object"),
		]),
		required: Type.Optional(Type.Boolean()),
		description: Type.Optional(Type.String()),
		min_length: Type.Optional(Type.Integer({ minimum: 0 })),
		max_length: Type.Optional(Type.Integer({ minimum: 0 })),
		enum: Type.Optional(Type.Array(Type.Union([Type.String(), Type.Number(), Type.Boolean()]))),
	}), { description: "Bounded schema for structured output fields" })),
	require_artifacts: Type.Optional(Type.Boolean({ description: "Require at least one non-missing artifact" })),
	required_artifact_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Specific artifact paths that must exist" })),
	required_checks: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Verification check IDs that must have passing, current evidence" })),
});

export const resultSchema = Type.Object({
	node_id: Type.Optional(Type.String({ minLength: 1, description: "The planned node (assignment) this result belongs to. Required when several nodes use the same persona." })),
	agent_name: Type.Optional(Type.String({ minLength: 1, description: "Persona name; sufficient only when exactly one node uses that persona." })),
	...resultFields,
});
