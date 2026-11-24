/* eslint-disable @typescript-eslint/no-unnecessary-condition */
import type { ChatCompletionTool } from "openai/resources";
import type { ToolHandler } from "../../types/ToolExecutionTypes";
import type { ToolFactoryContext, ToolSpec } from "../toolRegistry";
import { buildToolDefinitions, type CommonToolName } from "./definitions";
import { calculator } from "./calculator";
import { createStyledSpreadsheet } from "./createStyledSpreadsheet";
import { currenciesConvertor } from "./currencyConverter";
import { extractor } from "./extractor/extractor";
import { getCurrentDatetime } from "./getCurrentDatetime";
import { getDocument } from "./getDocument";
import { pdfCreator } from "./pdfCreator";
import { searchDb } from "./searchDb";

/**
 * One built-in tool, optionally tuned.
 *
 * A bare name in {@link CommonTools} means "use the defaults"; this shape is for
 * when a host wants to change something about a built-in.
 */
export interface CommonToolEntry<TMeta = unknown> extends Partial<
  Pick<ToolSpec<TMeta>, "cache" | "maxCalls" | "concurrency" | "stream">
> {
  /** Which built-in tool this entry configures. */
  name: CommonToolName;
  /** Replace the built-in handler, e.g. to add host-specific behaviour. */
  make?: (ctx: ToolFactoryContext<TMeta>) => ToolHandler;
}

/**
 * The built-in tools a host wants exposed.
 *
 * @example
 * ```ts
 * const common: CommonTools = ["calculator", { name: "get_document", maxCalls: 2 }];
 * ```
 */
export type CommonTools<TMeta = unknown> = readonly (
  | CommonToolName
  | CommonToolEntry<TMeta>
)[];

type Defaults = Omit<ToolSpec<unknown>, "name" | "definitions">;

const DEFAULT_SPECS: Record<CommonToolName, Defaults> = {
  get_document: {
    make: (ctx) => getDocument(ctx.userId),
    cache: { ttl: 3600, scoped: true },
    stream: { emitResult: "none" },
  },
  extractor: {
    make: () => extractor(false),
    concurrency: 3,
    stream: { emitResult: "none" },
  },
  search_db: {
    make: () => searchDb(),
    cache: { ttl: 3600 },
    stream: { emitResult: "none" },
  },
  get_current_datetime: { make: () => getCurrentDatetime() },
  calculator: { make: () => calculator() },
  currencies_convertor: {
    make: () => currenciesConvertor(),
    cache: { ttl: 6 * 60 * 60 },
  },
  create_styled_spreadsheet: {
    make: () => createStyledSpreadsheet(),
    concurrency: 2,
  },
  pdf_creator: { make: () => pdfCreator(), concurrency: 2 },
};

function definitionFor(name: CommonToolName): ChatCompletionTool {
  const definition = buildToolDefinitions({ enabled: [name] })[0];
  if (!definition) {
    throw new Error(`No tool definition is declared for "${name}".`);
  }
  return definition;
}

function assemble<TMeta>(
  name: CommonToolName,
  base: Defaults,
  override: CommonToolEntry<TMeta>,
): ToolSpec<TMeta> {
  const spec: ToolSpec<TMeta> = {
    name,
    make: override.make ?? base.make,
    definitions: definitionFor(name),
  };

  const cache =
    base.cache && override.cache
      ? { ...base.cache, ...override.cache }
      : (override.cache ?? base.cache);
  if (cache) spec.cache = cache;

  const stream =
    base.stream && override.stream
      ? { ...base.stream, ...override.stream }
      : (override.stream ?? base.stream);
  if (stream) spec.stream = stream;

  const maxCalls = override.maxCalls ?? base.maxCalls;
  if (maxCalls !== undefined) spec.maxCalls = maxCalls;

  const concurrency = override.concurrency ?? base.concurrency;
  if (concurrency !== undefined) spec.concurrency = concurrency;

  return spec;
}

/**
 * Turn the built-in tool selection into executable tool specs.
 *
 * Entries are resolved in the built-in order, so the resulting spec list is
 * stable regardless of how the host ordered its selection. An entry can override
 * any of the cache, call cap, concurrency and stream policy of its built-in.
 *
 * @param tools - The built-in names to enable, optionally tuned.
 * @returns One spec per enabled tool; empty when nothing was requested.
 * @example
 * ```ts
 * const specs = resolveCommonTools(["calculator", "search_db"]);
 * ```
 */
export function resolveCommonTools<TMeta = unknown>(
  tools: CommonTools<TMeta> = [],
): ToolSpec<TMeta>[] {
  if (tools.length === 0) return [];

  const requested = new Map<CommonToolName, CommonToolEntry<TMeta>>();
  for (const tool of tools) {
    const entry = typeof tool === "string" ? { name: tool } : tool;
    requested.set(entry.name, entry);
  }

  const specs: ToolSpec<TMeta>[] = [];
  for (const name of Object.keys(DEFAULT_SPECS) as CommonToolName[]) {
    const override = requested.get(name);
    if (!override) continue;
    specs.push(assemble(name, DEFAULT_SPECS[name], override));
  }
  return specs;
}
