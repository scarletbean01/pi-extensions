import {
	isKillablePid, json,
	type CommandResult, type CoreIdentity, type CoreStopResult,
} from "./hc-live-core.ts";

export const EXPECTED_STATUS_TOP_LEVEL_KEYS = [
	"core", "version", "pid", "uptime_ms", "live", "finished",
	"holder", "holders", "installed_by", "keeps_running_after_logout", "logout_linger_user",
] as const;

export const EXPECTED_STATUS_CORE_KEYS = ["id", "name"] as const;

export function recordStatusShapeFindings(result: CommandResult) {
	const raw = json(result.stdout);
	const topLevelKeys = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.keys(raw) : [];
	const coreKeys = raw?.core && typeof raw.core === "object" && !Array.isArray(raw.core) ? Object.keys(raw.core) : [];
	return {
		raw: result,
		topLevelKeys,
		coreKeys,
		expectedTopLevelKeys: [...EXPECTED_STATUS_TOP_LEVEL_KEYS],
		expectedCoreKeys: [...EXPECTED_STATUS_CORE_KEYS],
		expectedKeysPresent: EXPECTED_STATUS_TOP_LEVEL_KEYS.every(key => topLevelKeys.includes(key))
			&& EXPECTED_STATUS_CORE_KEYS.every(key => coreKeys.includes(key)),
		ticket03ProbeMatches: typeof raw?.core?.id === "string" && !!raw.core.id.trim()
			&& typeof raw?.version === "string" && !!raw.version.trim(),
	};
}

export function recordShimFindings(shimLogContents: string) {
	const shimCalls = shimLogContents.split("\n").filter(Boolean);
	return {
		shimCalls,
		shimCallCount: shimCalls.length,
	};
}

export function recordCoreEnvFindings(status: {
	identity: CoreIdentity;
	cgroup: string;
	hasRuntimeMarker: boolean;
	coreRuntimeEnv: string | null;
}) {
	return {
		identity: status.identity,
		cgroup: status.cgroup,
		hasRuntimeMarker: status.hasRuntimeMarker,
		observedCoreRuntimeEnv: status.coreRuntimeEnv,
	};
}

export function recordTeardownFindings(stopResult: CoreStopResult) {
	const survivingPids = [
		...(stopResult.remainingCoreAlive && isKillablePid(stopResult.corePid) ? [stopResult.corePid] : []),
		...stopResult.remainingHolderPids.filter(pid => isKillablePid(pid)),
	];
	const findings: Record<string, unknown> = {
		corePid: stopResult.corePid,
		holderPids: stopResult.holderPids,
		teardownPids: {
			mode: stopResult.mode,
			corePid: stopResult.corePid,
			holderPids: stopResult.holderPids,
			remainingCoreAlive: stopResult.remainingCoreAlive,
			remainingHolderPids: stopResult.remainingHolderPids,
			socketRemaining: stopResult.socketRemaining,
		},
	};
	if (stopResult.mode === "fallback") findings.fallbackCleanup = stopResult;
	if (stopResult.stopError) findings.stopError = stopResult.stopError;
	if (survivingPids.length > 0) findings.killCommand = `kill ${survivingPids.join(" ")}`;
	return { findings, survivingPids };
}
