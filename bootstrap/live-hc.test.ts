/** Operator-only live hc spike. Each run owns an isolated core and disposable PTY fixtures. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runSupervised } from "./test-harness.ts";
import {
	assertPrivatePath, command, createSignalForwarder, extractHolderPids, formatOrphanWarning, isKillablePid, json, localAddress, payload, readCoreStatus, stopCoreWithFallback, successful,
	type CommandResult, type CoreIdentity,
} from "./test-support/hc-live-core.ts";
import {
	buildHcEnvironment, HC_LIVE_FINDINGS_DIR, HC_LIVE_GATE, HC_LIVE_ONLY, hcLiveEnabled, installHcShims, parseLiveHcSelection,
} from "./test-support/hc-live-env.ts";
import {
	evaluateLiveBhRequirements, readCoreLogTail, recordCoreEnvFindings, recordShimFindings, recordStatusShapeFindings,
	recordTeardownFindings, runBlockedSendSuite, runOscProbeSuite, type OscProbeOps,
} from "./test-support/hc-live-findings.ts";

const fixture = fileURLToPath(new URL("./test-support/hc-live-terminal.ts", import.meta.url));
const wake = (id: string) => `[BOOTSTRAP_WAKE handoff=${id}]`;
const bytes = (input: Buffer) => ({ hex: input.toString("hex"), utf8: input.toString("utf8") });
const questions = {
	wrapping: "a. Send wrapping and reach",
	osc: "b. OSC 7501 status reports",
	isolation: "c. Core isolation and teardown",
	boot: "d. Send before stdin is read",
	discovery: "e. Label filtering, inspection, and RunResult",
	names: "f. Name reuse",
	statusShape: "g. Server status shape",
	blocked: "h. Blocked send",
	finishedKill: "i. Kill on an already-finished terminal",
} as const;

function shQuote(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function stopOrphanCommand(env: NodeJS.ProcessEnv): string {
	const assignments = Object.entries(env)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}=${shQuote(v)}`);
	return `env -i ${assignments.join(" ")} hc server stop --json`;
}

async function until<T>(what: string, read: () => T | undefined | Promise<T | undefined>, ms = 5_000): Promise<T> {
	if (!Number.isFinite(ms) || ms <= 0) {
		throw new RangeError(`until(${JSON.stringify(what)}) requires a finite positive timeout, got ${String(ms)}`);
	}
	const end = Date.now() + ms;
	do {
		const value = await read();
		if (value !== undefined) return value;
		await delay(40);
	} while (Date.now() < end);
	throw new Error(`Timed out waiting for ${what}`);
}

test("live hc spike (a–i)", {
	skip: !hcLiveEnabled(process.env) && `UNVERIFIED: live hc tests require ${HC_LIVE_GATE}=1`,
	timeout: 420_000,
}, async t => {
	assert.equal(process.platform, "linux", "hc live isolation requires Linux /proc");
	const selected = parseLiveHcSelection(process.env[HC_LIVE_ONLY]);
	const reportBase = resolve(process.env[HC_LIVE_FINDINGS_DIR] ?? tmpdir());
	mkdirSync(reportBase, { recursive: true });
	const reportDir = mkdtempSync(join(reportBase, "bootstrap-hc-findings-"));
	// Keep Unix socket paths short, even when run-tests has a nested temp root.
	const root = mkdtempSync(join(realpathSync("/tmp"), "bootstrap-hc-"));
	const shims = installHcShims(root);
	const env = buildHcEnvironment(root, process.env);
	const orphanCmd = stopOrphanCommand(env);
	const findings: Record<keyof typeof questions, Record<string, unknown>> = {
		wrapping: {}, osc: {}, isolation: {}, boot: {}, discovery: {}, names: {}, statusShape: {}, blocked: {}, finishedKill: {},
	};
	const { wrapping, osc, isolation, boot, discovery, names, statusShape, blocked, finishedKill } = findings;
	const terminalEnvs: Record<string, unknown> = {};
	Object.assign(isolation, {
		root, env, shimDir: shims.shimDir, shimLogPath: shims.logPath, stopCommand: orphanCmd,
		selectedQuestions: [...selected].sort(),
		start: ["server", "start", "--json"], stop: ["server", "stop", "--json"],
		ownership: "Fresh Unix socket, inode, core id, systemd shims, /proc/<pid>/environ (allowing HC_RUNTIME=1) + /proc/<pid>/cgroup checks",
		terminalEnvs,
	});
	const failures: unknown[] = [];
	const addresses = new Set<string>();
	let identity: CoreIdentity | undefined;
	let recordedStartPid: number | undefined;
	let startAttempted = false;
	let launchMayHaveCreatedTerminals = false;
	let stopped = false;

	const warnOrphan = () => {
		if (startAttempted && !stopped) {
			const teardown = isolation.teardownPids as {
				corePid?: number | null;
				remainingCoreAlive?: boolean;
				remainingHolderPids?: number[];
			} | undefined;
			const survivingPids = [...new Set([
				...(teardown?.remainingCoreAlive && isKillablePid(teardown.corePid) ? [teardown.corePid] : []),
				...(teardown?.remainingHolderPids ?? []).filter(pid => isKillablePid(pid)),
			])].sort((a, b) => a - b);
			const msg = formatOrphanWarning({
				root,
				stopCommand: orphanCmd,
				socketExists: socketExists(),
				survivingPids,
			});
			process.stderr.write(msg);
			t.diagnostic(msg.trim());
		}
	};
	const forwardSignal = createSignalForwarder(() => { warnOrphan(); });
	const onSigInt = forwardSignal("SIGINT");
	const onSigTerm = forwardSignal("SIGTERM");
	process.once("SIGINT", onSigInt);
	process.once("SIGTERM", onSigTerm);

	const save = () => {
		const shimLogContents = existsSync(shims.logPath) ? readFileSync(shims.logPath, "utf8") : "";
		Object.assign(isolation, recordShimFindings(shimLogContents));
		const path = join(reportDir, "hc-spike-findings");
		const report = Object.entries(questions).map(([key, title]) => [title, findings[key as keyof typeof questions]]);
		writeFileSync(path + ".json", JSON.stringify(Object.fromEntries(report), null, 2) + "\n");
		const markdown = report.map(([title, evidence]) =>
			`## ${title}\n\n\`\`\`json\n${JSON.stringify(evidence, null, 2)}\n\`\`\`\n`);
		writeFileSync(path + ".md", "# Live hc spike findings\n\n" + markdown.join("\n"));
	};
	const scenario = async (evidence: Record<string, unknown>, body: () => Promise<void>) => {
		try { await body(); } catch (error) {
			evidence.failure = String(error);
			failures.push(error);
		}
	};
	const socketExists = () => existsSync(env.HC_SOCKET!);
	const verify = () => readCoreStatus(root, env, identity);
	const cli = async (...args: string[]) => {
		assert.ok(identity, "hc isolation has no verified core");
		await verify();
		return command(root, env, "hc", args);
	};
	const get = async (address: string) => {
		const result = await cli("get", "--json", localAddress(address));
		successful(result, "hc get");
		const terminal = payload(result);
		assert.equal(terminal?.address, address);
		return terminal;
	};
	const list = async (...args: string[]) => {
		const result = await cli("ls", "--all", "--json", ...args);
		successful(result, "hc ls");
		const listing = payload(result);
		assert.ok(Array.isArray(listing?.terminals), "hc ls did not return a terminals array");
		for (const terminal of listing.terminals) localAddress(terminal.address);
		return { result, terminals: listing.terminals };
	};
	const run = async (name: string, args: string[], options: string[] = []) => {
		launchMayHaveCreatedTerminals = true;
		const result = await cli("run", "--json", "--bg", "--name", name, "--cwd", root, "--no-notify", ...options, ...args);
		const address = payload(result)?.address;
		if (typeof address === "string") addresses.add(localAddress(address));
		return result;
	};
	const addressOf = async (result: CommandResult, name: string) => {
		successful(result, `hc run ${name}`);
		const raw = payload(result);
		if (typeof raw?.address === "string") return localAddress(raw.address);
		// Keep probing when the CLI omits the API's address field. The shape
		// comparison always uses the original stdout.
		const matches = (await list()).terminals.filter((terminal: { name: string }) => terminal.name === name);
		assert.equal(matches.length, 1, `could not identify the freshly launched ${name} fixture`);
		return localAddress(matches[0].address);
	};
	const file = (name: string, suffix: string) => join(root, `${name}.${suffix}`);
	const capture = (name: string, suffix = "input") => readFileSync(file(name, suffix));
	const fixtureRun = async (name: string, options = ["--no-parent"], mode = "read") => {
		const result = await run(name, [process.execPath, fixture, name, mode], options);
		const address = await addressOf(result, name);
		const ready = await until(`${name} fixture`, () => {
			const marker = file(name, mode === "boot" || mode === "boot-late-raw" ? "boot" : "ready");
			if (existsSync(marker)) return JSON.parse(readFileSync(marker, "utf8"));
		});
		assert.equal(ready.caller, address, "fixture must run inside the expected hc terminal");
		if (ready.env !== undefined) terminalEnvs[name] = ready.env;
		return address;
	};
	const request = async (name: string, data: object) => {
		const response = file(name, "response");
		rmSync(response, { force: true });
		writeFileSync(file(name, "request.tmp"), JSON.stringify(data));
		renameSync(file(name, "request.tmp"), file(name, "request"));
		const reply = await until(`${name} fixture response`, () => existsSync(response) ? json(readFileSync(response, "utf8")) : undefined, 18_000);
		assert.equal(reply.error, undefined, reply.error);
		return reply;
	};
	const send = (address: string, text: string) => cli("send", "--json", localAddress(address), text);
	const received = async (name: string, offset: number, text: string) => {
		await until(`raw stdin for ${name}`, () => {
			const input = capture(name).subarray(offset);
			if (input.includes(text) && /[\r\n]/.test(input.subarray(input.indexOf(text) + text.length).toString())) return true;
		}).catch(() => { /* keep the exact partial capture when delivery is absent */ });
		return capture(name).subarray(offset);
	};
	const errorKind = (result: CommandResult) => json(result.stderr)?.error?.kind;

	try {
		for (const path of [env.HOME, env.TMPDIR, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME,
			env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_RUNTIME_DIR]) {
			mkdirSync(path!, { mode: 0o700 });
			assertPrivatePath(root, path!);
		}
		assert.ok(!socketExists(), "hc isolation socket unexpectedly exists before start");
		startAttempted = true;
		const start = await command(root, env, "hc", ["server", "start", "--json"], 15_000);
		isolation.startResult = start;
		successful(start, "hc server start");
		const startPid = payload(start)?.pid;
		if (isKillablePid(startPid)) {
			recordedStartPid = startPid;
			isolation.startPid = startPid;
		}
		statusShape.startTopLevelKeys = recordStatusShapeFindings(start).topLevelKeys;
		const initialStatus = await readCoreStatus(root, env, undefined, result => {
			Object.assign(statusShape, recordStatusShapeFindings(result));
		});
		identity = initialStatus.identity;
		Object.assign(isolation, recordCoreEnvFindings(initialStatus));
		assert.equal((await list()).terminals.length, 0, "fresh hc core should have no terminals");

		if (selected.has("c")) await scenario(isolation, async () => {
			const probeAddr = await fixtureRun("probe");
			const selfProbe = await request("probe", { action: "self-probe" });
			isolation.terminalSelfProbe = {
				address: probeAddr,
				caller: selfProbe.caller,
				env: selfProbe.env,
				serverStatus: selfProbe.serverStatus,
				serverStatusCoreIdMatches: payload(selfProbe.serverStatus)?.core?.id === identity?.id,
				getSelf: selfProbe.getSelf,
				getSelfMatchesCaller: selfProbe.getSelf?.code === 0 && payload(selfProbe.getSelf)?.address === selfProbe.caller,
			};
		});

		if (selected.has("a")) await scenario(wrapping, async () => {
			const dest = await fixtureRun("receiver");
			const sibling = await fixtureRun("sender");
			const child = await fixtureRun("child", ["--parent", dest]);
			wrapping.relationships = { receiver: await get(dest), sender: await get(sibling), child: await get(child) };
			wrapping.reachInput = "The CLI has no reach switch; vary caller and parent relationship to observe a generated reach attribute.";
			const cases = [
				{ id: "plain", to: dest, reader: "receiver" },
				{ id: "plain-to-child", to: child, reader: "child" },
				{ id: "unrelated", to: dest, reader: "receiver", from: "sender", caller: sibling },
				{ id: "parent-to-child", to: child, reader: "child", from: "receiver", caller: dest },
				{ id: "child-to-parent", to: dest, reader: "receiver", from: "child", caller: child },
			];
			for (const sample of cases) {
				const text = wake(sample.id);
				const offset = capture(sample.reader).length;
				const result = sample.from
					? await request(sample.from, { action: "send", target: sample.to, text, core: identity })
					: { caller: null, result: await send(sample.to, text) };
				assert.equal(result.caller, sample.caller ?? null);
				const input = await received(sample.reader, offset, text);
				wrapping[sample.id] = { text, ...result, input: bytes(input), delivered: input.includes(text), wrapped: input.includes("<hc "),
					reach: /<hc [^>]*\breach="([^"]*)"/.exec(input.toString())?.[1] ?? null };
			}
		});

		if (selected.has("b") || selected.has("h")) {
			const nameByAddress = new Map<string, string>();
			const probeOps: OscProbeOps = {
				createTerminal: async name => {
					const address = await fixtureRun(name);
					nameByAddress.set(address, name);
					return { address, name };
				},
				emitOsc: async (address, wireText) => {
					const name = nameByAddress.get(address);
					assert.ok(name, `unknown probe terminal address ${address}`);
					const offset = capture(name).length;
					const wire = Buffer.from(wireText);
					await request(name, { action: "osc", hex: wire.toString("hex") });
					if (wireText.includes("?")) {
						await until(`capability reply for ${name}`, () => capture(name).length > offset || undefined, 300).catch(() => {});
					}
					return capture(name).subarray(offset);
				},
				get: address => get(address),
				list: () => list(),
				send: (address, text) => send(address, text),
				stdinOffset: async address => {
					const name = nameByAddress.get(address);
					assert.ok(name, `unknown probe terminal address ${address}`);
					return capture(name).length;
				},
				readStdinSince: async (address, offset, text) => {
					const name = nameByAddress.get(address);
					assert.ok(name, `unknown probe terminal address ${address}`);
					if (text) return received(name, offset, text);
					return capture(name).subarray(offset);
				},
				cleanupTerminal: async address => {
					const kill = await cli("kill", "--json", address);
					if (kill.code !== 3 && kill.code !== 11) successful(kill, "hc kill probe terminal");
					await until(`remove probe ${address}`, async () => {
						const rm = await cli("rm", "--json", address);
						if (errorKind(rm) === "live") return;
						if (rm.code !== 3) successful(rm, "hc rm probe terminal");
						return true;
					});
					addresses.delete(address);
				},
			};

			let acceptedTerminator: "\x1b\\" | "\x07" | undefined;
			if (selected.has("b")) await scenario(osc, async () => {
				const oscResults = await runOscProbeSuite(probeOps);
				Object.assign(osc, oscResults);
				try {
					osc.coreLog = readCoreLogTail(root);
				} catch (error) {
					osc.coreLogError = String(error);
				}
				acceptedTerminator = oscResults.acceptedTerminator ?? undefined;

				// C: exercise the installed Pi binary inside this same isolated core.
				// The fresh HOME/XDG environment has no provider credentials, and we
				// never send input, so Pi can report startup status without starting a run.
				const realPi: Record<string, unknown> = { command: "pi", statusOverride: "unset" };
				osc.realPi = realPi;
				try {
					const piRun = await run("pi-native-status", ["pi"], ["--no-parent"]);
					realPi.run = piRun;
					const address = await addressOf(piRun, "pi-native-status");
					realPi.address = address;
					const deadline = Date.now() + 6_000;
					let terminal: any;
					do {
						terminal = await get(address);
						if (terminal?.reported === true || terminal?.state === "finished") break;
						await delay(100);
					} while (Date.now() < deadline);
					realPi.terminal = terminal;
					realPi.reported = terminal?.reported === true;
					realPi.piStatusObserved = terminal?.reported === true && terminal?.status?.app === "pi";
					realPi.note = "Fresh isolated HOME/XDG paths; no PI_PROGRAM_STATUS override or user input; terminal is cleaned up with the isolated core.";
				} catch (error) {
					realPi.error = String(error);
					realPi.note = "Real Pi-in-hc observation could not be completed; fixture probes remain independent.";
				}
			});

			if (selected.has("h")) await scenario(blocked, async () => {
				const blockedResults = await runBlockedSendSuite(probeOps, {
					terminator: acceptedTerminator ?? "\x1b\\",
					wakeText: id => wake(id),
				});
				Object.assign(blocked, blockedResults);
			});

			const evaluated = evaluateLiveBhRequirements({ selected, osc, blocked });
			if (selected.has("b")) osc.observations = evaluated.oscObservations;
			if (selected.has("h")) blocked.observations = evaluated.blockedObservations;
			if (evaluated.missing.length > 0) {
				if (selected.has("b")) osc.missingObservations = evaluated.missing.filter(msg => msg.startsWith("b:"));
				if (selected.has("h")) blocked.missingObservations = evaluated.missing.filter(msg => msg.startsWith("h:"));
				for (const msg of evaluated.missing) failures.push(new Error(msg));
			}
		}

		if (selected.has("d")) await scenario(boot, async () => {
			const runBootVariant = async (name: string, mode: "boot" | "boot-late-raw") => {
				const variant: Record<string, unknown> = { mode };
				const dest = await fixtureRun(name, ["--no-parent"], mode);
				variant.before = await get(dest);
				const text = wake(`${name}-before-read`);
				assert.equal(existsSync(file(name, "ready")), false);
				variant.send = await send(dest, text);
				variant.readerStillHeldAfterSend = !existsSync(file(name, "ready"));
				writeFileSync(file(name, "release"), "");
				await until(`${name} fixture to start reading`, () => existsSync(file(name, "ready")) || undefined);
				const control = wake(`${name}-after-read`);
				variant.readyControl = await send(dest, control);
				const input = await received(name, 0, control);
				variant.input = bytes(input);
				if (mode === "boot-late-raw") {
					variant.flushed = bytes(capture(name, "flushed"));
				}
				const earlyResult = variant.send as CommandResult;
				variant.outcome = earlyResult.timedOut ? "inconclusive (CLI timed out)"
					: input.includes(text) ? "delivered to post-ready reader"
						: mode === "boot-late-raw" && capture(name, "flushed").includes(text)
							? "buffered before readiness and discarded by startup flush"
							: earlyResult.code !== 0 ? "send error"
								: input.includes(control) ? "dropped before readiness" : "inconclusive (positive control missing)";
				return variant;
			};

			boot.bufferedVariant = await runBootVariant("booting", "boot");
			boot.lateRawFlushVariant = await runBootVariant("booting-late-raw", "boot-late-raw");
		});

		if (selected.has("e")) await scenario(discovery, async () => {
			const result = await run("owned", ["/bin/sleep", "240"], [
				"--no-parent", "--label", "bootstrap_run=spike-owned", "--label", "bootstrap_node=spike-node",
			]);
			discovery.runStdout = result;
			const schema = await command(root, env, "hc", ["schema"]);
			successful(schema, "hc schema");
			const expected = json(schema.stdout)?.components?.schemas?.RunResult;
			const raw = json(result.stdout);
			discovery.apiRunResult = expected;
			discovery.cliTopLevelKeys = Object.keys(raw ?? {});
			discovery.missingApiKeysAtTopLevel = expected?.required?.filter((key: string) => !Object.hasOwn(raw ?? {}, key));
			const address = await addressOf(result, "owned");
			await fixtureRun("other-label", ["--no-parent", "--label", "bootstrap_run=spike-other"]);
			const filtered = await list("--label", "bootstrap_run=spike-owned");
			discovery.filtered = filtered.result;
			const confirmed = await Promise.all(filtered.terminals.map((terminal: { address: string }) => get(terminal.address)));
			discovery.confirmed = confirmed;
			discovery.filterAndGetMatch = confirmed.length === 1 && confirmed[0].address === address
				&& confirmed[0].labels?.bootstrap_run === "spike-owned" && confirmed[0].labels?.bootstrap_node === "spike-node";
			await verify();
			const compact = await runSupervised("script", ["-q", "-e", "-c", "hc ls --all --label bootstrap_run=spike-owned", "/dev/null"],
				{ cwd: root, env, timeoutMs: 8_000 });
			discovery.compact = compact;
			discovery.compactShowsLabel = compact.code === 0 ? /bootstrap_run|spike-owned|bootstrap_node|spike-node/.test(compact.stdout) : null;
			successful(compact, "compact hc ls under a PTY");
		});

		if (selected.has("f")) await scenario(names, async () => {
			const first = await run("reuse", ["/bin/sleep", "240"], ["--no-parent"]);
			const address = await addressOf(first, "reuse");
			const duplicate = await run("reuse", ["/bin/true"], ["--no-parent"]);
			names.whileLive = { ...duplicate, errorKind: errorKind(duplicate) ?? null };
			const kill = await cli("kill", "--json", address);
			successful(kill, "hc kill before name reuse");
			names.finished = await until("original terminal to finish", async () => {
				const terminal = await get(address);
				if (terminal.state === "finished") return terminal;
			});
			names.beforeRm = await run("reuse", ["/bin/true"], ["--no-parent"]);
			// Use a second name to measure reuse with no older records left.
			const fresh = await run("reuse-after-rm", ["/bin/true"], ["--no-parent"]);
			const freshAddress = await addressOf(fresh, "reuse-after-rm");
			await until("second terminal to finish", async () => (await get(freshAddress)).state === "finished" || undefined);
			const removed = await cli("rm", "--json", freshAddress);
			names.rm = removed;
			successful(removed, "hc rm before name reuse");
			names.afterRm = await run("reuse-after-rm", ["/bin/true"], ["--no-parent"]);
		});

		if (selected.has("i")) await scenario(finishedKill, async () => {
			const runRes = await run("finished-kill", ["/bin/true"], ["--no-parent"]);
			const addr = await addressOf(runRes, "finished-kill");
			const beforeKill = await until("finished-kill terminal to finish", async () => {
				const terminal = await get(addr);
				if (terminal.state === "finished") return terminal;
			});
			finishedKill.beforeKill = beforeKill;
			const killRes = await cli("kill", "--json", addr);
			finishedKill.kill = killRes;
			finishedKill.errorKind = errorKind(killRes) ?? null;
			finishedKill.afterKill = await get(addr).catch(error => ({ getError: String(error) }));
			finishedKill.outcome = killRes.code === 0
				? "succeeded/no-op (exit 0)"
				: `error (exit ${killRes.code}, kind ${errorKind(killRes) ?? "none"})`;
		});
	} catch (error) {
		isolation.failure = String(error);
		failures.push(error);
	} finally {
		process.off("SIGINT", onSigInt);
		process.off("SIGTERM", onSigTerm);
		const cleanup: unknown[] = [];
		isolation.cleanup = cleanup;
		let corePid: number | undefined;
		let holderPids: number[] = [];
		const attemptCleanup = async (action: () => Promise<void>) => {
			try { await action(); } catch (error) {
				cleanup.push({ error: String(error) });
				failures.push(error);
			}
		};
		if (startAttempted && !socketExists() && !identity) {
			// A start whose CLI timed out may still be bringing up its daemon.
			await until("possibly late isolated daemon socket", () => socketExists() || undefined).catch(() => {});
		}
		if (startAttempted && (identity || socketExists() || recordedStartPid !== undefined)) {
			let verifiedForTerminalCleanup = false;
			if (launchMayHaveCreatedTerminals) {
				try {
					const statusCheck = await verify();
					identity = statusCheck.identity;
					corePid = statusCheck.identity.pid;
					holderPids = extractHolderPids(payload(statusCheck.result));
					verifiedForTerminalCleanup = true;
					const listed = await list();
					for (const terminal of listed.terminals) addresses.add(localAddress(terminal.address));
				} catch (error) {
					cleanup.push({ terminalDiscoverySkippedOnVerifyFailure: String(error) });
				}
			}
			if (verifiedForTerminalCleanup) {
				for (const address of addresses) {
					await attemptCleanup(async () => {
						const kill = await cli("kill", "--json", address);
						cleanup.push({ address, kill });
						if (kill.code !== 3 && kill.code !== 11) successful(kill, "hc kill during cleanup");
					});
					await attemptCleanup(async () => {
						await until(`remove ${address}`, async () => {
							const rm = await cli("rm", "--json", address);
							cleanup.push({ address, rm });
							if (errorKind(rm) === "live") return;
							if (rm.code !== 3) successful(rm, "hc rm during cleanup");
							return true;
						});
					});
				}
			}
			await attemptCleanup(async () => {
				const stopResult = await stopCoreWithFallback(root, env, {
					identity,
					startPid: recordedStartPid,
					holderPids,
				});
				cleanup.push({ stopResult });
				if (stopResult.mode === "fallback" && failures.length === 0 && stopResult.verifyError) {
					failures.push(new Error(stopResult.verifyError));
				}
				if (stopResult.stopError) {
					failures.push(new Error(stopResult.stopError));
				}
				const teardownFindings = recordTeardownFindings(stopResult);
				Object.assign(isolation, teardownFindings.findings);
				assert.equal(stopResult.stopped, true,
					`isolated hc core did not stop cleanly: ${JSON.stringify(stopResult)}`);
				stopped = true;
			});
		}
		try {
			isolation.coreLog = readCoreLogTail(root);
		} catch (error) {
			isolation.coreLogError = String(error);
		}
		save();
		warnOrphan();
		t.diagnostic(`Live hc spike findings: ${reportDir}`);
		if (!startAttempted || stopped) rmSync(root, { recursive: true, force: true });
	}
	if (failures.length) throw new AggregateError(failures, "Live hc spike had incomplete observations or cleanup");
});
