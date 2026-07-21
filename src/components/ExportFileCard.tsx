import type { ExportedFile } from "../lib/documentExport";
import {
  isShareDismissedError,
  openExportedFile,
  shareExportedFile,
} from "../lib/documentExport";

interface ExportFileCardProps {
  file: ExportedFile;
  compact?: boolean;
  onRemove?: (file: ExportedFile) => void;
}

export function ExportFileCard({
  file,
  compact,
  onRemove,
}: ExportFileCardProps) {
  const handleOpen = async () => {
    try {
      await openExportedFile(file);
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  const handleShare = async () => {
    try {
      await shareExportedFile(file);
    } catch (err) {
      if (isShareDismissedError(err)) return;
      alert(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className={`export-card${compact ? " compact" : ""}`}>
      <div className="export-card-main">
        <div className="export-card-name">{file.name}</div>
        <div className="export-card-meta">
          {file.locationLabel} · {file.path}
        </div>
      </div>
      <div className="export-card-actions">
        <button type="button" className="secondary-btn" onClick={() => void handleOpen()}>
          打开
        </button>
        <button type="button" className="secondary-btn" onClick={() => void handleShare()}>
          发送
        </button>
        {onRemove && (
          <button
            type="button"
            className="secondary-btn"
            onClick={() => onRemove(file)}
          >
            删除
          </button>
        )}
      </div>
    </div>
  );
}
