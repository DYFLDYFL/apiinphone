import type { ExportedFile } from "../lib/documentExport";
import {
  openExportedFile,
  shareExportedFile,
} from "../lib/documentExport";

interface ExportFileCardProps {
  file: ExportedFile;
  compact?: boolean;
}

export function ExportFileCard({ file, compact }: ExportFileCardProps) {
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
      </div>
    </div>
  );
}
