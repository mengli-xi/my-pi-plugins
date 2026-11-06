const EDITOR_IMAGE_SOURCE_KEY = Symbol.for("pi.claude-style.editor-image-source.v2");

interface EditorImageSourceRegistry {
	version: 2;
	sourceText(visibleText: string): string;
	restoredSource(sourceText: string): { handled: boolean; editorText: string };
}

function registry(): Partial<EditorImageSourceRegistry> | undefined {
	const value = (globalThis as Record<PropertyKey, unknown>)[EDITOR_IMAGE_SOURCE_KEY];
	return typeof value === "object" && value !== null
		? value as Partial<EditorImageSourceRegistry>
		: undefined;
}

/** Read the editor owner's recoverable source without depending on its private marker map. */
export function editorSourceText(visibleText: string): string {
	const candidate = registry();
	if (candidate?.version !== 2 || typeof candidate.sourceText !== "function") return visibleText;
	try {
		const source = candidate.sourceText(visibleText);
		return typeof source === "string" ? source : visibleText;
	} catch {
		return visibleText;
	}
}

/** Ask the editor owner whether the preceding setEditorText call rebuilt every image marker. */
export function restoredEditorSource(sourceText: string): { handled: boolean; editorText: string } {
	const candidate = registry();
	if (candidate?.version !== 2 || typeof candidate.restoredSource !== "function") {
		return { handled: false, editorText: sourceText };
	}
	try {
		const result = candidate.restoredSource(sourceText);
		return typeof result === "object"
			&& result !== null
			&& typeof result.handled === "boolean"
			&& typeof result.editorText === "string"
			? result
			: { handled: false, editorText: sourceText };
	} catch {
		return { handled: false, editorText: sourceText };
	}
}
