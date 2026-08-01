import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../types";
import { listModels } from "../lib/apiClient";
import {
  DEEPSEEK_PROVIDER,
  defaultReasoningEffortForModel,
  getProvider,
  modelSupportsThinking,
  normalizeReasoningEffort,
  reasoningEffortsForModel,
  type ReasoningEffort,
} from "../lib/apiProviders";
import { thinkingActive } from "../lib/settings";

interface SettingsPanelProps {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
}

type ReasoningTierValue = "off" | ReasoningEffort;

function tierFromSettings(settings: AppSettings): ReasoningTierValue {
  if (settings.thinkingMode === "disabled") return "off";
  return normalizeReasoningEffort(settings.reasoningEffort, settings.model);
}

export function SettingsPanel({
  open,
  settings,
  onClose,
  onSave,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const fetchGen = useRef(0);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const loadModelOptions = async (source: AppSettings) => {
    if (!source.apiKey.trim()) {
      setModelOptions([]);
      setModelsError("请先填写 API Key");
      return [];
    }
    const gen = ++fetchGen.current;
    setModelsLoading(true);
    setModelsError("");
    try {
      const models = await listModels(source);
      if (gen !== fetchGen.current) return models;
      setModelOptions(models);
      return models;
    } catch (err) {
      if (gen !== fetchGen.current) return [];
      setModelOptions([]);
      setModelsError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      if (gen === fetchGen.current) setModelsLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      return;
    }
    setDraft(settings);
    void loadModelOptions(settings).catch(() => {});
    // Only re-sync when panel opens (avoid refetch on every keystroke save).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      void loadModelOptions(draftRef.current).catch(() => {});
    }, 600);
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [open, draft.apiKey, draft.baseUrl]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onSave(next);
  };

  const provider = getProvider();
  const modelChoices = [
    ...new Set([...provider.models, ...modelOptions, draft.model]),
  ].filter(Boolean);
  const thinkingVisible = modelSupportsThinking(draft.model);
  const thinkingOn = thinkingActive({ ...draft, model: draft.model });
  const effortLevels = reasoningEffortsForModel(draft.model);
  const tierValue = tierFromSettings(draft);

  const setModel = (model: string) => {
    const effort = normalizeReasoningEffort(draft.reasoningEffort, model);
    update({ model, reasoningEffort: effort });
  };

  const setTier = (value: ReasoningTierValue) => {
    if (value === "off") {
      update({ thinkingMode: "disabled" });
      return;
    }
    update({
      thinkingMode: "enabled",
      reasoningEffort: value,
    });
  };

  const refreshModels = async () => {
    try {
      const models = await loadModelOptions(draft);
      if (models.length && !models.includes(draft.model)) {
        setModel(models[0]);
      }
    } catch (err) {
      alert(String(err));
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button type="button" className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <p className="settings-hint">
            {DEEPSEEK_PROVIDER.label} ·{" "}
            <a
              href={DEEPSEEK_PROVIDER.apiKeyUrl}
              target="_blank"
              rel="noreferrer"
            >
              获取 API Key
            </a>
          </p>

          <label>
            API Key
            <input
              type="password"
              value={draft.apiKey}
              placeholder={provider.apiKeyHint}
              onChange={(e) => update({ apiKey: e.target.value })}
            />
          </label>

          <label>
            API 地址
            <input
              value={draft.baseUrl}
              onChange={(e) => update({ baseUrl: e.target.value })}
            />
          </label>

          <label className="row-label">
            模型
            <div className="row">
              <select
                value={draft.model}
                onChange={(e) => setModel(e.target.value)}
              >
                {modelChoices.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="secondary-btn"
                disabled={modelsLoading}
                onClick={() => void refreshModels()}
              >
                {modelsLoading ? "刷新中…" : "刷新"}
              </button>
            </div>
            {modelsError ? (
              <div className="info-muted" style={{ marginTop: 6, fontSize: 12 }}>
                {modelsError}
              </div>
            ) : modelOptions.length > 0 ? (
              <div className="info-muted" style={{ marginTop: 6, fontSize: 12 }}>
                共 {modelOptions.length} 个可用模型（来自 API）
              </div>
            ) : (
              <div className="info-muted" style={{ marginTop: 6, fontSize: 12 }}>
                填写 API Key 后点刷新，获取账号可用模型
              </div>
            )}
          </label>

          {thinkingVisible && (
            <label>
              推理档位
              <select
                value={
                  tierValue === "off" || effortLevels.includes(tierValue)
                    ? tierValue
                    : defaultReasoningEffortForModel(draft.model)
                }
                onChange={(e) =>
                  setTier(e.target.value as ReasoningTierValue)
                }
              >
                <option value="off">关闭</option>
                {effortLevels.map((level) => (
                  <option key={level} value={level}>
                    {level}
                  </option>
                ))}
              </select>
              <p className="settings-hint">
                对应 DeepSeek API 的 thinking / reasoning_effort（随模型变化）。
              </p>
            </label>
          )}

          <label>
            文件导出目录
            <select
              value={draft.exportLocation ?? "documents"}
              onChange={(e) =>
                update({
                  exportLocation: e.target
                    .value as AppSettings["exportLocation"],
                })
              }
            >
              <option value="documents">文档（推荐）</option>
              <option value="data">应用数据</option>
              <option value="cache">缓存（可能被清理）</option>
            </select>
            <p className="settings-hint">
              {draft.exportLocation === "data"
                ? "当前路径：Data/AIExports/"
                : draft.exportLocation === "cache"
                  ? "当前路径：Cache/AIExports/"
                  : "当前路径：Documents/AIExports/"}
              保存后可在聊天界面点「打开」或「发送」，无需自己翻文件夹。
            </p>
          </label>

          <details className="advanced-block">
            <summary>采样</summary>
            <label>
              Temperature
              <input
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={draft.temperature}
                disabled={thinkingOn}
                onChange={(e) =>
                  update({ temperature: Number(e.target.value) })
                }
              />
            </label>
            {thinkingOn && (
              <p className="settings-hint">
                思考模式开启时，Temperature 由 API 忽略。
              </p>
            )}
          </details>

          <details className="advanced-block">
            <summary>搜索设置</summary>
            <label>
              搜索引擎
              <select
                value={draft.webSearchEngine}
                onChange={(e) => update({ webSearchEngine: e.target.value })}
              >
                <option value="bing_cn">Bing 中国（默认，免 Key）</option>
                <option value="bing_intl">Bing 国际</option>
                <option value="bing_rss">Bing RSS</option>
                <option value="searxng">SearXNG</option>
                <option value="duckduckgo">DuckDuckGo HTML</option>
                <option value="ddg_api">DuckDuckGo API（备用）</option>
                <option value="metaso">Metaso</option>
                <option value="baidu">百度 AI 搜索</option>
              </select>
              <p className="settings-hint">
                手机端若 Bing/DDG 失败，推荐配置 Metaso 或百度 Key。
              </p>
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
                <p className="settings-hint">
                  手机不要填 localhost。留空时使用公共 SearXNG 回退。
                </p>
              </label>
            )}
            {draft.webSearchEngine === "metaso" && (
              <label>
                Metaso API Key
                <input
                  type="password"
                  value={draft.webSearchMetasoKey}
                  onChange={(e) =>
                    update({ webSearchMetasoKey: e.target.value })
                  }
                />
              </label>
            )}
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
            <label>
              每次搜索默认条数
              <input
                type="number"
                min={1}
                max={30}
                value={draft.webSearchDefaultTopK}
                onChange={(e) =>
                  update({ webSearchDefaultTopK: Number(e.target.value) })
                }
              />
            </label>
            <label>
              每次搜索条数上限
              <input
                type="number"
                min={1}
                max={30}
                value={draft.webSearchMaxTopK}
                onChange={(e) =>
                  update({ webSearchMaxTopK: Number(e.target.value) })
                }
              />
            </label>
          </details>

          <details className="advanced-block">
            <summary>超时与上限</summary>
            <label>
              Max tokens
              <input
                type="number"
                min={256}
                max={384000}
                step={256}
                value={draft.maxTokens ?? 4096}
                onChange={(e) =>
                  update({ maxTokens: Number(e.target.value) || null })
                }
              />
            </label>
            <label>
              工具调用轮次上限
              <input
                type="number"
                min={1}
                max={64}
                value={draft.maxToolRounds}
                onChange={(e) =>
                  update({ maxToolRounds: Number(e.target.value) })
                }
              />
              <p className="settings-hint">
                单条消息内模型可连续调用工具的最大轮数。用满后会自动汇总回答。
              </p>
            </label>
            <label>
              沙盒超时（秒）
              <input
                type="number"
                min={3}
                max={120}
                value={draft.pythonSandboxTimeout}
                onChange={(e) =>
                  update({ pythonSandboxTimeout: Number(e.target.value) })
                }
              />
              <p className="settings-hint">
                Android App 使用 Chaquopy 真 Python；浏览器使用 Pyodide（首次约
                15MB）。
              </p>
            </label>
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
