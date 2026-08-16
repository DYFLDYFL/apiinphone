import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../types";
import type { ChatMessage } from "../../types";
import {
  type WorkspaceAgent,
  type WorkspaceMeta,
  deleteWorkspaceAgent,
  listWorkspaceAgents,
  saveWorkspaceAgent,
  appendWorkspaceAgentHistory,
} from "../../lib/workspaceStore";
import { chatStream, createStreamControl } from "../../lib/apiClient";
import { normalizeReasoningEffort } from "../../lib/apiProviders";
import {
  buildWorkspaceToolDefs,
  buildWorkspaceToolHandlers,
} from "../../lib/workspaceTools";
import { ChatViewer, useChatViewerRef, viewerFromRef } from "../ChatViewer";
import { settingsForWorkspace } from "../../lib/settings";
import { confirmAsync } from "../../lib/uiDialogs";

interface WorkspaceChatProps {
  settings: AppSettings;
  workspace: WorkspaceMeta;
  onWorkspaceChanged: () => void;
}

function defaultAgent(index: number): WorkspaceAgent {
  return {
    id: `agent_${Date.now().toString(36)}${index}`,
    name: `助手 ${index + 1}`,
    persona:
      "你是本项目工作区的 AI 编程助手。用户会请你处理项目文件：先浏览目录（workspace_list）、读取相关文件（workspace_read），再修改（workspace_write）或删除（workspace_delete）。需要联网信息时用 web_search/web_fetch。修改文件前先读取确认内容。回答用中文。",
    providerId: "",
    model: "",
    tools: { read: true, write: true, github: true, search: true, python: true },
    history: [],
  };
}

export function WorkspaceChat({
  settings,
  workspace,
  onWorkspaceChanged,
}: WorkspaceChatProps) {
  const viewerRef = useChatViewerRef();
  const [agents, setAgents] = useState<WorkspaceAgent[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [status, setStatus] = useState("");
  const [viewerReady, setViewerReady] = useState(false);
  const controlRef = useRef<ReturnType<typeof createStreamControl> | null>(null);

  const active = agents.find((agent) => agent.id === activeId) ?? null;

  const refresh = async () => {
    const list = await listWorkspaceAgents(workspace.id);
    setAgents(list);
    if (list.length && !list.some((agent) => agent.id === activeId)) {
      setActiveId(list[0].id);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  useEffect(() => {
    if (!viewerReady) return;
    const viewer = viewerFromRef(viewerRef);
    viewer?.clearMessages?.();
    if (active) {
      for (const message of active.history) {
        if (message.role === "user") {
          const text = typeof message.content === "string" ? message.content : "";
          viewer?.appendMessage("user", text, { typing: false });
        } else if (message.role === "assistant") {
          const text = typeof message.content === "string" ? message.content : "";
          viewer?.appendMessage("assistant", text, { typing: false });
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, agents.length, viewerReady]);

  const addAgent = async () => {
    const agent = defaultAgent(agents.length);
    await saveWorkspaceAgent(workspace.id, agent);
    setActiveId(agent.id);
    onWorkspaceChanged();
    await refresh();
  };

  const removeAgent = async (id: string) => {
    if (!(await confirmAsync("删除该助手及其对话历史？"))) return;
    await deleteWorkspaceAgent(workspace.id, id);
    onWorkspaceChanged();
    await refresh();
  };

  const providerForAgent = (agent: WorkspaceAgent) => {
    const ws = settingsForWorkspace(settings);
    const provider = (settings.providers ?? []).find(
      (item) => item.id === (agent.providerId || ws.apiProvider),
    );
    return provider ?? (settings.providers ?? [])[0];
  };

  const stop = () => {
    controlRef.current?.cancel();
    setStreaming(false);
  };

  const send = async () => {
    const text = input.trim();
    if (!text || streaming || !active) return;
    const viewer = viewerFromRef(viewerRef);
    if (!viewer) return;
    const provider = providerForAgent(active);
    if (!provider || !provider.apiKey.trim()) {
      setStatus("该助手的供应商未配置 API Key，请先在设置中配置。");
      return;
    }
    const wsSettings = settingsForWorkspace(settings);
    const model =
      active.model ||
      provider.model ||
      wsSettings.model ||
      settings.model ||
      "";
    const agentSettings: AppSettings = {
      ...settings,
      apiProvider: provider.id,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl,
      model,
      systemPrompt: "",
      toolsEnabled: true,
      toolsWebSearch: active.tools.search,
      toolsPythonSandbox: active.tools.python,
      thinkingMode:
        active.thinkingMode ?? wsSettings.workspaceThinkingMode ?? settings.thinkingMode,
      reasoningEffort: normalizeReasoningEffort(
        active.reasoningEffort ??
          wsSettings.workspaceReasoningEffort ??
          settings.reasoningEffort,
        model,
      ),
    };
    const toolOptions = {
      workspaceId: workspace.id,
      repo: workspace.repo ?? null,
      githubToken: settings.githubToken.trim(),
      allowRead: active.tools.read,
      allowWrite: active.tools.write,
      allowGithub: active.tools.github,
    };
    const extraTools = buildWorkspaceToolDefs(toolOptions);
    const extraToolHandlers = buildWorkspaceToolHandlers(toolOptions);

    const systemPrompt = [
      active.persona?.trim() || defaultAgent(0).persona,
      "可用工具：workspace_list / workspace_read / workspace_write / workspace_delete 操作本项目文件；github_commit 提交到 GitHub（若已连接）；get_current_time / web_search / web_fetch / run_python / save_document 按配置可用。",
    ].join("\n\n");

    const userMessage: ChatMessage = { role: "user", content: text };
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      ...active.history,
      userMessage,
    ];

    setInput("");
    setStreaming(true);
    setStatus("");
    viewer.appendMessage("user", text, { typing: false });
    viewer.appendMessage("assistant", "", { typing: true });

    const control = createStreamControl();
    controlRef.current = control;

    let streamText = "";
    let reasoningBuffer = "";
    let viewerRaf = 0;
    const pushViewerStream = () => {
      viewer.updateLastAssistant(streamText, true, reasoningBuffer, false);
    };
    const scheduleViewerStream = () => {
      if (viewerRaf) return;
      viewerRaf = requestAnimationFrame(() => {
        viewerRaf = 0;
        pushViewerStream();
      });
    };

    try {
      const response = await chatStream(agentSettings, messages, {
        control,
        onStreamRoundStart: () => {
          streamText = "";
          scheduleViewerStream();
        },
        onDelta: (delta) => {
          streamText += delta;
          scheduleViewerStream();
        },
        onReasoningDelta: (delta) => {
          reasoningBuffer += delta;
          viewer.updateLastAssistant("", true, reasoningBuffer, true);
        },
        onToolStatus: (phase, _id, label) => {
          viewer.updateLastAssistantTools(
            [
              {
                status:
                  phase === "done" ? "done" : phase === "error" ? "error" : "running",
                label,
                name: label,
              },
            ],
            true,
          );
        },
        extraTools,
        extraToolHandlers,
      });
      if (viewerRaf) {
        cancelAnimationFrame(viewerRaf);
        viewerRaf = 0;
      }
      viewer.updateLastAssistant(response.content || "（无内容）", false, response.reasoning || reasoningBuffer, false);
      const newMessages: ChatMessage[] = [
        ...response.apiMessages,
        ...(response.apiMessages.some((m) => m.role === "assistant")
          ? []
          : [{ role: "assistant" as const, content: response.content }]),
      ];
      await appendWorkspaceAgentHistory(
        workspace.id,
        active.id,
        [userMessage, ...newMessages],
      );
      onWorkspaceChanged();
      await refresh();
    } catch (err) {
      viewer.showError?.(err instanceof Error ? err.message : String(err));
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      if (viewerRaf) {
        cancelAnimationFrame(viewerRaf);
        viewerRaf = 0;
      }
      setStreaming(false);
      controlRef.current = null;
    }
  };

  return (
    <div className="workspace-chat">
      <div className="workspace-agent-tabs">
        {agents.map((agent) => (
          <button
            type="button"
            key={agent.id}
            className={
              agent.id === activeId
                ? "workspace-agent-tab active"
                : "workspace-agent-tab"
            }
            onClick={() => setActiveId(agent.id)}
          >
            {agent.name}
          </button>
        ))}
        <button
          type="button"
          className="workspace-agent-tab add"
          onClick={() => void addAgent()}
        >
          ＋ 助手
        </button>
      </div>
      {active ? (
        <div className="workspace-agent-actions">
          <button
            type="button"
            className="link-btn game-map-delete-btn"
            onClick={() => void removeAgent(active.id)}
          >
            删除
          </button>
        </div>
      ) : null}
      <div className="workspace-chat-viewer">
        <ChatViewer
          ref={viewerRef}
          theme={settings.theme}
          onReady={() => setViewerReady(true)}
        />
      </div>
      {status ? (
        <p className="workspace-status" role="status">
          {status}
        </p>
      ) : null}
      <div className="workspace-chat-input">
        <textarea
          value={input}
          placeholder={`向 ${active?.name ?? "助手"} 描述要处理的任务…`}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          disabled={streaming}
        />
        {streaming ? (
          <button type="button" className="primary-btn" onClick={stop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="primary-btn"
            disabled={!input.trim() || !active}
            onClick={() => void send()}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}

