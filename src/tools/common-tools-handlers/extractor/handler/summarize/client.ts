import type {
  LinkPreviewClient,
  LinkPreviewClientOptions,
} from "@steipete/summarize-core/content";
import { getConfiguration } from "../../../../../config/config";
import { loadPeer } from "../../../../../utils/loadPeerDepend";


type ContentPeer = typeof import("@steipete/summarize-core/content");

async function summarizeContent(): Promise<ContentPeer> {
  return loadPeer<ContentPeer>(
    "@steipete/summarize-core/content",
    "the extractor tool",
  );
}


function clientEnv(): Record<string, string | undefined> {
  const { extractor } = getConfiguration()
  const WHISPER_CPP_BINARY = extractor?.whisperCppBin ?? "";
  const WHISPER_CPP_MODEL_PATH = extractor?.whisperCppModelPath ?? "";
  const DISABLE_LOCAL_WHISPER = extractor?.disableLocalWhisper ?? false;

  return {
    ...process.env,
    ...(WHISPER_CPP_BINARY === ""
      ? {}
      : { SUMMARIZE_WHISPER_CPP_BINARY: WHISPER_CPP_BINARY }),
    ...(WHISPER_CPP_MODEL_PATH === ""
      ? {}
      : { SUMMARIZE_WHISPER_CPP_MODEL_PATH: WHISPER_CPP_MODEL_PATH }),
    ...(DISABLE_LOCAL_WHISPER
      ? { SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP: "1" }
      : {}),
  };
}

let cachedClient: LinkPreviewClient | undefined;

export async function summarizeClient(): Promise<LinkPreviewClient> {
  if (cachedClient) return cachedClient;
  const { extractor } = getConfiguration()

  const YT_DLP_PATH = extractor?.ytDlpBin;
  const options: LinkPreviewClientOptions = {
    env: clientEnv(),
    ytDlpPath: YT_DLP_PATH ?? null,
    scrapeWithFirecrawl: null,
  };

  const { createLinkPreviewClient } = await summarizeContent();
  cachedClient = createLinkPreviewClient(options);
  return cachedClient;
}

export function resetSummarizeClient(): void {
  cachedClient = undefined;
}
