const ANSI_ESCAPE =
  /\x1b\[[0-9;]*[A-Za-z]|\x1b\([AB]|\x1b[PX^_].*?\x1b\\|\x1b\].*?(?:\x07|\x1b\\)/g;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_ESCAPE, "");
}

export function stripMarkdownCodeFences(code: string): string {
  let out = code.trim();
  out = out.replace(/^```\w*\n?/, "");
  out = out.replace(/\n?```\s*$/, "");
  return out.trim();
}

export function sanitizeCode(code: string): string {
  return stripMarkdownCodeFences(stripAnsiCodes(code));
}
