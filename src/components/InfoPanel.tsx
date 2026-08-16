import type { AppSettings, ChatSession, TokenUsage } from "../types";
import { getProvider } from "../lib/apiProviders";
import type { ExportedFile } from "../lib/documentExport";
import { effectiveModel } from "../lib/settings";
import {
  balanceUnavailableText,
  formatContextUsage,
  formatLastRequestUsage,
  formatSessionUsage,
} from "../lib/usageInfo";
import { ExportFileCard } from "./ExportFileCard";

interface InfoPanelProps {
  open: boolean;
  onClose: () => void;
  settings: AppSettings;
  session: ChatSession;
  lastUsage: TokenUsage | null;
  lastSpentCny: number | null;
  lastSpendKind: "balance" | "estimate" | null;
  balanceLines: string[];
  balanceError: string;
  balanceLoading: boolean;
  onRefreshBalance: () => void;
  exportHistory: ExportedFile[];
  onRemoveExport: (file: ExportedFile) => void;
}

export function InfoPanel({
  open,
  onClose,
  settings,
  session,
  lastUsage,
  lastSpentCny,
  lastSpendKind,
  balanceLines,
  balanceError,
  balanceLoading,
  onRefreshBalance,
  exportHistory,
  onRemoveExport,
}: InfoPanelProps) {
  if (!open) return null;

  const provider = getProvider(settings);
  const model = effectiveModel(settings);
  const activeConfig = settings.providers?.find(
    (item) => item.id === settings.apiProvider,
  );
  const isDeepSeek = settings.apiProvider === "deepseek";
  const isOpenCodeGo = settings.apiProvider === "opencode-go";

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="info-panel" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-header">
          <strong>用量与账户</strong>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <section className="info-block">
          <div className="info-label">提供商 / 模型</div>
          <div className="info-value">{provider.label}</div>
          <div className="info-muted">{model}</div>
        </section>

        <section className="info-block">
          <div className="info-label">当前上下文</div>
          <pre className="info-pre">
            {formatContextUsage(session.contextTokens, model)}
          </pre>
        </section>

        {isOpenCodeGo && (
          <section className="info-block">
            <div className="info-label">可用模型</div>
            <div className="info-muted">
              {activeConfig?.models?.length
                ? activeConfig.models.slice(0, 20).join("、")
                : "（尚未获取模型列表）"}
            </div>
          </section>
        )}

        <section className="info-block">
          <div className="info-label">对话用量</div>
          <pre className="info-pre">
            {formatSessionUsage(
              session.promptTokens,
              session.completionTokens,
              session.totalTokens,
              session.cacheHitTokens,
              model,
              session.spentCny,
              session.spentCny > 0 ? "balance" : "estimate",
            )}
          </pre>
        </section>

        <section className="info-block">
          <div className="info-label">上次请求</div>
          <pre className="info-pre">
            {formatLastRequestUsage(
              lastUsage,
              model,
              lastSpentCny,
              lastSpendKind,
            )}
          </pre>
        </section>

        <section className="info-block">
          <div className="info-label">最近导出</div>
          {exportHistory.length ? (
            <div className="export-history-list">
              {exportHistory.slice(0, 8).map((file) => (
                <ExportFileCard
                  key={file.id}
                  file={file}
                  compact
                  onRemove={onRemoveExport}
                />
              ))}
            </div>
          ) : (
            <div className="info-muted">尚无导出文件</div>
          )}
        </section>

        {isDeepSeek && (
          <section className="info-block">
            <div className="info-row">
              <div className="info-label">账户余额</div>
              <button
                type="button"
                className="link-btn"
                disabled={balanceLoading}
                onClick={onRefreshBalance}
              >
                {balanceLoading ? "查询中…" : "刷新"}
              </button>
            </div>
            {balanceError ? (
              <div className="info-error">{balanceError}</div>
            ) : balanceLines.length ? (
              balanceLines.map((line) => (
                <div key={line} className="info-value">
                  {line}
                </div>
              ))
            ) : (
              <div className="info-muted">{balanceUnavailableText()}</div>
            )}
          </section>
        )}
      </aside>
    </div>
  );
}
