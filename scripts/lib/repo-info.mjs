// The bridge's payload: repo info fetched at DEPLOY time (server-side,
// authenticated when GITHUB_TOKEN is present) and baked into the bundle,
// so the deployed Pages/IPFS site exposes the repo's real metadata to
// every visitor without each browser depending on the unauthenticated
// GitHub API. The runtime API refresh in main.js still runs on top of
// this — the bake paints instantly and correctly even when the API is
// rate-limited or down.
//
// Pure + injectable (fetchImpl) for unit tests; network only happens in
// the caller (vite.config.js's repo-live-info plugin).
export const REPO_INFO_FIELDS = 'default_branch,visibility,stargazers_count,forks_count,subscribers_count,open_issues_count,description,topics,pushed_at';

export async function fetchRepoInfo({ owner, name, token, fetchImpl = fetch, timeoutMs = 8000 }) {
  if (!owner || !name) return null;
  const base = `https://api.github.com/repos/${owner}/${name}`;
  const headers = {
    accept: 'application/vnd.github+json',
    'user-agent': 'ipfs-gh-pages-repo-info',
    ...(token ? { authorization: `Bearer ${token}` } : {})
  };
  const signal = AbortSignal.timeout(timeoutMs);
  const get = async (url) => {
    const res = await fetchImpl(url, { headers, signal });
    if (!res.ok) return { res, json: null };
    return { res, json: await res.json() };
  };
  const [repoR, tagsR, branchesR, releasesR, langR] = await Promise.all([
    get(base),
    get(`${base}/tags?per_page=100`),
    get(`${base}/branches?per_page=1`),
    get(`${base}/releases?per_page=1`),
    get(`${base}/languages`)
  ]);
  if (!repoR.json) return null;
  const repo = repoR.json;
  // Exact counts from the Link header's last page (same trick the browser
  // uses); the array length is the fallback for 0/1-page repos.
  const countFrom = (r, arr) => {
    const link = r.res.headers.get('link') || '';
    const last = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    return last ? parseInt(last[1], 10) : (Array.isArray(arr) ? arr.length : 0);
  };
  const tags = Array.isArray(tagsR.json) ? tagsR.json : [];
  return {
    owner,
    name,
    defaultBranch: repo.default_branch || '',
    visibility: repo.visibility || '',
    stars: repo.stargazers_count ?? null,
    forks: repo.forks_count ?? null,
    watchers: repo.subscribers_count ?? null,
    openIssues: repo.open_issues_count ?? null,
    description: repo.description || '',
    topics: Array.isArray(repo.topics) ? repo.topics : [],
    pushedAt: repo.pushed_at || '',
    branchesCount: countFrom(branchesR, branchesR.json),
    tagsCount: countFrom(tagsR, tags),
    tagNames: tags.map((t) => t.name),
    releasesCount: countFrom(releasesR, releasesR.json),
    latestRelease: (() => {
      const rel = Array.isArray(releasesR.json) ? releasesR.json[0] : null;
      return rel && rel.tag_name ? { tag: rel.tag_name, url: rel.html_url } : null;
    })(),
    languages: (langR.json && typeof langR.json === 'object' && !Array.isArray(langR.json)) ? langR.json : null,
    fetchedAt: Date.now()
  };
}
