import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../types";
import { listModels } from "../lib/apiClient";
import {
  defaultReasoningEffortForModel,
  getProvider,
  modelSupportsThinking,
  normalizeReasoningEffort,
  reasoningEffortsForModel,
  type ReasoningEffort,
} from "../lib/apiProviders";
import { effectiveModel } from "../lib/settings";

type TierValue = "off" | ReasoningEffort;

interface ModelSwitcherProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  disabled?: boolean;
}

function tierFromSettings(settings: AppSettings): TierValue {
  if (settings.thinkingMode === "disabled") return "off";
  return normalizeReasoningEffort(settings.reasoningEffort, settings.model);
}

function displayTier(settings: AppSettings): string {
  if (!modelSupportsThinking(effectiveModel(settings))) return "";
  if (settings.thinkingMode === "disabled") return "off";
  return normalizeReasoningEffort(settings.reasoningEffort, settings.model);
}

export function ModelSwitcher({
  settings,
  onChange,
  disabled,
}: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fetchGen = useRef(0);

  const model = effectiveModel(settings);
  const tier = displayTier(settings);

  const loadModels = async (source: AppSettings) => {
    if (!source.apiKey.trim()) {
      setModelOptions([]);
      setError("请先在设置中填写 API Key");
      return;
    }
    const gen = ++fetchGen.current;
    setLoading(true);
    setError("");
    try {
      const models = await listModels(source);
      if (gen !== fetchGen.current) return;
      setModelOptions(models);
    } catch (err) {
      if (gen !== fetchGen.current) return;
      setModelOptions([]);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === fetchGen.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadModels(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const provider = getProvider();
  const choices = [
    ...new Set(
      modelOptions.length > 0
        ? [...modelOptions, model]
        : [model, provider.defaultModel, ...provider.models],
    ),
  ].filter(Boolean);
  const effortLevels = reasoningEffortsForModel(model);
  const showTiers = modelSupportsThinking(model);
  const tierValue = tierFromSettings(settings);

  const apply = (patch: Partial<AppSettings>) => {
    onChange({ ...settings, ...patch });
  };

  const setModel = (nextModel: string) => {
    const effort = normalizeReasoningEffort(settings.reasoningEffort, nextModel);
    apply({ model: nextModel, reasoningEffort: effort });
  };

  const setTier = (value: TierValue) => {
    if (value === "off") {
      apply({ thinkingMode: "disabled" });
      return;
    }
    apply({ thinkingMode: "enabled", reasoningEffort: value });
  };

  return (
    <>
      <button
        type="button"
        className="model-switcher-btn"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="切换模型 / 推理档位"
      >
        <span className="model-label">{model}</span>
        {tier ? <span className="tier-label"> · {tier}</span> : null}
      </button>

      {open ? (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div
            className="modal model-picker-modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-header">
              <h2>选择</h2>
              <button
                type="button"
                className="icon-btn"
                onClick={() => setOpen(false)}
              >
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="picker-section">
                <div className="picker-options">
                  {choices.map((m) => (
                    <button
                      key={m}
                      type="button"
                      className={
                        m === model ? "picker-option active" : "picker-option"
                      }
                      onClick={() => setModel(m)}
                    >
                      {m}
                    </button>
                  ))}
                </div>
                <div className="picker-actions">
                  <button
                    type="button"
                    className="secondary-btn"
                    disabled={loading}
                    onClick={() => void loadModels(settings)}
                  >
                    {loading ? "刷新中…" : "刷新列表"}
                  </button>
                </div>
                {error ? (
                  <p className="settings-hint">{error}</p>
                ) : modelOptions.length > 0 ? (
                  <p className="settings-hint">
                    共 {modelOptions.length} 个可用（来自 API）
                  </p>
                ) : null}
              </div>

              {showTiers ? (
                <div className="picker-section">
                  <div className="picker-options picker-tiers">
                    <button
                      type="button"
                      className={
                        tierValue === "off"
                          ? "picker-option active"
                          : "picker-option"
                      }
                      onClick={() => setTier("off")}
                    >
                      off
                    </button>
                    {effortLevels.map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={
                          tierValue === level
                            ? "picker-option active"
                            : "picker-option"
                        }
                        onClick={() => setTier(level)}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                  <p className="settings-hint">
                    {tierValue === "off"
                      ? "thinking 关闭"
                      : `reasoning_effort=${
                          effortLevels.includes(tierValue as ReasoningEffort)
                            ? tierValue
                            : defaultReasoningEffortForModel(model)
                        }`}
                  </p>
                </div>
              ) : null}
            </div>
            <div className="modal-footer">
              <button
                type="button"
                className="primary-btn"
                onClick={() => setOpen(false)}
              >
                完成
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
