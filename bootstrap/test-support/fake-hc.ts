/**
 * Stateful fake `hc` executor for deterministic Host/bootstrap tests.
 * Simulates `hc server status`, `hc run`, `hc ls`, `hc get`, `hc kill`, and `hc rm`
 * without ever touching a real `hc` binary or core.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { HostExecResult } from "../host.ts";
import { atomicJson, readJson, readyPath, type WorkerConfig } from "../session-store.ts";

export interface FakeHcTerminal {
	address: string;
	name: string | null;
	cwd: string;
	argv: string[];
	labels: Record<string, string>;
	state: "live" | "finished";
	parent: string | null;
	notify: boolean;
	exit_code: number | null;
	created_ms: number;
	finished_ms: number | null;
	screen: string;
	cols: number;
	rows: number;
}

export interface FakeHcOptions {
	cwd?: string;
	serverRunning?: boolean;
	callerTerminalId?: string;
	acknowledge?: boolean;
	runLauncher?: boolean;
	omitLabelsInLs?: boolean;
}

function hcError(code: number, kind: string, message: string, hint?: string): HostExecResult {
	return {
		code,
		stdout: "",
		stderr: JSON.stringify({ error: { kind, message, ...(hint ? { hint } : {}) } }),
	};
}

export function makeFakeHcExec(options: FakeHcOptions = {}) {
	const calls: string[][] = [];
	const terminals = new Map<string, FakeHcTerminal>();
	const behavior = {
		serverRunning: options.serverRunning ?? true,
		acknowledge: options.acknowledge ?? false,
		runLauncher: options.runLauncher ?? false,
		omitLabelsInLs: options.omitLabelsInLs ?? false,
		failLs: false,
		failGet: false,
		failRun: false,
	};
	let seq = 0;

	if (options.callerTerminalId) {
		terminals.set(options.callerTerminalId, {
			address: options.callerTerminalId,
			name: "caller",
			cwd: options.cwd ?? process.cwd(),
			argv: ["pi"],
			labels: {},
			state: "live",
			parent: null,
			notify: false,
			exit_code: null,
			created_ms: Date.now(),
			finished_ms: null,
			screen: "exact",
			cols: 200,
			rows: 120,
		});
	}

	const findByTarget = (target: string): FakeHcTerminal | undefined => {
		const byAddr = terminals.get(target);
		if (byAddr) return byAddr;
		const byName = [...terminals.values()].filter(t => t.name === target);
		return byName.find(t => t.state === "live") ?? byName[0];
	};

	const exec = async (command: string, args: string[]): Promise<HostExecResult> => {
		if (command !== "hc") {
			throw new Error(`Fake hc executor received non-hc command: ${command}`);
		}
		calls.push([...args]);

		if (args[0] === "server" && args[1] === "status") {
			if (!behavior.serverRunning) {
				return hcError(1, "unavailable", "herdr-core is not running", "run hc server start");
			}
			const all = [...terminals.values()];
			return {
				code: 0,
				stdout: JSON.stringify({
					core: { id: "fake-hc-core", name: "fake-host" },
					version: "0.1.25",
					pid: process.pid,
					uptime_ms: 1000,
					holders: [],
					live: all.filter(t => t.state === "live").length,
					finished: all.filter(t => t.state === "finished").length,
				}),
				stderr: "",
			};
		}

		if (args[0] === "get") {
			if (behavior.failGet) return hcError(1, "unavailable", "get failed");
			const target = args.find((arg, idx) => idx > 0 && !arg.startsWith("-"));
			if (!target) return hcError(7, "needs_target", "missing terminal target");
			const found = findByTarget(target);
			if (!found) return hcError(3, "not_found", `terminal ${target} not found`);
			return { code: 0, stdout: JSON.stringify(found), stderr: "" };
		}

		if (args[0] === "ls") {
			if (behavior.failLs) return hcError(1, "unavailable", "ls failed");
			const includeAll = args.includes("--all");
			const requiredLabels: Array<[string, string]> = [];
			for (let i = 1; i < args.length; i++) {
				if (args[i] === "--label" && args[i + 1]) {
					const kv = args[++i]!;
					const eq = kv.indexOf("=");
					if (eq !== -1) requiredLabels.push([kv.slice(0, eq), kv.slice(eq + 1)]);
				}
			}
			const all = [...terminals.values()];
			const hidden_finished = includeAll ? 0 : all.filter(t => t.state === "finished").length;
			const matched = all.filter(t => {
				if (!includeAll && t.state !== "live") return false;
				return requiredLabels.every(([k, v]) => t.labels[k] === v);
			}).map(t => behavior.omitLabelsInLs ? { ...t, labels: {} } : t);
			return {
				code: 0,
				stdout: JSON.stringify({ terminals: matched, hidden_finished, machines: [] }),
				stderr: "",
			};
		}

		if (args[0] === "run") {
			if (behavior.failRun) return hcError(1, "spawn_failed", "fake run failure");
			let name: string | null = null;
			let cwd = options.cwd ?? process.cwd();
			let noParent = false;
			let noNotify = false;
			const labels: Record<string, string> = {};
			const argv: string[] = [];
			let pastOptions = false;
			for (let i = 1; i < args.length; i++) {
				const arg = args[i]!;
				if (pastOptions) {
					argv.push(arg);
					continue;
				}
				if (arg === "--") {
					pastOptions = true;
					continue;
				}
				if (arg === "--json" || arg === "--bg") continue;
				if (arg === "--no-parent") { noParent = true; continue; }
				if (arg === "--no-notify") { noNotify = true; continue; }
				if (arg === "--name" && args[i + 1] !== undefined) { name = args[++i]!; continue; }
				if (arg === "--cwd" && args[i + 1] !== undefined) { cwd = args[++i]!; continue; }
				if (arg === "--label" && args[i + 1] !== undefined) {
					const kv = args[++i]!;
					const eq = kv.indexOf("=");
					if (eq === -1) return hcError(1, "invalid_params", `invalid label ${kv}`);
					labels[kv.slice(0, eq)] = kv.slice(eq + 1);
					continue;
				}
				if (arg.startsWith("-")) {
					return hcError(1, "invalid_params", `unexpected option ${arg}`);
				}
				pastOptions = true;
				argv.push(arg);
			}
			if (name !== null) {
				if (!/^[a-z0-9_-]{1,32}$/.test(name)) {
					return hcError(1, "invalid_params", `invalid terminal name ${JSON.stringify(name)}`);
				}
				const liveDup = [...terminals.values()].find(t => t.state === "live" && t.name === name);
				if (liveDup) {
					return hcError(1, "name_taken", `live terminal name "${name}" is already taken (${liveDup.address})`);
				}
			}
			const address = `t${++seq}`;
			const terminal: FakeHcTerminal = {
				address,
				name,
				cwd,
				argv,
				labels,
				state: "live",
				parent: noParent ? null : (options.callerTerminalId ?? null),
				notify: !noNotify,
				exit_code: null,
				created_ms: Date.now(),
				finished_ms: null,
				screen: "exact",
				cols: 200,
				rows: 120,
			};
			terminals.set(address, terminal);

			if (behavior.runLauncher && argv.length > 0) {
				execFileSync(argv[0]!, argv.slice(1), { cwd });
			}
			if (behavior.acknowledge && labels.bootstrap_run && labels.bootstrap_node && options.cwd) {
				const sessionDir = join(options.cwd, ".pi", "agent-sessions", labels.bootstrap_run);
				const configPath = join(sessionDir, `${labels.bootstrap_node}.config.json`);
				if (existsSync(configPath)) {
					const config = readJson<WorkerConfig>(configPath);
					const ready = {
						task_id: labels.bootstrap_run,
						token: config.token,
						instance_id: labels.bootstrap_node,
						name: labels.bootstrap_node,
						pid: process.pid,
						session_id: `session-${labels.bootstrap_node}`,
						endpoint: "/tmp/fake-coms",
						model: config.expected_model,
					};
					atomicJson(readyPath(sessionDir, labels.bootstrap_node), ready);
					const registryDir = join(config.coms_dir, "projects", config.coms_project, "agents");
					mkdirSync(registryDir, { recursive: true });
					atomicJson(join(registryDir, `${labels.bootstrap_node}.json`), ready);
					const launcherPath = join(sessionDir, `${labels.bootstrap_node}.sh`);
					if (existsSync(launcherPath)) {
						// Sanity-check that launcher file is readable UTF-8 script.
						readFileSync(launcherPath, "utf8");
					}
				}
			}
			return { code: 0, stdout: JSON.stringify(terminal), stderr: "" };
		}

		if (args[0] === "kill") {
			const target = args.find((arg, idx) => idx > 0 && !arg.startsWith("-"));
			if (!target) return hcError(7, "needs_target", "missing terminal target");
			const found = findByTarget(target);
			if (!found) return hcError(3, "not_found", `terminal ${target} not found`);
			found.state = "finished";
			found.exit_code = 143;
			found.finished_ms = Date.now();
			return { code: 0, stdout: JSON.stringify(found), stderr: "" };
		}

		if (args[0] === "rm") {
			const target = args.find((arg, idx) => idx > 0 && !arg.startsWith("-"));
			if (!target) return hcError(7, "needs_target", "missing terminal target");
			const found = findByTarget(target);
			if (!found) return hcError(3, "not_found", `terminal ${target} not found`);
			if (found.state === "live") return hcError(1, "live", `terminal ${found.address} is still live`);
			terminals.delete(found.address);
			return { code: 0, stdout: JSON.stringify({ removed: true }), stderr: "" };
		}

		throw new Error(`Unexpected fake hc command: ${args.join(" ")}`);
	};

	return { exec, calls, terminals, behavior };
}
