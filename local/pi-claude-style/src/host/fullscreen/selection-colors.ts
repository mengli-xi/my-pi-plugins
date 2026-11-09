/**
 * One terminal escape at `index`: CSI (`ESC [ … final`), or a string sequence
 * (OSC/DCS/APC/PM/SOS) ended by BEL or ST. Local so the highlight needs no
 * import from pi-tui's unexported `dist/utils.js`.
 */
function escapeAt(text: string, index: number): string | undefined {
  if (text[index] !== "\x1b") return undefined;
  const kind = text[index + 1];
  if (kind === "[") {
    for (let end = index + 2; end < text.length; end++) {
      const code = text.charCodeAt(end);
      if (code >= 0x40 && code <= 0x7e) return text.slice(index, end + 1);
    }
    return undefined;
  }
  if (kind === "]" || kind === "P" || kind === "_" || kind === "^" || kind === "X") {
    for (let end = index + 2; end < text.length; end++) {
      if (text[end] === "\x07") return text.slice(index, end + 1);
      if (text[end] === "\x1b" && text[end + 1] === "\\") return text.slice(index, end + 2);
    }
    return undefined;
  }
  return undefined;
}

/**
 * Pi's sliceByColumn carries the original SGR prefix into the selected slice.
 * Paint the slice with the selection palette, replacing every SGR inside it
 * (search-match inverse, faint and the source colours), replay non-SGR escapes
 * such as OSC links untouched, and restore the source state at the end.
 */
export function highlightSelectionColors(text: string, palette: string): string {
  const selected = `\x1b[0m${palette}`;
  let result = selected;
  let originalStyle = "";
  for (let index = 0; index < text.length;) {
    const code = escapeAt(text, index);
    if (!code) {
      result += text[index++];
      continue;
    }
    if (code.startsWith("\x1b[") && code.endsWith("m")) {
      originalStyle += code;
      result += selected;
    } else result += code;
    index += code.length;
  }
  return `${result}\x1b[0m${originalStyle}`;
}
