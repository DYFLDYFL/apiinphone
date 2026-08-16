/**
 * 全局对话框：Android WebView 的 window.confirm/alert 静默失效
 * （Capacitor 未实现 onJsConfirm/onJsAlert），统一走 React 模态框。
 */

export interface DialogRequest {
  id: number;
  kind: "confirm" | "message";
  text: string;
  resolve: (ok: boolean) => void;
}

type DialogListener = (request: DialogRequest | null) => void;

let listener: DialogListener | null = null;
let seq = 0;

/** 由 ConfirmDialog 组件挂载时注册。 */
export function setDialogListener(fn: DialogListener | null): void {
  listener = fn;
}

function enqueue(kind: DialogRequest["kind"], text: string): Promise<boolean> {
  const current = listener;
  if (!current) {
    // 组件未挂载（理论只在启动瞬间）：网页端退回原生 confirm，原生端视为取消。
    if (typeof window !== "undefined" && window.confirm) {
      return Promise.resolve(kind === "confirm" ? window.confirm(text) : true);
    }
    return Promise.resolve(false);
  }
  return new Promise<boolean>((resolve) => {
    current({ id: ++seq, kind, text, resolve });
  });
}

/** 确认对话框（确定/取消），返回是否确定。 */
export function confirmAsync(text: string): Promise<boolean> {
  return enqueue("confirm", text);
}

/** 信息提示（仅确定），无返回值。 */
export function showMessage(text: string): Promise<void> {
  return enqueue("message", text).then(() => undefined);
}
