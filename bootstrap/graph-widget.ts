import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BootstrapService, RunStatus } from "./lifecycle.ts";
import { attemptKey, attemptNumber } from "./review-plan.ts";
import { formatAutomaticCleanup } from "./reporting.ts";
import { clipGraphText, renderGraph, type GraphViewModel } from "./graph-view.ts";
import { dispositionPath, expectationFor, inboundEdgesOf, parseCompletion, parseDisposition, readJson, resultPath } from "./session-store.ts";

const MAX_READ_FAILURES = 3;

function settled(status: RunStatus): boolean {
	const { manifest, outcome } = status;
	if (manifest.status === "error" || manifest.status === "cleaned" || manifest.session_dir_removed) return true;
	return outcome.terminal && !(manifest.status === "applied" && manifest.cleanup_policy?.mode === "on_success" && outcome.state === "succeeded" &&
		!status.worker_errors.length && !status.delivery_errors.length);
}

function recordedTime({ manifest, agents }: RunStatus): number {
	let latest = -Infinity;
	for (const [i, entry] of manifest.pane_manifest.entries()) {
		const agent = agents[i];
		const expected = { ...expectationFor(manifest, entry), attempt_id: agent.attempt_id };
		const key = attemptKey(manifest.review_plan, entry.instance_id, attemptNumber(agent.attempt_id));
		try {
			const time = agent.result_status
				? parseCompletion(readJson(resultPath(manifest.session_dir, key)), expected).completed_at
				: parseDisposition(readJson(dispositionPath(manifest.session_dir, key)), expected).recorded_at;
			const recorded = Date.parse(time);
			if (Number.isFinite(recorded)) latest = Math.max(latest, recorded);
		} catch {
			// Older records and nodes with no result or disposition can use the manifest timestamp.
		}
	}
	return Number.isFinite(latest) ? latest : Date.parse(manifest.updated_at);
}

function liveGraph({ manifest, agents, outcome, pending, worker_errors, delivery_errors }: RunStatus, observedAt: number): GraphViewModel {
	const byInstance = new Map(agents.map(agent => [agent.instance_id, agent]));
	const cleaned = manifest.status === "cleaned";
	return {
		mode: "live",
		runId: manifest.task_id,
		topology: manifest.topology,
		outcome: outcome.state,
		cleaned,
		elapsedMs: observedAt - Date.parse(manifest.created_at),
		pendingCount: pending.length,
		errorCount: worker_errors.length + delivery_errors.length + outcome.counts.failed,
		nodes: manifest.pane_manifest.map(entry => {
			const agent = byInstance.get(entry.instance_id)!;
			const parents = inboundEdgesOf(entry).map(id => byInstance.get(id)).filter(parent => parent !== undefined);
			return {
				id: agent.node_id,
				inboundEdges: parents.map(parent => parent.node_id),
				state: agent.parked ? "parked" : agent.execution,
				elapsedMs: agent.elapsed_ms,
				edgeStates: agent.edge_states,
				...(agent.attempt_limit && agent.attempt_limit > 1 ? { loop: {
					attempt: attemptNumber(agent.attempt_id),
					maxAttempts: agent.attempt_limit,
					lastVerdict: agent.last_verdict,
				} } : {}),
			};
		}),
	};
}

interface WidgetFrame {
	graph?: GraphViewModel;
	notice?: string;
}

function updateFrame(frame: WidgetFrame, status: RunStatus, useRecordedTime: boolean): void {
	if (status.manifest.session_dir_removed) {
		frame.notice = status.manifest.status === "cleaned" ? "Run cleaned · Session files unavailable" : "Session files unavailable";
		return;
	}
	frame.graph = liveGraph(status, useRecordedTime ? recordedTime(status) : Date.now());
	frame.notice = status.manifest.cleanup_trigger === "auto" ? formatAutomaticCleanup(status.manifest) : undefined;
}

export function createGraphWidgets(
	readStatus: BootstrapService["statusWithCleanup"],
	onAutomaticCleanup?: (taskId: string, message: string) => void,
) {
	let session = 0;
	const watches = new Map<string, { removeWidget(): void; stop(): void; frame: WidgetFrame }>();

	function attach(taskId: string, ctx: ExtensionContext, status: RunStatus): void {
		const key = `bootstrap-${taskId}`;
		const previous = watches.get(key);
		const frame: WidgetFrame = { graph: previous?.frame.graph };
		updateFrame(frame, status, true);
		previous?.stop();
		previous?.removeWidget();

		let timer: ReturnType<typeof setInterval> | undefined;
		let stopped = false;
		let refreshing = false;
		let failures = 0;
		let redraw: (() => void) | undefined;
		let widgetRegistered = false;
		const auto = status.manifest.cleanup_policy?.mode === "on_success";
		const stop = () => { stopped = true; clearInterval(timer); };
		const removeWidget = () => {
			if (!widgetRegistered) return;
			widgetRegistered = false;
			redraw = undefined;
			try { ctx.ui.setWidget(key, undefined); } catch { /* The UI may already be gone. */ }
		};
		const announce = (current: RunStatus) => {
			const message = formatAutomaticCleanup(current.manifest);
			if (!message) return;
			try { onAutomaticCleanup?.(taskId, message); } catch { /* Status still exposes the completed cleanup. */ }
		};
		const update = (current: RunStatus) => {
			if (stopped) return;
			const done = settled(current);
			updateFrame(frame, current, current.outcome.terminal || done);
			failures = 0;
			if (done) {
				stop();
				if (!widgetRegistered) watches.delete(key);
			}
			redraw?.();
		};
		const readFailed = (error: unknown) => {
			if (stopped) return;
			const ioError = error as NodeJS.ErrnoException;
			if (ioError?.code === "ENOENT" && ioError.path === status.manifest.session_dir) {
				frame.notice = "Session files unavailable";
			} else {
				if (++failures < MAX_READ_FAILURES) return;
				frame.notice = "Stale · Status read failed";
			}
			stop();
			if (!widgetRegistered) watches.delete(key);
			redraw?.();
		};

		if (ctx.hasUI) {
			try {
				ctx.ui.setWidget(key, (tui, theme) => {
					redraw = () => tui.requestRender();
					return {
						render(width) {
							const lines = frame.graph ? renderGraph(frame.graph, width, theme).split("\n") : [];
							const notices = frame.notice?.split("\n").map(line => clipGraphText(line, width));
							if (notices) lines.unshift(...(frame.graph ? notices : [clipGraphText(`Run ${taskId} · ${notices[0]}`, width)]));
							return lines;
						},
						invalidate() {},
						dispose() {
							widgetRegistered = false;
							redraw = undefined;
							if (!auto) stop();
						},
					};
				});
				widgetRegistered = true;
			} catch { /* A frontend can expose setWidget without supporting widgets. */ }
		}
		if ((widgetRegistered || auto) && !settled(status)) {
			timer = setInterval(() => {
				if (refreshing) return;
				try {
					const current = readStatus(taskId, ctx.cwd, announce);
					if (current instanceof Promise) {
						refreshing = true;
						void current.then(update, readFailed).finally(() => { refreshing = false; });
					} else update(current);
				} catch (error) { readFailed(error); }
			}, 2000);
			timer.unref();
		}
		if (widgetRegistered || timer) watches.set(key, {
			frame, stop, removeWidget() {
				removeWidget();
				if (!auto || stopped) {
					stop();
					watches.delete(key);
				}
			},
		});
		else watches.delete(key);
	}

	return {
		attach(taskId: string, ctx: ExtensionContext, initialStatus?: RunStatus) {
			const status = initialStatus ?? readStatus(taskId, ctx.cwd);
			if (status instanceof Promise) {
				const attachedIn = session;
				return status.then(current => { if (session === attachedIn) attach(taskId, ctx, current); });
			}
			attach(taskId, ctx, status);
		},
		clear() {
			for (const watch of watches.values()) watch.removeWidget();
		},
		reset() {
			session++;
			for (const watch of watches.values()) {
				watch.stop();
				watch.removeWidget();
			}
			watches.clear();
		},
	};
}
