export function sanitizeExtractedMarkdown(rawMarkdown: string): string {
  return rawMarkdown
    .replace(/!\[.*?\]\(.*?\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/data:image\/[a-zA-Z]*;base64,[^\s"']+/g, "")
    .replace(/(http|https):\/\/[^\s]+/g, "")
    .replace(/\s{3,}/g, "\n\n");
}
