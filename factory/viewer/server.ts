import { createServer, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { BootstrapService } from "../../bootstrap/lifecycle.ts";
import { factoryOperations, validateSubmissionReference, type ReleasedFactoryRun } from "../operations.ts";
import { headSummary, publicInspect } from "./inspect.ts";
import { liveSnapshot } from "./live.ts";

export interface ViewerReaderOptions {
  statePath: string;
  coordinationPath?: string;
  exec?: ConstructorParameters<typeof BootstrapService>[0]["exec"];
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
  return { factory_id, evidence: "unavailable", explanation: `${view} evidence is unavailable.` };
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
  });
  // Limit the factory reader to passive preflight; in particular do not provide status,
  // settlement, or recovery-capable Bootstrap methods.
  const preflight = {
    prepareDefinition: bootstrap.prepareDefinition.bind(bootstrap),
    prepareFromDefinition: bootstrap.prepareFromDefinition.bind(bootstrap),
  };
  const coordinationPath = resolve(options.coordinationPath ?? bootstrap.defaultCoordinationPath());
  const op = factoryOperations(statePath, preflight, { coordinationPath });
  const inspectLive = (factoryId: string) => {
    const releases: ReleasedFactoryRun[] = [];
    const inspection = factoryOperations(statePath, preflight, { coordinationPath, observeReleased: evidence => releases.push(evidence) })({ action: "inspect", factory_id: factoryId });
    return { inspection, releases };
  };
  const probeExec = async (args: string[] = ["api", "snapshot"]): Promise<string> => {
    const command = Reflect.get(bootstrap, "command") as (args: string[]) => Promise<string>;
    return command.call(bootstrap, args);
  };
  return { statePath, coordinationPath, bootstrap, preflight, op, inspectLive, probeExec };
}

export async function startViewer(
  options: ViewerOptions,
  { createReader = createViewerReader }: StartViewerDeps = {},
): Promise<ViewerServer> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1") throw new Error("Viewer must bind to loopback (127.0.0.1 or ::1)");
  const port = options.port ?? 0;
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Viewer port must be an integer between 0 and 65535");
  const { op, inspectLive } = createReader({
    statePath: options.statePath,
    coordinationPath: options.coordinationPath,
    exec: options.exec,
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
        const allowed = view === "inspect" ? ["version"] : view === "queue" ? ["filter"] : view === "receipts" ? ["reference"] : [];
        if ([...url.searchParams.keys()].some(key => !allowed.includes(key)) || [...url.searchParams.values()].some(value => value.length > 256)) { json(res, 400, { error: "Unsupported query parameter" }); return; }
        try {
          if (view === "inspect") {
            const version = url.searchParams.get("version") ?? undefined;
            if (version && !/^v[1-9][0-9]*$/.test(version)) { json(res, 400, { error: "Invalid version identifier" }); return; }
            const result = op({ action: "inspect", factory_id: id, ...(version ? { version } : {}) });
            json(res, 200, publicInspect(result, id)); return;
          }
          if (view === "queue") {
            const filter = url.searchParams.get("filter") ?? "open";
            if (filter !== "open" && filter !== "all") { json(res, 400, { error: "Invalid queue filter" }); return; }
            const result = op({ action: "inspect", factory_id: id });
            const entries = result.queue.filter(entry => filter === "all" || !["settled", "discarded", "cleared"].includes(entry.disposition)).map(({ input_id, reference, queue_position, bound_version, disposition, accepted_at }) => ({ input_id, reference, queue_position, bound_version, disposition, accepted_at, receipt_url: `/?${new URLSearchParams({ factory: id, view: "receipts", reference })}` }));
            json(res, 200, { factory_id: id, entries, absence: entries.length ? undefined : "no records", head_status: headSummary(result.head_status) }); return;
          }
          if (view === "receipts") {
            let reference: string;
            try { reference = validateSubmissionReference(url.searchParams.get("reference")); }
            catch { json(res, 400, { error: "A valid submission reference is required" }); return; }
            const receipt = op({ action: "receipt", factory_id: id, reference });
            json(res, 200, { type: "receipt", factory_id: id, input_id: receipt.input_id, reference: receipt.reference, accepted_at: receipt.accepted_at, bound_version: receipt.bound_version, disposition: receipt.disposition, attempt: receipt.attempt ? { attempt_id: receipt.attempt.attempt_id, state: receipt.attempt.state, bound_version: receipt.attempt.bound_version } : { evidence: "not applicable" }, note: "Receipt evidence is not a run report." }); return;
          }
          if (view === "requests") {
            const result = op({ action: "inspect", factory_id: id });
            const records = result.requests?.map(item => ({ request_id: item.request_id, node_id: item.node_id,
              kind: item.exhaustion ? "exhaustion" : "direction", state: item.state, question: item.question, choices: item.choices?.map(({ id, label }) => ({ id, label })),
              response_recorded: item.response_recorded, consumption: item.consumption,
              response_consumed: item.consumption === "consumed" ? true : item.consumption === "awaiting_consumption" || item.consumption === "never_consumed" ? false : { evidence: "unavailable" },
              uncertainty: item.reconciliation === "uncertain" ? "The original requester or response routing could not be verified." : undefined }));
            json(res, 200, { factory_id: id, records: records ?? [], absence: records?.length ? undefined : result.request_evidence_error ? "evidence unavailable" : records ? "no records" : "not applicable" }); return;
          }
          if (view === "proposals") {
            const records = op({ action: "proposals", factory_id: id }).map(item => ({ proposal_id: item.proposal_id,
              reference: item.reference, action: item.proposal_action, provenance: { source: item.source, run_id: item.provenance.run_id, attempt_id: item.provenance.attempt_id, proposed_at: item.proposed_at, decided_at: item.decided_at },
              outcome: item.outcome, file_sync_state: item.file_sync_state }));
            json(res, 200, { factory_id: id, records, absence: records.length ? undefined : "no records", note: "Proposals are not the active constraints file." }); return;
          }
          const { inspection, releases } = inspectLive(id);
          json(res, 200, liveSnapshot(inspection, releases)); return;
        } catch (error) {
          if (/Factory not found/.test(String(error))) { json(res, 404, { error: "Factory not found" }); return; }
          if (view === "receipts" && /Receipt not found/.test(String(error))) { json(res, 404, { error: "Unknown submission reference" }); return; }
          if (view === "inspect") { json(res, 200, safeUnavailable(id, "Factory inspection")); return; }
          if (view === "queue") { json(res, 200, { factory_id: id, entries: [], absence: "evidence unavailable" }); return; }
          if (view === "requests" || view === "proposals") { json(res, 200, { factory_id: id, records: [], absence: "evidence unavailable", ...(view === "proposals" ? { note: "Proposals are not the active constraints file." } : {}) }); return; }
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
