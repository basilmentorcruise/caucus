# Contributing to Caucus

Thanks for your interest in Caucus — an open-source agent war room for investigations and escalations. The project is built in the open and welcomes contributions from individuals and teams.

New here? Read [docs/VISION.md](docs/VISION.md) and [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then browse the [`good first issue`](../../issues?q=label%3A%22good+first+issue%22) tickets on the board.

## Ground rules

- Be respectful — see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- Discuss non-trivial changes in an issue first. Architecture-altering proposals should reference or add an ADR in [docs/DECISIONS.md](docs/DECISIONS.md).
- Keep PRs small and focused — one ticket, one branch, one PR.

## How we work

Caucus runs a ticket-driven SDLC on GitHub Projects. The full playbook is in [docs/GITHUB_PROJECTS.md](docs/GITHUB_PROJECTS.md). **Tickets live only on the GitHub Project board — not in this repo.** The short version:

1. **Find a ticket** on the board that's `Ready` (acceptance criteria present, dependencies done).
2. **Claim it** — self-assign so two people don't collide.
3. **Branch:** `cau-<n>-<slug>` (e.g. `cau-7-claim-ledger`).
4. **Build** — match the surrounding code's style; add tests; update docs if behavior changes.
5. **Open a PR** — use the template, link the issue with `Closes #<n>`, tick the acceptance-criteria checklist.
6. **Pass CI + review** — lint, typecheck, tests green; at least one approval.

## Definition of Done
- All acceptance criteria met (checklist ticked).
- CI green (lint / typecheck / test / build).
- Docs updated if behavior or interfaces changed.
- Linked issue closes on merge.

## Local development

> The toolchain stabilizes during Milestone M0 and this section will be expanded as the skeleton lands. Caucus is a pnpm TypeScript monorepo:

```
packages/
  schema/       # versioned typed-message schema + codec (shared)
  backbone/     # the channel service: log, claim ledger, cursors, seatbelts
  mcp-server/   # MCP server over the backbone interface
  hook/         # Claude Code turn-start awareness hook
examples/       # the war-room demo + quickstart
```

```bash
# placeholder — finalized in M0
pnpm install
pnpm build
pnpm test
```

## Commit & PR style
- Clear, imperative commit messages, referencing the ticket: `CAU-N: <what changed>`.
- Squash-merge; delete the branch on merge.

## Reporting bugs / proposing features
Use the issue templates (feature / bug / task / spike). For security-sensitive reports, see `SECURITY.md` (added during M0) rather than filing a public issue.

## License
By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
