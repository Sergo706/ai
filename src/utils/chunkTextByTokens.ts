import type { PreTrainedTokenizer } from "@huggingface/transformers";
import { estimateTextTokens } from "./messageTokens";

export function countTokens(
  text: string,
  tokenizer?: PreTrainedTokenizer,
  CHARS_PER_TOKEN_ESTIMATE = 4,
): number {
  if (tokenizer) {
    return tokenizer.encode(text, { add_special_tokens: false }).length;
  }
  return estimateTextTokens(text, CHARS_PER_TOKEN_ESTIMATE);
}

export function chunkByTokens(
  text: string,
  maxTokens = 1000,
  overlapTokens = 100,
  tokenizer?: PreTrainedTokenizer,
  CHARS_PER_TOKEN_ESTIMATE = 4,
): string[] {
  if (!text.trim()) return [];

  const chunks: string[] = [];
  let current = "";

  const getOverlap = (value: string): string => {
    if (overlapTokens <= 0) return "";

    if (tokenizer) {
      const tokens = tokenizer.encode(value, {
        add_special_tokens: false,
      });

      if (tokens.length <= overlapTokens) {
        return value;
      }

      return tokenizer
        .decode(tokens.slice(-overlapTokens), { skip_special_tokens: true })
        .trim();
    }

    const overlapChars = Math.floor(overlapTokens * CHARS_PER_TOKEN_ESTIMATE);
    if (value.length <= overlapChars) {
      return value;
    }

    return value.slice(-overlapChars).trim();
  };

  const pushCurrent = (keepOverlap = true) => {
    const value = current.trim();

    if (!value) {
      current = "";
      return;
    }

    chunks.push(value);

    current = keepOverlap ? getOverlap(value) : "";
  };

  const addPart = (part: string, separator: string) => {
    const candidate = current ? `${current}${separator}${part}` : part;

    if (countTokens(candidate) <= maxTokens) {
      current = candidate;
      return;
    }

    // save current chunk and retain its last N tokens.
    pushCurrent(true);

    // try adding the next part after the overlap.
    const withOverlap = current ? `${current}${separator}${part}` : part;

    if (countTokens(withOverlap) <= maxTokens) {
      current = withOverlap;
      return;
    }

    // part fits by itself, but not together with the overlap.
    // drop the overlap rather than exceeding maxTokens.
    if (countTokens(part) <= maxTokens) {
      current = part;
      return;
    }

    // oversized: try line boundaries.
    const lines = part.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      const lineCandidate = current ? `${current}\n${line}` : line;

      if (countTokens(lineCandidate) <= maxTokens) {
        current = lineCandidate;
        continue;
      }

      if (countTokens(line) <= maxTokens) {
        pushCurrent(true);

        const withLineOverlap = current ? `${current}\n${line}` : line;

        if (countTokens(withLineOverlap) <= maxTokens) {
          current = withLineOverlap;
        } else {
          current = line;
        }

        continue;
      }

      // single line itself is > maxTokens.
      pushCurrent(true);

      const step = maxTokens - overlapTokens;

      if (step <= 0) {
        throw new Error("overlapTokens must be smaller than maxTokens");
      }

      if (tokenizer) {
        const tokens = tokenizer.encode(line, {
          add_special_tokens: false,
        });

        for (let i = 0; i < tokens.length; i += step) {
          const tokenSlice = tokens.slice(i, i + maxTokens);

          const decoded = tokenizer
            .decode(tokenSlice, {
              skip_special_tokens: true,
            })
            .trim();

          if (decoded) {
            chunks.push(decoded);
          }

          if (i + maxTokens >= tokens.length) {
            break;
          }
        }
      } else {
        const maxChars = Math.floor(maxTokens * CHARS_PER_TOKEN_ESTIMATE);
        const stepChars = Math.floor(step * CHARS_PER_TOKEN_ESTIMATE);

        for (let i = 0; i < line.length; i += stepChars) {
          const decoded = line.slice(i, i + maxChars).trim();

          if (decoded) {
            chunks.push(decoded);
          }

          if (i + maxChars >= line.length) {
            break;
          }
        }
      }

      current = "";
    }
  };

  const paragraphs = text.split(/\n{2,}/);

  for (const paragraph of paragraphs) {
    const value = paragraph.trim();

    if (!value) continue;

    addPart(value, "\n\n");
  }

  // final chunk shouldn't create another overlap.
  pushCurrent(false);

  return chunks;
}
