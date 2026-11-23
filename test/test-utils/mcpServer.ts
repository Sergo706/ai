import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";



const PROTOCOL_VERSION = "2025-06-18";

export interface McpToolFixture {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  /** Returned as the tool result when called. */
  result?: string;
}

export interface McpServerOptions {
  /** Tools the server advertises, in order. */
  tools: readonly McpToolFixture[];
  /** How many tools per `tools/list` page. Omit for a single unpaged reply. */
  pageSize?: number;
  /** Require this exact bearer token, or `undefined` to accept anything. */
  bearer?: string;
  /** Require these exact headers, or `undefined` to accept anything. */
  headers?: Record<string, string>;
  /** Reply 500 to every request, to exercise the connect-failure path. */
  failWith?: number;
  /** Omit `mcp-session-id` from the initialize reply. */
  sessionless?: boolean;
}

export interface McpServerHandle {
  url: string;
  /** Every JSON-RPC method the client sent, in order. */
  methods: string[];
  /** Every request body the client sent, in order. */
  bodies: Record<string, unknown>[];
  /** Authorization and custom headers seen, per request. */
  seenHeaders: Record<string, string | undefined>[];
  /** Sockets refused by the lifetime cap, if the caller set one. */
  close: () => Promise<void>;
}

interface JsonRpcRequest {
  jsonrpc: string;
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

function reply(
  res: import("node:http").ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

/**
 * Starts the fixture on an ephemeral port and returns its URL plus a log.
 */
export async function startMcpServer(
  options: McpServerOptions,
): Promise<McpServerHandle> {
  const methods: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const seenHeaders: Record<string, string | undefined>[] = [];

  const server: Server = createServer((req, res) => {
    void (async () => {
      const raw = await readBody(req);
      seenHeaders.push({
        authorization: req.headers.authorization,
        "x-custom": req.headers["x-custom"] as string | undefined,
      });

      if (options.failWith !== undefined) {
        res.writeHead(options.failWith, { "content-type": "text/plain" });
        res.end("nope");
        return;
      }

      if (req.method === "DELETE") {
        res.writeHead(200).end();
        return;
      }

      if (options.bearer !== undefined) {
        if (req.headers.authorization !== `Bearer ${options.bearer}`) {
          res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
          return;
        }
      }

      if (options.headers !== undefined) {
        for (const [name, value] of Object.entries(options.headers)) {
          if (req.headers[name.toLowerCase()] !== value) {
            res.writeHead(403, { "content-type": "text/plain" }).end("forbidden");
            return;
          }
        }
      }

      if (raw === "") {
        res.writeHead(202).end();
        return;
      }

      const message = JSON.parse(raw) as JsonRpcRequest | JsonRpcRequest[];
      const requests = Array.isArray(message) ? message : [message];

      for (const request of requests) {
        bodies.push(request as unknown as Record<string, unknown>);
        methods.push(request.method);

        if (request.id === undefined) {
          // A notification: acknowledge with 202, as the spec requires.
          continue;
        }

        if (request.method === "initialize") {
          reply(
            res,
            200,
            {
              jsonrpc: "2.0",
              id: request.id,
              result: {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: { listChanged: false } },
                serverInfo: { name: "fixture", version: "0.0.1" },
              },
            },
            options.sessionless === true
              ? {}
              : { "mcp-session-id": "fixture-session" },
          );
          return;
        }

        if (request.method === "tools/list") {
          const cursor = request.params?.cursor as string | undefined;
          const size = options.pageSize ?? options.tools.length;
          const start = cursor === undefined ? 0 : Number(cursor);
          const page = options.tools.slice(start, start + size);
          const next = start + size;

          reply(res, 200, {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              tools: page.map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema ?? {
                  type: "object",
                  properties: {},
                },
              })),
              nextCursor: next < options.tools.length ? String(next) : undefined,
            },
          });
          return;
        }

        if (request.method === "tools/call") {
          const name = request.params?.name as string;
          const tool = options.tools.find((candidate) => candidate.name === name);
          reply(res, 200, {
            jsonrpc: "2.0",
            id: request.id,
            result: {
              content: [{ type: "text", text: tool?.result ?? "" }],
            },
          });
          return;
        }

        reply(res, 200, {
          jsonrpc: "2.0",
          id: request.id,
          error: { code: -32601, message: `Unknown method ${request.method}` },
        });
        return;
      }

      // Only notifications arrived; the spec allows a bare 202.
      res.writeHead(202).end();
    })().catch((err: unknown) => {
      if (!res.headersSent) res.writeHead(500).end(String(err));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(address.port)}/mcp`,
    methods,
    bodies,
    seenHeaders,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}
