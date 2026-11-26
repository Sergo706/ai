import type {
  AuthProvider,
  OAuthClientProvider,
} from "@modelcontextprotocol/client";
import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { ToolSpec } from "../tools/toolRegistry";

export type McpAuth =
  | { type: "none" }
  | { type: "bearer"; token: string | (() => string | Promise<string>) }
  | { type: "headers"; headers: Record<string, string> }
  | { type: "oauth"; provider: AuthProvider | OAuthClientProvider };

/**
 * Defaults every tool from one server inherits.
 *
 * `ToolSpec` minus the fields that cannot be shared. `name` and `definitions`
 * come from the server's own tool list — one policy covers many differently-named
 * tools, so a shared name or schema would collapse them into one. `make` is
 * generated per tool, since each one calls back a different endpoint.
 *
 * What remains is the tuning that is per-server rather than per-tool: a cache
 * TTL, a call cap, a concurrency width and a stream policy.
 */
export type McpToolPolicy = Omit<
  ToolSpec<unknown>,
  "name" | "make" | "definitions"
>;

/** One MCP server to connect to. */
export interface McpServerConfig {
  /**
   * Prefix applied to every tool name this server exposes.
   */
  namespace?: string;
  /** Streamable HTTP endpoint, e.g. `https://mcp.example.com/mcp`. */
  url: string | URL;
  /** Defaults to `{ type: "none" }`. */
  auth?: McpAuth;
  /**
   * Which of the server's tools to drop.
   *
   * Array form drops the listed names; function form is called with the name
   * and drops the tool when it returns `true`. Both match the *server's* name,
   * before the namespace prefix is applied, because that is the name the
   * operator sees in the server's own documentation.
   */
  exclude?: readonly string[] | ((toolName: string) => boolean);
  /** Handshake identity. Defaults to this package's name. */
  clientInfo?: { name: string; version: string };
  /**
   * Applied to every tool this server exposes.
   *
   * Carried on the server rather than on each resulting tool because the caller
   * never writes those tools — they arrive from `listTools()`. Without this
   * there would be no place to say "cache this server's reads for an hour" or
   * "only two of these may run at once".
   */
  policy?: McpToolPolicy;
}

/** The result of connecting to one or more servers. */
export interface McpToolset {
  /**
   * OpenAI function definitions, ready to spread into `tools` next to native
   * ones.
   *
   * Mutated in place by `refresh()`, so a caller that spread it once does not
   * have to re-read the field to see updated tools.
   */
  definitions: ChatCompletionFunctionTool[];
  /**
   * One executable spec per advertised tool, calling the server back.
   *
   * Already carries the server's `policy`, so passing them to the agent is all
   * that is needed for caching, call caps and concurrency. Mutated in place by
   * `refresh()`, like `definitions`.
   */
  specs: ToolSpec<unknown>[];
  /** Re-reads every server's tool list and rewrites both arrays in place. */
  refresh: () => Promise<void>;
  /** Closes every connection. Safe to call more than once. */
  close: () => Promise<void>;
}
