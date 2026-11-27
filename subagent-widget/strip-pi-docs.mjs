// Explicit child-only extension: prepend persona instructions when set, keep project context and tool rules, omit Pi's own manual.
export default function (pi) {
	pi.on("before_agent_start", event => {
		const basePrompt = event.systemPrompt.replace(/\n\n<docs>[\s\S]*?<\/docs>(?=\n\n|$)/, "");
		const persona = process.env.PI_SUBAGENT_PERSONA_PROMPT;
		const systemPrompt = persona ? `${persona}\n\n${basePrompt}` : basePrompt;
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	});
}
