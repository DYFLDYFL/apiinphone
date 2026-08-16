import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../types";
import { listModels } from "../lib/apiClient";
import {
  getProvider,
  mergedModelPool,
  modelSupportsThinking,
  normalizeReasoningEffort,
  reasoningEffortsForModel,
  type ReasoningEffort,
} from "../lib/apiProviders";
import { effectiveGameModel, effectiveModel, effectiveWorkspaceModel, settingsForGame, settingsForWorkspace } from "../lib/settings";

type TierValue = "off" | ReasoningEffort;
export type ModelSwitcherScope = "chat" | "game" | "workspace";

interface ModelSwitcherProps {
  settings: AppSettings;
  onChange: (next: AppSettings) => void;
  disabled?: boolean;
  scope?: ModelSwitcherScope;
}

function activeModel(settings: AppSettings, scope: ModelSwitcherScope): string {
  if (scope === "game") return effectiveGameModel(settings);
  if (scope === "workspace") return effectiveWorkspaceModel(settings);
  return effectiveModel(settings);
}

function activeThinking(
  settings: AppSettings,
  scope: ModelSwitcherScope,
): "enabled" | "disabled" {
  if (scope === "game") {
    return settings.gameThinkingMode ?? settings.thinkingMode;
  }
  if (scope === "workspace") {
    return settings.workspaceThinkingMode ?? settings.thinkingMode;
  }
  return settings.thinkingMode;
}

function activeEffort(
  settings: AppSettings,
  scope: ModelSwitcherScope,
): ReasoningEffort {
  const model = activeModel(settings, scope);
  const effort =
    scope === "game"
      ? settings.gameReasoningEffort ?? settings.reasoningEffort
      : scope === "workspace"
        ? settings.workspaceReasoningEffort ?? settings.reasoningEffort
        : settings.reasoningEffort;
  return normalizeReasoningEffort(effort, model);
}

function tierFromSettings(
  settings: AppSettings,
  scope: ModelSwitcherScope,
): TierValue {
  if (activeThinking(settings, scope) === "disabled") return "off";
  return activeEffort(settings, scope);
}

export function ModelSwitcher({
  settings,
  onChange,
  disabled,
  scope = "chat",
}: ModelSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const fetchGen = useRef(0);
  const model = activeModel(settings, scope);
  const provider = getProvider(settings);
  const providers = settings.providers ?? [];
  const activeProvider = providers.find(
    (item) => item.id === settings.apiProvider,
  );

  const loadModels = async (source: AppSettings) => {
    const gen = ++fetchGen.current;
    setLoading(true);
    setError("");
    const snap =
      scope === "game"
        ? settingsForGame(source)
        : scope === "workspace"
          ? settingsForWorkspace(source)
          : source;
    const targets = (snap.providers ?? []).filter((p) => p.apiKey.trim());
    if (!targets.length) {
      if (gen === fetchGen.current) {
        setError("请先在设置中填写至少一个供应商的 API Key");
        setLoading(false);
      }
      return;
    }
    try {
      const results = await Promise.allSettled(
        targets.map((p) =>
          listModels({
            apiKey: p.apiKey,
            baseUrl: p.baseUrl,
            httpConnectTimeout: 15,
          } as AppSettings),
        ),
      );
      if (gen !== fetchGen.current) return;
      const updated = (snap.providers ?? []).map((p, index) => {
        const result = results[index];
        if (result.status === "fulfilled" && result.value.length) {
          return { ...p, models: result.value };
        }
        return p;
      });
      onChange({ ...snap, providers: updated });
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length) {
        const first = failures[0];
        setError(
          first.status === "rejected"
            ? `部分供应商识别失败：${first.reason instanceof Error ? first.reason.message : String(first.reason)}`
            : "",
        );
      }
    } catch (err) {
      if (gen !== fetchGen.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (gen === fetchGen.current) setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    void loadModels(settings);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scope]);

  const pool = mergedModelPool(settings);
  const choices = pool.length ? pool : [{ id: model, providerId: settings.apiProvider, providerLabel: provider.label }];
  const effortLevels = reasoningEffortsForModel(model);
  const showTiers = modelSupportsThinking(model);
  const tierValue = tierFromSettings(settings, scope);

  const apply = (patch: Partial<AppSettings>) => {
    onChange({ ...settings, ...patch });
  };

  const setModel = (nextModel: string, providerId?: string) => {
    const targetProvider = providerId
      ? providers.find((item) => item.id === providerId)
      : undefined;
    const target = targetProvider ?? activeProvider;
    if (!target) return;
    const effort = normalizeReasoningEffort(
      scope === "game"
        ? settings.gameReasoningEffort ?? settings.reasoningEffort
        : scope === "workspace"
          ? settings.workspaceReasoningEffort ?? settings.reasoningEffort
          : settings.reasoningEffort,
      nextModel,
    );
    if (scope === "game") {
      apply({ gameModel: nextModel, gameReasoningEffort: effort });
      return;
    }
    if (scope === "workspace") {
      apply({
        workspaceModel: nextModel,
        workspaceProviderId: target.id,
        workspaceReasoningEffort: effort,
      });
      return;
    }
    apply({
      apiProvider: target.id,
      apiKey: target.apiKey,
      baseUrl: target.baseUrl,
      model: nextModel,
      reasoningEffort: effort,
      providers: providers.map((item) =>
        item.id === target.id ? { ...item, model: nextModel } : item,
      ),
    });
  };

  const setTier = (value: TierValue) => {
    if (scope === "game") {
      apply(
        value === "off"
          ? { gameThinkingMode: "disabled" }
          : { gameThinkingMode: "enabled", gameReasoningEffort: value },
      );
      return;
    }
    if (scope === "workspace") {
      apply(
        value === "off"
          ? { workspaceThinkingMode: "disabled" }
          : { workspaceThinkingMode: "enabled", workspaceReasoningEffort: value },
      );
      return;
    }
    apply(
      value === "off"
        ? { thinkingMode: "disabled" }
        : { thinkingMode: "enabled", reasoningEffort: value },
    );
  };

  return (
    <>
      <button
        type="button"
        className="model-switcher-btn"
        disabled={disabled}
        onClick={() => setOpen(true)}
        title="切换供应商 / 模型 / 推理档位"
      >
        <span className="model-label">{model}</span>
        {showTiers && tierValue ? (
          <span className="tier-label"> · {tierValue}</span>
        ) : null}
      </button>
      {open ? (
        <div className="modal-backdrop" onClick={() => setOpen(false)}>
          <div className="modal model-picker-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {scope === "game"
                  ? "游戏模型"
                  : scope === "workspace"
                    ? "工作区模型"
                    : "选择模型"}
              </h2>
              <button type="button" className="icon-btn" onClick={() => setOpen(false)}>
                ✕
              </button>
            </div>
            <div className="modal-body">
              <div className="picker-section">
                <div className="picker-label">模型</div>
                <div className="picker-options">
                  {choices.map((choice) => (
                    <button
                      key={`${choice.providerId}:${choice.id}`}
                      type="button"
                      className={
                        choice.providerId === settings.apiProvider &&
                        choice.id === model
                          ? "picker-option active"
                          : "picker-option"
                      }
                      onClick={() => setModel(choice.id, choice.providerId)}
                    >
                      {choice.providerLabel} · {choice.id}
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
                {error ? <p className="settings-hint">{error}</p> : null}
              </div>
              {showTiers ? (
                <div className="picker-section">
                  <div className="picker-options picker-tiers">
                    <button
                      type="button"
                      className={tierValue === "off" ? "picker-option active" : "picker-option"}
                      onClick={() => setTier("off")}
                    >
                      off
                    </button>
                    {effortLevels.map((level) => (
                      <button
                        key={level}
                        type="button"
                        className={tierValue === level ? "picker-option active" : "picker-option"}
                        onClick={() => setTier(level)}
                      >
                        {level}
                      </button>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
            <div className="modal-footer">
              <button type="button" className="primary-btn" onClick={() => setOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
