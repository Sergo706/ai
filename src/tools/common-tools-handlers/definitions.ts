import type { ChatCompletionTool } from "openai/resources";
import z from "zod";
import {
  documentParams,
  pdfCreatorParams,
  spreadsheetCreatorParams,
  currencyParams,
} from "./schemas";
import { extractorParams } from "./extractor/schema";
import { datetimeParams } from "./getCurrentDatetime";
import { searchParams } from "../../models/searchDbDocs";

/**
 * 
 * Tool definitions for the generic tool loop.
 *
 * Only tools that need nothing but their arguments live here. Anything bound to
 * an application — its research runs, its product/video tables, its market data
 * provider — is defined by that application and passed in as `extra`, because
 * the package cannot describe a domain it does not know.
 */

/** Every tool this module can build. */
export type CommonToolName =
  | "get_document"
  | "extractor"
  | "search_db"
  | "get_current_datetime"
  | "calculator"
  | "currencies_convertor"
  | "create_styled_spreadsheet"
  | "pdf_creator";

export interface BuildToolDefinitionsArgs {
  /** Which of the common tools to include. Defaults to all of them. */
  enabled?: readonly CommonToolName[];
  /** Additional definitions — the host's own tools, MCP tools, anything else. */
  extra?: readonly ChatCompletionTool[];
}

const COMMON_TOOLS: readonly ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "get_document",
      description:
        "READ the full text of one stored document. This is the only tool that pages through long text.\n" +
        "Every response reports chunkCount and nextChunkStart:\n" +
        "- Omit chunkStart and chunkEnd to get the first ~3000 tokens as one block plus truncated. Fine for a short document; for a long one it is only a sample.\n" +
        "- To read further, send BOTH chunkStart and chunkEnd, zero-based and INCLUSIVE, spanning at most 10 chunks (chunkEnd - chunkStart <= 9). Advance with the nextChunkStart of the previous response, which is null once the document is exhausted. Each chunk is at most ~1000 tokens.\n" +
        "Costs one cached read per window, so walk a long document in chunks instead of assuming one call returns all of it.",
      parameters: z.toJSONSchema(documentParams, { io: "input" }),
    },
  },
  {
    type: "function",
    function: {
      name: "extractor",
      description:
        "Extract clean markdown content from one or more URLs. Use this to read the contents of web pages.",
      parameters: z.toJSONSchema(extractorParams, { io: "input" }),
    },
  },
  {
    type: "function",
    function: {
      name: "search_db",
      description:
        "Search the stored documents by meaning, using vector similarity over their chunks. Returns the best-matching chunks with their document id, chunk index and source title. Use it to find which document answers a question, then get_document to read it in full.",
      parameters: z.toJSONSchema(searchParams, { io: "input" }),
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_datetime",
      description:
        "Get the actual server clock as ISO UTC and formatted in an optional validated IANA timezone (default UTC).",
      parameters: z.toJSONSchema(datetimeParams, { io: "input" }),
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description:
        "Evaluate mathematical expressions. Use this for accurate calculations instead of guessing.",
      parameters: z.toJSONSchema(
        z.object({
          expression: z
            .string()
            .describe(
              "The mathematical expression to evaluate (e.g., '100 * 1.25', '500 / 12').",
            ),
        }),
        { io: "input" },
      ),
    },
  },
  {
    type: "function",
    function: {
      name: "currencies_convertor",
      description:
        "Convert an amount from one currency to another using real-time exchange rates.",
      parameters: z.toJSONSchema(currencyParams, { io: "input" }),
    },
  },
  {
    type: "function",
    function: {
      name: "create_styled_spreadsheet",
      description:
        "Create a styled Excel spreadsheet (XLSX) or CSV from JSON data. Supports custom columns, header styles, and data row styles (styles apply to XLSX only).",
      parameters: z.toJSONSchema(spreadsheetCreatorParams, { io: "input" }),
    },
  },
  {
    type: "function",
    function: {
      name: "pdf_creator",
      description:
        "Create a new PDF document or modify an existing one with extensive styling and customization. Supports adding pages, drawing text, rectangles, and SVG paths.",
      parameters: z.toJSONSchema(pdfCreatorParams, { io: "input" }),
    },
  },
];

/**
 * The tool definitions to hand the loop.
 *
 * `enabled` selects from `COMMON_TOOLS` by name rather than by rebuild, so a
 * host that disables one pays nothing for it and cannot end up with a handler
 * whose definition it forgot to include. `extra` is appended after the common
 * ones, which keeps a host's own tool names late in the list without reordering
 * anything it did not supply.
 *
 * Filtering preserves declaration order: a caller passing
 * `["pdf_creator", "calculator"]` gets them in the order this module declares,
 * not the order it asked for, so two callers that enable the same set send the
 * model the same list.
 */
export function buildToolDefinitions(
  args: BuildToolDefinitionsArgs = {},
): ChatCompletionTool[] {
  const selected =
    args.enabled === undefined
      ? COMMON_TOOLS
      : COMMON_TOOLS.filter(
          (tool) =>
            tool.type === "function" &&
            args.enabled?.includes(tool.function.name as CommonToolName),
        );

  return [...selected, ...(args.extra ?? [])];
}
