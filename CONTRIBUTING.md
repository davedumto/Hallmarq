# Contributing to Hallmarq

## Flow

- `dev` is the default and integration branch. `main` is releases only.
- Branch from `dev` and open the PR against `dev`. Use `feat/<nn>-<slug>` for a roadmap PR,
  `fix/<slug>` for fixes, and `chore/<slug>` for tooling and docs. Never use `claude/` or
  personal prefixes.
- Don't add AI-tool attribution trailers (`Co-Authored-By`, session links) to commits or PRs.
- One roadmap PR per branch. Don't bundle unrelated changes.
- Conventional commits (`feat(core): ...`, `test(contract): ...`, `fix(sdk): ...`).
- Before you push, run `pnpm lint && pnpm format:check && pnpm build && pnpm test`.
- Open the PR with **every section of the template filled in** (see "PR descriptions" below).
  Then address every review comment with a push or a reply saying why not.

## PR descriptions

PRs are the project's long-term record. The description has to make sense to someone
reading it a year from now without this conversation. That means it covers:

- what changed and **why**, linked to the roadmap item and spec IDs (F1–F5, N1–N5, D1…)
- the decisions made, and the alternatives rejected
- exactly how it was tested, with output (test summary, gas table, coverage, screenshots)
- the effect on security and privacy
- known limitations, follow-ups, and where reviewers should look hardest

A PR with a thin or partly empty description gets "changes requested" before the code is reviewed.
If the code changes during review, update the description to match before merge.

## What review checks (the CTO's checklist)

**PR description**

- Every template section is filled in and matches the final code.

**Spec fidelity**

- Behaviour matches the spec + `docs/DECISIONS.md`. Any deviation is called out in the PR.
- Hashing goes through `@hallmarq/core` only. No second implementation anywhere.

**Contract** (zero tolerance, because deployed records are permanent)

- No owner, proxy, `selfdestruct`, `delegatecall` or delete path (N2).
- Every revert path has a test. Every event field is asserted.
- No new storage or features without a DECISIONS entry.

**Privacy (N1)**

- Content, prompts and user data never leave the device. Only hashes and RPC calls
  go over the network.
- The verifier has no third-party requests: no analytics, CDNs or fonts.

**Code quality**

- TypeScript strict, no `any` without a comment, and no unhandled promises.
- Errors are typed (`HallmarqError` subclasses) and never swallowed.
- Secrets come only from env. `.env` is never committed.

**Tests**

- New behaviour has tests, and bug fixes come with a test that fails without the fix.
- Shared vectors (`vectors/vectors.json`) still pass in every package.
- Never skip or disable a test to get green.

## Merge rule

CI is green and the CTO has approved, then squash-merge into `dev`. Release PRs
`dev` → `main` use a merge commit.
