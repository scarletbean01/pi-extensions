// Match Pi's own section, including its boundaries, so other documentation stays intact.
export const piHarnessDocs = new RegExp([
	String.raw`\n\n<docs>`,
	String.raw`Pi documentation \(read only when the user asks about the harness itself, its SDK, extensions, themes, skills, or TUI\):`,
	String.raw`- Main documentation: [^\n]+/README\.md`,
	String.raw`- Additional docs: [^\n]+`,
	String.raw`- Examples: [^\n]+`,
	String.raw`- When reading pi docs or examples, [^\n]+`,
	String.raw`- When asked about: [^\n]+`,
	String.raw`- Before implementing harness changes, [^\n]+`,
	String.raw`</docs>(?=\n\n|$)`,
].join("\n"));
