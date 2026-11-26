// Advisory status reporting for hc terminals. Keep this separate from the
// Herdr-managed herdr-agent-state.ts, which Herdr overwrites on installation.

const hcTerminalId = process.env.HC_TERMINAL_ID;

type AgentState = "working" | "idle" | "blocked" | "done";
type BlockedKind = "permission" | "question" | "auth";

function isEnabled(): boolean {
	return typeof hcTerminalId === "string" && hcTerminalId.length > 0;
}

function promptKind(event: any): BlockedKind {
	const explicitKind = event?.blockedKind;
	if (explicitKind === "permission" || explicitKind === "question" || explicitKind === "auth") {
		return explicitKind;
	}
	if (event?.kind === "confirm" || event?.kind === "permission") {
		return "permission";
	}
	if (event?.kind === "auth") {
		return "auth";
	}
	return "question";
}

export default function (pi: any): void {
	if (!isEnabled()) {
		return;
	}

	let tuiSession = false;
	let agentActive = false;
	let uiBlockedKind: BlockedKind | undefined;
	let lastRecord: string | undefined;
	const directionRequests = new Set<string>();

	function report(state: AgentState, kind?: BlockedKind): void {
		const record = state === "blocked"
			? `state=blocked:app=pi:kind=${kind ?? "question"}`
			: `state=${state}:app=pi`;
		if (record === lastRecord) {
			return;
		}
		lastRecord = record;
		try {
			// Pi owns stdout for its TUI. A short OSC frame is written directly to
			// that same terminal stream; it has no visible text and is fire-and-forget.
			process.stdout.write(`\x1b]7501;${record}\x1b\\`, () => {});
		} catch {
			// Status is advisory: a closed or unavailable output stream must not
			// affect the agent or its workflow.
		}
	}

	function publishCurrent(): void {
		if (!tuiSession) {
			return;
		}
		const blockedKind = uiBlockedKind ?? (directionRequests.size > 0 ? "question" : undefined);
		if (blockedKind) {
			report("blocked", blockedKind);
		} else {
			report(agentActive ? "working" : "idle");
		}
	}

	pi.on("session_start", (_event: any, ctx: any) => {
		// Match the Herdr extension's TUI-only reporting. Headless modes have no
		// terminal status surface to report to.
		tuiSession = ctx?.mode === "tui";
		if (!tuiSession) {
			return;
		}
		agentActive = ctx?.isIdle?.() === false;
		uiBlockedKind = undefined;
		directionRequests.clear();
		lastRecord = undefined;
		publishCurrent();
	});

	pi.on("agent_start", () => {
		if (!tuiSession) {
			return;
		}
		agentActive = true;
		publishCurrent();
	});

	pi.on("agent_settled", (_event: any, ctx: any) => {
		if (!tuiSession || ctx?.isIdle?.() !== true) {
			return;
		}
		agentActive = false;
		publishCurrent();
	});

	pi.on("tool_execution_start", (event: any) => {
		if (!tuiSession || event?.toolName !== "bootstrap_request_direction" || typeof event?.toolCallId !== "string") {
			return;
		}
		directionRequests.add(event.toolCallId);
		publishCurrent();
	});

	pi.on("tool_execution_end", (event: any) => {
		if (!tuiSession || event?.toolName !== "bootstrap_request_direction" || typeof event?.toolCallId !== "string") {
			return;
		}
		if (directionRequests.delete(event.toolCallId)) {
			publishCurrent();
		}
	});

	pi.on("ui_prompt_start", (event: any) => {
		if (!tuiSession || event?.reason !== "ui_prompt") {
			return;
		}
		uiBlockedKind = promptKind(event);
		publishCurrent();
	});

	pi.on("ui_prompt_end", (event: any) => {
		if (!tuiSession || event?.reason !== "ui_prompt") {
			return;
		}
		uiBlockedKind = undefined;
		publishCurrent();
	});

	pi.on("session_shutdown", (event: any) => {
		if (!tuiSession) {
			return;
		}
		report(event?.reason === "quit" ? "done" : "idle");
		tuiSession = false;
		agentActive = false;
		uiBlockedKind = undefined;
		directionRequests.clear();
	});
}
