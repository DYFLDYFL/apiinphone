import { useEffect, useState } from "react";
import type { AppSettings } from "../types";
import { DEEPSEEK_PROVIDER, getProvider } from "../lib/apiProviders";
import { testDeepseekWebConnection } from "../lib/deepseekWeb/client";

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
  const [limitTokens, setLimitTokens] = useState(
    () => settings.maxTokens != null && settings.maxTokens > 0,
  );
  const [testBusy, setTestBusy] = useState(false);
  const [testMsg, setTestMsg] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(settings);
    setLimitTokens(settings.maxTokens != null && settings.maxTokens > 0);
    setTestMsg("");
  }, [open, settings]);

  if (!open) return null;

  const update = (patch: Partial<AppSettings>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    onSave(next);
  };

  const provider = getProvider();
  const isWeb = draft.deepseekTransport === "web";

  const handleTestWeb = async () => {
    setTestBusy(true);
    setTestMsg("测试中…");
    try {
      const reply = await testDeepseekWebConnection(draft);
      setTestMsg(`成功：${reply.slice(0, 80)}`);
    } catch (err) {
      setTestMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setTestBusy(false);
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
            DeepSeek · 模型与推理档位请在聊天顶栏点击切换。
          </p>

          <fieldset className="settings-fieldset">
            <legend>连接方式</legend>
            <label className="radio-row">
              <input
                type="radio"
                name="deepseekTransport"
                checked={!isWeb}
                onChange={() => update({ deepseekTransport: "official" })}
              />
              官方 API
            </label>
            <label className="radio-row">
              <input
                type="radio"
                name="deepseekTransport"
                checked={isWeb}
                onChange={() => update({ deepseekTransport: "web" })}
              />
              网页会话
            </label>
          </fieldset>

          {!isWeb ? (
            <>
              <p className="settings-hint">
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
            </>
          ) : (
            <>
              <p className="settings-hint warn-hint">
                非官方通道：易失效、有封号风险。本 App
                将强制串行请求并加间隔；网页模式关闭工具调用。请仅使用你自己的登录会话。
              </p>
              <label>
                网页会话 Token
                <textarea
                  rows={3}
                  value={draft.webSessionToken}
                  placeholder='LocalStorage userToken 的 value，或整段 {"value":"..."}'
                  onChange={(e) => update({ webSessionToken: e.target.value })}
                />
              </label>
              <label>
                Cookie（建议含 aws-waf-token）
                <textarea
                  rows={3}
                  value={draft.webSessionCookies}
                  placeholder="从浏览器 Network 请求头复制 Cookie"
                  onChange={(e) =>
                    update({ webSessionCookies: e.target.value })
                  }
                />
              </label>
              <label>
                请求最小间隔（毫秒）
                <input
                  type="number"
                  min={500}
                  max={60000}
                  step={500}
                  value={draft.webMinIntervalMs}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    update({
                      webMinIntervalMs:
                        Number.isNaN(n) || n < 500
                          ? 3000
                          : Math.min(60000, Math.round(n)),
                    });
                  }}
                />
                <p className="settings-hint">
                  网页模式并发固定为 1。默认 3000ms。游戏交互轮次上限 ≤3。
                </p>
              </label>
              <p className="settings-hint">
                如何获取：浏览器打开 chat.deepseek.com 并登录 → F12 → Application →
                Local Storage → userToken → 复制 value；再在 Network 任意
                /api/v0 请求中复制 Cookie。
              </p>
              <button
                type="button"
                className="secondary-btn"
                disabled={testBusy || !draft.webSessionToken.trim()}
                onClick={() => void handleTestWeb()}
              >
                {testBusy ? "测试中…" : "测试连接"}
              </button>
              {testMsg ? <p className="settings-hint">{testMsg}</p> : null}
            </>
          )}

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
              <p className="settings-hint">默认不限制；开启后写入请求的 max_tokens。</p>
            </label>
          )}

          {!isWeb && (
            <details className="advanced-block">
              <summary>搜索设置</summary>
              <label>
                搜索引擎
                <select
                  value={
                    ["mojeek", "bing_cn", "searxng", "metaso", "baidu"].includes(
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
                </select>
                <p className="settings-hint">
                  对齐 Reasonix：默认 Mojeek HTML 抓取。失败时自动回退 Bing RSS /
                  DuckDuckGo。填写秘塔 Key 后优先用秘塔。
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
                <p className="settings-hint">
                  约 ¥0.03/次；国内中文最稳。在 metaso.cn 创建 Key。
                </p>
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
          )}

          <label>
            系统提示词
            <textarea
              rows={3}
              value={draft.systemPrompt}
              onChange={(e) => update({ systemPrompt: e.target.value })}
            />
            <p className="settings-hint">
              {isWeb
                ? "网页模式不调用工具；系统提示仍会发给模型。"
                : "发送时会自动附带工具调用轮次上限说明（不可在此改上限）。"}
            </p>
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
