import { piHarnessDocs } from "../bootstrap/pi-harness-docs.mjs";

// Explicit child-only extension: prepend persona instructions when set, keep project context and tool rules, omit Pi's own <docs> manual.
export default function (pi) {
	const persona = process.env.PI_SUBAGENT_PERSONA_PROMPT;
	delete process.env.PI_SUBAGENT_PERSONA_PROMPT;
	pi.on("before_agent_start", event => {
		const basePrompt = event.systemPrompt.replace(piHarnessDocs, "");
		const systemPrompt = persona ? `${persona}\n\n${basePrompt}` : basePrompt;
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	});
}
