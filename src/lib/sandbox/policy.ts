import { SandboxError } from "./types";

export const MAX_CODE_CHARS = 24_000;

export const ALLOWED_IMPORTS = new Set([
  "math",
  "cmath",
  "statistics",
  "decimal",
  "fractions",
  "random",
  "json",
  "re",
  "string",
  "textwrap",
  "unicodedata",
  "datetime",
  "calendar",
  "time",
  "collections",
  "itertools",
  "functools",
  "copy",
  "operator",
  "enum",
  "hashlib",
  "hmac",
  "base64",
  "binascii",
  "typing",
  "dataclasses",
  "array",
  "bisect",
  "heapq",
  "queue",
  "uuid",
  "secrets",
  "pprint",
  "numbers",
  "abc",
  "contextlib",
  "warnings",
]);

export const FORBIDDEN_CALLS = new Set([
  "eval",
  "exec",
  "compile",
  "__import__",
  "open",
  "input",
  "breakpoint",
  "getattr",
  "setattr",
  "delattr",
  "globals",
  "locals",
  "vars",
  "dir",
  "help",
  "memoryview",
  "super",
]);

const IMPORT_RE = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;
const CALL_RE = /\b([a-zA-Z_]\w*)\s*\(/g;
const DUNDER_ATTR_RE = /\.\s*(__[a-zA-Z_]\w*__)\s*[\.\(\[]/g;

export function validateSource(source: string): void {
  const text = source.trim();
  if (!text) throw new SandboxError("代码不能为空。");
  if (text.length > MAX_CODE_CHARS) {
    throw new SandboxError(`代码超过 ${MAX_CODE_CHARS} 字符上限。`);
  }

  for (const match of text.matchAll(IMPORT_RE)) {
    const mod = (match[1] ?? match[2] ?? "").split(".")[0];
    if (mod && !ALLOWED_IMPORTS.has(mod)) {
      throw new SandboxError(`不允许 import ${match[1] ?? match[2]}`);
    }
  }

  for (const match of text.matchAll(DUNDER_ATTR_RE)) {
    throw new SandboxError(`不允许访问 ${match[1]}`);
  }

  const stripped = text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''|"[^"]*"|'[^']*'/g, "");
  for (const match of stripped.matchAll(CALL_RE)) {
    const name = match[1];
    if (FORBIDDEN_CALLS.has(name)) {
      throw new SandboxError(`不允许调用 ${name}()`);
    }
  }
}
