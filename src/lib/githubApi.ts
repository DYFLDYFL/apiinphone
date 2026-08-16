import { httpJson } from "./nativeHttp";

const API = "https://api.github.com";

export class GithubError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

function describeError(status: number, fallback: string): string {
  if (status === 401) return "Token 无效或已过期，请检查后重填";
  if (status === 403)
    return "无权限：私人仓库需要带 repo 权限的 Token（或触发限流）";
  if (status === 404)
    return "仓库不存在，或 Token 无权访问该私人仓库（需 repo 权限）";
  if (status === 409) return "文件冲突（可能已被他人修改，请刷新后重试）";
  if (status === 422) return "提交被拒绝（内容或路径不合法）";
  return fallback;
}

/** 验证 Token 并返回其所属用户名（GET /user）。 */
export async function getUser(token: string): Promise<string> {
  const { status, data } = await httpJson<{ login?: string }>(
    `${API}/user`,
    { headers: authHeaders(token) },
  );
  if (status !== 200) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  return data.login ?? "";
}

export interface GithubRepoInfo {
  owner: string;
  repo: string;
  fullName: string;
  description: string;
  language: string | null;
  stars: number;
  defaultBranch: string;
  updatedAt: string;
}

export async function getRepo(
  token: string,
  owner: string,
  repo: string,
): Promise<GithubRepoInfo> {
  const { status, data } = await httpJson<{
    full_name?: string;
    description?: string | null;
    language?: string | null;
    stargazers_count?: number;
    default_branch?: string;
    updated_at?: string;
  }>(`${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, {
    headers: authHeaders(token),
  });
  if (status !== 200) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  return {
    owner,
    repo,
    fullName: data.full_name ?? `${owner}/${repo}`,
    description: data.description ?? "",
    language: data.language ?? null,
    stars: data.stargazers_count ?? 0,
    defaultBranch: data.default_branch ?? "main",
    updatedAt: data.updated_at ?? "",
  };
}

export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
  /** git blob sha（git tree API 返回），用于与本地内容对比。 */
  sha?: string;
}

export async function getFileTree(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<GithubTreeEntry[]> {
  const { status, data } = await httpJson<{
    tree?: Array<{
      path?: string;
      type?: string;
      size?: number;
      sha?: string;
    }>;
  }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers: authHeaders(token) },
    30000,
  );
  if (status !== 200) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  return (data.tree ?? [])
    .filter(
      (entry): entry is GithubTreeEntry & { path: string } =>
        Boolean(entry.path) && (entry.type === "blob" || entry.type === "tree"),
    )
    .map((entry) => ({
      path: entry.path,
      type: entry.type as "blob" | "tree",
      ...(entry.size !== undefined ? { size: entry.size } : {}),
      ...(entry.sha ? { sha: entry.sha } : {}),
    }));
}

export interface GithubFileContent {
  path: string;
  sha: string;
  content: string;
  size: number;
}

function base64ToUtf8(base64: string): string {
  try {
    const binary = atob(base64.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return "";
  }
}

export async function getFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  branch: string,
): Promise<GithubFileContent> {
  const { status, data } = await httpJson<{
    path?: string;
    sha?: string;
    content?: string;
    size?: number;
    encoding?: string;
  }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(
      branch,
    )}`,
    { headers: authHeaders(token) },
    30000,
  );
  if (status !== 200) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  const content =
    data.encoding === "base64" ? base64ToUtf8(data.content ?? "") : "";
  return {
    path: data.path ?? path,
    sha: data.sha ?? "",
    content,
    size: data.size ?? 0,
  };
}

export async function putFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  message: string,
  content: string,
  sha?: string,
): Promise<void> {
  const body: Record<string, unknown> = {
    message,
    content: btoa(unescape(encodeURIComponent(content))),
  };
  if (sha) body.sha = sha;
  const { status, data } = await httpJson<{ message?: string }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "PUT",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    30000,
  );
  if (status < 200 || status >= 300) {
    throw new GithubError(
      describeError(status, data.message ?? `GitHub HTTP ${status}`),
      status,
    );
  }
}

export async function deleteFileContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  message: string,
  sha: string,
): Promise<void> {
  const { status, data } = await httpJson<{ message?: string }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/contents/${path.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "DELETE",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ message, sha }),
    },
    30000,
  );
  if (status < 200 || status >= 300) {
    throw new GithubError(
      describeError(status, data.message ?? `GitHub HTTP ${status}`),
      status,
    );
  }
}

/* ===== git data API（批量 push 用） ===== */

export function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** git blob 的 SHA-1：sha1("blob <len>\0" + content)。 */
export async function gitBlobSha(content: string): Promise<string> {
  const data = new TextEncoder().encode(
    `blob ${content.length}\0${content}`,
  );
  const digest = await crypto.subtle.digest("SHA-1", data);
  return toHex(digest);
}

/** 分支指向的 HEAD commit sha。 */
export async function getRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ sha: string }> {
  const { status, data } = await httpJson<{ sha?: string; object?: { sha?: string } }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/git/ref/heads/${encodeURIComponent(branch)}`,
    { headers: authHeaders(token) },
    30000,
  );
  if (status !== 200) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  const sha = data.object?.sha ?? data.sha ?? "";
  if (!sha) throw new GithubError("无法获取分支引用", status);
  return { sha };
}

/** commit 对应的 tree sha。 */
export async function getCommitTreeSha(
  token: string,
  owner: string,
  repo: string,
  commitSha: string,
): Promise<string> {
  const { status, data } = await httpJson<{ tree?: { sha?: string } }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/git/commits/${encodeURIComponent(commitSha)}`,
    { headers: authHeaders(token) },
    30000,
  );
  if (status !== 200) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  const treeSha = data.tree?.sha ?? "";
  if (!treeSha) throw new GithubError("无法获取 commit 的 tree", status);
  return treeSha;
}

export async function createBlob(
  token: string,
  owner: string,
  repo: string,
  content: string,
): Promise<string> {
  const { status, data } = await httpJson<{ sha?: string }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/git/blobs`,
    {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ content: utf8ToBase64(content), encoding: "base64" }),
    },
    30000,
  );
  if (status !== 201) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  const sha = data.sha ?? "";
  if (!sha) throw new GithubError("创建 blob 失败", status);
  return sha;
}

export async function createTree(
  token: string,
  owner: string,
  repo: string,
  baseTreeSha: string,
  entries: Array<{ path: string; sha: string }>,
): Promise<string> {
  const { status, data } = await httpJson<{ sha?: string }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/git/trees`,
    {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({
        base_tree: baseTreeSha,
        tree: entries.map((entry) => ({
          path: entry.path,
          mode: "100644",
          type: "blob",
          sha: entry.sha,
        })),
      }),
    },
    30000,
  );
  if (status !== 201) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  const sha = data.sha ?? "";
  if (!sha) throw new GithubError("创建 tree 失败", status);
  return sha;
}

export async function createCommit(
  token: string,
  owner: string,
  repo: string,
  message: string,
  treeSha: string,
  parentSha: string,
): Promise<string> {
  const { status, data } = await httpJson<{ sha?: string }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/git/commits`,
    {
      method: "POST",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ message, tree: treeSha, parents: [parentSha] }),
    },
    30000,
  );
  if (status !== 201) {
    throw new GithubError(
      describeError(status, `GitHub HTTP ${status}`),
      status,
    );
  }
  const sha = data.sha ?? "";
  if (!sha) throw new GithubError("创建 commit 失败", status);
  return sha;
}

export async function updateRef(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  commitSha: string,
): Promise<void> {
  const { status, data } = await httpJson<{ message?: string }>(
    `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo,
    )}/git/refs/heads/${encodeURIComponent(branch)}`,
    {
      method: "PATCH",
      headers: { ...authHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ sha: commitSha, force: false }),
    },
    30000,
  );
  if (status < 200 || status >= 300) {
    throw new GithubError(
      describeError(status, data?.message ?? `GitHub HTTP ${status}`),
      status,
    );
  }
}

/**
 * 批量推送本地文件为一条 commit（blob → tree → commit → update-ref）。
 * files 为空时返回 null（无改动）。
 */
export async function pushFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  message: string,
  files: Array<{ path: string; content: string }>,
): Promise<string | null> {
  if (!files.length) return null;
  const head = await getRef(token, owner, repo, branch);
  const baseTree = await getCommitTreeSha(token, owner, repo, head.sha);
  const blobs: Array<{ path: string; sha: string }> = [];
  for (const file of files) {
    const blobSha = await createBlob(token, owner, repo, file.content);
    blobs.push({ path: file.path, sha: blobSha });
  }
  const treeSha = await createTree(token, owner, repo, baseTree, blobs);
  const commitSha = await createCommit(
    token,
    owner,
    repo,
    message,
    treeSha,
    head.sha,
  );
  await updateRef(token, owner, repo, branch, commitSha);
  return commitSha;
}

/** 拉取仓库 blob 文件清单（含解码后的内容），供写入本地。 */
export async function pullFiles(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<Array<{ path: string; content: string }>> {
  const tree = await getFileTree(token, owner, repo, branch);
  const blobs = tree.filter((entry) => entry.type === "blob");
  const files: Array<{ path: string; content: string }> = [];
  for (const entry of blobs) {
    const detail = await getFileContent(token, owner, repo, entry.path, branch);
    if (entry.size != null && entry.size > 0 && !detail.content) continue; // 二进制跳过
    files.push({ path: entry.path, content: detail.content });
  }
  return files;
}
