---
title: Getting Started
description: Learn what @riavzon/ai provides, install the core package and optional peers, plan your database and cache infrastructure, and build your first streaming agent.
navigation: false
seo:
  title: Getting Started with @riavzon/ai — Riavzon AI
  description: "Start with @riavzon/ai: explore the architecture, install optional peers, choose SQLite or PostgreSQL with Redis, and ship your first streaming agent."
---

`@riavzon/ai` is an embeddable TypeScript runtime for AI agents, tool calling, MCP integrations, hybrid RAG, multi-step research workflows, and durable SSE runs. Follow the guides below to understand the architecture, install only the optional peers your stack needs, and ship your first streaming agent.

## Follow the onboarding path

::card-group
  :::card{title="Introduction" icon="i-lucide-book-open" to="/getting-started/introduction"}
  Explore the runtime architecture, subsystem layers, and design principles behind `@riavzon/ai`.
  :::
  :::card{title="Installation" icon="i-lucide-download" to="/getting-started/installation"}
  Install `@riavzon/ai`, `openai`, and only the lazy-loaded peer dependencies your project uses.
  :::
  :::card{title="Infrastructure" icon="i-lucide-server" to="/getting-started/infrastructure"}
  Choose between SQLite + in-memory cache for single-node apps and PostgreSQL + Redis for multi-replica deployments.
  :::
  :::card{title="Quickstart" icon="i-lucide-rocket" to="/getting-started/quickstart"}
  Configure the runtime, create an agent with built-in and custom tools, and stream SSE responses in five minutes.
  :::
  :::card{title="AI & LLM Integrations" icon="i-lucide-sparkles" to="/getting-started/ai-integrations"}
  Connect coding agents and pipelines to these docs via downloadable Agent Skills, MCP, `llms.txt`, raw Markdown, and OpenAPI.
  :::
::
