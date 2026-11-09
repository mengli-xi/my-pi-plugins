export interface StoredDocumentShape {
	schemaVersion: 1 | 2 | 3 | 4 | 5 | 6;
	revision: number;
	overrides: Record<string, unknown>;
	migration?: unknown;
}

export function validateStoredDocument(value: unknown): StoredDocumentShape {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error("expected a configuration object");
	}
	const document = value as Record<string, unknown>;
	if (![1, 2, 3, 4, 5, 6].includes(document.schemaVersion as number)) {
		throw new Error("expected schemaVersion 1, 2, 3, 4, 5 or 6");
	}
	if (!Number.isInteger(document.revision) || (document.revision as number) < 0) {
		throw new Error("expected a non-negative integer revision");
	}
	if (typeof document.overrides !== "object" || document.overrides === null || Array.isArray(document.overrides)) {
		throw new Error("expected object overrides");
	}
	if (document.migration !== undefined) {
		if (typeof document.migration !== "object" || document.migration === null || Array.isArray(document.migration)) {
			throw new Error("expected migration receipt object");
		}
		const migration = document.migration as Record<string, unknown>;
		if (typeof migration.at !== "string" || !Array.isArray(migration.sources) || migration.sources.some((source) => {
			if (typeof source !== "object" || source === null || Array.isArray(source)) return true;
			const item = source as Record<string, unknown>;
			return typeof item.path !== "string" || typeof item.sha256 !== "string";
		})) {
			throw new Error("expected valid migration receipt");
		}
	}
	return document as unknown as StoredDocumentShape;
}
