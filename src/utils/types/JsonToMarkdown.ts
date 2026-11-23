export interface JsonToMarkdownOptions {
  headingLevel?: number;
  maxDepth?: number;
  maxArrayItems?: number;
  maxStringLength?: number;
  maxTotalLength?: number;
  omitEmpty?: boolean;
  /**
   * Keys used to title an array item, checked in order. The first key present
   * with a non-empty string (or a finite number) wins.
   *
   * Generic here on purpose: the library has no business knowing that `symbol`
   * or `shortName` happen to be what a finance provider returns. A caller that
   * wants those passes them.
   */
  titleKeys?: readonly string[];
}

export type Obj = Record<string, unknown>;

export interface Ctx {
  opts: Required<JsonToMarkdownOptions>;
  seen: WeakSet<object>;
}