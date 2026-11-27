// Explicit child-only extension: keep project context and tool rules, omit Pi's own manual.
export default function (pi) {
	pi.on("before_agent_start", event => {
		const systemPrompt = event.systemPrompt.replace(/\n\n<docs>[\s\S]*?<\/docs>(?=\n\n|$)/, "");
		if (systemPrompt !== event.systemPrompt) return { systemPrompt };
	});
}
