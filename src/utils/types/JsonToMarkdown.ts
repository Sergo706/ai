/** Tuning for {@link jsonToMarkdown}. */
export interface JsonToMarkdownOptions {
  /**
   * Heading level for the top of the document.
   *
   * @default 2
   */
  headingLevel?: number;
  /**
   * Depth at which nested values are flattened to one line.
   *
   * @default Infinity
   */
  maxDepth?: number;
  /**
   * Items rendered per array; the rest are summarised.
   *
   * @default Infinity
   */
  maxArrayItems?: number;
  /**
   * Strings longer than this are truncated.
   *
   * @default Infinity
   */
  maxStringLength?: number;
  /**
   * Hard cap on the returned markdown.
   *
   * @default Infinity
   */
  maxTotalLength?: number;
  /**
   * Render empty values instead of skipping them.
   *
   * @default false
   */
  omitEmpty?: boolean;
  /**
   * Keys used to title an array item, checked in order. The first key present
   * with a non-empty string (or a finite number) wins.
   *
   * Override it when your payloads have their own naming, e.g. `symbol` or
   * `shortName`.
   *
   * @default ['title', 'name', 'label', 'id', 'headline', 'query', 'type']
   */
  titleKeys?: readonly string[];
}

/** A plain object to render. */
export type Obj = Record<string, unknown>;

/** Internal rendering state. */
export interface Ctx {
  opts: Required<JsonToMarkdownOptions>;
  seen: WeakSet<object>;
}
