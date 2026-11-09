import { StringDecoder } from "node:string_decoder";

export type LogStream = "stdout" | "stderr";

export interface NormalizedLogRecord {
  text: string;
  terminated: boolean;
  truncated: boolean;
  utf8ReplacementBytes: number;
}

export interface NormalizerCounters {
  sourceBytes: number;
  normalizedBytes: number;
  droppedBytes: number;
  droppedLines: number;
  utf8ReplacementBytes: number;
}

const MAX_LINE_BYTES = 65_536;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

type EscapeState = "ground" | "escape" | "csi" | "osc" | "string" | "osc-escape" | "string-escape";

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isStrippedControl(char: string): boolean {
  const code = char.codePointAt(0)!;
  return (code >= 0 && code <= 8)
    || code === 11
    || code === 12
    || (code >= 14 && code <= 31)
    || (code >= 127 && code <= 159)
    || BIDI_CONTROLS.test(char);
}

export class StreamNormalizer {
  readonly #decoder = new StringDecoder("utf8");
  #escapeState: EscapeState = "ground";
  #text = "";
  #textBytes = 0;
  #replacementBytes = 0;
  #discardUntilTerminator = false;
  #pendingCr = false;
  #counters: NormalizerCounters = {
    sourceBytes: 0,
    normalizedBytes: 0,
    droppedBytes: 0,
    droppedLines: 0,
    utf8ReplacementBytes: 0,
  };

  get counters(): Readonly<NormalizerCounters> {
    return { ...this.#counters };
  }

  push(chunk: Uint8Array): NormalizedLogRecord[] {
    this.#counters.sourceBytes += chunk.byteLength;
    return this.#acceptDecoded(this.#decoder.write(Buffer.from(chunk)));
  }

  finish(): NormalizedLogRecord[] {
    const records = this.#acceptDecoded(this.#decoder.end());
    if (this.#pendingCr) {
      this.#pendingCr = false;
      records.push(...this.#terminate());
    }
    this.#escapeState = "ground";
    if (this.#discardUntilTerminator) {
      this.#discardUntilTerminator = false;
      return records;
    }
    if (this.#textBytes > 0) records.push(this.#emit(false, false));
    return records;
  }

  #acceptDecoded(decoded: string): NormalizedLogRecord[] {
    const records: NormalizedLogRecord[] = [];
    let index = 0;
    if (this.#pendingCr) {
      this.#pendingCr = false;
      if (decoded.startsWith("\n")) index = 1;
      records.push(...this.#terminate());
    }
    for (const char of decoded.slice(index)) {
      if (this.#pendingCr) {
        this.#pendingCr = false;
        records.push(...this.#terminate());
        if (char === "\n") continue;
      }
      if (this.#escapeState !== "ground") {
        this.#consumeEscape(char);
        continue;
      }
      if (char === "\u001b") {
        this.#escapeState = "escape";
        continue;
      }
      if (char === "\r") {
        this.#pendingCr = true;
        continue;
      }
      if (char === "\n") {
        records.push(...this.#terminate());
        continue;
      }
      const normalized = char === "\t" ? "    " : isStrippedControl(char) ? "" : char;
      if (normalized.length > 0) this.#acceptSafeText(normalized, records);
    }
    return records;
  }

  #consumeEscape(char: string): void {
    switch (this.#escapeState) {
      case "escape":
        if (char === "[") this.#escapeState = "csi";
        else if (char === "]") this.#escapeState = "osc";
        else if (char === "P" || char === "X" || char === "^" || char === "_") this.#escapeState = "string";
        else this.#escapeState = "ground";
        return;
      case "csi": {
        const code = char.codePointAt(0)!;
        if (code >= 0x40 && code <= 0x7e) this.#escapeState = "ground";
        return;
      }
      case "osc":
        if (char === "\u0007") this.#escapeState = "ground";
        else if (char === "\u001b") this.#escapeState = "osc-escape";
        return;
      case "string":
        if (char === "\u001b") this.#escapeState = "string-escape";
        return;
      case "osc-escape":
        this.#escapeState = char === "\\" ? "ground" : char === "\u001b" ? "osc-escape" : "osc";
        return;
      case "string-escape":
        this.#escapeState = char === "\\" ? "ground" : char === "\u001b" ? "string-escape" : "string";
        return;
      case "ground":
        return;
    }
  }

  #acceptSafeText(text: string, records: NormalizedLogRecord[]): void {
    const bytes = byteLength(text);
    const replacements = [...text].filter((char) => char === "\ufffd").length * 3;
    this.#counters.utf8ReplacementBytes += replacements;
    if (this.#discardUntilTerminator) {
      this.#counters.droppedBytes += bytes;
      return;
    }
    if (this.#textBytes + bytes <= MAX_LINE_BYTES) {
      this.#text += text;
      this.#textBytes += bytes;
      this.#replacementBytes += replacements;
      this.#counters.normalizedBytes += bytes;
      return;
    }
    let retained = "";
    let retainedBytes = 0;
    for (const char of text) {
      const size = byteLength(char);
      if (this.#textBytes + retainedBytes + size > MAX_LINE_BYTES) break;
      retained += char;
      retainedBytes += size;
    }
    this.#text += retained;
    this.#textBytes += retainedBytes;
    this.#replacementBytes += [...retained].filter((char) => char === "\ufffd").length * 3;
    this.#counters.normalizedBytes += retainedBytes;
    this.#counters.droppedBytes += bytes - retainedBytes;
    this.#counters.droppedLines += 1;
    records.push(this.#emit(false, true));
    this.#discardUntilTerminator = true;
  }

  #terminate(): NormalizedLogRecord[] {
    this.#escapeState = "ground";
    if (this.#discardUntilTerminator) {
      this.#discardUntilTerminator = false;
      return [];
    }
    return [this.#emit(true, false)];
  }

  #emit(terminated: boolean, truncated: boolean): NormalizedLogRecord {
    const record: NormalizedLogRecord = {
      text: this.#text,
      terminated,
      truncated,
      utf8ReplacementBytes: this.#replacementBytes,
    };
    this.#text = "";
    this.#textBytes = 0;
    this.#replacementBytes = 0;
    return record;
  }
}
