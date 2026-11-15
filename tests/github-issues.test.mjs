// js/github-issues.js tests: URL parsing, GitHub JSON -> note-field mapping,
// bidirectional diff by immutable id, API helpers against a mocked fetch,
// token hygiene (never in errors).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseIssueUrl,
  listGithubIssues,
  mapGithubIssue,
  mapGithubComment,
  diffComments,
  fetchGithubThread,
  postGithubComment
} from '../js/github-issues.js';

test('parseIssueUrl: full URLs, issues and pulls', () => {
  assert.deepEqual(parseIssueUrl('https://github.com/gnostr-org/gnostr/issues/42'), { owner: 'gnostr-org', repo: 'gnostr', number: 42 });
  assert.deepEqual(parseIssueUrl('https://github.com/o/r/pull/7'), { owner: 'o', repo: 'r', number: 7 });
  assert.equal(parseIssueUrl('https://example.com/o/r/issues/1'), null);
  assert.equal(parseIssueUrl('not a url'), null);
  assert.equal(parseIssueUrl(''), null);
});

test('mapGithubIssue / mapGithubComment carry the github link metadata', () => {
  const issue = mapGithubIssue({
    title: 'T', body: 'B', number: 5, id: 5001,
    html_url: 'https://github.com/o/r/issues/5',
    user: { login: 'alice' },
    repository: { name: 'r', owner: { login: 'o' } }
  });
  assert.equal(issue.title, 'T');
  assert.deepEqual(issue.github, { owner: 'o', repo: 'r', number: 5, id: 5001, url: 'https://github.com/o/r/issues/5', user: 'alice' });
  const c = mapGithubComment({ id: 9001, body: 'hi', html_url: 'https://github.com/o/r/issues/5#issuecomment-1', user: { login: 'bob' }, created_at: '2026-11-15T00:00:00Z' });
  assert.equal(c.body, 'hi');
  assert.equal(c.github.id, 9001);
  assert.equal(c.github.user, 'bob');
});

test('diffComments: bidirectional by immutable github id', () => {
  const remote = [
    { id: 1, body: 'first' },
    { id: 2, body: 'second' },
    { id: 3, body: 'third' }
  ];
  const local = [
    { signed: { github: { id: 1 } } },
    { signed: { github: { id: 4 } }, body: 'written in-app' },   // not on GitHub yet
    { github: { id: 2 } }                                          // unwrapped envelope form
  ];
  const d = diffComments(local, remote);
  assert.deepEqual(d.missingLocally.map((c) => c.id), [3]);
  assert.equal(d.missingOnGithub.length, 1);
  assert.equal(d.missingOnGithub[0].signed.github.id, 4);
});

test('fetchGithubThread: one request per side, token on both, failure surfaces status', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, auth: init.headers.authorization });
    if (/\/comments/.test(url)) return new Response(JSON.stringify([{ id: 1, body: 'c' }]), { status: 200 });
    return new Response(JSON.stringify({ title: 't', number: 3, id: 30 }), { status: 200 });
  };
  const { issue, comments } = await fetchGithubThread('o', 'r', 3, { token: 'TOK', fetchImpl });
  assert.equal(issue.number, 3);
  assert.equal(comments.length, 1);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((c) => c.auth === 'Bearer TOK'));
  const bad = await fetchGithubThread('o', 'r', 3, { fetchImpl: async () => new Response('{"message":"Not Found"}', { status: 404 }) }).then(() => null, (e) => e.message);
  assert.ok(bad.includes('404'), 'status in error');
});

test('postGithubComment: requires token, posts JSON, error carries status not token', async () => {
  await assert.rejects(postGithubComment('o', 'r', 1, 'x', { token: '', fetchImpl: async () => assert.fail('no fetch') }), /token/);
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, init });
    return new Response(JSON.stringify({ id: 77 }), { status: 201 });
  };
  const out = await postGithubComment('o', 'r', 1, 'hello', { token: 'SECRET_TOK', fetchImpl });
  assert.equal(out.id, 77);
  assert.equal(sent[0].init.method, 'POST');
  assert.equal(JSON.parse(sent[0].init.body).body, 'hello');
  const err = await postGithubComment('o', 'r', 1, 'x', {
    token: 'SECRET_TOK',
    fetchImpl: async () => new Response('{"message":"Validation Failed"}', { status: 422 })
  }).then(() => null, (e) => e.message);
  assert.ok(err.includes('422'));
  assert.ok(!err.includes('SECRET_TOK'), 'token never leaks into errors');
});

test('listGithubIssues: fetches open issues, filters out PRs, token when present', async () => {
  const sent = [];
  const fetchImpl = async (url, init) => {
    sent.push({ url, auth: init.headers.authorization });
    return new Response(JSON.stringify([
      { number: 2, title: 'bug', pull_request: {} },
      { number: 3, title: 'real issue', user: { login: 'a' } }
    ]), { status: 200 });
  };
  const out = await listGithubIssues('o', 'r', { token: 'T', fetchImpl });
  assert.equal(out.length, 1);
  assert.equal(out[0].number, 3);
  assert.ok(sent[0].url.includes('/repos/o/r/issues?state=open'));
  assert.equal(sent[0].auth, 'Bearer T');
});
