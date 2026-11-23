import {
  createLinkPreviewClient,
  type LinkPreviewClient,
  type LinkPreviewClientOptions,
} from "@steipete/summarize-core/content";
import { getConfiguration } from "../../../../../config/config";


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

export function summarizeClient(): LinkPreviewClient {
  if (cachedClient) return cachedClient;
  const { extractor } = getConfiguration()

  const YT_DLP_PATH = extractor?.ytDlpBin;
  const options: LinkPreviewClientOptions = {
    env: clientEnv(),
    ytDlpPath: YT_DLP_PATH ?? null,
    scrapeWithFirecrawl: null,
  };

  cachedClient = createLinkPreviewClient(options);
  return cachedClient;
}

export function resetSummarizeClient(): void {
  cachedClient = undefined;
}
