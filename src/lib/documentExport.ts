import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { Share } from "@capacitor/share";
import { FileOpener } from "@capacitor-community/file-opener";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import type { AppSettings } from "../types";

export type ExportFormat = "txt" | "docx" | "pdf";
export type ExportLocation = "documents" | "data" | "cache";

export interface ExportedFile {
  id: string;
  name: string;
  format: ExportFormat;
  mime: string;
  path: string;
  uri: string;
  directory: Directory;
  locationLabel: string;
  createdAt: string;
}

export const EXPORT_FOLDER = "AIExports";
export const MAX_EXPORT_CHARS = 200_000;

const MIME: Record<ExportFormat, string> = {
  txt: "text/plain",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pdf: "application/pdf",
};

export function resolveExportRoot(settings: AppSettings): {
  directory: Directory;
  folder: string;
  label: string;
  pathHint: string;
} {
  const loc = (settings.exportLocation || "documents") as ExportLocation;
  if (loc === "data") {
    return {
      directory: Directory.Data,
      folder: EXPORT_FOLDER,
      label: "应用数据",
      pathHint: `Data/${EXPORT_FOLDER}/`,
    };
  }
  if (loc === "cache") {
    return {
      directory: Directory.Cache,
      folder: EXPORT_FOLDER,
      label: "缓存（可能被清理）",
      pathHint: `Cache/${EXPORT_FOLDER}/`,
    };
  }
  return {
    directory: Directory.Documents,
    folder: EXPORT_FOLDER,
    label: "文档",
    pathHint: `Documents/${EXPORT_FOLDER}/`,
  };
}

export function sanitizeFilename(raw: string, format: ExportFormat): string {
  let name = String(raw || "document")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .slice(0, 80);
  if (!name) name = "document";
  const ext = `.${format}`;
  if (!name.toLowerCase().endsWith(ext)) name += ext;
  return name;
}

function splitParagraphs(content: string): string[] {
  return content.replace(/\r\n/g, "\n").split(/\n/).map((l) => l.trimEnd());
}

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function buildTxt(content: string, title?: string): Promise<string> {
  const head = title?.trim() ? `${title.trim()}\n\n` : "";
  return head + content;
}

async function buildDocxBase64(
  content: string,
  title?: string,
): Promise<string> {
  const lines = splitParagraphs(content);
  const children: Paragraph[] = [];
  if (title?.trim()) {
    children.push(
      new Paragraph({
        text: title.trim(),
        heading: HeadingLevel.HEADING_1,
      }),
    );
  }
  for (const line of lines) {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: line || " ", size: 24 })],
      }),
    );
  }
  if (!children.length) {
    children.push(new Paragraph({ children: [new TextRun({ text: " " })] }));
  }
  const doc = new Document({
    sections: [{ children }],
  });
  return Packer.toBase64String(doc);
}

function needsCanvasPdf(text: string): boolean {
  return /[^\x00-\x7F]/.test(text);
}

async function buildPdfAsciiBase64(
  content: string,
  title?: string,
): Promise<string> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const fontBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 48;
  const fontSize = 11;
  const lineHeight = 16;
  let page = pdf.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const drawLine = (text: string, bold = false) => {
    if (y < margin + lineHeight) {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
    page.drawText(text.slice(0, 110), {
      x: margin,
      y,
      size: bold ? 16 : fontSize,
      font: bold ? fontBold : font,
      color: rgb(0.1, 0.1, 0.1),
    });
    y -= bold ? 28 : lineHeight;
  };

  if (title?.trim()) drawLine(title.trim(), true);
  for (const line of splitParagraphs(content)) {
    if (!line) {
      y -= lineHeight / 2;
      continue;
    }
    const maxChars = 90;
    for (let i = 0; i < line.length; i += maxChars) {
      drawLine(line.slice(i, i + maxChars));
    }
  }
  return uint8ToBase64(await pdf.save());
}

async function buildPdfCanvasBase64(
  content: string,
  title?: string,
): Promise<string> {
  const pdf = await PDFDocument.create();
  const pageWidth = 595;
  const pageHeight = 842;
  const margin = 40;
  const cssWidth = 720;
  const scale = (pageWidth - margin * 2) / cssWidth;
  const fontSize = 16;
  const lineHeight = 26;
  const lines: string[] = [];
  if (title?.trim()) {
    lines.push(title.trim());
    lines.push("");
  }
  for (const raw of splitParagraphs(content)) {
    if (!raw) {
      lines.push("");
      continue;
    }
    const measure = document.createElement("canvas").getContext("2d");
    if (!measure) {
      lines.push(raw);
      continue;
    }
    measure.font = `${fontSize}px "Segoe UI","Microsoft YaHei UI",sans-serif`;
    let current = "";
    for (const ch of raw) {
      const next = current + ch;
      if (measure.measureText(next).width > cssWidth - 24) {
        if (current) lines.push(current);
        current = ch;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
  }
  if (!lines.length) lines.push(" ");

  const maxLinesPerPage = Math.floor(
    (pageHeight - margin * 2) / (lineHeight * scale) - 1,
  );
  for (let start = 0; start < lines.length; start += maxLinesPerPage) {
    const slice = lines.slice(start, start + maxLinesPerPage);
    const canvas = document.createElement("canvas");
    canvas.width = cssWidth;
    canvas.height = Math.max(slice.length * lineHeight + 24, lineHeight + 24);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法创建画布以生成 PDF");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#1f2937";
    ctx.font = `${fontSize}px "Segoe UI","Microsoft YaHei UI",sans-serif`;
    ctx.textBaseline = "top";
    slice.forEach((line, i) => {
      ctx.fillText(line || " ", 12, 12 + i * lineHeight);
    });
    const dataUrl = canvas.toDataURL("image/png");
    const png = await pdf.embedPng(dataUrl);
    const page = pdf.addPage([pageWidth, pageHeight]);
    const drawHeight = png.height * scale;
    page.drawImage(png, {
      x: margin,
      y: pageHeight - margin - drawHeight,
      width: png.width * scale,
      height: drawHeight,
    });
  }
  return uint8ToBase64(await pdf.save());
}

async function buildPdfBase64(content: string, title?: string): Promise<string> {
  const full = `${title ?? ""}\n${content}`;
  if (needsCanvasPdf(full)) return buildPdfCanvasBase64(content, title);
  return buildPdfAsciiBase64(content, title);
}

export async function generateDocument(
  format: ExportFormat,
  content: string,
  title?: string,
): Promise<{ data: string; encoding?: Encoding; mime: string }> {
  const text = content ?? "";
  if (text.length > MAX_EXPORT_CHARS) {
    throw new Error(
      `内容过长（${text.length} 字），上限 ${MAX_EXPORT_CHARS} 字。`,
    );
  }
  if (format === "txt") {
    return {
      data: await buildTxt(text, title),
      encoding: Encoding.UTF8,
      mime: MIME.txt,
    };
  }
  if (format === "docx") {
    return { data: await buildDocxBase64(text, title), mime: MIME.docx };
  }
  if (format === "pdf") {
    return { data: await buildPdfBase64(text, title), mime: MIME.pdf };
  }
  throw new Error(`不支持的格式：${format}`);
}

export async function saveExportedFile(
  settings: AppSettings,
  options: {
    filename: string;
    format: ExportFormat;
    content: string;
    title?: string;
  },
): Promise<ExportedFile> {
  const format = options.format;
  const name = sanitizeFilename(options.filename, format);
  const root = resolveExportRoot(settings);
  const generated = await generateDocument(
    format,
    options.content,
    options.title,
  );

  try {
    await Filesystem.mkdir({
      path: root.folder,
      directory: root.directory,
      recursive: true,
    });
  } catch {
    /* exists */
  }

  const relativePath = `${root.folder}/${name}`;
  await Filesystem.writeFile({
    path: relativePath,
    directory: root.directory,
    data: generated.data,
    encoding: generated.encoding,
    recursive: true,
  });

  const { uri } = await Filesystem.getUri({
    path: relativePath,
    directory: root.directory,
  });

  return {
    id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    format,
    mime: generated.mime,
    path: relativePath,
    uri,
    directory: root.directory,
    locationLabel: root.label,
    createdAt: new Date().toISOString(),
  };
}

export async function openExportedFile(file: ExportedFile): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    await downloadOnWeb(file);
    return;
  }
  await FileOpener.open({
    filePath: file.uri,
    contentType: file.mime,
    openWithDefault: true,
  });
}

export async function shareExportedFile(file: ExportedFile): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    await downloadOnWeb(file);
    return;
  }
  await Share.share({
    title: file.name,
    text: file.name,
    files: [file.uri],
    dialogTitle: "发送文件",
  });
}

async function downloadOnWeb(file: ExportedFile): Promise<void> {
  const result = await Filesystem.readFile({
    path: file.path,
    directory: file.directory,
    encoding: file.format === "txt" ? Encoding.UTF8 : undefined,
  });
  const data = result.data;
  let blob: Blob;
  if (typeof data === "string") {
    if (file.format === "txt") {
      blob = new Blob([data], { type: file.mime });
    } else {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: file.mime });
    }
  } else {
    blob = new Blob([data as BlobPart], { type: file.mime });
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.click();
  URL.revokeObjectURL(url);
}

export function formatExportToolResult(file: ExportedFile): string {
  return [
    `已保存：${file.name}`,
    `目录：${file.locationLabel}/${EXPORT_FOLDER}`,
    `路径：${file.path}`,
    "请提示用户在聊天界面点击「打开」或「发送」。",
  ].join("\n");
}
