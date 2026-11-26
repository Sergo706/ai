import { beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "~~/test/test-utils/config";

/**
 * The client is the boundary that decides which local binaries the library is
 * allowed to run. Getting the env wrong means a deployment silently falls back
 * to a PATH lookup and picks up the wrong whisper model, so the merge is worth
 * asserting exactly rather than inferring from a successful extraction.
 *
 * `createLinkPreviewClient` is the only thing mocked: a real one spawns
 * `yt-dlp`/`whisper-cli` on first use, which is an external process this suite
 * cannot execute.
 */

const h = vi.hoisted(() => ({
  createLinkPreviewClient: vi.fn(),
}));

vi.mock("@steipete/summarize-core/content", () => ({
  createLinkPreviewClient: h.createLinkPreviewClient,
}));

type ClientModule = typeof import("../client.js");

interface Harness {
  client: ClientModule;
  cleanup: () => Promise<void>;
}

/**
 * The client memoises its instance at module scope and reads `extractor` from
 * the process-wide configuration, so every case needs its own module registry.
 * `loadConfig` resets modules before importing the config, and the client is
 * imported afterwards so it shares that same fresh configuration.
 */
async function bootClient(
  extractor: Record<string, unknown> = {},
): Promise<Harness> {
  const env = await loadConfig({ overrides: { extractor } });
  const client = await import("../client.js");
  return { client, cleanup: env.cleanup };
}

function optionsOf(): Record<string, unknown> {
  return h.createLinkPreviewClient.mock.calls[0][0] as Record<string, unknown>;
}

beforeEach(() => {
  h.createLinkPreviewClient.mockReset();
  h.createLinkPreviewClient.mockReturnValue({ fetchLinkContent: vi.fn() });
});

describe("summarizeClient", () => {
  it("memoises the client across calls", async () => {
    const env = await bootClient();
    try {
      const first = await env.client.summarizeClient();
      const second = await env.client.summarizeClient();

      expect(h.createLinkPreviewClient).toHaveBeenCalledTimes(1);
      expect(second).toBe(first);
    } finally {
      await env.cleanup();
    }
  });

  it("builds a new client after a reset", async () => {
    const env = await bootClient();
    try {
      await env.client.summarizeClient();
      env.client.resetSummarizeClient();
      await env.client.summarizeClient();

      expect(h.createLinkPreviewClient).toHaveBeenCalledTimes(2);
    } finally {
      await env.cleanup();
    }
  });

  it("passes null for yt-dlp when no path is configured", async () => {
    const env = await bootClient();
    try {
      await env.client.summarizeClient();

      expect(optionsOf().ytDlpPath).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  it("passes the configured yt-dlp path through", async () => {
    const env = await bootClient({ ytDlpBin: "/opt/bin/yt-dlp" });
    try {
      await env.client.summarizeClient();

      expect(optionsOf().ytDlpPath).toBe("/opt/bin/yt-dlp");
    } finally {
      await env.cleanup();
    }
  });

  it("disables Firecrawl so no keyless scrape is attempted", async () => {
    const env = await bootClient();
    try {
      await env.client.summarizeClient();

      expect(optionsOf().scrapeWithFirecrawl).toBeNull();
    } finally {
      await env.cleanup();
    }
  });

  it("omits whisper keys when nothing is configured", async () => {
    const env = await bootClient();
    try {
      await env.client.summarizeClient();

      const procEnv = optionsOf().env as Record<string, string | undefined>;
      // Omitted, not passed as "": an empty value would read as a broken path.
      expect(procEnv).not.toHaveProperty("SUMMARIZE_WHISPER_CPP_BINARY");
      expect(procEnv).not.toHaveProperty("SUMMARIZE_WHISPER_CPP_MODEL_PATH");
      expect(procEnv).not.toHaveProperty("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP");
    } finally {
      await env.cleanup();
    }
  });

  it("forwards both whisper paths when configured", async () => {
    const env = await bootClient({
      whisperCppBin: "/opt/bin/whisper-cli",
      whisperCppModelPath: "/models/ggml-base.bin",
    });
    try {
      await env.client.summarizeClient();

      const procEnv = optionsOf().env as Record<string, string | undefined>;
      expect(procEnv.SUMMARIZE_WHISPER_CPP_BINARY).toBe("/opt/bin/whisper-cli");
      expect(procEnv.SUMMARIZE_WHISPER_CPP_MODEL_PATH).toBe(
        "/models/ggml-base.bin",
      );
    } finally {
      await env.cleanup();
    }
  });

  it("sets the disable flag only when explicitly turned on", async () => {
    const env = await bootClient({ disableLocalWhisper: true });
    try {
      await env.client.summarizeClient();

      const procEnv = optionsOf().env as Record<string, string | undefined>;
      expect(procEnv.SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP).toBe("1");
    } finally {
      await env.cleanup();
    }
  });

  it("keeps the ambient process env visible to the library", async () => {
    const env = await bootClient({ disableLocalWhisper: false });
    try {
      await env.client.summarizeClient();

      const procEnv = optionsOf().env as Record<string, string | undefined>;
      // Everything else the library reads (HOME, PATH, provider keys) still
      // works, and an explicit `false` must not become "1".
      expect(procEnv.HOME).toBe(process.env.HOME);
      expect(procEnv).not.toHaveProperty("SUMMARIZE_DISABLE_LOCAL_WHISPER_CPP");
    } finally {
      await env.cleanup();
    }
  });

  it("keeps a configured binary when only the model is missing", async () => {
    const env = await bootClient({ whisperCppBin: "/opt/bin/whisper-cli" });
    try {
      await env.client.summarizeClient();

      const procEnv = optionsOf().env as Record<string, string | undefined>;
      // Each knob is merged independently; one missing path must not drop the
      // other.
      expect(procEnv.SUMMARIZE_WHISPER_CPP_BINARY).toBe("/opt/bin/whisper-cli");
      expect(procEnv).not.toHaveProperty("SUMMARIZE_WHISPER_CPP_MODEL_PATH");
    } finally {
      await env.cleanup();
    }
  });
});
