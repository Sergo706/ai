/* eslint-disable @typescript-eslint/restrict-template-expressions */

import { Ctx, JsonToMarkdownOptions, Obj } from "./types/JsonToMarkdown";

const DEFAULT_TITLE_KEYS: readonly string[] = [
  "title",
  "name",
  "label",
  "id",
  "headline",
  "query",
  "type",
];

/** What an empty value renders as when `omitEmpty` is off. */
const EMPTY_MARKER = "_(none)_";

function isPlainObject(v: unknown): v is Obj {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    !(v instanceof Date)
  );
}

function isScalar(v: unknown): boolean {
  return (
    v === null ||
    v === undefined ||
    v instanceof Date ||
    typeof v === "string" ||
    typeof v === "number" ||
    typeof v === "boolean" ||
    typeof v === "bigint"
  );
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim().length === 0;
  if (Array.isArray(v)) return v.length === 0;
  if (isPlainObject(v)) return Object.keys(v).length === 0;
  return false;
}

function formatScalar(v: unknown, maxLen: number): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date)
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : null;
  if (typeof v === "string") {
    const clean = v.replace(/\s+/g, " ").trim();
    if (!clean) return null;
    return clean.length <= maxLen ? clean : `${clean.slice(0, maxLen - 1)}…`;
  }
  return null;
}

function heading(level: number, text: string): string {
  return `${"#".repeat(Math.min(Math.max(level, 1), 6))} ${text}`;
}

function itemTitle(
  item: Obj,
  index: number,
  titleKeys: readonly string[],
): string {
  for (const k of titleKeys) {
    const v = item[k];
    if (typeof v === "string" && v.trim()) {
      const clean = v.replace(/\s+/g, " ").trim();
      return `${index + 1}. ${clean.length > 90 ? `${clean.slice(0, 89)}…` : clean}`;
    }
    if (typeof v === "number" && Number.isFinite(v))
      return `${index + 1}. ${v}`;
  }
  return `${index + 1}.`;
}

/**
 * One-line JSON rendering that survives a cycle.
 *
 * `JSON.stringify` throws on a circular structure, which is the whole reason
 * the depth cutoff used to be able to discard everything already rendered: the
 * throw unwound to the outer `catch`, whose only recourse is `JSON.stringify`
 * again. Anything unrepresentable falls back to a placeholder instead.
 */
function safeFlatten(value: unknown, maxLen: number): string | null {
  try {
    return formatScalar(JSON.stringify(value), maxLen);
  } catch {
    return "_(unrenderable value)_";
  }
}

function renderObject(
  o: Obj,
  level: number,
  depth: number,
  ctx: Ctx,
  out: string[],
): void {
  // Cycle check first. A cutoff check that flattens before this point can throw
  // on exactly the circular case this guard exists to catch.
  if (ctx.seen.has(o)) {
    out.push("- _(circular reference)_");
    return;
  }

  if (depth > ctx.opts.maxDepth) {
    const flat = safeFlatten(o, ctx.opts.maxStringLength);
    if (flat) out.push(`- ${flat}`);
    return;
  }

  ctx.seen.add(o);

  for (const [key, value] of Object.entries(o)) {
    if (ctx.opts.omitEmpty && isEmpty(value)) continue;

    if (isScalar(value)) {
      const s = formatScalar(value, ctx.opts.maxStringLength);
      out.push(`- **${key}**: ${s ?? EMPTY_MARKER}`);
      continue;
    }

    if (Array.isArray(value)) {
      renderArray(key, value, level, depth, ctx, out);
      continue;
    }

    out.push("", heading(level, key), "");
    renderObject(value as Obj, level + 1, depth + 1, ctx, out);
  }

  ctx.seen.delete(o);
}

function renderArray(
  key: string,
  arr: unknown[],
  level: number,
  depth: number,
  ctx: Ctx,
  out: string[],
): void {
  const cap = Number.isFinite(ctx.opts.maxArrayItems)
    ? Math.min(arr.length, ctx.opts.maxArrayItems)
    : arr.length;
  const capped = arr.slice(0, cap);

  if (capped.every(isScalar)) {
    const parts = capped
      .map((v) => formatScalar(v, ctx.opts.maxStringLength))
      .filter((v): v is string => v !== null);
    // An all-empty scalar array has nothing to list, but the key exists. Say so
    // rather than emitting a heading with no content under it.
    out.push(
      parts.length
        ? `- **${key}**: ${parts.join(", ")}`
        : `- **${key}**: ${EMPTY_MARKER}`,
    );
    if (arr.length > capped.length) {
      out.push(
        `- **${key}**: _… ${arr.length - capped.length} more item(s) omitted_`,
      );
    }
    return;
  }

  out.push("", heading(level, key), "");

  capped.forEach((item, i) => {
    if (isScalar(item)) {
      const s = formatScalar(item, ctx.opts.maxStringLength);
      if (s !== null) out.push(`- ${s}`);
      return;
    }
    if (Array.isArray(item)) {
      const nested = item
        .map((v) => formatScalar(v, ctx.opts.maxStringLength))
        .filter((v): v is string => v !== null);
      if (nested.length) out.push(`- ${nested.join(", ")}`);
      return;
    }
    const obj = item as Obj;
    out.push(heading(level + 1, itemTitle(obj, i, ctx.opts.titleKeys)), "");
    renderObject(obj, level + 2, depth + 1, ctx, out);
  });

  if (arr.length > capped.length) {
    out.push("", `_… ${arr.length - capped.length} more item(s) omitted_`);
  }
}

export function jsonToMarkdown(
  value: unknown,
  options: JsonToMarkdownOptions = {},
): string {
  const opts: Required<JsonToMarkdownOptions> = {
    headingLevel: 2,
    maxDepth: Infinity,
    maxArrayItems: Infinity,
    maxStringLength: Infinity,
    maxTotalLength: Infinity,
    omitEmpty: false,
    titleKeys: DEFAULT_TITLE_KEYS,
    ...options,
  };
  const ctx: Ctx = { opts, seen: new WeakSet() };
  const out: string[] = [];

  try {
    if (isScalar(value)) {
      out.push(formatScalar(value, opts.maxStringLength) ?? EMPTY_MARKER);
    } else if (Array.isArray(value)) {
      renderArray("items", value, opts.headingLevel, 0, ctx, out);
    } else if (isPlainObject(value)) {
      renderObject(value, opts.headingLevel, 0, ctx, out);
    } else {
      out.push(
        formatScalar(String(value), opts.maxStringLength) ?? EMPTY_MARKER,
      );
    }
  } catch {
    out.push(safeFlatten(value, opts.maxStringLength) ?? EMPTY_MARKER);
  }

  let md = out
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (Number.isFinite(opts.maxTotalLength) && md.length > opts.maxTotalLength) {
    const cut = md.length - opts.maxTotalLength;
    md = `${md.slice(0, opts.maxTotalLength).trimEnd()}\n\n_… truncated, ${cut} character(s) dropped_`;
  }

  return md || EMPTY_MARKER;
}
