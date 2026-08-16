import { useEffect, useState } from "react";
import {
  setDialogListener,
  type DialogRequest,
} from "../lib/uiDialogs";

/** 全局确认/提示对话框（Android WebView 无 window.confirm/alert）。 */
export function ConfirmDialog() {
  const [request, setRequest] = useState<DialogRequest | null>(null);

  useEffect(() => {
    setDialogListener((next) => setRequest(next));
    return () => setDialogListener(null);
  }, []);

  if (!request) return null;

  const close = (ok: boolean) => {
    request.resolve(ok);
    setRequest(null);
  };

  return (
    <div className="modal-backdrop" onClick={() => close(false)}>
      <div className="modal confirm-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-body">
          <p className="confirm-dialog-text">{request.text}</p>
        </div>
        <div className="modal-footer">
          {request.kind === "confirm" ? (
            <>
              <button
                type="button"
                className="secondary-btn"
                onClick={() => close(false)}
              >
                取消
              </button>
              <button
                type="button"
                className="primary-btn"
                onClick={() => close(true)}
              >
                确定
              </button>
            </>
          ) : (
            <button
              type="button"
              className="primary-btn"
              onClick={() => close(true)}
            >
              确定
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
