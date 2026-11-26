export const landingCapabilities = [
  {
    icon: "i-lucide-bot",
    title: "Agents",
    body: "Build once, then run turn after turn with tools, attachments, memory, and structured output. Config mistakes fail at construction, not on the first request.",
  },
  {
    icon: "i-lucide-wrench",
    title: "Tool calling",
    body: "A bounded loop over rounds and calls, with caching, concurrency limits, per-tool call caps, and streamed tool events.",
  },
  {
    icon: "i-lucide-plug",
    title: "MCP",
    body: "Model Context Protocol servers become executable tools. Each one arrives as a function definition and a spec whose handler calls back on the live connection.",
  },
  {
    icon: "i-lucide-scan-search",
    title: "RAG",
    body: "Chunking, embedding, adaptive filtering, and vector search on pgvector or sqlite-vec, behind one query path for both dialects.",
  },
  {
    icon: "i-lucide-workflow",
    title: "Workflow agents",
    body: "A budgeted, multi-stage loop for work that cannot finish in one call. Every stage is capped, so a run always terminates.",
  },
  {
    icon: "i-lucide-history",
    title: "Runs",
    body: "Durable records with leases, heartbeats, event logs, checkpoints, and crash recovery. A client can reattach from another replica.",
  },
] as const;

export const landingPrinciples = [
  "The package never opens a port, mounts a route, or ships a prompt you did not write.",
  "Every heavy dependency is an optional peer, resolved on first use.",
  "SQLite and PostgreSQL share one schema, one migration set, one query API.",
] as const;

export const landingInstallCommand = "npm install @riavzon/ai";
export const landingRepoUrl = "https://github.com/Sergo706/ai";
