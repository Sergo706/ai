/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/restrict-template-expressions */
import { PDFParse } from "pdf-parse";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { CreateOrModifyPdfParams, ReadPdfParams } from "./types/PdfManipulation";
import { getRoot, resolvePath } from "@riavzon/utils/server";
import { loadPeer } from "./loadPeerDepend";


type PdfLibPeer = typeof import("pdf-lib");
type FontkitPeer = typeof import("@pdf-lib/fontkit");
type PDFDocument = import("pdf-lib").PDFDocument;

let pdfLibModule: PdfLibPeer | undefined;
let fontkitModule: FontkitPeer | undefined;

async function pdfLib(): Promise<PdfLibPeer> {
  pdfLibModule ??= await loadPeer<PdfLibPeer>("pdf-lib", "PDF creation");
  return pdfLibModule;
}

async function fontkit(): Promise<FontkitPeer> {
  fontkitModule ??= await loadPeer<FontkitPeer>(
    "@pdf-lib/fontkit",
    "PDF creation",
  );
  return fontkitModule;
}


const PACKAGE_ROOT = getRoot(dirname(fileURLToPath(import.meta.url)));

function toExactBytes(bytes: Buffer): Uint8Array {
  const exact = new Uint8Array(bytes.length);
  exact.set(bytes);
  return exact;
}

export async function readPdf(params: ReadPdfParams): Promise<string> {
  const { fileBuffer, maxPages = 0, includeMetadata = true } = params;
  const parser = new PDFParse({ data: fileBuffer });

  try {
    let output = "";
    const infoResult = await parser.getInfo({ parsePageInfo: true });

    if (includeMetadata) {
      const dates = infoResult.getDateNode();
      output += `## PDF Metadata\n`;
      output += `- Title: ${infoResult.info?.Title ?? "N/A"}\n`;
      output += `- Author: ${infoResult.info?.Author ?? "N/A"}\n`;
      output += `- Creator: ${infoResult.info?.Creator ?? "N/A"}\n`;
      output += `- Producer: ${infoResult.info?.Producer ?? "N/A"}\n`;
      output += `- Creation Date: ${dates.CreationDate ?? "N/A"}\n`;
      output += `- Modification Date: ${dates.ModDate ?? "N/A"}\n`;
      output += `- Total Pages: ${infoResult.total}\n\n`;
    }

    output += `## PDF Content`;

    const totalPagesToRead =
      maxPages > 0 ? Math.min(maxPages, infoResult.total) : infoResult.total;

    for (let i = 1; i <= totalPagesToRead; i++) {
      const pageResult = await parser.getText({ partial: [i] });
      output += `\n\n--- Page ${i} ---\n${pageResult.text.trim()}`;
    }

    return output;
  } catch (error) {
    throw new Error(`Failed to read PDF: ${(error as Error).message}`);
  } finally {
    await parser.destroy();
  }
}


export async function createPdf(params: CreateOrModifyPdfParams): Promise<{
  buffer: Buffer;
  filename?: string;
  mimeType: string;
  base64Data: string;
}> {
  const { PDFDocument: PdfDocument, StandardFonts, rgb } = await pdfLib();
  const fontkitModule = await fontkit();

  let pdfDoc: PDFDocument;

  if (params.basePdfBase64) {
    pdfDoc = await PdfDocument.load(
      Buffer.from(params.basePdfBase64, "base64"),
    );
  } else {
    pdfDoc = await PdfDocument.create();
  }

  pdfDoc.registerFontkit(fontkitModule);


  const fontPath = (name: string) =>
    resolvePath(name, ["assets", "dist/assets"], [], PACKAGE_ROOT);
  const regular = await pdfDoc.embedFont(
    await readFile(fontPath("DejaVuSans.ttf")),
    { subset: true },
  );

  const bold = await pdfDoc.embedFont(
    await readFile(fontPath("DejaVuSans-Bold.ttf")),
    { subset: true },
  );

  const fonts = {
    Helvetica: await pdfDoc.embedFont(StandardFonts.Helvetica),
    HelveticaBold: await pdfDoc.embedFont(StandardFonts.HelveticaBold),
    TimesRoman: await pdfDoc.embedFont(StandardFonts.TimesRoman),
    Courier: await pdfDoc.embedFont(StandardFonts.Courier),
    DejaVu: regular,
    DejaVuBold: bold,
  };

  if (params.metadata) {
    if (params.metadata.title) pdfDoc.setTitle(params.metadata.title);
    if (params.metadata.author) pdfDoc.setAuthor(params.metadata.author);
    if (params.metadata.subject) pdfDoc.setSubject(params.metadata.subject);
    if (params.metadata.creator) pdfDoc.setCreator(params.metadata.creator);
    if (params.metadata.keywords) pdfDoc.setKeywords(params.metadata.keywords);
  }

  for (const pageDef of params.pages) {
    let page;

    if (pageDef.action === "add") {
      const dims = pageDef.dimensions ?? [595.28, 841.89];
      page = pdfDoc.addPage(dims);
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (pageDef.action === "modify" && pageDef.pageIndex !== undefined) {
      const pages = pdfDoc.getPages();
      page = pages[pageDef.pageIndex];
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!page)
        throw new Error(`Page index ${pageDef.pageIndex} out of bounds.`);
    } else {
      throw new Error(
        "Invalid page instruction: must specify action 'add' or 'modify' (with pageIndex).",
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (!pageDef.items) continue;

    for (const item of pageDef.items) {
      const color = item.colorRgb
        ? rgb(item.colorRgb[0], item.colorRgb[1], item.colorRgb[2])
        : undefined;
      const borderColor = item.borderColorRgb
        ? rgb(
            item.borderColorRgb[0],
            item.borderColorRgb[1],
            item.borderColorRgb[2],
          )
        : undefined;

      if (item.type === "text" && item.text) {
        page.drawText(item.text, {
          x: item.x,
          y: item.y,
          size: item.size ?? 12,
          font: fonts[item.font ?? "DejaVu"],
          color: color ?? rgb(0, 0, 0),
        });
      } else if (
        item.type === "image" &&
        item.imageBase64 &&
        item.imageType &&
        item.width &&
        item.height
      ) {
        const imgBuffer = Buffer.from(item.imageBase64, "base64");
        const embeddedImg =
          item.imageType === "png"
            ? await pdfDoc.embedPng(imgBuffer)
            : await pdfDoc.embedJpg(toExactBytes(imgBuffer));
        page.drawImage(embeddedImg, {
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
        });
      } else if (item.type === "rectangle" && item.width && item.height) {
        page.drawRectangle({
          x: item.x,
          y: item.y,
          width: item.width,
          height: item.height,
          color,
          borderColor,
          borderWidth: item.borderWidth,
        });
      } else if (item.type === "svgPath" && item.path) {
        page.moveTo(item.x, item.y);
        page.drawSvgPath(item.path, {
          scale: item.scale,
          color,
          borderColor,
          borderWidth: item.borderWidth,
        });
      }
    }
  }

  const pdfBytes = await pdfDoc.save();
  const buffer = Buffer.from(pdfBytes);
  return {
    buffer,
    filename: params.filename,
    mimeType: "application/pdf",
    base64Data: buffer.toString("base64"),
  };
}
