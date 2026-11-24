import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService } from "../../bootstrap/lifecycle.ts";
import { parseVersionToken } from "../../bootstrap/factory-records.ts";
import { factoryOperations, validateSubmissionReference, type Inspection, type ReleasedFactoryRun } from "../operations.ts";
import { publicInspect } from "./inspect.ts";
import { liveSnapshot } from "./live.ts";
import { absentProposalsSnapshot, proposalsSnapshot, unavailableProposalsSnapshot } from "./proposals.ts";
import { queueSnapshot, receiptSnapshot, unavailableQueueSnapshot } from "./queue.ts";
import { absentRequestsSnapshot, collectRequestBlockedPaths, createViewerDirectionReader, requestsSnapshot, unavailableRequestsSnapshot } from "./requests.ts";

export interface ViewerReaderOptions {
  statePath: string;
  coordinationPath?: string;
  exec?: ConstructorParameters<typeof BootstrapService>[0]["exec"];
  env?: NodeJS.ProcessEnv;
  home?: string;
}
export interface ViewerOptions extends ViewerReaderOptions {
  host?: string;
  port?: number;
}
export interface StartViewerDeps {
  createReader?: typeof createViewerReader;
}
export interface ViewerServer { url: string; close(): Promise<void>; server: Server }
const token = /^[A-Za-z0-9_-]{1,128}$/;
const assets = join(dirname(fileURLToPath(import.meta.url)), "assets");
const ASSET_CSP = "default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'";

function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (hostHeader === undefined) return true;
  if (!hostHeader || /[\s/\\@]/.test(hostHeader)) return false;
  try {
    const parsed = new URL(`http://${hostHeader}`);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
  } catch {
    return false;
  }
}

function safeUnavailable(factory_id: string, view: string) {
  return { factory_id, evidence: "unavailable", absence: "evidence unavailable", explanation: `${view} evidence is unavailable.` };
}
function json(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}
export function createViewerReader(options: ViewerReaderOptions) {
  const statePath = resolve(options.statePath);
  const exec = options.exec ?? (async () => { throw new Error("The viewer does not execute commands"); });
  const bootstrap = new BootstrapService({
    extensionDir: resolve(assets, "../../.."),
    exec,
    ...(options.env ? { env: options.env } : {}),
    ...(options.home ? { home: options.home } : {}),
  });
  // Limit the factory reader to passive preflight, raw non-release verification, and
  // regular-file/no-symlink/non-blocking direction observation; never provide status, settlement,
  // or recovery-capable Bootstrap methods.
  const directionReader = createViewerDirectionReader(bootstrap.store.indexRoot);
  const preflight = {
    prepareDefinition: bootstrap.prepareDefinition.bind(bootstrap),
    prepareFromDefinition: bootstrap.prepareFromDefinition.bind(bootstrap),
    validateFactoryNonReleaseEvidence: bootstrap.validateFactoryNonReleaseEvidence.bind(bootstrap),
    validateFactoryPreReleaseAbortAndExit: bootstrap.validateFactoryPreReleaseAbortAndExit.bind(bootstrap),
    directionObservation: directionReader.directionObservation,
    directionRouting: directionReader.directionRouting,
    directionExhaustions: directionReader.directionExhaustions,
  };
  const coordinationPath = resolve(options.coordinationPath ?? bootstrap.defaultCoordinationPath());
  const blockedPaths = [
    statePath,
    dirname(statePath),
    coordinationPath,
    dirname(coordinationPath),
    bootstrap.store.indexRoot,
    homedir(),
    ...(options.home ? [options.home] : []),
    ...(options.env?.HOME ? [options.env.HOME] : []),
  ];
  const op = factoryOperations(statePath, preflight, { coordinationPath });
  const inspectLive = (factoryId: string) => {
    const releases: ReleasedFactoryRun[] = [];
    const inspection = factoryOperations(statePath, preflight, { coordinationPath, observeReleased: evidence => releases.push(evidence) })({ action: "inspect", factory_id: factoryId });
    return { inspection, releases };
  };
  // `bootstrap` is returned solely for test-support `probeReaderExec` positive controls that prove
  // `options.exec` reaches the underlying `BootstrapService`; `startViewer` ignores it and passes only `preflight`.
  return { statePath, coordinationPath, indexRoot: bootstrap.store.indexRoot, blockedPaths, bootstrap, preflight, op, inspectLive };
}

export async function startViewer(
  options: ViewerOptions,
  { createReader = createViewerReader }: StartViewerDeps = {},
): Promise<ViewerServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Viewer must bind to loopback (127.0.0.1 or ::1)");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Viewer port must be an integer between 0 and 65535");
  const { statePath, indexRoot, op, inspectLive, blockedPaths } = createReader({
    statePath: options.statePath,
    coordinationPath: options.coordinationPath,
    exec: options.exec,
    env: options.env,
    home: options.home,
  });
  const server = createServer(async (req, res) => {
    try {
      if (req.method !== "GET") { res.writeHead(405, { allow: "GET", "cache-control": "no-store", "x-content-type-options": "nosniff" }); res.end(); return; }
      if (!isLoopbackHostHeader(req.headers.host)) { json(res, 403, { error: "Loopback host required" }); return; }
      const rawUrl = req.url ?? "/";
      if (!rawUrl.startsWith("/") || rawUrl.startsWith("//") || rawUrl.includes("\\")) { json(res, 400, { error: "Invalid request target" }); return; }
      let url: URL;
      try { url = new URL(rawUrl, "http://127.0.0.1"); }
      catch { json(res, 400, { error: "Invalid request URL" }); return; }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        const body = await readFile(join(assets, "index.html")); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control":"no-store", "x-content-type-options": "nosniff", "content-security-policy": ASSET_CSP }); res.end(body); return;
      }
      if (url.pathname === "/app.js" || url.pathname === "/style.css") {
        const file = url.pathname.slice(1); const body = await readFile(join(assets, file));
        res.writeHead(200, { "content-type": file.endsWith("js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "cache-control":"no-store", "x-content-type-options": "nosniff", "content-security-policy": ASSET_CSP }); res.end(body); return;
      }
      if (url.pathname === "/api/factories") {
        if ([...url.searchParams.keys()].length) { json(res, 400, { error: "Unsupported query parameter" }); return; }
        json(res, 200, op({ action: "list" }).map(({ factory_id, name, current_version, management }) => ({ factory_id, name, current_version, management }))); return;
      }
      const match = /^\/api\/factories\/([^/]+)\/(live|inspect|queue|receipts|requests|proposals)$/.exec(url.pathname);
      if (match) {
        const [, id, view] = match;
        if (!token.test(id)) { json(res, 404, { error:"Factory not found" }); return; }
        const allowed = view === "inspect" ? ["version", "node", "factory"] : view === "queue" ? ["filter"] : view === "receipts" ? ["reference"] : [];
        const keys = [...url.searchParams.keys()];
        if (keys.some(key => !allowed.includes(key)) || new Set(keys).size !== keys.length || [...url.searchParams.values()].some(value => value.length > 256)) { json(res, 400, { error: "Unsupported query parameter" }); return; }
        try {
          if (view === "inspect") {
            const hasVersion = url.searchParams.has("version");
            const version = hasVersion ? url.searchParams.get("version")! : undefined;
            if (hasVersion) {
              try { parseVersionToken(version!, "version"); }
              catch { json(res, 400, { error: "Invalid version identifier" }); return; }
            }
            const hasNode = url.searchParams.has("node");
            const node = hasNode ? url.searchParams.get("node")! : undefined;
            if (hasNode && !token.test(node!)) { json(res, 400, { error: "Invalid node identifier" }); return; }
            const hasFactoryParam = url.searchParams.has("factory");
            const targetFactory = hasFactoryParam ? url.searchParams.get("factory")! : undefined;
            if (hasFactoryParam && !token.test(targetFactory!)) { json(res, 400, { error: "Invalid factory identifier" }); return; }
            let result: Inspection;
            let notRetained = false;
            if (version) {
              try {
                result = op({ action: "inspect", factory_id: id, version });
              } catch (versionError) {
                const message = versionError instanceof Error ? versionError.message : String(versionError);
                notRetained = /^Version "v[1-9][0-9]*" not found for factory /.test(message);
                if (notRetained) {
                  const base = op({ action: "inspect", factory_id: id });
                  result = {
                    ...base,
                    inspected_version: version,
                    definition: undefined,
                    node_policies: undefined,
                  };
                } else {
                  const base = op({ action: "inspect", factory_id: id });
                  const requestedNum = parseVersionToken(version, "version").version_num;
                  const currentNum = parseVersionToken(base.factory.current_version, "current_version").version_num;
                  if (requestedNum > currentNum || !base.versions[requestedNum - 1]?.corrupt_reason) throw versionError;
                  result = {
                    ...base,
                    inspected_version: version,
                    definition: undefined,
                    node_policies: undefined,
                    inspected_error: message,
                  };
                }
              }
            } else {
              result = op({ action: "inspect", factory_id: id });
            }
            const targetQuery = (node !== undefined || targetFactory !== undefined || notRetained)
              ? { ...(node !== undefined ? { node } : {}), ...(targetFactory !== undefined ? { targetFactory } : {}), ...(notRetained ? { notRetained: true } : {}) }
              : undefined;
            json(res, 200, publicInspect(result, id, targetQuery)); return;
          }
          if (view === "queue") {
            const filter = url.searchParams.get("filter") ?? "open";
            if (filter !== "open" && filter !== "all") { json(res, 400, { error: "Invalid queue filter" }); return; }
            const result = op({ action: "inspect", factory_id: id });
            json(res, 200, queueSnapshot(result, id, filter)); return;
          }
          if (view === "receipts") {
            let reference: string;
            try { reference = validateSubmissionReference(url.searchParams.get("reference")); }
            catch { json(res, 400, { error: "A valid submission reference is required" }); return; }
            const receipt = op({ action: "receipt", factory_id: id, reference });
            let inspectedAttempt: NonNullable<Inspection["attempts"]>[number] | undefined;
            if (receipt.attempt) {
              try {
                const inspection = op({ action: "inspect", factory_id: id });
                inspectedAttempt = inspection.attempts.find(a => a.attempt_id === receipt.attempt!.attempt_id);
              } catch {
                // Receipt lookup still works when manager, pointer, or coordination evidence is unavailable for full inspect.
              }
            }
            json(res, 200, receiptSnapshot(receipt, id, inspectedAttempt)); return;
          }
          if (view === "requests") {
            if (!op({ action: "identities" }).some(f => f.factory_id === id)) {
              json(res, 404, { error: "Factory not found" }); return;
            }
            const requests = op({ action: "requests", factory_id: id });
            if (requests.length === 0) {
              const target = op({ action: "publication_target", factory_id: id });
              json(res, 200, absentRequestsSnapshot(id, target.management === "unmanaged" ? "not applicable" : "no records")); return;
            }
            const perAttemptBlocked = collectRequestBlockedPaths(statePath, indexRoot, id, requests);
            json(res, 200, requestsSnapshot(requests, id, blockedPaths, perAttemptBlocked)); return;
          }
          if (view === "proposals") {
            const proposals = op({ action: "proposals", factory_id: id });
            if (proposals.length === 0) {
              const target = op({ action: "publication_target", factory_id: id });
              json(res, 200, absentProposalsSnapshot(id, target.management === "unmanaged" ? "not applicable" : "no records")); return;
            }
            json(res, 200, proposalsSnapshot(proposals, id, blockedPaths)); return;
          }
          const { inspection, releases } = inspectLive(id);
          json(res, 200, liveSnapshot(inspection, releases)); return;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/^Factory not found\b/.test(message)) { json(res, 404, { error: "Factory not found" }); return; }
          if (view === "receipts" && /^Receipt not found\b/.test(message)) { json(res, 404, { error: "Unknown submission reference" }); return; }
          if (view === "inspect") { json(res, 200, safeUnavailable(id, "Factory inspection")); return; }
          if (view === "queue") { json(res, 200, unavailableQueueSnapshot(id)); return; }
          if (view === "requests") { json(res, 200, unavailableRequestsSnapshot(id)); return; }
          if (view === "proposals") { json(res, 200, unavailableProposalsSnapshot(id)); return; }
          throw error;
        }
      }
      json(res, 404, { error:"Not found" });
    } catch { json(res, 503, { error:"Evidence unavailable" }); }
  });
  await new Promise<void>((resolveListen, reject) => { server.once("error", reject); server.listen(port, host, resolveListen); });
  const address = server.address();
  const close = () => {
    if (!server.listening) return Promise.resolve();
    return new Promise<void>((resolveClose, reject) => {
      server.close(error => error ? reject(error) : resolveClose());
      server.closeIdleConnections?.();
    });
  };
  if (!address || typeof address === "string" || (address.address !== "127.0.0.1" && address.address !== "::1")) {
    await close();
    throw new Error("Viewer failed to bind to loopback");
  }
  const formattedHost = address.address.includes(":") ? `[${address.address}]` : address.address;
  return { url: `http://${formattedHost}:${address.port}`, server, close };
}
