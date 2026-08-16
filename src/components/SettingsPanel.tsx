import { useEffect, useState } from "react";
import type { AppSettings, ProviderConfig } from "../types";
import {
  BUILTIN_PROVIDERS,
  providerToConfig,
} from "../lib/apiProviders";
import { listModels } from "../lib/apiClient";

interface SettingsPanelProps {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
  /** 打开时显示的配置分区（对话区 / 工作区）。 */
  section?: "chat" | "workspace";
}

export function SettingsPanel({
  open,
  settings,
  onClose,
  onSave,
  section = "chat",
}: SettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  const [limitTokens, setLimitTokens] = useState(
    () => settings.maxTokens != null && settings.maxTokens > 0,
  );
  const [view, setView] = useState<"main" | "providers">("main");

  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setLimitTokens(settings.maxTokens != null && settings.maxTokens > 0);
    setView("main");
    // 只在打开/切换分区时重置；编辑保存会改动 settings prop，若依赖它会导致
    // 每次编辑都把供应商子界面弹回主设置页。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, section]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onSave(next);
  };

  const providersView = (
    <>
      <div className="settings-providers">
        <div className="game-section-title">
          <h3>模型供应商</h3>
          <span>{draft.providers?.length ?? 0} 个</span>
        </div>
        {(draft.providers ?? []).map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            onChange={(next) =>
              update({
                providers: (draft.providers ?? []).map((item) =>
                  item.id === provider.id ? next : item,
                ),
                ...(draft.apiProvider === provider.id
                  ? {
                      apiKey: next.apiKey,
                      baseUrl: next.baseUrl,
                      model: next.model,
                    }
                  : {}),
              })
            }
            onRemove={() =>
              update({
                providers: (draft.providers ?? []).filter(
                  (item) => item.id !== provider.id,
                ),
              })
            }
          />
        ))}
        <div className="settings-provider-add">
          {BUILTIN_PROVIDERS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className="secondary-btn"
              onClick={() =>
                update({
                  providers: [
                    ...(draft.providers ?? []),
                    providerToConfig(preset),
                  ],
                })
              }
            >
              + {preset.label}
            </button>
          ))}
        </div>
      </div>
    </>
  );

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>
            {view === "providers"
              ? "模型供应商"
              : section === "workspace"
                ? "工作区设置"
                : "设置"}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          {view === "providers" ? (
            providersView
          ) : section === "workspace" ? (
            <>
          <button
            type="button"
            className="settings-providers-entry"
            onClick={() => setView("providers")}
          >
            <span>
              模型供应商（{(draft.providers?.length ?? 0)} 个）
            </span>
            <span>›</span>
          </button>

          <label>
            思考深度
            <select
              value={
                draft.workspaceThinkingMode === "disabled"
                  ? "off"
                  : (draft.workspaceReasoningEffort ?? "high")
              }
              onChange={(e) => {
                const value = e.target.value;
                if (value === "off") {
                  update({ workspaceThinkingMode: "disabled" });
                } else {
                  update({
                    workspaceThinkingMode: "enabled",
                    workspaceReasoningEffort: value as "low" | "high" | "max",
                  });
                }
              }}
            >
              <option value="off">关闭</option>
              <option value="low">低</option>
              <option value="high">高</option>
              <option value="max">最大</option>
            </select>
          </label>

          <label>
            GitHub Token（连接与同步仓库用）
            <input
              type="password"
              value={draft.githubToken}
              placeholder="ghp_… 或个人访问令牌"
              onChange={(e) => update({ githubToken: e.target.value })}
            />
          </label>

          <label>
            主题
            <select
              value={draft.theme}
              onChange={(e) =>
                update({ theme: e.target.value as AppSettings["theme"] })
              }
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
            </>
          ) : (
            <>
          <p className="settings-hint">
            模型与推理档位请在聊天顶栏点击切换。
          </p>

          <button
            type="button"
            className="settings-providers-entry"
            onClick={() => setView("providers")}
          >
            <span>
              模型供应商（{(draft.providers?.length ?? 0)} 个）
            </span>
            <span>›</span>
          </button>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={limitTokens}
              onChange={(e) => {
                const on = e.target.checked;
                setLimitTokens(on);
                update({ maxTokens: on ? 4096 : null });
              }}
            />
            限制输出长度（max tokens）
          </label>
          {limitTokens && (
            <label>
              Max tokens
              <input
                type="number"
                min={256}
                max={384000}
                step={256}
                value={draft.maxTokens ?? 4096}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  update({
                    maxTokens:
                      Number.isNaN(n) || n <= 0
                        ? 4096
                        : Math.min(384000, Math.max(256, Math.round(n))),
                  });
                }}
              />
              <p className="settings-hint">默认不限制；开启后对每次请求设置输出长度上限。</p>
            </label>
          )}

          <label>
            上下文压缩阈值（%）
            <input
              type="number"
              min={0}
              max={95}
              step={5}
              value={draft.contextCompressThreshold ?? 0}
              onChange={(e) => {
                const n = Number(e.target.value);
                update({
                  contextCompressThreshold:
                    Number.isNaN(n) || n <= 0
                      ? 0
                      : Math.min(95, Math.max(0, Math.round(n))),
                });
              }}
            />
            <p className="settings-hint">
              达到该占用比例时，发送前把早期对话压缩为 AI 摘要；0 关闭。
            </p>
          </label>

          <details className="advanced-block">
              <summary>搜索设置</summary>
              <label>
                搜索引擎
                <select
                  value={
                    ["mojeek", "bing_cn", "searxng", "metaso", "baidu", "exa"].includes(
                      draft.webSearchEngine,
                    )
                      ? draft.webSearchEngine
                      : "mojeek"
                  }
                  onChange={(e) => update({ webSearchEngine: e.target.value })}
                >
                  <option value="mojeek">Mojeek（默认，免 Key）</option>
                  <option value="bing_cn">Bing 中国</option>
                  <option value="searxng">SearXNG（自托管）</option>
                  <option value="metaso">秘塔 Metaso</option>
                  <option value="baidu">百度 AI 搜索</option>
                  <option value="exa">Exa（语义搜索）</option>
                </select>
              </label>
              {draft.webSearchEngine === "searxng" && (
                <label>
                  SearXNG 地址
                  <input
                    value={draft.webSearchEndpoint}
                    placeholder="https://your-searxng.example"
                    onChange={(e) =>
                      update({ webSearchEndpoint: e.target.value })
                    }
                  />
                </label>
              )}
              <label>
                秘塔 Metaso API Key（可选）
                <input
                  type="password"
                  value={draft.webSearchMetasoKey}
                  placeholder="填写后优先使用秘塔"
                  onChange={(e) => {
                    const key = e.target.value;
                    update({
                      webSearchMetasoKey: key,
                      ...(key.trim()
                        ? { webSearchEngine: "metaso" as const }
                        : {}),
                    });
                  }}
                />
              </label>
              <label>
                Exa API Key（可选）
                <input
                  type="password"
                  value={draft.webSearchExaKey}
                  placeholder="填写后优先使用 Exa 语义搜索"
                  onChange={(e) => {
                    const key = e.target.value;
                    update({
                      webSearchExaKey: key,
                      ...(key.trim()
                        ? { webSearchEngine: "exa" as const }
                        : {}),
                    });
                  }}
                />
              </label>
              {draft.webSearchEngine === "baidu" && (
                <label>
                  百度 API Key
                  <input
                    type="password"
                    value={draft.webSearchBaiduKey}
                    onChange={(e) =>
                      update({ webSearchBaiduKey: e.target.value })
                    }
                  />
                </label>
              )}
          </details>

          <label>
            系统提示词
            <textarea
              rows={3}
              value={draft.systemPrompt}
              onChange={(e) => update({ systemPrompt: e.target.value })}
            />
          </label>

          <label>
            主题
            <select
              value={draft.theme}
              onChange={(e) =>
                update({ theme: e.target.value as AppSettings["theme"] })
              }
            >
              <option value="light">浅色</option>
              <option value="dark">深色</option>
            </select>
          </label>
            </>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="primary-btn" onClick={onClose}>
            完成
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  onChange,
  onRemove,
}: {
  provider: ProviderConfig;
  onChange: (next: ProviderConfig) => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");
  if (!editing) {
    return (
      <div className="settings-provider-card">
        <div className="settings-provider-head">
          <strong>{provider.label}</strong>
          <span>{provider.id}</span>
        </div>
        <p>{provider.baseUrl}</p>
        <p>
          {provider.apiKey ? "已填 Key" : "未填 Key"} · 模型：{" "}
          {provider.model || "未选择"}
        </p>
        <div className="settings-provider-actions">
          <button
            type="button"
            className="link-btn"
            onClick={() => setEditing(true)}
          >
            编辑
          </button>
          <button
            type="button"
            className="link-btn game-map-delete-btn"
            onClick={onRemove}
          >
            删除
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="settings-provider-card editing">
      <label>
        名称
        <input
          value={provider.label}
          onChange={(e) => onChange({ ...provider, label: e.target.value })}
        />
      </label>
      <label>
        Base URL
        <input
          value={provider.baseUrl}
          placeholder="https://api.example.com/v1"
          onChange={(e) => onChange({ ...provider, baseUrl: e.target.value })}
        />
      </label>
      <label>
        API Key
        <input
          type="password"
          value={provider.apiKey}
          placeholder="粘贴 API Key"
          onChange={(e) => onChange({ ...provider, apiKey: e.target.value })}
        />
      </label>
      <label>
        模型（可手动输入；也可在顶栏从自动识别列表选择）
        <input
          value={provider.model}
          placeholder="模型 ID"
          onChange={(e) => onChange({ ...provider, model: e.target.value })}
        />
      </label>
      <div className="settings-provider-actions">
        <button
          type="button"
          className="secondary-btn"
          disabled={!provider.apiKey.trim() || importing}
          onClick={async () => {
            if (!provider.apiKey.trim()) return;
            setImporting(true);
            setImportError("");
            try {
              const models = await listModels({
                apiKey: provider.apiKey,
                baseUrl: provider.baseUrl,
                httpConnectTimeout: 15,
              } as AppSettings);
              onChange({ ...provider, models });
            } catch (err) {
              setImportError(err instanceof Error ? err.message : String(err));
            } finally {
              setImporting(false);
            }
          }}
        >
          {importing ? "识别中…" : "自动识别模型"}
        </button>
        <button
          type="button"
          className="secondary-btn"
          onClick={() => setEditing(false)}
        >
          完成
        </button>
      </div>
      {importError ? (
        <p className="settings-hint">{importError}</p>
      ) : null}
      {provider.models.length ? (
        <div className="settings-model-checks">
          <span>启用模型（未勾选的不可在顶栏切换）</span>
          <div className="settings-model-check-list">
            {provider.models.map((model) => {
              const enabled =
                !provider.enabledModels?.length ||
                provider.enabledModels.includes(model);
              return (
                <label className="game-pipeline-check" key={model}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) => {
                      const current = new Set(
                        provider.enabledModels?.length
                          ? provider.enabledModels
                          : provider.models,
                      );
                      if (e.target.checked) current.add(model);
                      else current.delete(model);
                      onChange({
                        ...provider,
                        enabledModels: Array.from(current),
                      });
                    }}
                  />
                  {model}
                </label>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
