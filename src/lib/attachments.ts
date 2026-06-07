import type { AppSettings, ChatMessage } from "../types";
import { providerSupportsVision } from "./apiProviders";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".bmp",
  ".svg",
  ".ico",
]);

const MAX_ATTACHMENTS = 10;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_EMBED_BYTES = 512 * 1024;
const MAX_BINARY_EMBED_BYTES = 2 * 1024 * 1024;

export class AttachmentError extends Error {}

function guessMime(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".md")) return "text/markdown";
  if (lower.endsWith(".txt")) return "text/plain";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".py")) return "text/x-python";
  return "application/octet-stream";
}

function ext(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function isImage(name: string, mime: string): boolean {
  return IMAGE_EXTENSIONS.has(ext(name)) || mime.startsWith("image/");
}

function truncateText(text: string, max = MAX_TEXT_EMBED_BYTES): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= max) return text;
  return `${text.slice(0, Math.floor(max / 2))}...(内容已截断)`;
}

function isMostlyText(text: string): boolean {
  if (!text) return false;
  const sample = text.slice(0, 4096);
  let printable = 0;
  for (const ch of sample) {
    const code = ch.charCodeAt(0);
    if (code === 9 || code === 10 || code === 13 || code >= 32) printable++;
  }
  return printable / sample.length >= 0.85;
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new AttachmentError(`无法读取：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.onerror = () => reject(new AttachmentError(`无法读取：${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function loadAttachmentFromFile(
  file: File,
): Promise<import("../types").AttachmentPreview> {
  if (file.size > MAX_FILE_BYTES) {
    throw new AttachmentError(`文件过大：${file.name}（最大 10MB）`);
  }
  const mime = file.type || guessMime(file.name);
  if (isImage(file.name, mime)) {
    return {
      name: file.name,
      kind: "image",
      mime,
      dataUrl: await readAsDataUrl(file),
    };
  }
  if (file.size <= MAX_TEXT_EMBED_BYTES) {
    const text = await file.text();
    if (isMostlyText(text)) {
      return {
        name: file.name,
        kind: "text",
        mime,
        textContent: truncateText(text),
      };
    }
  }
  if (file.size > MAX_BINARY_EMBED_BYTES) {
    throw new AttachmentError(
      `文件过大，无法随消息发送（${file.name}，二进制附件上限 2MB）`,
    );
  }
  return {
    name: file.name,
    kind: "binary",
    mime,
    textContent: await readAsBase64(file),
  };
}

export async function loadPastedImage(blob: Blob, name = "pasted-image.png") {
  const file = new File([blob], name, { type: blob.type || "image/png" });
  return loadAttachmentFromFile(file);
}

export function describeAttachment(
  att: import("../types").AttachmentPreview,
): string {
  if (att.kind === "image") return `[图片] ${att.name}`;
  if (att.kind === "text") {
    const lines = att.textContent?.split("\n").length ?? 0;
    return `[文本] ${att.name}（${lines} 行）`;
  }
  return `[文件] ${att.name}`;
}

export function attachmentDisplayMarkdown(
  att: import("../types").AttachmentPreview,
  supportsVision: boolean,
): string {
  if (att.kind === "image" && att.dataUrl) {
    let block = `![${att.name}](${att.dataUrl})`;
    if (!supportsVision) {
      block +=
        "\n\n> 当前 API 不支持识图，模型看不到此图；如需识图请用 Poe + GPT-4o 等 vision 模型。";
    }
    return block;
  }
  if (att.kind === "text" && att.textContent) {
    const lang = ext(att.name).replace(".", "") || "text";
    return `**附件 \`${att.name}\`：**\n\n\`\`\`${lang}\n${att.textContent}\n\`\`\``;
  }
  if (att.kind === "binary" && att.textContent) {
    return (
      `**附件 \`${att.name}\` (${att.mime})：**\n\n` +
      "以下为 Base64 编码内容。请根据文件名与类型尝试理解；若无法解析请直接说明。\n\n" +
      `\`\`\`\n${att.textContent.slice(0, 8000)}${att.textContent.length > 8000 ? "\n...(内容已截断)" : ""}\n\`\`\``
    );
  }
  return `**附件：** \`${att.name}\`（二进制，未嵌入）`;
}

export function buildUserMessage(
  text: string,
  attachments: import("../types").AttachmentPreview[],
  settings: AppSettings,
): {
  content: string;
  apiContent: string | Array<Record<string, unknown>>;
} {
  const supportsVision = providerSupportsVision(settings);
  const textParts: string[] = [];
  if (text.trim()) textParts.push(text.trim());

  for (const att of attachments) {
    if (att.kind === "text" && att.textContent) {
      textParts.push(
        `\n\n---\n**附件 \`${att.name}\`** (${att.mime})\n\n\`\`\`\n${att.textContent}\n\`\`\``,
      );
    } else if (att.kind === "binary" && att.textContent) {
      textParts.push(
        `\n\n---\n**附件 \`${att.name}\`** (${att.mime})\n\n` +
          "以下为 Base64 编码内容。请根据文件名与类型尝试理解。\n\n" +
          `\`\`\`\n${att.textContent}\n\`\`\``,
      );
    } else if (att.kind === "image" && !supportsVision) {
      textParts.push(
        `\n\n---\n**附件 \`${att.name}\`** (${att.mime})\n\n` +
          "当前 API 不支持图像输入，模型无法看到图片内容。如需识图，请切换到 Poe API 并使用 GPT-4o 等 vision 模型。",
      );
    } else {
      textParts.push(attachmentDisplayMarkdown(att, supportsVision));
    }
  }

  const body = textParts.join("\n").trim() || "请查看附件。";
  const content = body;
  const images = attachments.filter((a) => a.kind === "image" && a.dataUrl);

  if (!images.length || !supportsVision) {
    return { content, apiContent: body };
  }

  const blocks: Array<Record<string, unknown>> = [{ type: "text", text: body }];
  for (const img of images) {
    blocks.push({
      type: "image_url",
      image_url: { url: img.dataUrl },
    });
  }
  return { content, apiContent: blocks };
}

export function normalizeMessagesForApi(
  messages: ChatMessage[],
  supportsVision: boolean,
): ChatMessage[] {
  if (supportsVision) return messages;
  return messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg;
    const textParts: string[] = [];
    for (const part of msg.content) {
      if (part.type === "text") {
        textParts.push(String(part.text ?? ""));
      } else if (part.type === "image_url") {
        textParts.push(
          "\n\n---\n**图片附件**（当前 API 不支持 vision，图像未发送；可改用 Poe + GPT-4o 等 vision 模型。）",
        );
      }
    }
    const merged =
      textParts.filter(Boolean).join("\n").trim() || "（附件）";
    return { ...msg, content: merged };
  });
}

export const MAX_ATTACHMENT_COUNT = MAX_ATTACHMENTS;

export async function loadAttachmentsFromFiles(
  files: FileList | File[],
): Promise<import("../types").AttachmentPreview[]> {
  const list = Array.from(files);
  if (list.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`最多附加 ${MAX_ATTACHMENTS} 个文件`);
  }
  return Promise.all(list.map(loadAttachmentFromFile));
}
