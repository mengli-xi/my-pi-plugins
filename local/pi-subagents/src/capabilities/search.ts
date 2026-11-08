/** All query words must occur, in any order; provider/model separators are optional. */
export const SEARCH_RESULT_LIMIT_V1 = 20;

export function queryWordsV1(query: string): readonly string[] {
  return query.toLowerCase().split(/[\s/:]+/u).filter(Boolean);
}

export function matchesQueryWordsV1(value: string, words: readonly string[]): boolean {
  const haystack = value.toLowerCase();
  return words.every((word) => haystack.includes(word));
}
