import { useEffect, useState } from "react";

interface RenameDialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  onConfirm: (title: string) => void;
}

export function RenameDialog({
  open,
  title,
  onClose,
  onConfirm,
}: RenameDialogProps) {
  const [value, setValue] = useState(title);

  useEffect(() => {
    if (open) setValue(title);
  }, [open, title]);

  if (!open) return null;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal rename-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>重命名对话</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <label>
            标题
            <input
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onConfirm(value);
              }}
            />
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="secondary-btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="primary-btn"
            onClick={() => onConfirm(value)}
          >
            确定
          </button>
        </div>
      </div>
    </div>
  );
}
