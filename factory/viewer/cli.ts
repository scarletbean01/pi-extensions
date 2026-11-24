#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import { startViewer } from "./server.ts";

function resolveStatePath(env: NodeJS.ProcessEnv): string {
  if (env.FACTORY_STATE_PATH !== undefined) {
    if (!env.FACTORY_STATE_PATH.trim()) {
      throw new Error("FACTORY_STATE_PATH cannot be empty.");
    }
    return env.FACTORY_STATE_PATH;
  }
  const dir = env.PI_FACTORY_STATE_DIR || env.PI_BOOTSTRAP_STATE_DIR || join(homedir(), ".pi", "agent", "bootstrap-sessions");
  return join(dir, "factories.sqlite");
}

function parsePort(raw: string | undefined): number {
  if (raw === undefined) return 0;
  if (!/^\d+$/.test(raw.trim())) {
    throw new Error(`Invalid FACTORY_VIEWER_PORT: ${raw}`);
  }
  return Number(raw);
}

try {
  const statePath = resolveStatePath(process.env);
  const port = parsePort(process.env.FACTORY_VIEWER_PORT);
  const host = process.env.FACTORY_VIEWER_HOST;
  const viewer = await startViewer({
    statePath,
    port,
    ...(host !== undefined ? { host } : {}),
  });
  console.log(`Factory Viewer: ${viewer.url}`);
  let closing = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    void viewer.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
}
