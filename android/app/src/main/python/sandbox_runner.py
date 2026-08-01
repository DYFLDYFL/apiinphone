"""Restricted Python runner for apiinphone run_python (Chaquopy)."""

from __future__ import annotations

import ast
import builtins
import io
import json
import re
import traceback
from contextlib import redirect_stderr, redirect_stdout

RESULT_VAR = "__sandbox_result__"
MAX_CODE_CHARS = 24_000
MAX_OUTPUT_CHARS = 48_000

ALLOWED_IMPORTS = {
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
}

FORBIDDEN_CALLS = {
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
}

IMPORT_RE = re.compile(
    r"^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))",
    re.MULTILINE,
)
CALL_RE = re.compile(r"\b([a-zA-Z_]\w*)\s*\(")
DUNDER_ATTR_RE = re.compile(r"\.\s*(__[a-zA-Z_]\w*__)\s*[\.\(\[]")
STRING_RE = re.compile(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'|"[^"]*"|\'[^\']*\'')


def _validate_source(source: str) -> None:
    text = source.strip()
    if not text:
        raise ValueError("代码不能为空。")
    if len(text) > MAX_CODE_CHARS:
        raise ValueError(f"代码超过 {MAX_CODE_CHARS} 字符上限。")

    for match in IMPORT_RE.finditer(text):
        mod = (match.group(1) or match.group(2) or "").split(".")[0]
        if mod and mod not in ALLOWED_IMPORTS:
            raise ValueError(f"不允许 import {match.group(1) or match.group(2)}")

    for match in DUNDER_ATTR_RE.finditer(text):
        raise ValueError(f"不允许访问 {match.group(1)}")

    stripped = STRING_RE.sub("", text)
    for match in CALL_RE.finditer(stripped):
        name = match.group(1)
        if name in FORBIDDEN_CALLS:
            raise ValueError(f"不允许调用 {name}()")


def _safe_import(name, globals=None, locals=None, fromlist=(), level=0):
    root = name.split(".")[0]
    if root not in ALLOWED_IMPORTS:
        raise ImportError(f"import of module {name!r} is not allowed")
    return builtins.__import__(name, globals, locals, fromlist, level)


def _capture_last_expr(source: str) -> str:
    tree = ast.parse(source, mode="exec")
    if not tree.body or not isinstance(tree.body[-1], ast.Expr):
        return source
    if len(tree.body) == 1:
        prefix = ""
    else:
        prefix = ast.unparse(
            ast.Module(body=tree.body[:-1], type_ignores=[])
        ).rstrip()
    expr_src = ast.unparse(tree.body[-1].value)
    if prefix:
        return prefix + "\n" + RESULT_VAR + " = " + expr_src
    return RESULT_VAR + " = " + expr_src


def _format_output(payload: dict) -> str:
    if payload.get("error") and not payload.get("ok", True):
        err = payload.get("error") or "Python 执行失败"
        stderr = (payload.get("stderr") or "").strip()
        return f"{err}\n{stderr}".strip() if stderr else str(err)

    parts: list[str] = []
    stdout = payload.get("stdout") or ""
    stderr = payload.get("stderr") or ""
    result = payload.get("result")
    if stdout:
        parts.append(stdout.rstrip("\n"))
    if stderr:
        parts.append("[stderr]\n" + stderr.rstrip("\n"))
    if result is not None:
        parts.append("[return]\n" + json.dumps(result, ensure_ascii=False))
    text = "\n\n".join(parts) if parts else "(无输出)"
    if len(text) > MAX_OUTPUT_CHARS:
        overflow = len(text) - MAX_OUTPUT_CHARS
        text = text[:MAX_OUTPUT_CHARS] + f"\n\n[… truncated {overflow} chars …]"
    return text


def run(code: str) -> str:
    """Execute user code under the sandbox policy. Returns text for the model."""
    try:
        _validate_source(code)
    except ValueError as exc:
        return str(exc)

    safe_builtins = {
        k: getattr(builtins, k)
        for k in (
            "abs",
            "all",
            "any",
            "ascii",
            "bin",
            "bool",
            "bytes",
            "chr",
            "dict",
            "divmod",
            "enumerate",
            "filter",
            "float",
            "format",
            "frozenset",
            "hash",
            "hex",
            "int",
            "isinstance",
            "issubclass",
            "iter",
            "len",
            "list",
            "map",
            "max",
            "min",
            "next",
            "oct",
            "ord",
            "pow",
            "print",
            "range",
            "repr",
            "reversed",
            "round",
            "set",
            "slice",
            "sorted",
            "str",
            "sum",
            "tuple",
            "zip",
            "True",
            "False",
            "None",
            "Ellipsis",
            "NotImplemented",
            "Exception",
            "BaseException",
            "ValueError",
            "TypeError",
            "ZeroDivisionError",
            "IndexError",
            "KeyError",
            "StopIteration",
            "RuntimeError",
            "ArithmeticError",
            "LookupError",
            "AssertionError",
            "OverflowError",
        )
    }
    safe_builtins["__import__"] = _safe_import

    stdout = io.StringIO()
    stderr = io.StringIO()
    namespace = {"__name__": "__main__", "__builtins__": safe_builtins}

    try:
        wrapped = _capture_last_expr(code.strip())
        compiled = compile(wrapped, "<sandbox>", "exec")
        with redirect_stdout(stdout), redirect_stderr(stderr):
            exec(compiled, namespace, namespace)
        result = namespace.get(RESULT_VAR)
        if result is not None:
            try:
                json.dumps(result, ensure_ascii=False)
            except TypeError:
                result = repr(result)
        payload = {
            "ok": True,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "result": result,
        }
    except Exception:
        stderr.write(traceback.format_exc())
        payload = {
            "ok": False,
            "stdout": stdout.getvalue(),
            "stderr": stderr.getvalue(),
            "error": "Python 执行失败",
        }

    return _format_output(payload)
