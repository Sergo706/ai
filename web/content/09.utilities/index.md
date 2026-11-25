---
title: Utilities
description: Standalone schema repair, reasoning stripping, token accounting, JSON-to-Markdown formatting, PDF/spreadsheet helpers, generated file downloads, and vector math utilities.
navigation:
  icon: i-lucide-wrench
seo:
  title: Utilities — Riavzon AI
  description: Standalone utility functions exported from @riavzon/ai for structured output parsing, token counting, PDF & Excel generation, URL validation, and cosine similarity.
---

Even if you never use `createAgent()` or `AgenticWorkflowLoop`, `@riavzon/ai` exports its core utility toolkit at the package root so you can reuse battle-tested AI building blocks inside any OpenAI-compatible client or Node.js backend.

## Utility categories at a glance

| Module | Exports | Use case |
| --- | --- | --- |
| **Schema parsing & repair** | `llmSchemaParser`, `removeThinking`, `removeCodeFence` | Validate untrusted LLM JSON against Zod schemas with automatic error-guided repair loops; strip `<think>` blocks and Markdown fences. |
| **Tokens & text** | `countTokens`, `chunkByTokens`, `estimateMessageTokens`, `estimateMessagesTokens`, `estimateTextTokens`, `jsonToMarkdown`, `fingerprintQuery` | Budget context windows, chunk documents with overlap, render arbitrary JSON payloads as clean LLM-readable Markdown, and normalize search intents. |
| **URL safety** | `safeUrlProtocol`, `isHttpUrl` | Validate user- or model-supplied URLs safely without throwing. |
| **PDF & spreadsheets** | `readPdf`, `createPdf`, `readXlsxToMarkdown`, `readCsvToMarkdown`, `generateStyledSpreadsheet` | Extract Markdown from PDF/XLSX/CSV uploads and create styled downloadable PDFs and Excel/CSV reports. |
| **Generated file downloads** | `fileKey`, `readGeneratedFile` | Serve binary files created by `pdf_creator` or `create_styled_spreadsheet` over HTTP with ready-to-use `Content-Disposition` headers. |
| **Streaming & vectors** | `framesToStream`, `calculateCosineSimilarity` | Convert `AsyncIterable<SseFrame>` to SSE streams and compute cosine similarity between dense vectors. |

## Explore utilities

::card-group
  :::card
  ---
  icon: i-lucide-braces
  title: Schema Parsing & Text Helpers
  to: /utilities/schema-and-text
  ---
  Use `llmSchemaParser()`, `removeThinking()`, `removeCodeFence()`, token estimators, `jsonToMarkdown()`, `fingerprintQuery()`, and URL guards.
  :::

  :::card
  ---
  icon: i-lucide-file-spreadsheet
  title: Files, Spreadsheets & Vectors
  to: /utilities/files-and-vectors
  ---
  Read/create PDFs and Excel/CSV files, serve generated files via `readGeneratedFile()`, and compute similarity with `calculateCosineSimilarity()`.
  :::
::
