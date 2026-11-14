// scripts/lib/repo-info.mjs tests: the bridge payload shape against a
// mocked fetch — field mapping, Link-header counts, release-vs-tag
// fallback data, auth header, failure → null.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRepoInfo } from '../scripts/lib/repo-info.mjs';

const REPO = {
  default_branch: 'master',
  visibility: 'public',
  stargazers_count: 42,
  forks_count: 7,
  subscribers_count: 3,
  open_issues_count: 9,
  description: 'an ipfs bridge',
  topics: ['ipfs', 'git'],
  pushed_at: '2026-11-14T21:00:59Z'
};
const TAGS = ['phase-0', 'batch-e'].map((name) => ({ name, commit: { sha: 'a'.repeat(40) } }));

const mkResponse = (json, { link = null } = {}) => ({
  ok: true,
  headers: { get: (h) => (h.toLowerCase() === 'link' ? link : null) },
  json: async () => json
});

const mkFetch = (overrides = {}) => {
  const calls = [];
  const routes = {
    repo: mkResponse(REPO),
    tags: mkResponse(TAGS, { link: '<https://api.github.com/repos/o/n/tags?page=2>; rel="last"' }),
    branches: mkResponse([{ name: 'master' }]),
    releases: mkResponse([{ tag_name: 'phase-0', html_url: 'https://github.com/o/n/releases/tag/phase-0' }], { link: '<https://api.github.com/repos/o/n/releases?page=3>; rel="last"' }),
    languages: mkResponse({ Rust: 100, Go: 50 }),
    ...overrides
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (/\/tags\?/.test(url)) return routes.tags;
    if (/\/branches\?/.test(url)) return routes.branches;
    if (/\/releases\?/.test(url)) return routes.releases;
    if (/\/languages$/.test(url)) return routes.languages;
    return routes.repo;
  };
  return { fetchImpl, calls };
};

test('fetchRepoInfo maps the payload and parses Link-header counts', async () => {
  const { fetchImpl, calls } = mkFetch();
  const info = await fetchRepoInfo({ owner: 'o', name: 'n', token: 'TOK', fetchImpl });
  assert.equal(info.defaultBranch, 'master');
  assert.equal(info.visibility, 'public');
  assert.equal(info.stars, 42);
  assert.equal(info.forks, 7);
  assert.equal(info.watchers, 3);
  assert.equal(info.description, 'an ipfs bridge');
  assert.deepEqual(info.topics, ['ipfs', 'git']);
  assert.equal(info.branchesCount, 1);
  assert.equal(info.tagsCount, 2, 'Link last page = 2');
  assert.deepEqual(info.tagNames, ['phase-0', 'batch-e']);
  assert.equal(info.releasesCount, 3, 'Link last page = 3');
  assert.equal(info.latestRelease.tag, 'phase-0');
  assert.equal(info.languages.Rust, 100);
  assert.ok(info.fetchedAt > 0);
  assert.ok(calls.every((c) => c.auth === 'Bearer TOK'), 'token on every call');
});

test('fetchRepoInfo: array-length counts when no Link header; release null when empty', async () => {
  const { fetchImpl } = mkFetch({
    tags: mkResponse(TAGS),
    releases: mkResponse([])
  });
  const info = await fetchRepoInfo({ owner: 'o', name: 'n', fetchImpl });
  assert.equal(info.tagsCount, 2);
  assert.equal(info.releasesCount, 0);
  assert.equal(info.latestRelease, null);
  assert.equal(info.tagNames[0], 'phase-0', 'newest tag still exposed for the chip');
});

test('fetchRepoInfo: no token → no auth header', async () => {
  const { fetchImpl, calls } = mkFetch();
  await fetchRepoInfo({ owner: 'o', name: 'n', fetchImpl });
  assert.ok(calls.every((c) => c.auth === undefined));
});

test('fetchRepoInfo: repo fetch failure → null (page falls back to runtime API)', async () => {
  const { fetchImpl } = mkFetch({ repo: { ok: false, headers: { get: () => null }, json: async () => null } });
  assert.equal(await fetchRepoInfo({ owner: 'o', name: 'n', fetchImpl }), null);
});

test('fetchRepoInfo: missing owner/name → null without fetching', async () => {
  assert.equal(await fetchRepoInfo({ owner: '', name: 'n', fetchImpl: async () => assert.fail('no fetch') }), null);
});
