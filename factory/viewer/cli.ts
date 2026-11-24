#!/usr/bin/env node
import { startViewer } from "./server.ts";
const statePath = process.env.FACTORY_STATE_PATH;
if (!statePath) { console.error("Set FACTORY_STATE_PATH to the factory state database path."); process.exitCode = 2; }
else {
  const port = Number(process.env.FACTORY_VIEWER_PORT ?? 0);
  const viewer = await startViewer({ statePath, port });
  console.log(`Factory Viewer: ${viewer.url}`);
  const stop = () => { void viewer.close().finally(() => process.exit(0)); };
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}
