/** Arguments for {@link readPdf}. */
export interface ReadPdfParams {
  /** The PDF bytes. */
  fileBuffer: Buffer;
  /**
   * Pages to read from the first one on.
   *
   * @default 0 - every page
   */
  maxPages?: number;
  /**
   * Prepend a metadata block (title, author, page count).
   *
   * @default true
   */
  includeMetadata?: boolean;
}

/** Arguments for {@link createPdf}. */
export interface CreateOrModifyPdfParams {
  /**
   * Filename to report back with the buffer.
   *
   * Omitted from the result when not given.
   */
  filename?: string;
  /** Base64 PDF to modify; a new document is created when omitted. */
  basePdfBase64?: string;
  /** Document metadata, applied to the document. */
  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    keywords?: string[];
  };

  /** Pages to add or modify, applied in order. */
  pages: {
    /**
     * Add a new page, or draw onto an existing one.
     *
     * `modify` requires `pageIndex`.
     */
    action: "add" | "modify";
    /** 0-based page to modify. Required when `action` is `"modify"`. */
    pageIndex?: number;
    /**
     * Page size in points for `add`.
     *
     * @default [595.28, 841.89] - A4
     */
    dimensions?: [number, number];
    /** What to draw on the page, in order. */
    items: {
      /** Which of the drawing modes to use. */
      type: "text" | "image" | "rectangle" | "svgPath";
      /** Left position in points. */
      x: number;
      /** Bottom position in points, PDF-style: measured from the page edge. */
      y: number;
      /** Text for `type: "text"`. */
      text?: string;
      /**
       * Font size in points for `type: "text"`.
       *
       * @default 12
       */
      size?: number;
      /**
       * Font for `type: "text"`. The `DejaVu` faces cover non-Latin scripts.
       *
       * @default "DejaVu"
       */
      font?:
        | "Helvetica"
        | "TimesRoman"
        | "Courier"
        | "HelveticaBold"
        | "DejaVu"
        | "DejaVuBold";
      /** Base64 image bytes for `type: "image"`. */
      imageBase64?: string;
      /** Image encoding; must match the bytes. */
      imageType?: "png" | "jpg";
      /** Width in points for images and rectangles. */
      width?: number;
      /** Height in points for images and rectangles. */
      height?: number;
      /** SVG path data for `type: "svgPath"`. */
      path?: string;
      /** Scale factor for `type: "svgPath"`. */
      scale?: number;
      /** Fill colour as `[r, g, b]` in 0-1; black when omitted. */
      colorRgb?: [number, number, number];
      /** Border colour as `[r, g, b]` in 0-1. */
      borderColorRgb?: [number, number, number];
      /** Border width in points. */
      borderWidth?: number;
    }[];
  }[];
}
