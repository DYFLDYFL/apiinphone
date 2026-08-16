import { useEffect, useRef, useState } from "react";
import type { AppSettings } from "../../types";
import { ModeSwitcher } from "../ModeSwitcher";
import type { AppMode } from "../ModeSwitcher";
import { ModelSwitcher } from "../ModelSwitcher";
import { settingsForWorkspace } from "../../lib/settings";
import { WorkspaceChat } from "./WorkspaceChat";
import {
  clearWorkspaceRepo,
  createWorkspace,
  createLocalFile,
  deleteLocalFile,
  deleteWorkspace,
  listLocalFiles,
  listWorkspaces,
  readLocalFile,
  renameWorkspace,
  setWorkspaceRepo,
  writeLocalFile,
  type LocalFileEntry,
  type WorkspaceMeta,
  type WorkspaceRepo,
} from "../../lib/workspaceStore";
import {
  deleteFileContent,
  getFileContent,
  getFileTree,
  getRepo,
  getUser,
  putFileContent,
  type GithubFileContent,
  type GithubTreeEntry,
} from "../../lib/githubApi";
import { confirmAsync } from "../../lib/uiDialogs";

interface WorkspaceScreenProps {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  onOpenSettings: () => void;
  onOpenInfo: () => void;
  theme: "light" | "dark";
  appMode?: AppMode;
  onSwitchMode?: (mode: AppMode) => void;
}
function WorkspaceHeader({
  title,
  subtitle,
  dirOpen,
  onToggleDir,
  onOpenSettings,
  onOpenInfo,
  appMode,
  onSwitchMode,
  settings,
  onSettingsChange,
}: {
  title: string;
  subtitle: string;
  dirOpen: boolean;
  onToggleDir: () => void;
  onOpenSettings: () => void;
  onOpenInfo: () => void;
  appMode?: AppMode;
  onSwitchMode?: (mode: AppMode) => void;
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
}) {
  return (
    <header className="game-topbar game-editor-header">
      <button
        type="button"
        className={dirOpen ? "icon-btn workspace-dir-btn active" : "icon-btn workspace-dir-btn"}
        onClick={onToggleDir}
        title="项目目录"
        aria-label="项目目录"
      >
        📁
      </button>
      <div className="game-topbar-title">
        <div className="workspace-title-row">
          <span>{title}</span>
          <ModelSwitcher
            scope="workspace"
            settings={settingsForWorkspace(settings)}
            onChange={(next) =>
              onSettingsChange({
                ...settings,
                workspaceModel: next.workspaceModel,
                workspaceProviderId: next.workspaceProviderId,
                workspaceThinkingMode: next.workspaceThinkingMode,
                workspaceReasoningEffort: next.workspaceReasoningEffort,
                providers: next.providers,
              })
            }
          />
        </div>
        <div className="game-subtitle">{subtitle}</div>
      </div>
      <div className="game-topbar-actions">
        {onSwitchMode && (
          <ModeSwitcher current={appMode ?? "workspace"} onSwitch={onSwitchMode} />
        )}
        <button type="button" className="icon-btn" onClick={onOpenInfo} title="用量">
          ℹ
        </button>
        <button
          type="button"
          className="icon-btn"
          onClick={onOpenSettings}
          title="设置"
        >
          ⚙
        </button>
      </div>
    </header>
  );
}

export function WorkspaceScreen({
  settings,
  onSettingsChange,
  theme,
  onOpenSettings,
  onOpenInfo,
  appMode,
  onSwitchMode,
}: WorkspaceScreenProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceMeta[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [newName, setNewName] = useState("");
  const [dirOpen, setDirOpen] = useState(false);
  const [showPanel, setShowPanel] = useState<"chat" | "files">("chat");

  const refresh = async () => {
    setWorkspaces(await listWorkspaces());
  };

  useEffect(() => {
    void refresh();
  }, []);

  const openWorkspace = workspaces.find((item) => item.id === openId) ?? null;

  const handleCreate = async () => {
    try {
      const created = await createWorkspace(newName);
      setNewName("");
      setNotice("");
      await refresh();
      setOpenId(created.id);
      setDirOpen(false);
    } catch (err) {
      setNotice(String(err));
    }
  };

  const handleRename = async (id: string, name: string) => {
    try {
      await renameWorkspace(id, name);
      setNotice("");
      await refresh();
    } catch (err) {
      setNotice(String(err));
    }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmAsync("删除工作区将清除其本地文件夹，确定？"))) return;
    await deleteWorkspace(id);
    if (openId === id) setOpenId(null);
    await refresh();
  };

  const subtitle = openWorkspace
    ? openWorkspace.repo
      ? `已连接 ${openWorkspace.repo.owner}/${openWorkspace.repo.repo}（${openWorkspace.repo.branch}）`
      : "未连接 GitHub 仓库"
    : "固定目录 Documents/Workspaces 下的多个工作区文件夹";

  return (
    <div className="game-screen">
      <WorkspaceHeader
        title={openWorkspace?.name ?? "项目工作区"}
        subtitle={subtitle}
        dirOpen={dirOpen}
        onToggleDir={() => setDirOpen((v) => !v)}
        onOpenSettings={onOpenSettings}
        onOpenInfo={onOpenInfo}
        appMode={appMode}
        onSwitchMode={onSwitchMode}
        settings={settings}
        onSettingsChange={onSettingsChange}
      />

      {dirOpen ? (
        <div className="drawer-backdrop" onClick={() => setDirOpen(false)}>
          <aside
            className="workspace-dir-drawer"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="drawer-header">
              <strong>项目目录</strong>
            </div>
            <div className="workspace-dir-create">
              <input
                value={newName}
                placeholder="新工作区名称"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleCreate();
                  }
                }}
              />
              <button
                type="button"
                className="primary-btn"
                disabled={!newName.trim()}
                onClick={() => void handleCreate()}
              >
                创建
              </button>
            </div>
            {notice ? (
              <p className="workspace-dir-notice" role="status">
                {notice}
              </p>
            ) : null}
            <div className="workspace-dir-list">
              {workspaces.length ? (
                workspaces.map((workspace) => (
                  <WorkspaceCard
                    key={workspace.id}
                    workspace={workspace}
                    active={workspace.id === openId}
                    onOpen={() => {
                      setOpenId(workspace.id);
                      setDirOpen(false);
                    }}
                    onRename={(name) => void handleRename(workspace.id, name)}
                    onDelete={() => void handleDelete(workspace.id)}
                  />
                ))
              ) : (
                <p className="game-map-no-selection">
                  还没有工作区，先在上面创建一个。
                </p>
              )}
            </div>
            <div className="workspace-panel-tabs workspace-dir-switch">
              <button
                type="button"
                className={
                  showPanel === "chat"
                    ? "workspace-panel-tab active"
                    : "workspace-panel-tab"
                }
                onClick={() => setShowPanel("chat")}
              >
                对话助手
              </button>
              <button
                type="button"
                className={
                  showPanel === "files"
                    ? "workspace-panel-tab active"
                    : "workspace-panel-tab"
                }
                onClick={() => setShowPanel("files")}
              >
                项目文件
              </button>
            </div>
          </aside>
        </div>
      ) : null}

      <div className="workspace-main">
        {!openWorkspace ? (
          <p className="game-map-no-selection workspace-main-empty">
            还没有选择工作区，点左上角「项目目录」选择或新建。
          </p>
        ) : (
          <WorkspaceMain
            key={openWorkspace.id}
            settings={settings}
            onSettingsChange={onSettingsChange}
            workspace={openWorkspace}
            theme={theme}
            showPanel={showPanel}
            onWorkspaceChanged={() => void refresh()}
          />
        )}
      </div>
    </div>
  );
}

function WorkspaceCard({
  workspace,
  active,
  onOpen,
  onRename,
  onDelete,
}: {
  workspace: WorkspaceMeta;
  active?: boolean;
  onOpen: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(workspace.name);
  return (
    <div className={active ? "workspace-card active" : "workspace-card"}>
      <button type="button" className="workspace-card-main" onClick={onOpen}>
        <strong>{workspace.name}</strong>
        <span>
          {workspace.repo
            ? `${workspace.repo.owner}/${workspace.repo.repo}（${workspace.repo.branch}）`
            : "未连接 GitHub 仓库"}
        </span>
      </button>
      {renaming ? (
        <input
          className="workspace-rename-input"
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              onRename(name);
              setRenaming(false);
            }
          }}
          onBlur={() => {
            onRename(name);
            setRenaming(false);
          }}
        />
      ) : (
        <div className="workspace-card-actions">
          <button
            type="button"
            className="link-btn"
            onClick={() => {
              setName(workspace.name);
              setRenaming(true);
            }}
          >
            重命名
          </button>
          <button
            type="button"
            className="link-btn game-map-delete-btn"
            onClick={onDelete}
          >
            删除
          </button>
        </div>
      )}
    </div>
  );
}

function WorkspaceMain({
  settings,
  onSettingsChange,
  workspace,
  theme,
  showPanel,
  onWorkspaceChanged,
}: {
  settings: AppSettings;
  onSettingsChange: (settings: AppSettings) => void;
  workspace: WorkspaceMeta;
  theme: "light" | "dark";
  showPanel: "chat" | "files";
  onWorkspaceChanged: () => void;
}) {
  const [tree, setTree] = useState<GithubTreeEntry[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [file, setFile] = useState<GithubFileContent | null>(null);
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const [commitMsg, setCommitMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [repoLoading, setRepoLoading] = useState(false);
  const [repoError, setRepoError] = useState("");
  const treeReqRef = useRef(0);
  const [connectOwner, setConnectOwner] = useState(
    workspace.repo?.owner ?? "",
  );
  const [connectRepo, setConnectRepo] = useState(workspace.repo?.repo ?? "");
  const [connectBranch, setConnectBranch] = useState(
    workspace.repo?.branch ?? "",
  );
  const [localListing, setLocalListing] = useState<
    Record<string, LocalFileEntry[]>
  >({});
  const [localExpanded, setLocalExpanded] = useState<Set<string>>(
    new Set([""]),
  );
  const [newLocalFile, setNewLocalFile] = useState("");
  const [fileSource, setFileSource] = useState<"local" | "repo">("local");

  const token = settings.githubToken.trim();
  const repo = workspace.repo;

  const notify = (text: string) => setStatus(text);

  const loadLocalDir = async (dir: string) => {
    const entries = await listLocalFiles(workspace.id, dir);
    setLocalListing((prev) => ({ ...prev, [dir]: entries }));
  };

  /** 工作区内容变化（AI 工具写文件等）后：刷新列表 + 重载本地根目录。 */
  const handleWorkspaceChanged = () => {
    onWorkspaceChanged();
    void loadLocalDir("");
  };

  useEffect(() => {
    void loadLocalDir("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace.id]);

  const connect = async () => {
    const owner = connectOwner.trim();
    const name = connectRepo.trim();
    if (!token) {
      notify("请先填写 GitHub Token");
      return;
    }
    if (!owner || !name) {
      notify("请填写仓库所属者和仓库名");
      return;
    }
    setBusy(true);
    try {
      notify("正在验证 Token…");
      const login = await getUser(token);
      notify("正在获取仓库信息…");
      const info = await getRepo(token, owner, name);
      const branch = connectBranch.trim() || info.defaultBranch;
      await setWorkspaceRepo(workspace.id, { owner, repo: name, branch });
      onWorkspaceChanged();
      setConnectBranch(branch);
      setTree([]);
      setExpanded(new Set());
      notify(`已连接仓库（Token 用户：${login || "未知"}）`);
      if (fileSource === "repo") {
        void loadRepoTree({ owner, repo: name, branch });
      }
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    await clearWorkspaceRepo(workspace.id);
    onWorkspaceChanged();
    setTree([]);
    setSelectedPath(null);
    setFile(null);
    setEditing(false);
    setFileSource("local");
    setLocalExpanded(new Set([""]));
    await loadLocalDir("");
    notify("已断开仓库，回到本地浏览");
  };

  /** 按需加载仓库文件树：连接成功后不阻塞，进入仓库文件视图或点重试时加载。 */
  const loadRepoTree = async (target?: WorkspaceRepo) => {
    const targetRepo = target ?? repo;
    if (!token || !targetRepo) return;
    const req = ++treeReqRef.current;
    setRepoLoading(true);
    setRepoError("");
    try {
      const entries = await getFileTree(
        token,
        targetRepo.owner,
        targetRepo.repo,
        targetRepo.branch,
      );
      if (req !== treeReqRef.current) return;
      setTree(entries);
      setExpanded(new Set([""]));
    } catch (err) {
      if (req !== treeReqRef.current) return;
      setRepoError(err instanceof Error ? err.message : String(err));
      setTree([]);
    } finally {
      if (req === treeReqRef.current) setRepoLoading(false);
    }
  };

  useEffect(() => {
    if (fileSource === "repo" && repo && !tree.length && !repoLoading) {
      void loadRepoTree();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileSource, workspace.id]);

  const openFile = async (path: string) => {
    if (!token || !repo) return;
    setBusy(true);
    try {
      const content = await getFileContent(
        token,
        repo.owner,
        repo.repo,
        path,
        repo.branch,
      );
      setFile(content);
      setSelectedPath(path);
      setEditing(false);
      setEditText(content.content);
      setStatus("");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const saveFile = async () => {
    if (!token || !repo || !selectedPath) return;
    setBusy(true);
    try {
      await putFileContent(
        token,
        repo.owner,
        repo.repo,
        selectedPath,
        commitMsg.trim() || `Update ${selectedPath}`,
        editText,
        file?.sha,
      );
      notify("已提交到仓库");
      setCommitMsg("");
      await openFile(selectedPath);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeFile = async () => {
    if (!token || !repo || !selectedPath || !file) return;
    if (!(await confirmAsync(`删除仓库中的 ${selectedPath}？`))) return;
    setBusy(true);
    try {
      await deleteFileContent(
        token,
        repo.owner,
        repo.repo,
        selectedPath,
        `Delete ${selectedPath}`,
        file.sha,
      );
      setFile(null);
      setSelectedPath(null);
      setEditing(false);
      notify("已删除");
      await loadRepoTree();
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const openLocalFile = async (path: string) => {
    setBusy(true);
    try {
      const content = await readLocalFile(workspace.id, path);
      setFile({
        path,
        sha: "",
        content: content ?? "",
        size: 0,
      });
      setSelectedPath(path);
      setEditing(false);
      setEditText(content ?? "");
      setStatus("");
    } finally {
      setBusy(false);
    }
  };

  const saveLocalFile = async () => {
    if (!selectedPath) return;
    setBusy(true);
    try {
      await writeLocalFile(workspace.id, selectedPath, editText);
      notify("已保存到本地文件夹");
      await openLocalFile(selectedPath);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const createLocal = async () => {
    const path = newLocalFile.trim().replace(/^\/+/, "");
    if (!path) {
      notify("请输入文件路径（可用 / 指定子目录）");
      return;
    }
    setBusy(true);
    try {
      await createLocalFile(workspace.id, path);
      setNewLocalFile("");
      notify("已创建文件");
      const parts = path.split("/");
      parts.pop();
      const dir = parts.join("/");
      if (dir) {
        setLocalExpanded((prev) => new Set([...prev, dir]));
        await loadLocalDir(dir);
      }
      await loadLocalDir(dir);
      await openLocalFile(path);
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const removeLocalFile = async () => {
    if (!selectedPath) return;
    if (!(await confirmAsync(`删除本地文件 ${selectedPath}？`))) return;
    setBusy(true);
    try {
      await deleteLocalFile(workspace.id, selectedPath);
      setFile(null);
      setSelectedPath(null);
      setEditing(false);
      notify("已删除");
      const parts = selectedPath.split("/");
      parts.pop();
      await loadLocalDir(parts.join("/"));
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const toggleLocalDir = async (dir: string) => {
    setLocalExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(dir)) next.delete(dir);
      else next.add(dir);
      return next;
    });
    if (!localListing[dir]) await loadLocalDir(dir);
  };

  const localChildrenOf = (dir: string): LocalFileEntry[] =>
    localListing[dir] ?? [];
  const repoChildrenOf = (dir: string): GithubTreeEntry[] => {
    const prefix = dir ? `${dir}/` : "";
    const direct = tree.filter((entry) => {
      if (!entry.path.startsWith(prefix)) return false;
      const rest = entry.path.slice(prefix.length);
      return rest.length > 0 && !rest.includes("/");
    });
    return direct.sort((a, b) =>
      a.type === b.type
        ? a.path.localeCompare(b.path)
        : a.type === "tree"
          ? -1
          : 1,
    );
  };

  return (
    <>
      {status ? (
        <div className="workspace-status" role="status">
          {status}
        </div>
      ) : null}

      {showPanel === "chat" ? (
        <WorkspaceChat
          settings={settings}
          workspace={workspace}
          onWorkspaceChanged={handleWorkspaceChanged}
        />
      ) : (
        <>
          <div className="workspace-panel-tabs workspace-file-subtabs">
            <button
              type="button"
              className={
                fileSource === "local"
                  ? "workspace-panel-tab active"
                  : "workspace-panel-tab"
              }
              onClick={() => setFileSource("local")}
            >
              本地文件
            </button>
            <button
              type="button"
              className={
                fileSource === "repo"
                  ? "workspace-panel-tab active"
                  : "workspace-panel-tab"
              }
              onClick={() => setFileSource("repo")}
            >
              仓库文件
            </button>
            {repo ? (
              <div className="workspace-repo-capsule">
                <span>
                  已连接 <strong>{repo.owner}/{repo.repo}</strong>
                </span>
                <button
                  type="button"
                  className="link-btn game-map-delete-btn"
                  onClick={() => void disconnect()}
                >
                  断开
                </button>
              </div>
            ) : null}
          </div>
          {fileSource === "repo" && repo ? (
          <section className="game-editor-section game-card workspace-repo-files">
            <div className="game-section-title">
              <h3>仓库文件</h3>
              <span>
                {tree.length} 个文件 · 目录可展开
              </span>
            </div>
            <div className="workspace-file-browser">
              <div className="workspace-tree">
                {repoLoading ? (
                  <p className="game-map-no-selection">正在加载文件列表…</p>
                ) : repoError ? (
                  <div className="workspace-repo-error">
                    <p className="game-map-no-selection">{repoError}</p>
                    <button
                      type="button"
                      className="secondary-btn"
                      onClick={() => void loadRepoTree()}
                    >
                      重试
                    </button>
                  </div>
                ) : repoChildrenOf("").length ? (
                  <RepoTreeNodes
                    dir=""
                    depth={0}
                    expanded={expanded}
                    childrenOf={repoChildrenOf}
                    selectedPath={selectedPath}
                    onToggleDir={(path) =>
                      setExpanded((prev) => {
                        const next = new Set(prev);
                        if (next.has(path)) next.delete(path);
                        else next.add(path);
                        return next;
                      })
                    }
                    onOpenFile={(path) => void openFile(path)}
                  />
                ) : (
                  <p className="game-map-no-selection">暂无文件</p>
                )}
              </div>
              <div className="workspace-file-panel">
                {!selectedPath || !file ? (
                  <p className="game-map-no-selection">
                    点击左侧文件查看内容
                  </p>
                ) : editing ? (
                  <div className="workspace-editor">
                    <div className="workspace-editor-head">
                      <strong>{selectedPath}</strong>
                      <div className="workspace-editor-actions">
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={busy}
                          onClick={() => void saveFile()}
                        >
                          保存提交
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => {
                            setEditing(false);
                            setEditText(file.content);
                          }}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                    <input
                      value={commitMsg}
                      placeholder={`提交信息（默认 Update ${selectedPath}）`}
                      onChange={(e) => setCommitMsg(e.target.value)}
                    />
                    <textarea
                      className="workspace-editor-textarea"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  <div className="workspace-file-view">
                    <div className="workspace-editor-head">
                      <strong>{selectedPath}</strong>
                      <div className="workspace-editor-actions">
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => {
                            setEditText(file.content);
                            setEditing(true);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="link-btn game-map-delete-btn"
                          onClick={() => void removeFile()}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    {/\.(md|markdown)$/i.test(selectedPath) ? (
                      <MarkdownPreview content={file.content} theme={theme} />
                    ) : (
                      <pre className="workspace-file-pre">
                        {file.content || "（空文件）"}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
          ) : fileSource === "repo" ? (
          <section className="game-editor-section game-card workspace-repo-connect">
            <div className="game-section-title">
              <h3>GitHub 仓库</h3>
              <span>未连接</span>
            </div>
            <div className="workspace-connect-block">
              <div className="workspace-connect-form">
                <input
                  type="password"
                  value={settings.githubToken}
                  placeholder="GitHub Token（ghp_…）"
                  onChange={(e) =>
                    onSettingsChange({ ...settings, githubToken: e.target.value })
                  }
                />
                <input
                  value={connectOwner}
                  placeholder="所属者 owner"
                  onChange={(e) => setConnectOwner(e.target.value)}
                />
                <input
                  value={connectRepo}
                  placeholder="仓库名 repo"
                  onChange={(e) => setConnectRepo(e.target.value)}
                />
                <input
                  value={connectBranch}
                  placeholder="分支（留空用默认）"
                  onChange={(e) => setConnectBranch(e.target.value)}
                />
                <button
                  type="button"
                  className="primary-btn"
                  disabled={busy}
                  onClick={() => void connect()}
                >
                  {busy ? "连接中…" : "连接"}
                </button>
              </div>
              <p className="workspace-connect-hint">
                Token 需有仓库 Contents 读写权限。
              </p>
            </div>
          </section>
          ) : (
          <section className="game-editor-section game-card workspace-repo-files">
            <div className="game-section-title">
              <h3>本地文件</h3>
              <span>{localListing[""]?.length ?? 0} 个文件 · 目录可展开</span>
            </div>
            <div className="workspace-create-row">
              <input
                value={newLocalFile}
                placeholder="新建文件路径（如 notes.md 或 src/a.ts）"
                onChange={(e) => setNewLocalFile(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void createLocal();
                  }
                }}
              />
              <button
                type="button"
                className="secondary-btn"
                disabled={busy || !newLocalFile.trim()}
                onClick={() => void createLocal()}
              >
                新建
              </button>
            </div>
            <div className="workspace-file-browser">
              <div className="workspace-tree">
                {localChildrenOf("").length ? (
                  <LocalTreeNodes
                    dir=""
                    depth={0}
                    expanded={localExpanded}
                    childrenOf={localChildrenOf}
                    selectedPath={selectedPath}
                    onToggleDir={(path) => void toggleLocalDir(path)}
                    onOpenFile={(path) => void openLocalFile(path)}
                  />
                ) : (
                  <p className="game-map-no-selection">文件夹为空</p>
                )}
              </div>
              <div className="workspace-file-panel">
                {!selectedPath ? (
                  <p className="game-map-no-selection">
                    点击左侧文件查看内容
                  </p>
                ) : editing ? (
                  <div className="workspace-editor">
                    <div className="workspace-editor-head">
                      <strong>{selectedPath}</strong>
                      <div className="workspace-editor-actions">
                        <button
                          type="button"
                          className="secondary-btn"
                          disabled={busy}
                          onClick={() => void saveLocalFile()}
                        >
                          保存
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => {
                            setEditing(false);
                            setEditText(file?.content ?? "");
                          }}
                        >
                          取消
                        </button>
                      </div>
                    </div>
                    <textarea
                      className="workspace-editor-textarea"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  <div className="workspace-file-view">
                    <div className="workspace-editor-head">
                      <strong>{selectedPath}</strong>
                      <div className="workspace-editor-actions">
                        <button
                          type="button"
                          className="secondary-btn"
                          onClick={() => {
                            setEditText(file?.content ?? "");
                            setEditing(true);
                          }}
                        >
                          编辑
                        </button>
                        <button
                          type="button"
                          className="link-btn game-map-delete-btn"
                          onClick={() => void removeLocalFile()}
                        >
                          删除
                        </button>
                      </div>
                    </div>
                    {/\.(md|markdown)$/i.test(selectedPath) ? (
                      <MarkdownPreview
                        content={file?.content ?? ""}
                        theme={theme}
                      />
                    ) : (
                      <pre className="workspace-file-pre">
                        {file?.content || "（空文件）"}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            </div>
          </section>
          )}
        </>
      )}
    </>
  );
}

export default WorkspaceScreen;

function MarkdownPreview({
  content,
  theme,
}: {
  content: string;
  theme: "light" | "dark";
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || !loaded) return;
    const win = iframe.contentWindow as
      | (Window & {
          renderMarkdown?: (text: string) => HTMLElement;
          setTheme?: (theme: string) => void;
        })
      | null;
    if (!win?.renderMarkdown) return;
    win.setTheme?.(theme);
    const wrapper = win.renderMarkdown(content);
    const messages = iframe.contentDocument?.getElementById("messages");
    if (messages) {
      messages.innerHTML = "";
      messages.appendChild(wrapper);
    }
  }, [content, loaded, theme]);

  return (
    <iframe
      ref={iframeRef}
      title="markdown-preview"
      src="./viewer.html"
      className="workspace-md-preview"
      onLoad={() => setLoaded(true)}
    />
  );
}

function LocalTreeNodes({
  dir,
  depth,
  expanded,
  childrenOf,
  selectedPath,
  onToggleDir,
  onOpenFile,
}: {
  dir: string;
  depth: number;
  expanded: Set<string>;
  childrenOf: (dir: string) => LocalFileEntry[];
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const entries = childrenOf(dir);
  const folders = entries.filter((entry) => entry.type === "directory");
  const files = entries.filter((entry) => entry.type === "file");
  return (
    <>
      {folders.map((entry) => {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        const open = expanded.has(path);
        return (
          <div key={path} className="workspace-tree-node">
            <button
              type="button"
              className="workspace-tree-dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onToggleDir(path)}
            >
              {open ? "▾" : "▸"} {entry.name}
            </button>
            {open ? (
              <LocalTreeNodes
                dir={path}
                depth={depth + 1}
                expanded={expanded}
                childrenOf={childrenOf}
                selectedPath={selectedPath}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ) : null}
          </div>
        );
      })}
      {files.map((entry) => {
        const path = dir ? `${dir}/${entry.name}` : entry.name;
        return (
          <button
            type="button"
            key={path}
            className={
              selectedPath === path
                ? "workspace-tree-file selected"
                : "workspace-tree-file"
            }
            style={{ paddingLeft: 8 + (depth + 1) * 14 }}
            onClick={() => onOpenFile(path)}
          >
            {entry.name}
          </button>
        );
      })}
    </>
  );
}

function RepoTreeNodes({
  dir,
  depth,
  expanded,
  childrenOf,
  selectedPath,
  onToggleDir,
  onOpenFile,
}: {
  dir: string;
  depth: number;
  expanded: Set<string>;
  childrenOf: (dir: string) => GithubTreeEntry[];
  selectedPath: string | null;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
}) {
  const entries = childrenOf(dir);
  const folders = entries.filter((entry) => entry.type === "tree");
  const files = entries.filter((entry) => entry.type === "blob");
  return (
    <>
      {folders.map((entry) => {
        const open = expanded.has(entry.path);
        const name = entry.path.split("/").pop() ?? entry.path;
        return (
          <div key={entry.path} className="workspace-tree-node">
            <button
              type="button"
              className="workspace-tree-dir"
              style={{ paddingLeft: 8 + depth * 14 }}
              onClick={() => onToggleDir(entry.path)}
            >
              {open ? "▾" : "▸"} {name}
            </button>
            {open ? (
              <RepoTreeNodes
                dir={entry.path}
                depth={depth + 1}
                expanded={expanded}
                childrenOf={childrenOf}
                selectedPath={selectedPath}
                onToggleDir={onToggleDir}
                onOpenFile={onOpenFile}
              />
            ) : null}
          </div>
        );
      })}
      {files.map((entry) => (
        <button
          type="button"
          key={entry.path}
          className={
            selectedPath === entry.path
              ? "workspace-tree-file selected"
              : "workspace-tree-file"
          }
          style={{ paddingLeft: 8 + (depth + 1) * 14 }}
          onClick={() => onOpenFile(entry.path)}
        >
          {entry.path.split("/").pop() ?? entry.path}
        </button>
      ))}
    </>
  );
}
