export type GitHubConnection = {
  token: string
  repoFullName: string
  defaultBranch: string
}

export async function fetchGitHubJson<T>(
  token: string,
  path: string,
  options?: RequestInit
): Promise<T> {
  const url = path.startsWith('http') ? path : `https://api.github.com${path}`
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      'User-Agent': 'taskcenter/1.0',
      ...(options?.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`GitHub API error ${res.status}: ${body.slice(0, 200)}`)
  }
  return res.json() as Promise<T>
}

export async function postGitHubJson<T>(token: string, path: string, body: unknown): Promise<T> {
  return fetchGitHubJson<T>(token, path, {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function putGitHubJson<T>(token: string, path: string, body: unknown): Promise<T> {
  return fetchGitHubJson<T>(token, path, {
    method: 'PUT',
    body: JSON.stringify(body),
  })
}

export async function getDefaultBranch(token: string, repoFullName: string): Promise<string> {
  const repo = await fetchGitHubJson<{ default_branch: string }>(
    token,
    `/repos/${repoFullName}`
  )
  return repo.default_branch
}

export async function getRefSha(token: string, repoFullName: string, ref: string): Promise<string> {
  const data = await fetchGitHubJson<{ object: { sha: string } }>(
    token,
    `/repos/${repoFullName}/git/ref/heads/${ref}`
  )
  return data.object.sha
}

export async function createGitHubBranch(
  token: string,
  repoFullName: string,
  branchName: string,
  fromSha: string
): Promise<void> {
  await postGitHubJson(token, `/repos/${repoFullName}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: fromSha,
  })
}

export async function createOrUpdateGitHubFile(
  token: string,
  repoFullName: string,
  filePath: string,
  content: string,
  commitMessage: string,
  branch: string
): Promise<string> {
  // Check if file exists to get its SHA
  let existingSha: string | undefined
  try {
    const existing = await fetchGitHubJson<{ sha: string }>(
      token,
      `/repos/${repoFullName}/contents/${filePath}?ref=${branch}`
    )
    existingSha = existing.sha
  } catch {
    // file doesn't exist, create it
  }

  const body: Record<string, unknown> = {
    message: commitMessage,
    content: btoa(unescape(encodeURIComponent(content))),
    branch,
  }
  if (existingSha) body.sha = existingSha

  const result = await putGitHubJson<{ content: { sha: string } }>(
    token,
    `/repos/${repoFullName}/contents/${filePath}`,
    body
  )
  return result.content.sha
}

export async function createGitHubPullRequest(
  token: string,
  repoFullName: string,
  input: {
    title: string
    body: string
    head: string
    base: string
    draft?: boolean
  }
): Promise<{ number: number; html_url: string; node_id: string }> {
  return postGitHubJson(token, `/repos/${repoFullName}/pulls`, {
    title: input.title,
    body: input.body,
    head: input.head,
    base: input.base,
    draft: input.draft ?? false,
  })
}
