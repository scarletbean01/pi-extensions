import { basename } from "node:path";
import type { AttentionItem, CapacityView, HeadStatus, Inspection } from "../operations.ts";
import { requiredChecksOf } from "../../bootstrap/evidence.ts";
import { inboundEdgesOf } from "../../bootstrap/session-store.ts";

export type TypedAbsence = "no records" | "not applicable" | "evidence unavailable";

export interface AbsentValue {
	absence: TypedAbsence;
	explanation: string;
}

export interface InspectTargetQuery {
	node?: string;
	targetFactory?: string;
	notRetained?: boolean;
}

const NODE_ID = /^[A-Za-z0-9_-]{1,128}$/;
type RetainedAgent = NonNullable<Inspection["definition"]>["agents"][number];

const NOT_FROZEN_DESCRIPTIONS: Record<string, { label: string; explanation: string }> = {
	pi_runtime: { label: "Pi runtime", explanation: "The live Pi runtime version and executable on PATH are not frozen in the definition." },
	live_tool_availability: { label: "Live tool availability", explanation: "Inherited tools depend on what Pi discovers at launch time." },
	live_skill_availability: { label: "Live skill availability", explanation: "Inherited skills depend on what Pi discovers at launch time." },
	extension_and_skill_contents: { label: "Extension and skill contents", explanation: "Extension and skill file contents on disk are not snapshotted in the definition." },
	provider_catalog_and_credentials: { label: "Provider catalog and credentials", explanation: "Model provider availability and credentials are live runtime inputs." },
	checkout_contents: { label: "Checkout contents", explanation: "Repository working tree contents in the target checkout are not frozen." },
};

const HEAD_BLOCK_MESSAGES: Record<NonNullable<HeadStatus["blocking_kind"]>, string> = {
	empty: "No queued input is waiting to launch.",
	unmanaged: "The factory is unmanaged; resume management in Pi before admitting or launching work.",
	stopped: "New launches are paused by the factory stop fence.",
	factory_held: "A launch attempt currently holds this factory's run slot.",
	checkout_held: "A launch attempt currently holds the target checkout slot.",
	preflight: "The queue head's bound definition did not pass live launch prerequisites.",
	compatibility: "A retained launch prerequisite is incompatible with the current runtime.",
	ceiling: "The bound definition exceeds a configured revision or attempt ceiling.",
	uncertain: "Launch or capacity evidence could not be verified; resolve uncertainty in Pi before launching.",
};

const HOLD_SCOPE_EXPLANATIONS: Record<NonNullable<CapacityView["blocking_hold"]>["scope"], string> = {
	both: "Both this factory's run slot and the target checkout slot are held.",
	factory: "This factory's run slot is held.",
	checkout: "The target checkout slot is held by another factory or an orphaned run.",
};

const HOLD_STATE_EXPLANATIONS: Record<string, string> = {
	reserved: "Launch reserved capacity before release authorization.",
	released: "Run was released and holds capacity until settlement or operator clearance.",
	failed_before_release: "Launch failed before release and still holds capacity until non-release is settled.",
	uncertain: "Hold state is uncertain and blocks new launches until resolved.",
};

const ATTEMPT_STATE_EXPLANATIONS: Record<string, string> = {
	reserved: "Launch reserved capacity and is preparing to release.",
	released: "Run was released to execute and currently holds capacity until settled or cleared.",
	failed_before_release: "Launch failed before release; non-release has not been settled yet.",
	proven_not_released: "Historical attempt was proven never to have released.",
	settled: "Run execution settled and its capacity holds were released.",
	cleared: "Capacity holds were cleared by an operator while original execution effects remain unresolved.",
};

const DISPOSITION_EXPLANATIONS: Record<string, string> = {
	queued: "Admitted and waiting in the FIFO queue.",
	launching: "Currently attempting to launch a run.",
	running: "Bound to an active released run.",
	settled: "Finished and settled.",
	discarded: "Discarded by operator before completion.",
	cleared: "Retired from launch eligibility via operator clearance.",
};

const ATTENTION_META: Record<AttentionItem["kind"], { label: string; detailView: "queue" | "requests" | "proposals"; explanation: string }> = {
	failed_run: {
		label: "Failed run",
		detailView: "queue",
		explanation: "A launch or run failed and requires operator review in Pi.",
	},
	uncertain: {
		label: "Uncertain evidence",
		detailView: "queue",
		explanation: "Factory, run, or capacity evidence could not be fully verified and requires review in Pi.",
	},
	intervention: {
		label: "Direction or exhaustion request",
		detailView: "requests",
		explanation: "A node or review loop is waiting for human direction or exhaustion review in Pi.",
	},
	constraint_proposal: {
		label: "Constraint proposal",
		detailView: "proposals",
		explanation: "A learned-constraint proposal is pending human confirmation in Pi.",
	},
	report_notice: {
		label: "Report notice",
		detailView: "queue",
		explanation: "Per-node attempt or rollback count evidence for a run could not be verified.",
	},
};

export function inspectLink(factory: string, version: string, node?: string) {
	return `/?${new URLSearchParams({ factory, view: "inspect", version, ...(node ? { node } : {}) })}`;
}

export function inspectSnapshotLink(factory: string, version: string, node?: string) {
	const params = new URLSearchParams({ version, ...(node ? { node } : {}) });
	return `/api/factories/${encodeURIComponent(factory)}/inspect?${params}`;
}

export function headSummary(head: HeadStatus): Record<string, unknown> {
	const isUnmanaged = head.blocking_kind === "unmanaged";
	const explanation = head.blocking_kind
		? HEAD_BLOCK_MESSAGES[head.blocking_kind]
		: "No blocker was observed in read-only launch preflight.";
	return {
		eligible: head.eligible,
		blocking_kind: head.blocking_kind,
		input_id: head.input_id,
		reference: head.reference,
		bound_version: head.bound_version,
		blocker: head.blocking_kind
			? { kind: head.blocking_kind, explanation }
			: { absence: "not applicable" as const, explanation },
		input: head.input_id
			? { input_id: head.input_id, reference: head.reference, bound_version: head.bound_version }
			: {
				absence: (isUnmanaged ? "not applicable" : "no records") as TypedAbsence,
				explanation: isUnmanaged ? "Queue head input evaluation applies only to a managed factory." : "No queued input is waiting to launch.",
			},
		explanation,
		...(head.without_control_fence ? { without_control_fence: headSummary(head.without_control_fence) } : {}),
	};
}

function summarizeManagement(management: Inspection["factory"]["management"]) {
	return management === "managed"
		? { state: "managed" as const, explanation: "This factory has a durable management record and accepts queue admissions and launches." }
		: { state: "unmanaged" as const, explanation: "This factory is unmanaged; queue admission and launches require /factory resume in Pi." };
}

function summarizeStopState(value: Inspection) {
	if (value.control_error) {
		return { absence: "evidence unavailable" as const, explanation: "Factory stop state evidence is damaged or unreadable." };
	}
	if (value.stopped === undefined) {
		return { absence: "not applicable" as const, explanation: "Stop state applies only to a managed factory." };
	}
	return value.stopped
		? { stopped: true, state: "stopped" as const, explanation: "The factory stop fence is active; new admissions and launches are paused until resumed." }
		: { stopped: false, state: "active" as const, explanation: "The factory stop fence is clear; admissions and launches are not paused by a stop control." };
}

function summarizeCapacity(value: Inspection) {
	const cap = value.capacity;
	if (!cap) {
		return { absence: "evidence unavailable" as const, explanation: "Factory capacity evidence is unavailable." };
	}
	const isUnmanaged = value.factory.management === "unmanaged";
	const queue = isUnmanaged && cap.queue_used === 0
		? { used: cap.queue_used, limit: cap.queue_limit, absence: "not applicable" as const, explanation: "Queue admission applies only to a managed factory." }
		: { used: cap.queue_used, limit: cap.queue_limit, explanation: `${cap.queue_used} of ${cap.queue_limit} queue slots are in use.` };

	const factorySlot = {
		state: cap.factory_slot,
		...(cap.factory_slot === "uncertain" ? { absence: "evidence unavailable" as const } : {}),
		explanation: cap.factory_slot === "free"
			? "Factory run slot is free."
			: cap.factory_slot === "held"
				? "Factory run slot is held by an active or un-settled launch attempt."
				: "Factory run slot state is uncertain because launch, release, or hold evidence could not be fully verified.",
	};

	const hold = cap.blocking_hold;
	const blockingHold = hold
		? {
			scope: hold.scope,
			scope_explanation: HOLD_SCOPE_EXPLANATIONS[hold.scope],
			factory_id: hold.factory_id,
			...(hold.factory_name ? { factory_name: hold.factory_name } : {}),
			input_id: hold.input_id,
			attempt_id: hold.attempt_id,
			...(hold.request_id ? { request_id: hold.request_id } : {}),
			task_id: hold.task_id,
			state: hold.state,
			state_explanation: HOLD_STATE_EXPLANATIONS[hold.state] ?? "A recorded hold state affects capacity.",
			...(hold.release_authorized !== undefined ? { release_authorized: hold.release_authorized } : {}),
			held_at: hold.held_at,
			explanation: hold.factory_id === value.factory.factory_id
				? `${HOLD_SCOPE_EXPLANATIONS[hold.scope]} Held by attempt ${hold.attempt_id} (run ${hold.task_id}).`
				: `Target checkout is held by factory "${hold.factory_name ?? hold.factory_id}" (${hold.factory_id}, attempt ${hold.attempt_id}, run ${hold.task_id}).`,
		}
		: (cap.factory_slot === "uncertain" || cap.checkout_slot === "uncertain")
			? { absence: "evidence unavailable" as const, explanation: "Blocking hold details could not be verified because capacity evidence is uncertain." }
			: { absence: "no records" as const, explanation: "No capacity hold is recorded for this factory or its checkout." };

	const checkoutSlot = {
		state: cap.checkout_slot,
		...(cap.checkout_slot === "uncertain" ? { absence: "evidence unavailable" as const } : {}),
		explanation: cap.checkout_slot === "free"
			? "Target checkout slot is free."
			: cap.checkout_slot === "held"
				? (hold && hold.factory_id !== value.factory.factory_id
					? `Target checkout slot is held by factory "${hold.factory_name ?? hold.factory_id}" (${hold.factory_id}).`
					: "Target checkout slot is held by an active or un-settled launch attempt.")
				: "Target checkout slot state is uncertain because coordination, hold, or checkout evidence could not be verified.",
	};

	return {
		queue_used: cap.queue_used,
		queue_limit: cap.queue_limit,
		queue,
		factory_slot: factorySlot,
		checkout_slot: checkoutSlot,
		blocking_hold: blockingHold,
	};
}

function summarizeAttention(value: Inspection, factoryId: string) {
	const rawItems: AttentionItem[] = [...(value.attention ?? [])];
	if (value.factory.management === "unmanaged" && value.attention === undefined && (value.uncertainty ?? []).length > 0) {
		rawItems.push({ kind: "uncertain", reason: "Uncertain evidence on unmanaged factory." });
	}
	if (rawItems.length > 0) {
		const items = rawItems.map(item => {
			const meta = ATTENTION_META[item.kind];
			return {
				kind: item.kind,
				label: meta.label,
				explanation: meta.explanation,
				detail_view: meta.detailView,
				detail_url: `/api/factories/${encodeURIComponent(factoryId)}/${meta.detailView}`,
				...(item.input_id ? { input_id: item.input_id } : {}),
				...(item.attempt_id ? { attempt_id: item.attempt_id } : {}),
				...(item.task_id ? { task_id: item.task_id } : {}),
				...(item.request_id ? { request_id: item.request_id } : {}),
				...(item.proposal_id ? { proposal_id: item.proposal_id } : {}),
			};
		});
		return {
			count: items.length,
			items,
			explanation: `${items.length} item(s) require operator attention in Pi.`,
		};
	}
	if (value.factory.management === "unmanaged") {
		return {
			count: 0,
			items: [] as never[],
			absence: "not applicable" as const,
			explanation: "Managed outstanding-attention tracking applies only to a managed factory.",
		};
	}
	return {
		count: 0,
		items: [] as never[],
		absence: "no records" as const,
		explanation: "No outstanding attention items are recorded.",
	};
}

function nodeLink(knownIds: ReadonlySet<string>, factoryId: string, version: string, target: string) {
	if (!NODE_ID.test(target) || !knownIds.has(target)) {
		return { absence: "evidence unavailable" as const, explanation: "This relationship target cannot be verified in the inspected version." };
	}
	return {
		factory_id: factoryId,
		version,
		node_id: target,
		anchor: `node-${target}`,
		href: inspectLink(factoryId, version, target),
		snapshot_url: inspectSnapshotLink(factoryId, version, target),
	};
}

function relationship(knownIds: ReadonlySet<string>, factoryId: string, version: string, label: string, value: string | readonly string[] | undefined) {
	if (value === undefined) return { label, absence: "not applicable" as const };
	const values = Array.isArray(value) ? value : [value];
	return { label, targets: values.map(target => nodeLink(knownIds, factoryId, version, target)) };
}

function projectAgentPolicies(agentEntry: Exclude<RetainedAgent, { kind: "command" }>) {
	const tools = agentEntry.tools.mode === "declared"
		? { mode: "declared" as const, names: [...agentEntry.tools.names], explanation: `Declared tools: ${agentEntry.tools.names.join(", ")}.` }
		: {
			mode: "inherit" as const,
			names: { absence: "not applicable" as const, explanation: "Inherited tools are resolved from live Pi runtime availability at launch." },
			explanation: "Inherits live Pi runtime tool availability at launch.",
		};
	const skills = agentEntry.skills.mode === "declared"
		? (agentEntry.skills.names.length > 0
			? { mode: "declared" as const, names: [...agentEntry.skills.names], explanation: `Advertises declared skills: ${agentEntry.skills.names.join(", ")}.` }
			: {
				mode: "declared" as const,
				names: { absence: "no records" as const, explanation: "Explicitly advertises no skills." },
				explanation: "Explicitly advertises no skills.",
			})
		: {
			mode: "inherit" as const,
			names: { absence: "not applicable" as const, explanation: "Inherited skills are discovered from live Pi runtime availability at launch." },
			explanation: "Inherits live Pi runtime skill availability at launch.",
		};
	const extensions = {
		mode: agentEntry.extensions.mode,
		declared: agentEntry.extensions.declared.length > 0
			? agentEntry.extensions.declared.map(ext => (ext.includes("/") || ext.includes("\\")) ? basename(ext) : ext)
			: { absence: "no records" as const, explanation: "No extra extensions declared beyond inherited live Pi extensions." },
		explanation: "Inherits live Pi extensions plus any declared additions.",
	};
	return { tools, skills, extensions };
}

function projectNode(knownIds: ReadonlySet<string>, factoryId: string, version: string, entry: RetainedAgent, definition: NonNullable<Inspection["definition"]>) {
	const { node: n } = entry;
	const id = n.node_id;
	const isCommand = n.kind === "command" || ("kind" in entry && entry.kind === "command");
	const agentEntry = isCommand ? undefined : (entry as Exclude<RetainedAgent, { kind: "command" }>);
	const decision = agentEntry?.decision;
	const inbound = inboundEdgesOf(n);
	const dependencyPolicy = inbound.length > 0
		? (() => {
			const policy = n.dependency_policy ?? "allow_partial";
			return {
				policy,
				explanation: policy === "require_success"
					? "Requires every inbound dependency to succeed before starting."
					: "Allows partial or completed inbound dependencies.",
			};
		})()
		: { absence: "not applicable" as const, explanation: "Root node has no inbound dependencies." };
	const joinPolicy = inbound.length > 1
		? (() => {
			const policy = n.join_policy ?? "all_success";
			return {
				policy,
				sources: inbound.map(dep => nodeLink(knownIds, factoryId, version, dep)),
				explanation: policy === "all_success"
					? `Join across ${inbound.join(", ")} requires all inbound dependencies to succeed.`
					: `Join across ${inbound.join(", ")} allows partial upstream outcomes.`,
			};
		})()
		: { absence: "not applicable" as const, explanation: "Join policy applies only to nodes with two or more inbound dependencies." };
	const interventionPolicy = n.intervention
		? {
			enabled: true,
			require_route: Boolean(n.intervention.require_route),
			choices: n.intervention.choices.map(c => ({ choice_id: c.choice_id, label: c.label, ...(c.route ? { route: c.route } : {}) })),
			explanation: `Human direction enabled with ${n.intervention.choices.length} choice(s).`,
		}
		: { absence: "not applicable" as const, explanation: "Human direction intervention is not configured on this node." };
	const runtimePolicies = agentEntry
		? projectAgentPolicies(agentEntry)
		: {
			tools: { absence: "not applicable" as const, explanation: "Command nodes do not configure Pi tools." },
			skills: { absence: "not applicable" as const, explanation: "Command nodes do not advertise Pi skills." },
			extensions: { absence: "not applicable" as const, explanation: "Command nodes do not load Pi extensions." },
		};
	const checks = requiredChecksOf(n);
	const relationships = [
		relationship(knownIds, factoryId, version, "Dependencies", inbound.length ? inbound : undefined),
		...(inbound.length > 1 ? [{ ...relationship(knownIds, factoryId, version, "Join", inbound), policy: n.join_policy ?? "all_success" }] : []),
		relationship(knownIds, factoryId, version, "Feedback target", decision?.on_reject),
	];
	const feedbackLink = decision ? nodeLink(knownIds, factoryId, version, decision.on_reject) : undefined;
	const verifiedFeedback = feedbackLink !== undefined && "node_id" in feedbackLink;
	return {
		id,
		anchor: `node-${id}`,
		kind: isCommand ? "command" : "agent",
		kind_explanation: isCommand
			? "Deterministic command node (runs without a Pi session or language model)."
			: "Agent node (runs a Pi session from its resolved persona).",
		persona: agentEntry
			? { name: agentEntry.persona_name, explanation: `Resolved from persona "${agentEntry.persona_name}".` }
			: { absence: "not applicable" as const, explanation: "Command nodes execute a command directly without a persona." },
		model: agentEntry
			? { id: agentEntry.model, thinking: agentEntry.thinking, explanation: `Model ${agentEntry.model} with thinking level "${agentEntry.thinking}".` }
			: { absence: "not applicable" as const, explanation: "Command nodes do not use a language model." },
		command: isCommand
			? { executable: n.command, args: [...(n.args ?? [])], explanation: "Deterministic spawn argv command." }
			: { absence: "not applicable" as const, explanation: "Agent nodes run a Pi session rather than a direct command." },
		policies: {
			...runtimePolicies,
			dependency: dependencyPolicy,
			join: joinPolicy,
			intervention: interventionPolicy,
			...(decision ? { max_revisions: decision.max_revisions, on_exhausted: decision.on_exhausted } : {}),
		},
		dependencies: inbound.length > 0
			? {
				count: inbound.length,
				items: inbound.map(dep => nodeLink(knownIds, factoryId, version, dep)),
				policy: n.dependency_policy ?? "allow_partial",
				explanation: `Depends on ${inbound.join(", ")}.`,
			}
			: { count: 0, items: [] as never[], absence: "not applicable" as const, explanation: "This node has no inbound dependencies." },
		join: inbound.length > 1
			? joinPolicy
			: { absence: "not applicable" as const, explanation: "This node is not a join (fewer than two inbound dependencies)." },
		decision: decision
			? {
				field: decision.field,
				approve: decision.approve,
				reject: decision.reject,
				feedback_target: verifiedFeedback ? decision.on_reject : feedbackLink,
				feedback_target_link: feedbackLink,
				loop_body: [...decision.loop_body],
				loop_body_links: decision.loop_body.map(member => nodeLink(knownIds, factoryId, version, member)),
				max_revisions: decision.max_revisions,
				max_revisions_source: decision.max_revisions_source,
				on_exhausted: decision.on_exhausted,
				explanation: verifiedFeedback
					? `Routes on "${decision.field}": "${decision.approve}" approves; "${decision.reject}" feeds back to "${decision.on_reject}" (max ${decision.max_revisions} revisions, on exhausted: ${decision.on_exhausted}).`
					: `Routes on "${decision.field}": "${decision.approve}" approves; "${decision.reject}" feedback target could not be verified in ${version} (max ${decision.max_revisions} revisions, on exhausted: ${decision.on_exhausted}).`,
			}
			: { absence: "not applicable" as const, explanation: "This node is not a decision node." },
		feedback_target: feedbackLink
			? (verifiedFeedback
				? { ...feedbackLink, explanation: `Rejection routes back to "${decision!.on_reject}".` }
				: feedbackLink)
			: { absence: "not applicable" as const, explanation: "Only decision nodes have a feedback target." },
		required_checks: checks.length > 0
			? { count: checks.length, items: checks, explanation: `Requires checks: ${checks.join(", ")}.` }
			: { count: 0, items: [] as never[], absence: "no records" as const, explanation: "No required verification checks are configured on this node." },
		limits: {
			task_timeout_ms: n.task_timeout_ms !== undefined
				? { value: n.task_timeout_ms, inherited: false, explanation: `Node task timeout is ${n.task_timeout_ms} ms.` }
				: definition.task_timeout_ms !== null && definition.task_timeout_ms !== undefined
					? { value: definition.task_timeout_ms, inherited: true, explanation: `Inherits definition task timeout of ${definition.task_timeout_ms} ms.` }
					: { absence: "no records" as const, explanation: "No task timeout is configured for this node or its definition." },
			dependency_wait_timeout_ms: inbound.length === 0
				? { absence: "not applicable" as const, explanation: "Dependency wait timeout applies only to nodes with inbound dependencies." }
				: n.dependency_wait_timeout_ms !== undefined
					? { value: n.dependency_wait_timeout_ms, inherited: false, explanation: `Node dependency wait timeout is ${n.dependency_wait_timeout_ms} ms.` }
					: { value: definition.dependency_wait_timeout_ms, inherited: true, explanation: `Inherits definition dependency wait timeout of ${definition.dependency_wait_timeout_ms} ms.` },
		},
		relationships,
	};
}

function summarizeRuntimeAssumptions(assumptions: Inspection["runtime_assumptions"]) {
	const notFrozen = assumptions.not_frozen.map(key => {
		const desc = NOT_FROZEN_DESCRIPTIONS[key];
		return {
			key,
			label: desc?.label ?? key.replaceAll("_", " "),
			explanation: desc?.explanation ?? "This runtime input is resolved live at launch rather than frozen in the definition.",
		};
	});
	return {
		evidence: "available" as const,
		not_frozen: notFrozen,
		note: assumptions.note,
	};
}

function summarizeVersions(value: Inspection) {
	return value.versions.map(v => {
		const damaged = Boolean(v.corrupt_reason);
		const restoredFrom = damaged
			? { absence: "evidence unavailable" as const, explanation: "Restore provenance cannot be verified because the version record is damaged." }
			: v.restored_from_version
				? { version: v.restored_from_version, explanation: `Restored from ${v.restored_from_version}.` }
				: { absence: "not applicable" as const, explanation: "Original publication; not restored from an earlier version." };
		return {
			version: v.version,
			current: v.version === value.factory.current_version,
			inspected: v.version === value.inspected_version,
			digest: v.digest ? v.digest : { absence: "evidence unavailable" as const, explanation: "Version digest is unavailable because the record is damaged." },
			created_at: v.created_at ?? {
				absence: (damaged ? "evidence unavailable" : "not applicable") as TypedAbsence,
				explanation: damaged ? "Creation timestamp is unavailable because the version record is damaged." : "Creation timestamp was not recorded on legacy schema v1.",
			},
			restored_from: restoredFrom,
			evidence: damaged ? ("unavailable" as const) : ("available" as const),
			...(damaged ? { absence: "evidence unavailable" as const } : {}),
			explanation: damaged
				? "The retained definition record is damaged or unreadable."
				: v.restored_from_version
					? `Retained definition ${v.version} (restored from ${v.restored_from_version}) is verified.`
					: `Retained definition ${v.version} is verified.`,
		};
	});
}

function summarizeDamagedRecords(value: Inspection) {
	const items: Array<Record<string, unknown>> = [];
	const corruptVersions = new Set<string>();
	for (const v of value.versions) {
		if (v.corrupt_reason) {
			corruptVersions.add(v.version);
			items.push({
				scope: "definition_version",
				version: v.version,
				absence: "evidence unavailable",
				explanation: `Retained definition ${v.version} is damaged or unreadable.`,
			});
		}
	}
	if (value.current_error && !corruptVersions.has(value.factory.current_version)) {
		items.push({
			scope: "current_definition",
			version: value.factory.current_version,
			absence: "evidence unavailable",
			explanation: "Current definition evidence is damaged or unreadable.",
		});
	}
	if (value.inspected_error && value.inspected_version !== value.factory.current_version && !corruptVersions.has(value.inspected_version)) {
		items.push({
			scope: "inspected_definition",
			version: value.inspected_version,
			absence: "evidence unavailable",
			explanation: "Selected definition evidence is damaged or unreadable.",
		});
	}
	if (value.control_error) {
		items.push({ scope: "stop_control", absence: "evidence unavailable", explanation: "Factory stop state evidence is damaged or unreadable." });
	}
	if (value.request_evidence_error) {
		items.push({ scope: "requests", absence: "evidence unavailable", explanation: "Direction request evidence is damaged or unreadable." });
	}
	if (value.proposal_evidence_error) {
		items.push({ scope: "proposals", absence: "evidence unavailable", explanation: "Constraint proposal evidence is damaged or unreadable." });
	}
	if ((value.uncertainty ?? []).length > 0) {
		items.push({ scope: "launch_or_capacity", absence: "evidence unavailable", explanation: "Launch, run, or capacity hold evidence has missing or contradictory records." });
	}
	for (const a of value.attempts) {
		if (a.uncertainty?.length) {
			items.push({ scope: "attempt", attempt_id: a.attempt_id, absence: "evidence unavailable", explanation: `Attempt ${a.attempt_id} has missing, damaged, or contradictory evidence.` });
		}
		if (a.node_counts_error) {
			items.push({ scope: "attempt_node_counts", attempt_id: a.attempt_id, absence: "evidence unavailable", explanation: `Per-node attempt count evidence for ${a.attempt_id} is unavailable.` });
		}
	}
	if (items.length === 0) {
		return {
			count: 0,
			items: [] as never[],
			absence: "no records" as const,
			explanation: "No damaged or unavailable records were observed in this inspection.",
		};
	}
	return {
		count: items.length,
		items,
		explanation: `${items.length} damaged or unavailable record area(s) were observed.`,
	};
}

function summarizeOperationEvidence(
	value: Inspection,
	factoryId: string,
	versionRecords: ReturnType<typeof summarizeVersions>,
	capacity: ReturnType<typeof summarizeCapacity>,
	queueHead: ReturnType<typeof headSummary>,
	attention: ReturnType<typeof summarizeAttention>,
) {
	const encodedId = encodeURIComponent(factoryId);
	const queueUrl = `/api/factories/${encodedId}/queue`;
	const requestsUrl = `/api/factories/${encodedId}/requests`;
	const proposalsUrl = `/api/factories/${encodedId}/proposals`;
	const isUnmanaged = value.factory.management === "unmanaged";
	const queueByInputId = new Map(value.queue.map(q => [q.input_id, q]));
	const versionByName = new Map(versionRecords.map(v => [v.version, v]));

	const attemptsList = value.attempts.map(a => {
		const queueEntry = queueByInputId.get(a.input_id);
		const reference = queueEntry?.reference;
		const settlement = a.settlement
			? {
				outcome: a.settlement.outcome,
				execution_settlement: a.settlement.execution_settlement.state,
				cancellation_intent: a.settlement.cancellation.intent,
				resource_closure: a.settlement.resource_closure.state,
				capacity_release: a.settlement.capacity_release,
				...(a.settlement.settled_at ? { settled_at: a.settlement.settled_at } : {}),
				explanation: `Outcome: ${a.settlement.outcome}; execution settlement: ${a.settlement.execution_settlement.state}; capacity: ${a.settlement.capacity_release}.`,
			}
			: !a.release_authorized
				? { absence: "not applicable" as const, explanation: "Settlement applies only after a launch is authorized for release." }
				: a.state === "settled" || a.state === "cleared"
					? {
						absence: "evidence unavailable" as const,
						explanation: a.state === "settled"
							? "Settled attempt is missing a readable settlement record."
							: "Cleared attempt is missing a readable settlement or clearance record.",
					}
					: {
						absence: "no records" as const,
						explanation: "No durable settlement record has been recorded yet while the released run is in-flight; passive inspection does not load live run status.",
					};
		const clearance = a.clearance
			? {
				cleared: true,
				cleared_at: a.clearance.cleared_at,
				prior_input_disposition: a.clearance.prior_input_disposition,
				acknowledged_unknown_effects: a.clearance.acknowledged_unknown_effects,
				explanation: `Capacity holds cleared by operator at ${a.clearance.cleared_at}; original execution effects remain unresolved.`,
			}
			: a.clearance_eligibility
				? {
					cleared: false,
					eligible: a.clearance_eligibility.eligible,
					explanation: a.clearance_eligibility.eligible
						? "Operator clearance is available for this held run in Pi."
						: "Operator clearance is not eligible for this attempt.",
				}
				: { absence: "not applicable" as const, explanation: "Operator clearance applies only to an active held release." };
		return {
			attempt_id: a.attempt_id,
			input_id: a.input_id,
			task_id: a.task_id,
			bound_version: a.bound_version,
			historical: Boolean(a.historical),
			state: a.state,
			state_explanation: ATTEMPT_STATE_EXPLANATIONS[a.state] ?? `Launch attempt is in state "${a.state}".`,
			release_authorized: a.release_authorized,
			admission: queueEntry
				? {
					disposition: queueEntry.disposition,
					reference: queueEntry.reference,
					explanation: `Input ${a.input_id} (${queueEntry.reference}) was admitted at ${queueEntry.bound_version} with disposition "${queueEntry.disposition}".`,
				}
				: { absence: "evidence unavailable" as const, explanation: "Matching admitted input record is missing." },
			settlement,
			clearance,
			uncertainty: a.uncertainty?.length
				? { count: a.uncertainty.length, absence: "evidence unavailable" as const, explanation: "Attempt evidence has missing, damaged, or contradictory records." }
				: { absence: "no records" as const, explanation: "No attempt-level evidence contradictions observed." },
			receipt: reference
				? { reference, detail_view: "receipts" as const, detail_url: `/api/factories/${encodedId}/receipts?reference=${encodeURIComponent(reference)}` }
				: { absence: "evidence unavailable" as const, explanation: "No submission reference is available for this attempt." },
		};
	});

	const attempts = attemptsList.length > 0
		? {
			count: attemptsList.length,
			items: attemptsList,
			explanation: `${attemptsList.length} launch attempt(s) recorded.`,
			detail_view: "queue" as const,
			detail_url: queueUrl,
		}
		: {
			count: 0,
			items: [] as never[],
			absence: (isUnmanaged ? "not applicable" : "no records") as TypedAbsence,
			explanation: isUnmanaged ? "Launch attempts apply only after a factory is managed and submits work." : "No launch attempts have been recorded for this factory.",
			detail_view: "queue" as const,
			detail_url: queueUrl,
		};

	const admissionItems = value.queue.map(q => ({
		input_id: q.input_id,
		reference: q.reference,
		queue_position: q.queue_position,
		bound_version: q.bound_version,
		disposition: q.disposition,
		disposition_explanation: DISPOSITION_EXPLANATIONS[q.disposition] ?? `Input disposition is "${q.disposition}".`,
		accepted_at: q.accepted_at,
		detail_view: "receipts" as const,
		detail_url: `/api/factories/${encodedId}/receipts?reference=${encodeURIComponent(q.reference)}`,
	}));
	const admission = admissionItems.length > 0
		? {
			count: admissionItems.length,
			items: admissionItems,
			explanation: `${admissionItems.length} admitted input(s) recorded.`,
			detail_view: "queue" as const,
			detail_url: queueUrl,
		}
		: {
			count: 0,
			items: [] as never[],
			absence: (isUnmanaged ? "not applicable" : "no records") as TypedAbsence,
			explanation: isUnmanaged ? "Input admission applies only to a managed factory." : "No factory inputs have been admitted.",
			detail_view: "queue" as const,
			detail_url: queueUrl,
		};

	const boundMap = new Map<string, { input_count: number; attempt_count: number }>();
	for (const q of value.queue) {
		const rec = boundMap.get(q.bound_version) ?? { input_count: 0, attempt_count: 0 };
		rec.input_count++;
		boundMap.set(q.bound_version, rec);
	}
	for (const a of value.attempts) {
		const rec = boundMap.get(a.bound_version) ?? { input_count: 0, attempt_count: 0 };
		rec.attempt_count++;
		boundMap.set(a.bound_version, rec);
	}
	const boundItems = [...boundMap.entries()].map(([version, counts]) => {
		const verRec = versionByName.get(version);
		const available = verRec?.evidence === "available";
		return {
			version,
			matches_current: version === value.factory.current_version,
			input_count: counts.input_count,
			attempt_count: counts.attempt_count,
			retained_evidence: available ? ("available" as const) : ("unavailable" as const),
			...(!available ? { absence: "evidence unavailable" as const } : {}),
			explanation: available
				? `${version} (${version === value.factory.current_version ? "matches current" : "older than current"}): ${counts.input_count} input(s), ${counts.attempt_count} attempt(s).`
				: `Bound version ${version} record is missing or damaged.`,
		};
	});
	const boundVersions = boundItems.length > 0
		? { count: boundItems.length, items: boundItems, explanation: `${boundItems.length} bound definition version(s) referenced by inputs or attempts.` }
		: {
			count: 0,
			items: [] as never[],
			absence: (isUnmanaged ? "not applicable" : "no records") as TypedAbsence,
			explanation: isUnmanaged ? "Bound version tracking applies once a managed factory admits inputs." : "No inputs or attempts are bound to a version yet.",
		};

	const requests = value.request_evidence_error
		? { absence: "evidence unavailable" as const, explanation: "Direction request evidence is damaged or unreadable.", detail_view: "requests" as const, detail_url: requestsUrl }
		: !value.requests
			? { absence: "not applicable" as const, explanation: "Direction requests apply only to a managed factory.", detail_view: "requests" as const, detail_url: requestsUrl }
			: value.requests.length === 0
				? { count: 0, absence: "no records" as const, explanation: "No direction or exhaustion requests have been recorded.", detail_view: "requests" as const, detail_url: requestsUrl }
				: (() => {
					const pendingCount = value.requests.filter(r => r.state === "pending").length;
					const uncertainCount = value.requests.filter(r => r.reconciliation === "uncertain").length;
					return {
						count: value.requests.length,
						pending_count: pendingCount,
						uncertain_count: uncertainCount,
						explanation: `${value.requests.length} request(s) recorded (${pendingCount} pending, ${uncertainCount} uncertain).`,
						detail_view: "requests" as const,
						detail_url: requestsUrl,
					};
				})();

	const proposals = value.proposal_evidence_error
		? { absence: "evidence unavailable" as const, explanation: "Constraint proposal evidence is damaged or unreadable.", detail_view: "proposals" as const, detail_url: proposalsUrl }
		: !value.proposals
			? { absence: "not applicable" as const, explanation: "Constraint proposals apply only to a managed factory.", detail_view: "proposals" as const, detail_url: proposalsUrl }
			: value.proposals.length === 0
				? { count: 0, absence: "no records" as const, explanation: "No learned-constraint proposals have been recorded.", detail_view: "proposals" as const, detail_url: proposalsUrl }
				: (() => {
					const pendingCount = value.proposals.filter(p => p.outcome === "pending").length;
					return {
						count: value.proposals.length,
						pending_count: pendingCount,
						explanation: `${value.proposals.length} proposal(s) recorded (${pendingCount} pending confirmation).`,
						detail_view: "proposals" as const,
						detail_url: proposalsUrl,
					};
				})();

	return {
		attempts,
		admission,
		bound_versions: boundVersions,
		capacity: {
			...capacity,
			queue_head: queueHead,
			...(value.checkout_evidence_stand_in
				? { checkout_stand_in: { version: value.checkout_evidence_stand_in, explanation: `Checkout capacity checked against ${value.checkout_evidence_stand_in} because head bound definition was unavailable.` } }
				: { checkout_stand_in: { absence: "not applicable" as const, explanation: "Checkout capacity checked against active target definition." } }),
			detail_view: "queue" as const,
			detail_url: queueUrl,
		},
		requests,
		proposals,
		attention,
	};
}

function resolveTargetNode(
	factoryId: string,
	inspectedVersion: string,
	projectedNodes: Array<ReturnType<typeof projectNode>> | undefined,
	targetQuery?: InspectTargetQuery,
) {
	if (!targetQuery || (targetQuery.node === undefined && targetQuery.targetFactory === undefined)) {
		return undefined;
	}
	if (targetQuery.targetFactory !== undefined && targetQuery.targetFactory !== factoryId) {
		return {
			verified: false,
			factory_id: targetQuery.targetFactory,
			expected_factory_id: factoryId,
			version: inspectedVersion,
			...(targetQuery.node !== undefined ? { node_id: targetQuery.node } : {}),
			absence: "evidence unavailable" as const,
			explanation: `Link factory "${targetQuery.targetFactory}" does not match inspected factory "${factoryId}".`,
		};
	}
	if (targetQuery.node !== undefined) {
		if (!projectedNodes) {
			return {
				verified: false,
				factory_id: factoryId,
				version: inspectedVersion,
				node_id: targetQuery.node,
				absence: "evidence unavailable" as const,
				explanation: targetQuery.notRetained
					? `Cannot resolve node "${targetQuery.node}" because version ${inspectedVersion} is not retained for this factory.`
					: `Cannot resolve node "${targetQuery.node}" because version ${inspectedVersion} definition is damaged or unreadable.`,
			};
		}
		const matched = projectedNodes.find(n => n.id === targetQuery.node);
		if (!matched) {
			return {
				verified: false,
				factory_id: factoryId,
				version: inspectedVersion,
				node_id: targetQuery.node,
				absence: "evidence unavailable" as const,
				explanation: `Node "${targetQuery.node}" does not exist in factory "${factoryId}" version ${inspectedVersion}.`,
			};
		}
		return {
			verified: true,
			factory_id: factoryId,
			version: inspectedVersion,
			node_id: targetQuery.node,
			node: matched,
			explanation: `Resolved node "${targetQuery.node}" in factory "${factoryId}" version ${inspectedVersion}.`,
		};
	}
	return {
		verified: true,
		factory_id: factoryId,
		version: inspectedVersion,
		explanation: `Verified factory "${factoryId}" version ${inspectedVersion}.`,
	};
}

/** Operator-facing Inspect projection. Its input is the verified retained Inspection, not a raw store row. */
export function publicInspect(value: Inspection | undefined, factoryId: string, targetQuery?: InspectTargetQuery) {
	if (!value || typeof value !== "object") {
		return {
			factory_id: factoryId,
			evidence: "unavailable",
			absence: "evidence unavailable",
			explanation: "Factory inspection evidence is unavailable.",
		};
	}
	const definition = value.definition;
	const nodeIds = new Set((definition?.agents ?? []).map(entry => entry.node.node_id).filter((id): id is string => typeof id === "string"));
	const projectedNodes = definition
		? definition.agents.map(entry => projectNode(nodeIds, factoryId, value.inspected_version, entry, definition))
		: undefined;
	const targetNode = resolveTargetNode(factoryId, value.inspected_version, projectedNodes, targetQuery);
	const management = summarizeManagement(value.factory.management);
	const stopState = summarizeStopState(value);
	const capacity = summarizeCapacity(value);
	const queueHead = headSummary(value.head_status);
	const attention = summarizeAttention(value, factoryId);
	const runtimeAssumptions = summarizeRuntimeAssumptions(value.runtime_assumptions);
	const versionRecords = summarizeVersions(value);
	const damagedRecords = summarizeDamagedRecords(value);
	const inspectedVersionRecord = versionRecords.find(v => v.version === value.inspected_version);
	const currentVersionSummary = {
		version: value.factory.current_version,
		evidence: value.current_error ? ("unavailable" as const) : ("available" as const),
		...(value.current_error ? { absence: "evidence unavailable" as const } : {}),
		explanation: value.current_error
			? `Current version ${value.factory.current_version} definition record is damaged or unreadable.`
			: `Current published definition version is ${value.factory.current_version}.`,
	};
	const operationEvidence = summarizeOperationEvidence(value, factoryId, versionRecords, capacity, queueHead, attention);
	return {
		factory_id: factoryId,
		name: value.factory.name,
		management,
		stopped: stopState,
		current_version: value.factory.current_version,
		inspected_version: value.inspected_version,
		attention_summary: {
			name: value.factory.name,
			management,
			stop_state: stopState,
			current_version: currentVersionSummary,
			capacity,
			queue_head: queueHead,
			attention,
		},
		versions: versionRecords,
		damaged_records: damagedRecords,
		runtime_assumptions: runtimeAssumptions,
		...(targetNode ? { target_node: targetNode } : {}),
		definition: projectedNodes && definition ? {
			version: value.inspected_version,
			restored_from: inspectedVersionRecord?.restored_from ?? { absence: "not applicable" as const, explanation: "Original publication; not restored from an earlier version." },
			topology: definition.topology,
			nodes: projectedNodes,
			limits: {
				max_total_attempts: definition.max_total_attempts,
				max_total_attempts_source: definition.max_total_attempts_source ?? "built-in",
				ready_timeout_ms: definition.ready_timeout_ms,
				task_timeout_ms: definition.task_timeout_ms === null || definition.task_timeout_ms === undefined
					? { absence: "no records" as const, explanation: "No default task timeout is configured in this definition." }
					: definition.task_timeout_ms,
				dependency_wait_timeout_ms: definition.dependency_wait_timeout_ms,
				liveness_timeout_ms: definition.liveness_timeout_ms,
				cancel_grace_ms: definition.cancel_grace_ms,
			},
			runtime_assumptions: runtimeAssumptions,
			not_frozen: runtimeAssumptions,
		} : {
			absence: "evidence unavailable",
			evidence: "unavailable",
			explanation: targetQuery?.notRetained
				? `Requested version ${value.inspected_version} is not retained for this factory.`
				: "The selected retained definition is unavailable.",
		},
		current_definition: value.current_error
			? { available: false, absence: "evidence unavailable", evidence: "unavailable", explanation: "Current definition evidence is unavailable." }
			: { available: true, version: value.factory.current_version, evidence: "available", explanation: `Current definition ${value.factory.current_version} is verified and readable.` },
		capacity,
		queue_head: queueHead,
		attention,
		operation_evidence: operationEvidence,
		uncertainty: (value.uncertainty ?? []).length
			? { absence: "evidence unavailable", evidence: "unavailable", explanation: "Some factory evidence could not be verified." }
			: { absence: "no records", explanation: "No launch or capacity uncertainty was observed." },
		evidence: damagedRecords.count > 0 ? "uncertain" : "available",
	};
}
