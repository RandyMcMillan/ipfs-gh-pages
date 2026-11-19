// js/github-actions.js — pure helpers for the TUI's live Actions status.
// latestRunByWorkflow matches each workflow definition (from
// REPO_WORKFLOWS, {file, name}) to its most recent run in the
// api.github.com /actions/runs payload: by workflow path first, then by
// name. The API returns runs newest-first, so the first match is the
// latest. No network here — the fetch lives in js/ipfs-node.js; this
// module is the testable core.
//
// Design doc: docs/rust-js-bridge.md (bridge state) and
// docs/optional-services.md (live data is an accelerant, never a
// dependency — a failed fetch degrades to an error string, never a
// blocked tab).

// Normalize one run to the fields the TUI renders. Missing values stay
// empty strings / null so the UI can show a content-free placeholder.
export function normalizeRun(run) {
  if (!run || typeof run !== 'object') return null;
  return {
    status: typeof run.status === 'string' ? run.status : '',
    conclusion: typeof run.conclusion === 'string' ? run.conclusion : '',
    runNumber: Number.isFinite(run.run_number) ? run.run_number : null,
    headBranch: typeof run.head_branch === 'string' ? run.head_branch : '',
    createdAt: typeof run.created_at === 'string' ? run.created_at : ''
  };
}

// One entry per workflow, in workflow order, with its latest run (or
// null when the payload has no run for it).
export function latestRunByWorkflow(workflows, runs) {
  const list = Array.isArray(runs) ? runs : [];
  return (Array.isArray(workflows) ? workflows : []).map((wf) => {
    const file = wf && typeof wf.file === 'string' ? wf.file : '';
    const name = wf && typeof wf.name === 'string' ? wf.name : '';
    const byPath = file
      ? list.find(
          (r) => typeof r.path === 'string' && r.path.endsWith(`/${file}`)
        )
      : undefined;
    const byName = name ? list.find((r) => r.name === name) : undefined;
    return { file, name, run: normalizeRun(byPath || byName || null) };
  });
}

// A short display label: conclusion when finished, else the in-flight
// status, else null (nothing to show — the UI must not invent one).
export function runLabel(run) {
  if (!run || (!run.status && !run.conclusion)) return null;
  if (run.conclusion) return run.conclusion;
  return run.status;
}
