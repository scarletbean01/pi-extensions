import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

function sanitizeControlChar(ch: string): string {
	const code = ch.charCodeAt(0);
	if (code <= 0x1f) return String.fromCharCode(0x2400 + code);
	if (code === 0x7f) return "\u2421";
	return "?";
}

/** Replace C0/DEL/C1 controls 1-to-1 with printable BMP characters for safe TUI rendering without shifting string offsets. */
function sanitizeLineForDisplay(line: string): string {
	return line.replace(/[\x00-\x1f\x7f-\x9f]/g, sanitizeControlChar);
}

/**
 * Subclass Pi's TUI Editor so bracketed pastes and submissions preserve exact UTF-8 payloads
 * (CRLF, CR, tabs, controls, leading/trailing whitespace, and literal `/~.` or `[paste #...]` text)
 * while sanitizing control characters in rendered TUI rows.
 */
export function createRawBriefEditorClass<T extends new (...args: any[]) => any>(EditorBase: T) {
	return class RawBriefEditor extends EditorBase {
		private readonly onExactSubmit?: (text: string) => void;

		constructor(...args: any[]) {
			const [tui, editorTheme, onExactSubmit] = args;
			super(tui, editorTheme);
			this.onExactSubmit = typeof onExactSubmit === "function" ? onExactSubmit : undefined;
		}

		normalizeText(text: string): string {
			return text;
		}

		expandPasteMarkers(text: string): string {
			return text;
		}

		handlePaste(pastedText: string): void {
			if (!pastedText) return;
			this.cancelAutocomplete();
			this.exitHistoryBrowsing();
			this.lastAction = null;
			this.pushUndoSnapshot();
			this.insertTextAtCursorInternal(pastedText);
		}

		private withDisplayLines<R>(fn: () => R): R {
			const original = this.state.lines;
			this.state.lines = original.map(sanitizeLineForDisplay);
			try {
				return fn();
			} finally {
				this.state.lines = original;
			}
		}

		layoutText(contentWidth: number) {
			return this.withDisplayLines(() => super.layoutText(contentWidth));
		}

		buildVisualLineMap(width: number) {
			return this.withDisplayLines(() => super.buildVisualLineMap(width));
		}

		submitValue(): void {
			const exact = this.getText();
			const savedOnSubmit = this.onSubmit;
			this.onSubmit = undefined;
			try {
				super.submitValue();
			} finally {
				this.onSubmit = savedOnSubmit;
			}
			if (this.onExactSubmit) {
				this.onExactSubmit(exact);
			} else {
				this.onSubmit?.(exact);
			}
		}
	};
}

/** Open an interactive plain-text editor that preserves exact bracketed-paste payloads and whitespace on submit. */
export async function openBriefEditor(ctx: ExtensionCommandContext, title: string, helpLine: string): Promise<string | undefined> {
	if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
		const { Container, Editor, Spacer, Text } = await import("@mariozechner/pi-tui");
		const RawBriefEditor = createRawBriefEditorClass(Editor);
		return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
			const container = new Container();
			const editorTheme = {
				borderColor: (text: string) => theme.fg("border", text),
				selectList: {
					selectedPrefix: (text: string) => theme.fg("accent", text),
					selectedText: (text: string) => theme.fg("accent", text),
					description: (text: string) => theme.fg("muted", text),
					scrollInfo: (text: string) => theme.fg("dim", text),
					noMatch: (text: string) => theme.fg("warning", text),
				},
			};
			const editor = new RawBriefEditor(tui, editorTheme, (exact: string) => done(exact));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("accent", title), 1, 0));
			container.addChild(new Text(theme.fg("dim", helpLine), 1, 0));
			container.addChild(new Spacer(1));
			container.addChild(editor);
			container.addChild(new Spacer(1));
			return {
				get focused() { return editor.focused; },
				set focused(value: boolean) { editor.focused = value; },
				render: (width: number) => container.render(width),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					if (!editor.isInPaste && keybindings.matches(data, "tui.select.cancel")) {
						done(undefined);
						return;
					}
					editor.handleInput(data);
				},
			};
		}, { blocked: { kind: "question", message: title } });
	}
	return ctx.ui.editor(title);
}
