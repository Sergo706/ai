/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type {
  AuthProvider,
  Client,
  OAuthClientProvider,
} from "@modelcontextprotocol/client";
import { getConfiguration } from "../config/config";
import { loadPeer } from "../utils/loadPeerDepend";
import type { McpAuth, McpServerConfig, McpToolset } from "../types/mcp";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { ToolSpec } from "./toolRegistry";
import { toolError } from "./execution/protocol";


interface ServerTools {
  definitions: ChatCompletionFunctionTool[];
  specs: ToolSpec<unknown>[];
}
interface Connection {
  config: McpServerConfig;
  client: Client;
}

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

function contentToText(content: unknown): string {
  if (!Array.isArray(content)) return "";

  return content
    .map((block) =>
      block !== null && typeof block === "object" && "text" in block
        ? String((block as { text?: unknown }).text)
        : "",
    )
    .filter((text) => text !== "")
    .join("\n");
}



async function readServerTools(
  config: McpServerConfig,
  client: Client,
): Promise<ServerTools> {
  const definitions: ChatCompletionFunctionTool[] = [];
  const specs: ToolSpec<unknown>[] = [];
  let cursor: string | undefined;

  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    cursor = page.nextCursor;

    for (const tool of page.tools) {
      if (!isIncluded(config, tool.name)) continue;

      const definition: ChatCompletionFunctionTool = {
        type: "function",
        function: {
          name: functionName(config, tool.name),
          description:
            tool.description ?? `${config.namespace ?? "mcp"}: ${tool.name}`,
          parameters: tool.inputSchema ?? {
            type: "object",
            properties: {},
          },
        },
      };

      definitions.push(definition);
      specs.push({
        name: definition.function.name,
        definitions: definition,
        ...config.policy,
        make: () => async (args, context) => {
          try {
            const result = await client.callTool(
              { name: tool.name, arguments: args },
              { signal: context.signal, toolDefinition: tool },
            );

            const text = contentToText(result.content);

            if (result.isError === true) {
              return toolError(
                "MCP_TOOL_ERROR",
                text === "" ? "The MCP tool reported an error." : text,
              );
            }

            return result.structuredContent === undefined
              ? text
              : result.structuredContent;
          } catch (err: unknown) {
            return toolError(
              "MCP_CALL_FAILED",
              err instanceof Error ? err.message : String(err),
            );
          }
        },
      });
    }
  } while (cursor !== undefined);

  return { definitions, specs };
}

/**
 * Connect to one or more MCP servers and expose their tools.
 *
 * Each server tool becomes two things from one pass over `tools/list`: an
 * OpenAI definition, and a `ToolSpec` whose handler calls the tool back on the
 * live connection. Both arrays are replaced in place by `refresh()`.
 *
 * Pass `specs` to an agent's `tools` and the tools are advertised and
 * executable; cache, call caps and concurrency come from `McpServerConfig.policy`.
 *
 * @param configs - The servers to connect to. An empty list resolves to an empty
 * toolset with no connections.
 * @returns Definitions, callable specs, plus `refresh()` and `close()`.
 * @throws If a server cannot be connected, after closing the ones already open.
 * @example
 * ```ts
 * const agent = await createAgent({
 *   model: { model: "gpt-4o-mini" },
 *   tools: { mcp: [{ url: "https://mcp.example.com/mcp", namespace: "ex" }] },
 * });
 * ```
 */
export async function createMcpToolset(
  configs: readonly McpServerConfig[],
): Promise<McpToolset> {
  if (configs.length === 0) {
    return {
      definitions: [],
      specs: [],
      refresh: async () => {
        /* empty */
      },
      close: async () => {
        /* empty */
      },
    };
  }

  const log = getConfiguration().logger;
  const connections: Connection[] = [];
  const definitions: ChatCompletionFunctionTool[] = [];
  const specs: ToolSpec<unknown>[] = [];

  const loadAll = async (): Promise<void> => {
    const collectedDefinitions: ChatCompletionFunctionTool[] = [];
    const collectedSpecs: ToolSpec<unknown>[] = [];

    for (const connection of connections) {
      const tools = await readServerTools(connection.config, connection.client);
      log.debug(
        {
          namespace: connection.config.namespace,
          count: tools.definitions.length,
        },
        "[mcp] Read server tool list",
      );
      collectedDefinitions.push(...tools.definitions);
      collectedSpecs.push(...tools.specs);
    }

    // Replaced in place so a caller holding the arrays keeps seeing the truth.
    definitions.length = 0;
    definitions.push(...collectedDefinitions);
    specs.length = 0;
    specs.push(...collectedSpecs);
  };

  try {
    const { Client, StreamableHTTPClientTransport } = await mcpClient();
    for (const config of configs) {
      const client = new Client(config.clientInfo ?? DEFAULT_CLIENT_INFO, {
        versionNegotiation: { mode: "auto" },
      });
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
    specs,
    refresh: loadAll,
    close: async () => {
      await Promise.allSettled(connections.map(({ client }) => client.close()));
      connections.length = 0;
      definitions.length = 0;
      specs.length = 0;
    },
  };
}
