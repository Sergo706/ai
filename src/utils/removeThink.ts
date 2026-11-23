export function removeThinking(content: string): string {
  return content
    .replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, "")
    .replace(/<think\b[^>]*>[\s\S]*$/gi, "")
    .trim();
}

export function removeCodeFence(content: string): string {
  const trimmed = content.trim();
  const match = /^```[^\r\n`]*\r?\n([\s\S]*?)\r?\n```$/.exec(trimmed);

  return match ? match[1].trim() : content;
}
