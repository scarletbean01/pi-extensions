import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BootstrapService, RunStatus } from "./lifecycle.ts";
import { renderGraph, type GraphViewModel } from "./graph-view.ts";
import { dispositionPath, expectationFor, inboundEdgesOf, parseCompletion, parseDisposition, readJson, resultPath } from "./session-store.ts";

const MAX_READ_FAILURES = 3;

function settled(status: RunStatus): boolean {
	return status.outcome.terminal || status.manifest.status === "error"
		|| status.manifest.status === "cleaned" || !!status.manifest.session_dir_removed;
}

function recordedTime({ manifest, agents }: RunStatus): number {
	let latest = -Infinity;
	for (const [i, entry] of manifest.pane_manifest.entries()) {
		const agent = agents[i];
		const expected = expectationFor(manifest, entry);
		try {
			const time = agent.result_status
				? parseCompletion(readJson(resultPath(manifest.session_dir, entry.instance_id)), expected).completed_at
				: parseDisposition(readJson(dispositionPath(manifest.session_dir, entry.instance_id)), expected).recorded_at;
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
	return {
		mode: "live",
		runId: manifest.task_id,
		topology: manifest.topology,
		outcome: manifest.status === "cleaned" ? "cleaned" : outcome.state,
		elapsedMs: observedAt - Date.parse(manifest.created_at),
		pendingCount: pending.length,
		errorCount: worker_errors.length + delivery_errors.length + outcome.counts.failed,
		nodes: manifest.pane_manifest.map(entry => {
			const agent = byInstance.get(entry.instance_id)!;
			const parents = inboundEdgesOf(entry).map(id => byInstance.get(id)).filter(parent => parent !== undefined);
			return {
				id: agent.node_id,
				inboundEdges: parents.map(parent => parent.node_id),
				state: agent.execution,
				elapsedMs: agent.elapsed_ms,
				edgeStates: agent.edge_states,
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
	frame.notice = undefined;
}

export function createGraphWidgets(readStatus: BootstrapService["status"]) {
	const widgets = new Map<string, { remove(): void; frame: WidgetFrame }>();

	return {
		attach(taskId: string, ctx: ExtensionContext) {
			if (!ctx.hasUI) return;
			const key = `bootstrap-${taskId}`;
			const status = readStatus(taskId, ctx.cwd);
			const previous = widgets.get(key);
			const frame: WidgetFrame = { graph: previous?.frame.graph };
			updateFrame(frame, status, true);
			let timer: ReturnType<typeof setInterval> | undefined;
			const stop = () => clearInterval(timer);
			previous?.remove();
			widgets.delete(key);
			try {
				ctx.ui.setWidget(key, (tui, theme) => {
					let failures = 0;
					const refresh = () => {
						try {
							const current = readStatus(taskId, ctx.cwd);
							const done = settled(current);
							updateFrame(frame, current, done);
							failures = 0;
							if (done) stop();
						} catch (error) {
							const ioError = error as NodeJS.ErrnoException;
							if (ioError?.code === "ENOENT" && ioError.path === status.manifest.session_dir) {
								frame.notice = "Session files unavailable";
							} else {
								if (++failures < MAX_READ_FAILURES) return;
								frame.notice = "Stale · Status read failed";
							}
							stop();
						}
						tui.requestRender();
					};
					if (!settled(status)) {
						timer = setInterval(refresh, 2000);
						timer.unref();
					}
					return {
						render(width) {
							const lines = frame.graph ? renderGraph(frame.graph, width, theme).split("\n") : [];
							if (frame.notice) lines.unshift((frame.graph ? frame.notice : `Run ${taskId} · ${frame.notice}`).slice(0, width));
							return lines;
						},
						invalidate() {},
						dispose: stop,
					};
				});
				widgets.set(key, { frame, remove() {
					stop();
					try { ctx.ui.setWidget(key, undefined); } catch { /* The UI may already be gone. */ }
				} });
			} catch {
				// A frontend can expose setWidget without supporting widgets.
				stop();
			}
		},
		clear() {
			for (const widget of widgets.values()) widget.remove();
			widgets.clear();
		},
	};
}
