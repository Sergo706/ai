const isDev = process.env.NODE_ENV === 'development'

export default defineNuxtConfig({
  extends: ['docus'],
  modules: ['nuxt-studio'],

  studio: {
    route: '/_studio',
    repository: {
      provider: 'github',
      owner: 'Sergo706',
      repo: 'ai',
      branch: 'main',
      rootDir: 'web',
    },
  },

  site: {
    url: 'https://ai.riavzon.com',
    name: 'Riavzon AI',
    description: 'Centralized documentation for @riavzon/ai',
    defaultLocale: 'en',
    indexable: true,
  },

  colorMode: {
    preference: 'dark',
    fallback: 'dark',
  },

  fonts: {
    families: [
      { name: 'Geist', display: 'swap', preload: true },
      { name: 'Newsreader', display: 'swap', preload: true },
    ],
  },
    routeRules: isDev
    ? {}
    : {
        '/': { prerender: true, cache: { maxAge: 60 * 60 * 24 * 30 } }
      },

  sitemap: {
    exclude: ['/sitemap.xml'],
    zeroRuntime: true,
  },
  telemetry: false,

  llms: {
    domain: 'https://ai.riavzon.com',
    title: 'Riavzon AI',
    description:
      'Documentation for @riavzon/ai, a zero-magic embeddable TypeScript agent runtime. It owns the agent loop, the tool protocol, retrieval, and the run lifecycle, while leaving the HTTP layer, database state, and raw OpenAI wire payloads under your control. Scales from zero-config SQLite to multi-replica Postgres and Redis Streams with no external daemons and no hidden prompts.',
    sections: [
      {
        title: 'What @riavzon/ai Provides',
        description:
          'Every heavy dependency is an optional peer, loaded on first use, so a project that only needs chat installs only chat. The package never opens a port, never mounts a route, and never hides a prompt. `configuration()` is called once at startup and accepts an OpenAI-compatible client, a SQLite path or a `pg` Pool, embedding settings, an optional cache, and a logger.',
        links: [
          {
            title: 'Getting Started and Installation',
            description:
              'Install the package plus the peers you actually use. `openai` is required for chat and embeddings. A SQLite path needs `better-sqlite3` and `sqlite-vec`; a `pg` Pool needs `pg`. PostgreSQL also requires the `pgvector` extension.',
            href: '/getting-started/installation',
          },
          {
            title: 'Agents',
            description:
              'An agent is built once with `createAgent()` and reused. Construction resolves the model, validates the config, connects MCP servers, and assembles the tool registry, so a mistake fails at startup rather than on the first user request. `agent.chat()` returns a stream of typed frames; `agent.complete()` drains the same stream and resolves with the final result.',
            href: '/agents',
          },
          {
            title: 'Tool Calling and ToolSpec',
            description:
              'Tools come from the built-in set, your own `ToolSpec` objects, and MCP servers. A `ToolSpec` builds a fresh handler per request, so it can capture the user, the conversation, or a connection that only exists for that turn. Specs support a cache TTL, a call cap, and a concurrency limit.',
            href: '/tools',
          },
          {
            title: 'MCP Tools',
            description:
              'Point the agent at one or more Model Context Protocol servers and their tools arrive ready to run. Each server tool becomes an OpenAI function definition and a matching `ToolSpec` whose handler calls back on the live connection. Namespacing keeps tool names unique and exclusion lists hide the tools you do not want.',
            href: '/tools/mcp-tools',
          },
          {
            title: 'Streaming & SSE',
            description:
              'Typed Server-Sent Events helpers, heartbeat streams, out-of-band event sinks, trace collection, abort control, and composable low-level chat primitives.',
            href: '/sse',
          },
          {
            title: 'RAG',
            description:
              'Chunking, embedding, adaptive filtering, and vector search. Search is dialect-aware: `toVec` writes a pgvector literal on PostgreSQL and a `Float32Array` blob on SQLite, so the same query code returns `RelevantChunk` rows either way.',
            href: '/rag',
          },
          {
            title: 'Workflow Agents',
            description:
              'A budgeted, multi-stage loop for tasks that cannot finish in one model call. `WorkflowBudgets` caps every stage so a run always terminates even if an adapter never reports success. You supply adapters for local evidence, external discovery, target execution, and evaluation.',
            href: '/workflow-agents',
          },
          {
            title: 'The Run System',
            description:
              'Durable run records with leases, Redis-backed event logs, checkpoints, and crash recovery. A run survives a dropped connection, a rolling deploy, and a process crash, and a client can reattach to it from another replica. Cross-replica streaming requires Redis.',
            href: '/runs',
          },
          {
            title: 'Database & Models',
            description:
              'Type-safe Kysely schema for documents, chunks, conversations, messages, and runs, dialect-portable helpers for PostgreSQL and SQLite, and standalone data-access models.',
            href: '/database',
          },
          {
            title: 'Utilities',
            description:
              'Standalone schema repair, thinking-block stripping, token accounting, JSON-to-Markdown formatting, PDF and spreadsheet helpers, generated file downloads, and vector math.',
            href: '/utilities',
          },
          {
            title: 'Configuration',
            description:
              'Only `db`, `openAiConfig`, and `embeddingConfig` are required; everything else has a default. Tuning for leases, registry retention, event logs, and the recovery sweep lives under `runs` and falls back to defaults derived from the lease itself.',
            href: '/configuration',
          },
          {
            title: 'API Reference',
            description:
              'Complete root export index for @riavzon/ai covering every function, class, constant, Zod schema, and TypeScript type.',
            href: '/api-reference',
          },
        ],
      },
      {
        title: 'More From The Author',
        description:
          'Other packages and applications by the author of this runtime, maintained in the same ecosystem.',
        links: [
          {
            title: 'Identity and Access Management (IAM)',
            description:
              'An enterprise-grade JWT authentication service for Node.js and Express, with OAuth, MFA, magic links, and advanced rate limiting. Designed for a centralized authentication service pattern.',
            href: 'https://docs.riavzon.com/docs/iam',
          },
          {
            title: 'Auth H3 Client',
            description:
              'The client of the IAM service. Enforces OAuth 2.0 authentication and session management against a Nitro or H3 application.',
            href: 'https://docs.riavzon.com/docs/auth-h3client',
          },
          {
            title: 'Bot Detection',
            description:
              'A multi-layered defense system that classifies incoming web requests as human or bot. A pipeline of cheap checks (user-agent matching, IP validation) and heavy checks (GeoLite2 lookups, DNS) assigns each request a penalty score.',
            href: 'https://docs.riavzon.com/docs/bot-detection',
          },
          {
            title: 'Utils',
            description:
              'A standard library of optimized helpers, advanced concurrency locks, atomic file operations, tiered rate limiters, and background task schedulers, shared across the ecosystem.',
            href: 'https://docs.riavzon.com/docs/utils',
          },
          {
            title: 'Shield Base',
            description:
              'A curated threat intelligence and disposable email database powering the security and anti-abuse features of the bot detector and the IAM service.',
            href: 'https://docs.riavzon.com/docs/shield-base',
          },
          {
            title: 'Solana Bots',
            description:
              'A self-custodial CLI and desktop application for managing multiple Solana wallets and executing token swaps through the Jupiter aggregator. Private keys and the API key are encrypted with AES-256-GCM before being written to a local SQLite database, and the master password is never written to disk.',
            href: 'https://solana.riavzon.com',
          },
          {
            title: 'Author Site',
            description:
              'The author of this runtime and the packages above: work, projects, and contact details.',
            href: 'https://riavzon.com',
          },
          {
            title: 'Author Blog',
            description:
              'Announcements, updates, and deep dives into the technical concepts behind these projects.',
            href: 'https://riavzon.com/writing',
          },
        ],
      },
    ],
    notes: [
      'This site documents the @riavzon/ai TypeScript agent runtime. Sibling packages in the same ecosystem are listed under "More From The Author".',
      'For the latest announcements and deep dives into the technical concepts, see the author blog: https://riavzon.com/writing',
    ],
    full: {
      title: 'Riavzon AI Full Documentation',
      description:
        'Comprehensive documentation for the @riavzon/ai agent runtime: agents, tool calling, MCP, RAG, workflow agents, and the durable run system.',
    },
  },
  mdc: {
    highlight: {
      theme: {
        default: 'github-dark',
        dark: 'github-dark',
        light: 'github-light',
      },
      langs: [
        'ts',
        'js',
        'mjs',
        'mts',
        'json',
        'vue',
        'bash',
        'sh',
        'shell',
        'sql',
        'yaml',
        'yml',
        'diff',
        'mdc',
        'html',
        'css',
      ],
    },
  },
    app: {
    head: {
      title: 'Riavzon AI',
      htmlAttrs: {
        lang: 'en',
      },
      link: [
        { rel: 'icon', type: 'image/svg+xml', href: '/favicon.svg' },
        { rel: 'icon', type: 'image/x-icon', href: '/favicon.ico' },
        { rel: 'icon', type: 'image/png', sizes: '96x96', href: '/favicon-96x96.png' },
        { rel: 'apple-touch-icon', type: 'image/png', sizes: '180x180', href: '/apple-touch-icon.png' },
        { rel: 'manifest', href: '/site.webmanifest' },
      ],
      meta: [
        { name: 'theme-color', content: '#0a0a0a', media: '(prefers-color-scheme: dark)' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1.0' },
        { name: 'charset', content: 'utf-8' },
        { name: 'color-scheme', content: 'dark' },
      ]
    }
  },
  nitro: {
    prerender: {
      autoSubfolderIndex: false,
      crawlLinks: true,
      routes: ['/', '/sitemap.xml']
    },
    preset: "cloudflare-pages",
    cloudflare: {
      deployConfig: true,
      nodeCompat:true
    }
  },
  experimental: {
    viewTransition: true,
  },

  typescript: {
    tsConfig: {
      compilerOptions: {
        strictNullChecks: true,
        strict: true
      }
    }
  },
  compatibilityDate: '2025-07-22',
})
