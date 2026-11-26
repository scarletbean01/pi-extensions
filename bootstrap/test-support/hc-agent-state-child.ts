import { pathToFileURL } from "node:url";

type ScenarioEvent = {
	name: string;
	event?: Record<string, unknown>;
	context?: { mode?: string; idle?: boolean };
};

const extensionPath = process.argv[2];
if (!extensionPath) throw new Error("extension path is required");

const handlers = new Map<string, Array<(event: any, context: any) => unknown>>();
let registrationCount = 0;
const pi = {
	on(name: string, handler: (event: any, context: any) => unknown) {
		registrationCount += 1;
		const eventHandlers = handlers.get(name) ?? [];
		eventHandlers.push(handler);
		handlers.set(name, eventHandlers);
	},
};

const extension = await import(pathToFileURL(extensionPath).href);
extension.default(pi);

const scenario = JSON.parse(process.env.HC_AGENT_STATE_TEST_EVENTS ?? "[]") as ScenarioEvent[];
for (const item of scenario) {
	const context = {
		mode: item.context?.mode ?? "tui",
		isIdle: () => item.context?.idle ?? true,
	};
	for (const handler of handlers.get(item.name) ?? []) {
		await handler(item.event ?? {}, context);
	}
}

process.stderr.write(`registrations=${registrationCount}\n`);
