<!--
Write this for someone reading it a year from now with no other context.
Every section is required. Write "None" or "N/A" rather than deleting one.
-->

## Summary

<!-- 2–4 sentences: what this PR does and why. Link the roadmap item, e.g. "Roadmap PR 3". -->

## Context

<!-- The problem or requirement behind it. Cite spec requirement IDs (F1–F5, N1–N5) and
DECISIONS entries (D1…) where they apply. -->

## Changes

<!-- What changed, grouped by area (contract / core / sdk / verifier / CI / docs).
Name the important files and the public functions, types or errors you added or changed. -->

## Design decisions and alternatives

<!-- Choices made while building and why. List alternatives you rejected and why.
Name any library you added and the reason for it. -->

## Spec / DECISIONS deviations

<!-- "None", or each deviation with the reason. A deviation also needs a
DECISIONS.md entry in this PR. -->

## How it was tested

<!-- Commands run and their results. New tests, and what each one proves.
Paste output where useful: test summary, gas table, coverage, screenshots for UI. -->

## Security and privacy

<!-- The effect on N1 (content never leaves the device), N2 (no admin or upgrade path)
and key handling. "No impact" is fine if true; say why. -->

## Known limitations and follow-ups

<!-- What this PR intentionally doesn't do, TODOs left behind, and risks to watch. -->

## How to review

<!-- Suggested reading order, and where to look hardest. -->

## Checklist

- [ ] `pnpm lint && pnpm format:check && pnpm build && pnpm test` pass locally
- [ ] Shared vectors pass
- [ ] No secrets, keys or `.env` committed
- [ ] Docs updated where behaviour changed
- [ ] Every section above is filled in
