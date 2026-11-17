// Shared per-agent model resolution utilities for bootstrap launches.

// Short aliases → full provider/id strings expected by `pi --model`.
// Every target must exist in `pi --list-models`; stale IDs make a persona unlaunchable.
export const MODEL_ALIASES: Record<string, string> = {
	"opus":       "anthropic/claude-opus-5-5",
	"opus-5":     "anthropic/claude-opus-5-5",
	"opus-4":     "anthropic/claude-opus-4-8",
	"sonnet":     "anthropic/claude-sonnet-5-5",
	"sonnet-5":   "anthropic/claude-sonnet-5-5",
	"sonnet-4":   "anthropic/claude-sonnet-4-6",
	"haiku":      "anthropic/claude-haiku-5-5",
	"haiku-4":    "anthropic/claude-haiku-4-5",
	"fable":      "anthropic/claude-fable-5-2",
	"flash":      "openrouter/google/gemini-3-flash-preview",
	"gemini":     "openrouter/google/gemini-3-flash-preview",
	"gemini-3":   "openrouter/google/gemini-3-flash-preview",
	"gpt-4.1":    "openai/gpt-4.1",
	"gpt-5":      "openai/gpt-5",
};

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Split an optional `:thinking` suffix (as accepted by `pi --model`) from a model spec. */
export function splitModelSpec(spec: string): { model: string; thinking?: string } {
	const index = spec.lastIndexOf(":");
	if (index > 0 && THINKING_LEVELS.has(spec.slice(index + 1).toLowerCase())) return { model: spec.slice(0, index), thinking: spec.slice(index + 1) };
	return { model: spec };
}

/**
 * Whether the model Pi actually selected satisfies the planned spec.
 * Ignores a thinking suffix and accepts a dated snapshot of an undated ID
 * (`claude-haiku-4-5` → `claude-haiku-4-5-20251001`); anything else is a mismatch.
 */
export function modelMatches(expected: string, actual: string): boolean {
	const want = splitModelSpec(expected).model.toLowerCase();
	const got = actual.toLowerCase();
	return got === want || new RegExp(`^${want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d{8}$`).test(got);
}

// Resolve a model string for an agent.
// Precedence: agent's declared model (alias or full) → parent ctx.model → hardcoded fallback.
export function resolveModel(
	raw: string | undefined,
	ctxModel: { provider: string; id: string } | undefined,
): string {
	// If the agent declared a model frontmatter value, prefer it.
	if (raw?.trim()) {
		raw = raw.trim();
		// Full provider/id strings are passed through as-is.
		if (raw.includes("/")) return raw;
		// Alias lookup (case-insensitive), keeping an optional thinking suffix.
		const { model, thinking } = splitModelSpec(raw);
		const aliased = MODEL_ALIASES[model.toLowerCase()];
		if (aliased) return thinking ? `${aliased}:${thinking}` : aliased;
		// A typo in an explicit model choice must not silently select another model.
		throw new Error(`Unknown model alias "${raw}". Use a known alias or a full provider/model ID.`);
	}
	// Inherit from the parent Pi session.
	if (ctxModel) return `${ctxModel.provider}/${ctxModel.id}`;
	// Hardcoded fallback (matches the original default across all extensions).
	return "openrouter/google/gemini-3-flash-preview";
}
