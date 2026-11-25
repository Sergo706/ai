import { afterEach, describe, expect, it } from "vitest";

import { libLog, libLogger, resetLibLogger } from "~~/test/test-utils/logger.js";
import { loadConfig, type LoadedConfig } from "~~/test/test-utils/config.js";
import {
  startMcpServer,
  type McpServerHandle,
} from "~~/test/test-utils/mcpServer.js";

/**
 * Real-socket tests for the MCP toolset loader.
 *
 * The client, its transport and the JSON-RPC handshake are the library's own
 * code talking to a real HTTP server over a real socket. Only the *server* is a
 * fixture, because that is the external service boundary — there is no way to
 * exercise a network protocol without one end of the wire being local.
 */

let env: LoadedConfig;
const servers: McpServerHandle[] = [];

async function boot() {
  resetLibLogger();
  env = await loadConfig({ dialect: "sqlite", logger: libLogger });
  return await import("~/tools/mcpConnector.js");
}

function track(handle: McpServerHandle): McpServerHandle {
  servers.push(handle);
  return handle;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await env.cleanup();
});

describe("createMcpToolset", () => {
  it("returns an inert toolset for an empty config list", async () => {
    const { createMcpToolset } = await boot();
    const toolset = await createMcpToolset([]);

    expect(toolset.definitions).toEqual([]);
    expect(toolset.specs).toEqual([]);
    // Both no-ops must be callable without throwing.
    await expect(toolset.refresh()).resolves.toBeUndefined();
    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it("lists tools from a live server and maps them to OpenAI schemas", async () => {
    const server = track(
      await startMcpServer({
        tools: [
          {
            name: "search",
            description: "Search the web",
            inputSchema: {
              type: "object",
              properties: { q: { type: "string" } },
              required: ["q"],
            },
          },
          { name: "fetch" },
        ],
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: server.url, namespace: "web" },
    ]);

    expect(toolset.definitions).toEqual([
      {
        type: "function",
        function: {
          name: "web__search",
          description: "Search the web",
          parameters: {
            type: "object",
            properties: { q: { type: "string" } },
            required: ["q"],
          },
        },
      },
      {
        type: "function",
        function: {
          name: "web__fetch",
          // No description on the server, so the namespace and name are used.
          description: "web: fetch",
          parameters: { type: "object", properties: {} },
        },
      },
    ]);

    // The handshake really happened, in protocol order. `server/discover` comes
    // first: the transport probes for a modern envelope before falling back to
    // the classic `initialize` exchange.
    expect(server.methods).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(libLog.debug).toHaveBeenCalledWith(
      { namespace: "web", count: 2 },
      "[mcp] Read server tool list",
    );

    await toolset.close();
  });

  it("omits the namespace prefix when none is configured", async () => {
    const server = track(
      await startMcpServer({ tools: [{ name: "ping", description: "Ping" }] }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    expect(toolset.definitions[0]?.function.name).toBe("ping");
    await toolset.close();
  });

  it("sanitises characters an OpenAI function name cannot contain", async () => {
    const server = track(
      await startMcpServer({ tools: [{ name: "do.something/odd:now" }] }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: server.url, namespace: "ns.with dots" },
    ]);
    expect(toolset.definitions[0]?.function.name).toBe("ns_with_dots__do_something_odd_now");
    await toolset.close();
  });

  it("truncates a generated name to sixty-four characters", async () => {
    const server = track(
      await startMcpServer({ tools: [{ name: "t".repeat(80) }] }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: server.url, namespace: "n".repeat(20) },
    ]);
    const name = toolset.definitions[0]?.function.name ?? "";
    expect(name).toHaveLength(64);
    await toolset.close();
  });

  it("follows cursor paging until the server stops sending one", async () => {
    const server = track(
      await startMcpServer({
        pageSize: 2,
        tools: [
          { name: "a" },
          { name: "b" },
          { name: "c" },
          { name: "d" },
          { name: "e" },
        ],
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    expect(toolset.definitions.map((d) => d.function.name)).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
    // initialize + initialized + three pages.
    expect(server.methods.filter((m) => m === "tools/list")).toHaveLength(3);
    await toolset.close();
  });

  it("merges tool lists from several servers in order", async () => {
    const first = track(await startMcpServer({ tools: [{ name: "one" }] }));
    const second = track(await startMcpServer({ tools: [{ name: "two" }] }));
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: first.url, namespace: "a" },
      { url: second.url, namespace: "b" },
    ]);

    expect(toolset.definitions.map((d) => d.function.name)).toEqual([
      "a__one",
      "b__two",
    ]);
    await toolset.close();
  });

  it("filters with an exclusion array", async () => {
    const server = track(
      await startMcpServer({
        tools: [{ name: "keep" }, { name: "drop" }],
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: server.url, exclude: ["drop"] },
    ]);
    expect(toolset.definitions.map((d) => d.function.name)).toEqual(["keep"]);
    await toolset.close();
  });

  it("filters with an exclusion predicate", async () => {
    const server = track(
      await startMcpServer({
        tools: [{ name: "keep" }, { name: "drop" }],
      }),
    );
    const { createMcpToolset } = await boot();

    const seen: string[] = [];
    const toolset = await createMcpToolset([
      {
        url: server.url,
        exclude: (name) => {
          seen.push(name);
          return name === "drop";
        },
      },
    ]);
    expect(seen).toEqual(["keep", "drop"]);
    expect(toolset.definitions.map((d) => d.function.name)).toEqual(["keep"]);
    await toolset.close();
  });

  it("refreshes the definitions in place", async () => {
    const server = track(await startMcpServer({ tools: [{ name: "first" }] }));
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    const live = toolset.definitions;
    expect(live.map((d) => d.function.name)).toEqual(["first"]);

    // A caller holding the array must see the new list without re-reading it.
    const before = server.methods.filter((m) => m === "tools/list").length;
    await toolset.refresh();
    expect(server.methods.filter((m) => m === "tools/list").length).toBe(before + 1);
    expect(live.map((d) => d.function.name)).toEqual(["first"]);
    await toolset.close();
  });

  it("sends a bearer token supplied as a string", async () => {
    const server = track(
      await startMcpServer({ tools: [{ name: "t" }], bearer: "secret-token" }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: server.url, auth: { type: "bearer", token: "secret-token" } },
    ]);
    expect(toolset.definitions).toHaveLength(1);
    expect(server.seenHeaders.every((h) => h.authorization === "Bearer secret-token")).toBe(
      true,
    );
    await toolset.close();
  });

  it("calls the token function on every request, so a rotation is picked up", async () => {
    let issued = 0;
    const server = track(
      await startMcpServer({ tools: [{ name: "t" }], bearer: "token-1" }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      {
        url: server.url,
        auth: {
          type: "bearer",
          token: async () => {
            issued += 1;
            return "token-1";
          },
        },
      },
    ]);

    expect(toolset.definitions).toHaveLength(1);
    // The provider is consulted once per HTTP request, not once per connection.
    expect(issued).toBeGreaterThanOrEqual(2);
    await toolset.close();
  });

  it("sends custom headers", async () => {
    const server = track(
      await startMcpServer({
        tools: [{ name: "t" }],
        headers: { "x-custom": "value" },
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      {
        url: server.url,
        auth: { type: "headers", headers: { "x-custom": "value" } },
      },
    ]);
    expect(toolset.definitions).toHaveLength(1);
    expect(server.seenHeaders.every((h) => h["x-custom"] === "value")).toBe(true);
    await toolset.close();
  });

  it("delegates OAuth to the supplied provider", async () => {
    const server = track(
      await startMcpServer({ tools: [{ name: "t" }], bearer: "oauth-token" }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      {
        url: server.url,
        auth: {
          type: "oauth",
          provider: { token: async () => "oauth-token" },
        },
      },
    ]);
    expect(toolset.definitions).toHaveLength(1);
    expect(
      server.seenHeaders.every((h) => h.authorization === "Bearer oauth-token"),
    ).toBe(true);
    await toolset.close();
  });

  it("closes an earlier connection when a later server fails", async () => {
    const good = track(await startMcpServer({ tools: [{ name: "t" }] }));
    const bad = track(await startMcpServer({ tools: [], failWith: 500 }));
    const { createMcpToolset } = await boot();

    await expect(
      createMcpToolset([{ url: good.url }, { url: bad.url }]),
    ).rejects.toThrow(
      // The failure surfaces from the version-negotiation probe, which is the
      // first request the transport makes.
      "Version negotiation failed: the server answered the probe with HTTP 500",
    );
    expect(libLog.error).toHaveBeenCalledWith(
      { err: expect.any(Error) as Error },
      "[mcp] Failed to connect to an MCP server",
    );

    // The good server completed its handshake but was never asked for tools:
    // `loadAll` only runs once every connection is open, so a failure leaves
    // the set partially connected and the catch block tears it down.
    expect(good.methods).toEqual([
      "server/discover",
      "initialize",
      "notifications/initialized",
    ]);
    expect(bad.methods).toEqual([]);
  });

  it("rejects when the first server is unreachable", async () => {
    const { createMcpToolset } = await boot();
    await expect(
      createMcpToolset([{ url: "http://127.0.0.1:1/mcp" }]),
    ).rejects.toThrow();
  });

  it("clears the definitions on close", async () => {
    const server = track(await startMcpServer({ tools: [{ name: "t" }] }));
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    expect(toolset.definitions).toHaveLength(1);
    expect(toolset.specs).toHaveLength(1);
    await toolset.close();
    expect(toolset.definitions).toEqual([]);
    expect(toolset.specs).toEqual([]);

    // A second close is a no-op rather than an error.
    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it("passes the caller's client info to the handshake", async () => {
    const server = track(await startMcpServer({ tools: [{ name: "t" }] }));
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: server.url, clientInfo: { name: "custom", version: "9.9.9" } },
    ]);
    const init = server.bodies.find((b) => b.method === "initialize") as {
      params: { clientInfo: { name: string; version: string } };
    };
    expect(init.params.clientInfo).toEqual({ name: "custom", version: "9.9.9" });
    await toolset.close();
  });

  it("defaults the client info when the caller omits it", async () => {
    const server = track(await startMcpServer({ tools: [{ name: "t" }] }));
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    const init = server.bodies.find((b) => b.method === "initialize") as {
      params: { clientInfo: { name: string; version: string } };
    };
    expect(init.params.clientInfo).toEqual({ name: "ai", version: "1.0.0" });
    await toolset.close();
  });

  it("accepts a URL object as well as a string", async () => {
    const server = track(await startMcpServer({ tools: [{ name: "t" }] }));
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: new URL(server.url) }]);
    expect(toolset.definitions).toHaveLength(1);
    await toolset.close();
  });

  it("generates one callable spec per advertised tool", async () => {
    const server = track(
      await startMcpServer({
        tools: [{ name: "search", description: "Search the web" }, { name: "fetch" }],
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: server.url, namespace: "web" },
    ]);

    expect(toolset.specs.map((spec) => spec.name)).toEqual([
      "web__search",
      "web__fetch",
    ]);
    // Each spec advertises the same definition that was collected.
    expect(toolset.specs.map((spec) => spec.definitions)).toEqual(
      toolset.definitions,
    );
    await toolset.close();
  });

  it("carries the server policy onto every generated spec", async () => {
    const server = track(await startMcpServer({ tools: [{ name: "t" }] }));
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      {
        url: server.url,
        policy: { maxCalls: 2, concurrency: 1, cache: { ttl: 60 } },
      },
    ]);

    expect(toolset.specs[0]?.maxCalls).toBe(2);
    expect(toolset.specs[0]?.concurrency).toBe(1);
    expect(toolset.specs[0]?.cache?.ttl).toBe(60);
    await toolset.close();
  });

  it("calls the server's own tool name, not the exposed one", async () => {
    const server = track(
      await startMcpServer({
        tools: [{ name: "do.thing", result: "done" }],
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([
      { url: server.url, namespace: "ns" },
    ]);
    const spec = toolset.specs[0];
    expect(spec.name).toBe("ns__do_thing");

    const handler = spec.make({ userId: "u" });
    await expect(
      handler({}, { toolCallId: "c1", callIndex: 1, callTotal: 1 }),
    ).resolves.toBe("done");

    const call = server.bodies.find((body) => body.method === "tools/call");
    expect(call).toMatchObject({
      params: { name: "do.thing", arguments: {} },
    });
    await toolset.close();
  });

  it("returns structured content in preference to text", async () => {
    const server = track(
      await startMcpServer({
        tools: [{ name: "stats", result: "ignored", structured: { total: 3 } }],
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    const handler = toolset.specs[0].make({ userId: "u" });

    await expect(
      handler({}, { toolCallId: "c1", callIndex: 1, callTotal: 1 }),
    ).resolves.toEqual({ total: 3 });
    await toolset.close();
  });

  it("turns an isError result into a tool error payload", async () => {
    const server = track(
      await startMcpServer({
        tools: [{ name: "boom", result: "rate limited", isError: true }],
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    const handler = toolset.specs[0].make({ userId: "u" });

    const result = await handler(
      {},
      { toolCallId: "c1", callIndex: 1, callTotal: 1 },
    );
    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string)).toEqual({
      error: { code: "MCP_TOOL_ERROR", message: "rate limited" },
    });
    await toolset.close();
  });

  it("reports a call failure as a tool error instead of throwing", async () => {
    const server = track(
      await startMcpServer({ tools: [{ name: "t" }], callFailWith: 500 }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    const handler = toolset.specs[0].make({ userId: "u" });

    const result = await handler(
      {},
      { toolCallId: "c1", callIndex: 1, callTotal: 1 },
    );
    expect(typeof result).toBe("string");
    expect(JSON.parse(result as string)).toMatchObject({
      error: { code: "MCP_CALL_FAILED" },
    });
    await toolset.close();
  });

  it("rewrites the specs in place on refresh", async () => {
    const server = track(await startMcpServer({ tools: [{ name: "first" }] }));
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    const live = toolset.specs;
    expect(live.map((spec) => spec.name)).toEqual(["first"]);

    await toolset.refresh();
    expect(live.map((spec) => spec.name)).toEqual(["first"]);
    await toolset.close();
  });

  it("extracts text from embedded resources and resource links while ignoring binary blocks", async () => {
    const server = track(
      await startMcpServer({
        tools: [
          {
            name: "mixed",
            content: [
              { type: "text", text: "summary line" },
              {
                type: "resource",
                resource: {
                  uri: "file:///docs/readme.md",
                  mimeType: "text/markdown",
                  text: "hello from resource",
                },
              },
              {
                type: "resource_link",
                uri: "https://example.com/spec",
                name: "API Spec",
                description: "REST endpoints",
              },
              {
                type: "image",
                data: "iVBORw0KGgoAAAANSUhEUg==",
                mimeType: "image/png",
              },
              {
                type: "audio",
                data: "SUQzAwAAAAAA",
                mimeType: "audio/mpeg",
              },
              {
                type: "resource",
                resource: {
                  uri: "file:///docs/archive.bin",
                  mimeType: "application/octet-stream",
                  blob: "AQIDBA==",
                },
              },
            ],
          },
        ],
      }),
    );
    const { createMcpToolset } = await boot();

    const toolset = await createMcpToolset([{ url: server.url }]);
    const handler = toolset.specs[0].make({ userId: "u" });

    const output = await handler(
      {},
      { toolCallId: "c1", callIndex: 1, callTotal: 1 },
    );

    expect(output).toBe(
      [
        "summary line",
        "hello from resource",
        "API Spec https://example.com/spec: REST endpoints",
      ].join("\n"),
    );
    expect(String(output)).not.toContain("iVBORw0KGgo");
    expect(String(output)).not.toContain("SUQzAw");
    expect(String(output)).not.toContain("AQIDBA");
    await toolset.close();
  });
});
