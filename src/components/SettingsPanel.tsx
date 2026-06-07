import { useEffect, useState } from "react";
import type { AppSettings } from "../types";
import { listModels } from "../lib/apiClient";
import {
  applyProviderPreset,
  getProvider,
  modelSupportsThinking,
  PROVIDER_ORDER,
} from "../lib/apiProviders";
import { thinkingActive } from "../lib/settings";

interface SettingsPanelProps {
  open: boolean;
  settings: AppSettings;
  onClose: () => void;
  onSave: (settings: AppSettings) => void;
}

export function SettingsPanel({
  open,
  settings,
  onClose,
  onSave,
}: SettingsPanelProps) {
  const [draft, setDraft] = useState(settings);
  const [modelOptions, setModelOptions] = useState<string[]>(settings.recentModels);

  useEffect(() => {
    setDraft(settings);
    setModelOptions(settings.recentModels);
  }, [settings, open]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onSave(next);
  };

  const provider = getProvider(draft.apiProvider);
  const resolvedModel =
    draft.modelPreset === "flash"
      ? "deepseek-v4-flash"
      : draft.modelPreset === "pro"
        ? "deepseek-v4-pro"
        : draft.model;
  const thinkingVisible =
    draft.apiProvider === "deepseek" && modelSupportsThinking(resolvedModel);
  const thinkingOn = thinkingActive({ ...draft, model: resolvedModel });

  const refreshModels = async () => {
    try {
      const models = await listModels(draft);
      const merged = [...new Set([...models, ...draft.recentModels])].slice(
        0,
        200,
      );
      setModelOptions(merged);
      if (models.length && !merged.includes(draft.model)) {
        update({ model: models[0], modelPreset: "custom" });
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
            {provider.label} ·{" "}
            <a href={provider.apiKeyUrl} target="_blank" rel="noreferrer">
              获取 API Key
            </a>
          </p>

          <label>
            API 提供商
            <select
              value={draft.apiProvider}
              onChange={(e) =>
                update(
                  applyProviderPreset(
                    draft,
                    e.target.value as "poe" | "deepseek",
                  ),
                )
              }
            >
              {PROVIDER_ORDER.map((id) => (
                <option key={id} value={id}>
                  {getProvider(id).label}
                </option>
              ))}
            </select>
          </label>

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

          {draft.apiProvider === "deepseek" && (
            <label>
              模型预设
              <select
                value={draft.modelPreset}
                onChange={(e) =>
                  update({
                    modelPreset: e.target.value as AppSettings["modelPreset"],
                  })
                }
              >
                <option value="flash">快速 (v4-flash)</option>
                <option value="pro">深度 (v4-pro)</option>
                <option value="custom">自定义</option>
              </select>
            </label>
          )}

          <label className="row-label">
            模型
            <div className="row">
              <input
                list="model-options"
                value={draft.model}
                onChange={(e) =>
                  update({ model: e.target.value, modelPreset: "custom" })
                }
              />
              <datalist id="model-options">
                {modelOptions.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <button type="button" className="secondary-btn" onClick={() => void refreshModels()}>
                刷新
              </button>
            </div>
          </label>

          {thinkingVisible && (
            <>
              <label>
                思考模式
                <select
                  value={draft.thinkingMode}
                  onChange={(e) =>
                    update({
                      thinkingMode: e.target.value as AppSettings["thinkingMode"],
                    })
                  }
                >
                  <option value="enabled">开启思考</option>
                  <option value="disabled">关闭思考（更省）</option>
                </select>
              </label>
              <label>
                思考深度
                <select
                  value={draft.reasoningEffort}
                  onChange={(e) =>
                    update({
                      reasoningEffort: e.target
                        .value as AppSettings["reasoningEffort"],
                    })
                  }
                >
                  <option value="high">high（默认）</option>
                  <option value="max">max（更深）</option>
                </select>
              </label>
            </>
          )}

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
            <p className="settings-hint">思考模式开启时，Temperature 由 API 忽略。</p>
          )}

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

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.stream}
              onChange={(e) => update({ stream: e.target.checked })}
            />
            流式输出（逐字显示回复）
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.showThinking}
              onChange={(e) => update({ showThinking: e.target.checked })}
            />
            在界面显示思考过程
          </label>

          <label className="checkbox">
            <input
              type="checkbox"
              checked={draft.toolsEnabled}
              onChange={(e) => update({ toolsEnabled: e.target.checked })}
            />
            启用 Tool Calls
          </label>

          {draft.toolsEnabled && (
            <>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.toolsWebSearch}
                  onChange={(e) => update({ toolsWebSearch: e.target.checked })}
                />
                启用联网搜索
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={draft.toolsPythonSandbox}
                  onChange={(e) =>
                    update({ toolsPythonSandbox: e.target.checked })
                  }
                />
                启用 Python 沙盒（Pyodide，首次约 15MB 需联网下载）
              </label>
              {draft.toolsPythonSandbox && (
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
                </label>
              )}
              <label>
                搜索引擎
                <select
                  value={draft.webSearchEngine}
                  onChange={(e) => update({ webSearchEngine: e.target.value })}
                >
                  <option value="bing_cn">Bing 中国</option>
                  <option value="bing_intl">Bing 国际</option>
                  <option value="bing_rss">Bing RSS（移动端推荐）</option>
                  <option value="searxng">SearXNG</option>
                  <option value="duckduckgo">DuckDuckGo HTML</option>
                  <option value="ddg_api">DuckDuckGo API（备用推荐）</option>
                  <option value="metaso">Metaso</option>
                  <option value="baidu">百度 AI 搜索</option>
                </select>
                <p className="settings-hint">
                  手机端若 Bing/DDG 网络失败，推荐 Metaso 或百度 Key（国内 API 最稳）。
                </p>
              </label>
              {draft.webSearchEngine === "searxng" && (
                <label>
                  SearXNG 地址
                  <input
                    value={draft.webSearchEndpoint}
                    onChange={(e) =>
                      update({ webSearchEndpoint: e.target.value })
                    }
                  />
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
                自定义工具 JSON（数组，可选 x-apiinphone 扩展）
                <textarea
                  rows={5}
                  value={draft.toolsCustomJson}
                  placeholder={`[\n  {\n    "type": "function",\n    "function": {\n      "name": "echo_tool",\n      "description": "Echo args",\n      "parameters": { "type": "object", "properties": { "text": { "type": "string" } } }\n    },\n    "x-apiinphone": { "type": "js", "handler": "echo" }\n  }\n]`}
                  onChange={(e) => update({ toolsCustomJson: e.target.value })}
                />
              </label>
            </>
          )}

          <details className="advanced-block">
            <summary>高级网络设置</summary>
            <label>
              连接超时（秒）
              <input
                type="number"
                min={5}
                max={120}
                value={draft.httpConnectTimeout}
                onChange={(e) =>
                  update({ httpConnectTimeout: Number(e.target.value) })
                }
              />
            </label>
            <label>
              读取超时（秒）
              <input
                type="number"
                min={30}
                max={600}
                value={draft.httpReadTimeout}
                onChange={(e) =>
                  update({ httpReadTimeout: Number(e.target.value) })
                }
              />
            </label>
            <label>
              重试次数
              <input
                type="number"
                min={0}
                max={5}
                value={draft.retryCount}
                onChange={(e) => update({ retryCount: Number(e.target.value) })}
              />
            </label>
            <label>
              重试间隔（毫秒）
              <input
                type="number"
                min={200}
                max={10000}
                step={100}
                value={draft.retryBackoffMs}
                onChange={(e) =>
                  update({ retryBackoffMs: Number(e.target.value) })
                }
              />
            </label>
            {draft.apiProvider === "poe" && (
              <>
                <label>
                  HTTP-Referer
                  <input
                    value={draft.httpReferer}
                    onChange={(e) => update({ httpReferer: e.target.value })}
                  />
                </label>
                <label>
                  X-Title
                  <input
                    value={draft.appTitle}
                    onChange={(e) => update({ appTitle: e.target.value })}
                  />
                </label>
              </>
            )}
          </details>

          <label>
            系统提示词
            <textarea
              rows={4}
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
