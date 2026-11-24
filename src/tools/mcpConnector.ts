/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type {
  AuthProvider,
  Client,
  OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { getConfiguration } from "../config/config";
import { loadPeer } from "../utils/loadPeerDepend";
import type {
  McpAuth,
  McpServerConfig,
  McpToolset,
} from "../types/mcp";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

type McpClientPeer = typeof import("@modelcontextprotocol/client");

let mcpClientModule: McpClientPeer | undefined;

async function mcpClient(): Promise<McpClientPeer> {
  mcpClientModule ??= await loadPeer<McpClientPeer>(
    "@modelcontextprotocol/client",
    "MCP servers",
  );
  return mcpClientModule;
}


const MAX_NAME_LENGTH = 64;
const UNSAFE_NAME_CHAR = /[^a-zA-Z0-9_-]/g;

const DEFAULT_CLIENT_INFO = { name: "ai", version: "1.0.0" };

interface Connection {
  config: McpServerConfig;
  client: Client;
}

function toUrl(url: string | URL): URL {
  return typeof url === "string" ? new URL(url) : url;
}


function authFor(auth: McpAuth = { type: "none" }): {
  authProvider?: AuthProvider | OAuthClientProvider;
  requestInit?: RequestInit;
} {
  switch (auth.type) {
    case "none":
      return {};
    case "bearer": {
      const token = auth.token;
      return {
        authProvider: {
          token: async () =>
            typeof token === "function" ? await token() : token,
        },
      };
    }
    case "headers":
      return { requestInit: { headers: auth.headers } };
    case "oauth":
      return { authProvider: auth.provider };
  }
}


function isIncluded(config: McpServerConfig, toolName: string): boolean {
  const exclude = config.exclude;
  if (exclude === undefined) return true;
  if (typeof exclude === "function") return !exclude(toolName);
  return !exclude.includes(toolName);
}


function functionName(config: McpServerConfig, toolName: string): string {
  const cleanTool = toolName.replace(UNSAFE_NAME_CHAR, "_");
  if (config.namespace === undefined || config.namespace === "") {
    return cleanTool.slice(0, MAX_NAME_LENGTH);
  }
  const cleanNamespace = config.namespace.replace(UNSAFE_NAME_CHAR, "_");
  return `${cleanNamespace}__${cleanTool}`.slice(0, MAX_NAME_LENGTH);
}

async function readServerTools(
  config: McpServerConfig,
  client: Client,
): Promise<ChatCompletionFunctionTool[]> {
  const definitions: ChatCompletionFunctionTool[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    cursor = page.nextCursor;

    for (const tool of page.tools) {
      if (!isIncluded(config, tool.name)) continue;

      definitions.push({
        type: "function",
        function: {
          name: functionName(config, tool.name),
          description:
            tool.description ??
            `${config.namespace ?? "mcp"}: ${tool.name}`,
          parameters: (tool.inputSchema) ?? {
            type: "object",
            properties: {},
          },
        },
      });
    }
  } while (cursor !== undefined);

  return definitions;
}

/**
 * Connect to one or more MCP servers and collect their tool definitions.
 *
 * The returned `definitions` are plain OpenAI schemas, ready to merge with your
 * own. This function only lists tools; it never calls them, so caching,
 * concurrency and streaming stay with the layer that executes the call.
 *
 * @param configs - The servers to connect to. An empty list resolves to an empty
 * toolset with no connections.
 * @returns Definitions plus `refresh()` and `close()`.
 * @throws If a server cannot be connected, after closing the ones already open.
 * @example
 * ```ts
 * const toolset = await createMcpToolset([
 *   { url: "https://mcp.example.com/mcp", namespace: "ex" },
 * ]);
 * await agent.tools.mcp(toolset.definitions);
 * onShutdown(() => toolset.close());
 * ```
 */
export async function createMcpToolset(
  configs: readonly McpServerConfig[],
): Promise<McpToolset> {
  if (configs.length === 0) {
    return {
      definitions: [],
      refresh: async () => { /* empty */ },
      close: async () => { /* empty */ },
    };
  }

  const log = getConfiguration().logger;
  const connections: Connection[] = [];
  const definitions: ChatCompletionFunctionTool[] = [];

  const loadAll = async (): Promise<void> => {
    const collected: ChatCompletionFunctionTool[] = [];
    for (const connection of connections) {
      const tools = await readServerTools(connection.config, connection.client);
      log.debug(
        { namespace: connection.config.namespace, count: tools.length },
        "[mcp] Read server tool list",
      );
      collected.push(...tools);
    }
    // Replaced in place so a caller holding the array keeps seeing the truth.
    definitions.length = 0;
    definitions.push(...collected);
  };

  try {
    const { Client, StreamableHTTPClientTransport } = await mcpClient();
    for (const config of configs) {
      const client = new Client(
        config.clientInfo ?? DEFAULT_CLIENT_INFO,
        { versionNegotiation: { mode: "auto" } },
      );
      const transport = new StreamableHTTPClientTransport(toUrl(config.url), {
        ...authFor(config.auth),
      });
      await client.connect(transport);
      connections.push({ config, client });
    }

    await loadAll();
  } catch (err) {
    await Promise.allSettled(connections.map(({ client }) => client.close()));
    log.error({ err }, "[mcp] Failed to connect to an MCP server");
    throw err;
  }

  return {
    definitions,
    refresh: loadAll,
    close: async () => {
      await Promise.allSettled(connections.map(({ client }) => client.close()));
      connections.length = 0;
      definitions.length = 0;
    },
  };
}
