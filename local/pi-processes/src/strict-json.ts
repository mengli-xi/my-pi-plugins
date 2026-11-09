export function parseStrictJson(source: string, path: string): unknown {
  const fail = (message: string): never => { throw new Error(`${path}: ${message}`); };
  // JSON.parse validates grammar; this scanner additionally rejects duplicate
  // object keys instead of allowing policy fields to overwrite one another.
  const parsed = JSON.parse(source) as unknown;
  let i = 0;
  const ws = (): void => { while (/\s/u.test(source[i] ?? "")) i += 1; };
  const str = (): string => {
    if (source[i++] !== '"') fail("invalid JSON string");
    let raw = '"';
    while (i < source.length) {
      const ch = source[i++]; raw += ch;
      if (ch === "\\") { raw += source[i++] ?? ""; continue; }
      if (ch === '"') return JSON.parse(raw) as string;
    }
    return fail("unterminated JSON string");
  };
  const value = (): void => {
    ws();
    if (source[i] === "{") return object();
    if (source[i] === "[") { i += 1; ws(); if (source[i] === "]") { i += 1; return; } while (true) { value(); ws(); if (source[i++] === "]") return; if (source[i - 1] !== ",") fail("invalid JSON array"); } }
    if (source[i] === '"') { str(); return; }
    const start = i; while (i < source.length && !/[\s,}\]]/u.test(source[i])) i += 1;
    if (start === i) fail("invalid JSON value");
  };
  const object = (): void => {
    i += 1; const keys = new Set<string>(); ws(); if (source[i] === "}") { i += 1; return; }
    while (true) { ws(); const key = str(); if (keys.has(key)) fail(`${key}: duplicate key`); keys.add(key); ws(); if (source[i++] !== ":") fail("invalid JSON object"); value(); ws(); const next = source[i++]; if (next === "}") return; if (next !== ",") fail("invalid JSON object"); }
  };
  value(); ws(); if (i !== source.length) fail("trailing JSON content");
  return parsed;
}
