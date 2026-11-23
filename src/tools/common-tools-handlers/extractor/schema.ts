import z from "zod";
import { isHttpUrl } from "../../../utils/safeUrlProtocol";

export const extractorParams = z.object({
  urls: z.array(z.url().refine(isHttpUrl, "URL must use HTTP or HTTPS")).min(1),
});

export interface ExtractorCacheEntry {
  url: string;
  markdown?: string;
  error?: string;
}

export interface ExtractorCacheWrite {
  url: string;
  markdown: string;
}

export type ExtractorCachePrefix = "ext:lim:" | "ext:full:";

export interface ExtractorCacheRead {
  resultsByUrl: Map<string, ExtractorCacheEntry>;
  urlsToCrawl: string[];
}
