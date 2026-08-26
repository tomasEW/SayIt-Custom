/**
 * Removes only unmistakable, adjacent ASR repetition artifacts before an LLM
 * sees a transcript. Three or more exact repetitions are required so normal
 * emphasis such as「非常非常重要」(two repetitions) remains untouched.
 */
const MIN_REPETITIONS = 3;
const MIN_CHUNK_LENGTH = 2;
const MAX_CHUNK_LENGTH = 32;

export function collapseAsrRepetition(text: string): string {
  let result = "";
  let index = 0;

  while (index < text.length) {
    const remaining = text.length - index;
    const maxLength = Math.min(
      MAX_CHUNK_LENGTH,
      Math.floor(remaining / MIN_REPETITIONS),
    );
    let bestChunk = "";
    let bestCount = 0;

    for (let length = MIN_CHUNK_LENGTH; length <= maxLength; length += 1) {
      const chunk = text.slice(index, index + length);
      let count = 1;
      while (
        text.slice(index + count * length, index + (count + 1) * length) ===
        chunk
      ) {
        count += 1;
      }

      if (count >= MIN_REPETITIONS && length * count > bestChunk.length * bestCount) {
        bestChunk = chunk;
        bestCount = count;
      }
    }

    if (bestChunk) {
      result += bestChunk;
      index += bestChunk.length * bestCount;
    } else {
      result += text[index];
      index += 1;
    }
  }

  return result;
}
