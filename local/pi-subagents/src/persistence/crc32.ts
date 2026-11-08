const CASTAGNOLI_REVERSED = 0x82f63b78;

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 1) !== 0 ? (value >>> 1) ^ CASTAGNOLI_REVERSED : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32c(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffffffff) >>> 0;
  for (const byte of bytes) crc = (TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)) >>> 0;
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32cHex(bytes: Uint8Array): string {
  return crc32c(bytes).toString(16).padStart(8, "0");
}
