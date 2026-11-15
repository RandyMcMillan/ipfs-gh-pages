// GitHub <-> IPFS issues bridge. GitHub issue threads map 1:1 onto the
// app's native signed notes (docs/issues-car.md): an issue is a note,
// comments are notes whose parent is the issue (or the previous comment —
// a linear chain, exactly like git commits). GitHub metadata rides inside
// the signed envelope so the link is verifiable and immutable:
//
//   issue note:  { ns:'issues', type:'issue', title, body, github:{owner,repo,number,id,url,user}, timestamp }
//   comment:     { ns:'issues', type:'comment', parent:<cid>, body, github:{id,url,user}, timestamp }
//
// The index tip then propagates through the EXISTING git-notes bridge
// (.githooks pre-push writes refs/notes/<owner>/<repo>/index), so any clone
// or fork of the repo carries the interop state — readable with plain
// `git notes`. isomorphic-git (js/git-smart.js) can read the same refs
// in-browser for the pull-side adoption.
//
// Pure + injectable (fetchImpl/signNote) for unit tests; the network only
// happens through the injectable helpers.

// https://github.com/o/r/issues/123 | /pull/ handled too (issues are pull comments).
export function parseIssueUrl(raw) {
  const m = String(raw || '').match(/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], number: parseInt(m[3], 10) } : null;
}

// GitHub issue/comment JSON -> note fields (before signing).
export function mapGithubIssue(issue) {
  return {
    title: issue.title || '',
    body: issue.body || '',
    github: {
      owner: issue.repository?.owner?.login || issue.owner || '',
      repo: issue.repository?.name || issue.repo || '',
      number: issue.number,
      id: issue.id,
      url: issue.html_url || '',
      user: issue.user?.login || '',
      pull_request: issue.pull_request ? { url: issue.pull_request.url || '' } : null
    }
  };
}

export function mapGithubComment(comment) {
  return {
    body: comment.body || '',
    github: {
      id: comment.id,
      url: comment.html_url || '',
      user: comment.user?.login || '',
      createdAt: comment.created_at || ''
    }
  };
}

// Bidirectional diff by GitHub's immutable comment id. Local notes carry
// github.id in their envelope; remote come from the API. Returns what to
// append on each side — nothing is ever mutated, only chained.
export function diffComments(localEnvelopes, remoteComments) {
  const localIds = new Set(
    localEnvelopes
      .map((e) => (e.signed?.github?.id ?? e.github?.id))
      .filter(Boolean)
  );
  const remoteIds = new Set(remoteComments.map((c) => c.id));
  return {
    missingLocally: remoteComments.filter((c) => !localIds.has(c.id)),
    missingOnGithub: localEnvelopes.filter((e) => {
      const id = e.signed?.github?.id ?? e.github?.id;
      return id && !remoteIds.has(id);
    })
  };
}

const GH = (owner, repo, path) => `https://api.github.com/repos/${owner}/${repo}${path}`;
const headers = (token) => ({
  accept: 'application/vnd.github+json',
  'user-agent': 'ipfs-gh-pages-issues-bridge',
  ...(token ? { authorization: `Bearer ${token}` } : {})
});

// Fetch a full thread. Token optional (read); unauthenticated is 60 req/h.
export async function fetchGithubThread(owner, repo, number, { token = '', fetchImpl = fetch } = {}) {
  const [issueRes, commentsRes] = await Promise.all([
    fetchImpl(GH(owner, repo, `/issues/${number}`), { headers: headers(token) }),
    fetchImpl(GH(owner, repo, `/issues/${number}/comments?per_page=100`), { headers: headers(token) })
  ]);
  if (!issueRes.ok) throw new Error(`GitHub issue fetch HTTP ${issueRes.status}`);
  const issue = await issueRes.json();
  const comments = commentsRes.ok ? await commentsRes.json() : [];
  return { issue, comments: Array.isArray(comments) ? comments : [] };
}

// Post a comment back to GitHub (write — always needs a token). Token is
// the USER'S PAT from localStorage (same pattern as the rehost endpoint);
// it is never logged, never included in error text beyond the status.
export async function postGithubComment(owner, repo, number, body, { token, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('GitHub token not configured');
  const res = await fetchImpl(GH(owner, repo, `/issues/${number}/comments`), {
    method: 'POST',
    headers: { ...headers(token), 'content-type': 'application/json' },
    body: JSON.stringify({ body })
  });
  if (!res.ok) {
    const snippet = (await res.text()).slice(0, 200);
    throw new Error(`GitHub comment HTTP ${res.status}${snippet ? `: ${snippet}` : ''}`);
  }
  return res.json();
}

// List a repo's open GitHub issues — the app knows repoFullName, so the
// bridge LISTS instead of asking the user to paste URLs. Token optional
// (authenticated raises the ceiling; unauthenticated still works).
export async function listGithubIssues(owner, repo, { token = '', state = 'open', fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=30`, { headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub issues list HTTP ${res.status}`);
  const json = await res.json();
  return (Array.isArray(json) ? json : []).filter((i) => !i.pull_request);
}

// Repo contributors (About sidebar). Token raises the ceiling but the call
// works unauthenticated too — same pattern as everything else.
export async function fetchContributors(owner, repo, { token = '', fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=10`, { headers: headers(token) });
  if (!res.ok) throw new Error(`contributors HTTP ${res.status}`);
  const json = await res.json();
  return (Array.isArray(json) ? json : []).map((c) => ({ login: c.login, avatar: c.avatar_url || '', contributions: c.contributions, url: c.html_url || '' }));
}

// Pull requests ARE issues on GitHub's side (same object, plus a
// pull_request key) — same endpoint, opposite filter.
export async function listGithubPRs(owner, repo, { token = '', state = 'open', fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues?state=${state}&per_page=30`, { headers: headers(token) });
  if (!res.ok) throw new Error(`GitHub PR list HTTP ${res.status}`);
  const json = await res.json();
  return (Array.isArray(json) ? json : []).filter((i) => i.pull_request);
}

// GitHub milestones - the REST-accessible "project" surface. Each milestone
// carries its open issues; one click imports a milestone's issue thread.
export async function fetchMilestones(owner, repo, { token = '', fetchImpl = fetch } = {}) {
  const [ms, issues] = await Promise.all([
    fetchImpl(`https://api.github.com/repos/${owner}/${repo}/milestones?state=open&per_page=20`, { headers: headers(token) }),
    fetchImpl(`https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=100`, { headers: headers(token) })
  ]);
  if (!ms.ok) throw new Error(`milestones HTTP ${ms.status}`);
  const milestones = Array.isArray(await ms.json()) ? await (async () => { const r = ms; return r.json(); })() : [];
  const issueList = issues.ok ? (await issues.json()) : [];
  return milestones.map((m) => ({
    number: m.number, title: m.title, description: m.description || '',
    openIssues: (Array.isArray(issueList) ? issueList : []).filter((i) => i.milestone?.number === m.number)
  }));
}
