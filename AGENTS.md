# Working Agreement

Rules the user has set. Follow them exactly.

## STOP means STOP

When the user says "stop" (in any tone, including all-caps or profanity),
halt immediately: no finishing the current edit, no "one last tool call,"
no cleanup. Acknowledge and wait for the next instruction.

## Incremental commits, never stacked changes

- Commit every change as soon as it is verified. Nothing sits uncommitted.
- Never layer new edits on top of uncommitted edits. If a change cannot be
  committed yet, stop and tell the user why — do not keep working.
- One topic per commit. If two topics touch the same file, split the hunks
  into separate commits.

## One topic at a time

Do not stack unrelated tasks in a single turn. Finish (and commit) the
current task before starting a new one, even when the new request is small.

## Never elide values

Never truncate, shorten, or ellipsis identifiers (CIDs, hashes, addresses,
URLs, peer IDs, commit SHAs) for display. Show the full value and let the UI
wrap it. The user will say explicitly if they ever want a shortened form.

## Commands in docs always get their own line

Every runnable command shown in UI text, help docs, or README gets its own
line (its own code block). Never append comments or prose to a command line,
and never bury a command inside a sentence.

# Design Objectives

1. **This project enables devs to publish repos to IPFS — other people must
   be able to clone them.** Every feature is judged against that sentence.

2. **Map the app's IPFS functionality to its related IPFS/libp2p
   functionality.** Every feature the app provides has a canonical
   counterpart in the IPFS ecosystem (a Kubo CLI command, a libp2p
   mechanism, a spec). The app surfaces that mapping — the page is both a
   tool and a reference for how IPFS works.
