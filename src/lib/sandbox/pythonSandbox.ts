import { Sandpy } from "sandpy";
import { ALLOWED_IMPORTS } from "./policy";
import { sanitizeCode } from "./sanitize";
import { validateSource } from "./policy";
import { SandboxError, type SandboxRunResult } from "./types";

const MAX_OUTPUT_CHARS = 48_000;
const RESULT_VAR = "__sandbox_result__";

let sandboxPromise: Promise<Sandpy> | null = null;

function buildRunnerScript(userCode: string): string {
  const payload = JSON.stringify(userCode);
  const allowed = JSON.stringify([...ALLOWED_IMPORTS]);
  return `
import ast, io, json, traceback, builtins
from contextlib import redirect_stdout, redirect_stderr

ALLOWED = set(${allowed})
RESULT_VAR = ${JSON.stringify(RESULT_VAR)}
USER_CODE = json.loads(${JSON.stringify(payload)})

def safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in ALLOWED:
        raise ImportError(f"import of module {name!r} is not allowed")
    return builtins.__import__(name, globals, locals, fromlist, level)

SAFE_BUILTINS = {
    k: getattr(builtins, k)
    for k in (
        "abs","all","any","ascii","bin","bool","bytes","chr","dict","divmod",
        "enumerate","filter","float","format","frozenset","hash","hex","int",
        "isinstance","issubclass","iter","len","list","map","max","min","next",
        "oct","ord","pow","print","range","repr","reversed","round","set","slice",
        "sorted","str","sum","tuple","zip","True","False","None","Ellipsis",
        "NotImplemented","Exception","BaseException","ValueError","TypeError",
        "ZeroDivisionError","IndexError","KeyError","StopIteration","RuntimeError",
        "ArithmeticError","LookupError","AssertionError","OverflowError",
    )
}
SAFE_BUILTINS["__import__"] = safe_import

def capture_last_expr(source):
    tree = ast.parse(source, mode="exec")
    if not tree.body or not isinstance(tree.body[-1], ast.Expr):
        return source
    if len(tree.body) == 1:
        prefix = ""
    else:
        prefix = ast.unparse(ast.Module(body=tree.body[:-1], type_ignores=[])).rstrip()
    expr_src = ast.unparse(tree.body[-1].value)
    if prefix:
        return prefix + "\\n" + RESULT_VAR + " = " + expr_src
    return RESULT_VAR + " = " + expr_src

stdout = io.StringIO()
stderr = io.StringIO()
namespace = {"__name__": "__main__", "__builtins__": SAFE_BUILTINS}
try:
    wrapped = capture_last_expr(USER_CODE)
    compiled = compile(wrapped, "<sandbox>", "exec")
    with redirect_stdout(stdout), redirect_stderr(stderr):
        exec(compiled, namespace, namespace)
    result = namespace.get(RESULT_VAR)
    if result is not None:
        try:
            json.dumps(result, ensure_ascii=False)
        except TypeError:
            result = repr(result)
    print("__SANDPY_RESULT__" + json.dumps({
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "result": result,
    }, ensure_ascii=False))
except Exception:
    stderr.write(traceback.format_exc())
    print("__SANDPY_RESULT__" + json.dumps({
        "stdout": stdout.getvalue(),
        "stderr": stderr.getvalue(),
        "error": "execution_failed",
    }, ensure_ascii=False))
`;
}

async function getSandbox(): Promise<Sandpy> {
  if (!sandboxPromise) {
    sandboxPromise = Sandpy.create().catch((err) => {
      sandboxPromise = null;
      throw err;
    });
  }
  return sandboxPromise;
}

function parseRunnerOutput(raw: {
  success: boolean;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
  result?: unknown;
}): SandboxRunResult {
  const marker = "__SANDPY_RESULT__";
  const line = raw.stdout.split("\n").find((l: string) => l.startsWith(marker));
  const plainStdout = raw.stdout
    .split("\n")
    .filter((l: string) => !l.startsWith(marker))
    .join("\n")
    .replace(/\n$/, "");

  if (line) {
    try {
      const payload = JSON.parse(line.slice(marker.length)) as {
        stdout?: string;
        stderr?: string;
        result?: unknown;
        error?: string;
      };
      const stderr = [payload.stderr, raw.stderr].filter(Boolean).join("\n").trim();
      if (payload.error || !raw.success) {
        return {
          ok: false,
          stdout: payload.stdout ?? plainStdout,
          stderr,
          error: stderr || raw.error || "Python 执行失败",
        };
      }
      return {
        ok: true,
        stdout: payload.stdout ?? plainStdout,
        stderr,
        result: payload.result,
      };
    } catch {
      /* fall through */
    }
  }

  if (raw.timedOut) {
    return {
      ok: false,
      stdout: plainStdout,
      stderr: raw.stderr,
      error: "执行超时。",
      timedOut: true,
    };
  }

  if (!raw.success) {
    return {
      ok: false,
      stdout: plainStdout,
      stderr: raw.stderr,
      error: raw.error || raw.stderr || "Python 执行失败",
    };
  }

  return {
    ok: true,
    stdout: plainStdout || raw.stdout,
    stderr: raw.stderr,
    result: raw.result,
  };
}

export function formatForModel(result: SandboxRunResult): string {
  if (result.error && !result.ok) {
    return result.stderr
      ? `${result.error}\n${result.stderr}`.trim()
      : result.error;
  }
  const parts: string[] = [];
  if (result.stdout) parts.push(result.stdout.replace(/\n$/, ""));
  if (result.stderr) parts.push(`[stderr]\n${result.stderr.replace(/\n$/, "")}`);
  if (result.result !== undefined && result.result !== null) {
    parts.push(`[return]\n${JSON.stringify(result.result)}`);
  }
  let text = parts.length ? parts.join("\n\n") : "(无输出)";
  if (text.length > MAX_OUTPUT_CHARS) {
    const overflow = text.length - MAX_OUTPUT_CHARS;
    text = `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[… truncated ${overflow} chars …]`;
  }
  return text;
}

export async function runPython(
  code: string,
  timeoutSec = 15,
): Promise<string> {
  const sanitized = sanitizeCode(code);
  validateSource(sanitized);

  let sandbox: Sandpy;
  try {
    sandbox = await getSandbox();
  } catch (err) {
    throw new SandboxError(
      `无法初始化 Python 运行时（首次使用需联网下载 Pyodide，约 15MB）：${String(err)}`,
    );
  }

  const script = buildRunnerScript(sanitized);
  const timeoutMs = Math.min(120, Math.max(3, timeoutSec)) * 1000;

  try {
    const raw = await sandbox.run(script, { timeout: timeoutMs });
    return formatForModel(parseRunnerOutput(raw));
  } catch (err) {
    if (err instanceof SandboxError) throw err;
    throw new SandboxError(String(err));
  }
}

export async function warmupPythonSandbox(): Promise<void> {
  await getSandbox();
}

export async function destroyPythonSandbox(): Promise<void> {
  if (!sandboxPromise) return;
  try {
    const sandbox = await sandboxPromise;
    await sandbox.destroy();
  } finally {
    sandboxPromise = null;
  }
}

export { SandboxError } from "./types";
