/**
 * Strip a reasoning model's thinking blocks from its output.
 *
 * Removes complete `<think>…</think>` sections and an unclosed trailing one.
 *
 * @param content - The raw model output.
 * @returns The content without thinking blocks, trimmed.
 */
export function removeThinking(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

/**
 * Strip a surrounding Markdown code fence.
 *
 * Only a fence wrapping the whole string is removed; a bare string is returned
 * unchanged.
 *
 * @param content - The raw model output.
 * @returns The fenced body without the fence, or `content` unchanged.
 */
export function removeCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```[^\r\n`]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);

  return match ? match[1].trim() : content;
}
