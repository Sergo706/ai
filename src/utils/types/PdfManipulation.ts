export interface ReadPdfParams {
  fileBuffer: Buffer;
  maxPages?: number;
  includeMetadata?: boolean;
}

export interface CreateOrModifyPdfParams {
  filename?: string;
  basePdfBase64?: string;
  metadata?: {
    title?: string;
    author?: string;
    subject?: string;
    creator?: string;
    keywords?: string[];
  };

  pages: {
    action: "add" | "modify";
    pageIndex?: number;
    dimensions?: [number, number];
    items: {
      type: "text" | "image" | "rectangle" | "svgPath";
      x: number;
      y: number;
      text?: string;
      size?: number;
      font?:
        | "Helvetica"
        | "TimesRoman"
        | "Courier"
        | "HelveticaBold"
        | "DejaVu"
        | "DejaVuBold";
      imageBase64?: string;
      imageType?: "png" | "jpg";
      width?: number;
      height?: number;
      path?: string;
      scale?: number;
      colorRgb?: [number, number, number];
      borderColorRgb?: [number, number, number];
      borderWidth?: number;
    }[];
  }[];
}