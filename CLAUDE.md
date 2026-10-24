# Repository rules for AI coding agents

These rules apply to every commit, branch and pull request in this repo.

- **No attribution.** Never add `Co-Authored-By` trailers, session links, "Generated with ..."
  lines or any other AI-tool attribution to commit messages, PR titles, PR descriptions or
  review comments.
- **Commit identity.** Commits are authored and committed as `davedumto <ejeredavid2001@gmail.com>`.
  Set it with `git config user.name "davedumto"` and `git config user.email "ejeredavid2001@gmail.com"`
  before committing.
- **Branches.** Branch from `dev` and open PRs against `dev`. Name branches `feat/<nn>-<slug>`,
  `fix/<slug>` or `chore/<slug>`. Never use `claude/` or other tool or personal prefixes.
  `main` is releases only.
- **Commits.** Use conventional commits (`feat(core): ...`, `fix(sdk): ...`, `docs: ...`).
- **PR descriptions.** Fill in every section of `.github/pull_request_template.md`. The
  description is the permanent record of the change (see `CONTRIBUTING.md`).
- Read `docs/DECISIONS.md` and `docs/ROADMAP.md` before starting roadmap work.
