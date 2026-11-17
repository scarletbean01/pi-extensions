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
	metrics: Type.Optional(Type.Object({
		files_changed: Type.Optional(Type.Integer({ minimum: 0 })),
		issues_found: Type.Optional(Type.Integer({ minimum: 0 })),
		tests_run: Type.Optional(Type.Integer({ minimum: 0 })),
		tests_passed: Type.Optional(Type.Integer({ minimum: 0 })),
	})),
	warnings: Type.Optional(Type.Array(Type.String())),
	next_steps: Type.Optional(Type.Array(Type.String())),
};

export const resultSchema = Type.Object({
	node_id: Type.Optional(Type.String({ minLength: 1, description: "The planned node (assignment) this result belongs to. Required when several nodes use the same persona." })),
	agent_name: Type.Optional(Type.String({ minLength: 1, description: "Persona name; sufficient only when exactly one node uses that persona." })),
	...resultFields,
});
