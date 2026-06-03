# Releasing & versioning

Caucus uses [Changesets](https://github.com/changesets/changesets) to track changes,
compute version bumps, and generate changelogs across the monorepo.

> **Status:** packages are **not published** anywhere yet (every `@caucus/*` package is
> `"private": true`). This document describes how we **version** the workspace today and
> how publishing **will** work once the project decides to publish. **No npm tokens,
> publish workflow, tags, or GitHub releases are wired up** — see
> [Out of scope / follow-ups](#out-of-scope--follow-ups).

## Versioning model: fixed (lockstep)

All four library packages are versioned **together** as one unit:

```json
"fixed": [["@caucus/*"]]
```

**Why fixed and not independent:** `@caucus/schema`, `@caucus/backbone`,
`@caucus/mcp-server`, and `@caucus/hook` are one cohesive system that co-evolves around a
single shared, versioned message schema. Pre-1.0, lockstep versioning keeps version
reasoning trivial — there is exactly **one** Caucus version number, and any change ships
the whole set in step. We can revisit independent versioning if/when the packages develop
genuinely independent release cadences.

The `examples/*` workspace is a demo/quickstart, not a publishable library, and currently
contributes no npm package (no `package.json`), so it is not versioned or published.

Config lives in [`.changeset/config.json`](../.changeset/config.json):

- `"baseBranch": "main"` — changesets diffs against `main`.
- `"access": "restricted"` — private-safe default; nothing is published publicly even if a
  publish step is later added by mistake.
- `"changelog": "@changesets/cli/changelog"` — generates per-package `CHANGELOG.md`.

## The release flow

### 1. Add a changeset with your change

Whenever you make a user-facing change to one or more packages, add a changeset **in the
same PR**:

```bash
corepack pnpm changeset
```

This prompts for the bump type (patch / minor / major) and a summary, then writes a
markdown file under `.changeset/`. Because versioning is **fixed**, selecting any single
`@caucus/*` package bumps **all four** together — pick the highest appropriate bump for
the whole set. Commit the generated `.changeset/*.md` file with your PR.

To see what's pending at any time:

```bash
corepack pnpm changeset status
```

### 2. Version PR

When we're ready to cut a release, run:

```bash
corepack pnpm version   # = changeset version
```

This consumes all pending `.changeset/*.md` files, bumps every package's `version`, and
updates each `CHANGELOG.md`. Commit the result on a branch and open a **version PR**
(conventionally titled `Version Packages`). Review the version bumps and changelogs, then
merge.

> When a publish CI workflow is eventually added, this version PR is normally opened and
> kept up to date **automatically** by the changesets GitHub Action (see follow-ups).

### 3. Tag + GitHub release (future)

Once the version PR merges to `main`, a release is cut by tagging the version commit and
publishing a GitHub release with the changelog. **This is not automated or performed in
the current setup** — there are no tags or releases yet, by design.

### 4. npm publish — OUT OF SCOPE

Publishing to npm is **explicitly out of scope** until the project decides to go public.
The `release` root script (`pnpm build && changeset publish`) exists so the wiring is in
place, but **it is not run by any workflow** and all packages are `private: true`, so
`changeset publish` is a no-op for them. Do not add npm tokens or a publish workflow as
part of unrelated work.

## Root scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `pnpm changeset` | `changeset` | Add a changeset for your change. |
| `pnpm version` | `changeset version` | Consume changesets, bump versions, write changelogs. |
| `pnpm release` | `pnpm build && changeset publish` | Build then publish (no-op while packages are private; not run by CI). |

## Clean-machine install (quickstart artifacts)

The README quickstart and the demo must be reproducible from a fresh checkout. The
supported path uses the pnpm version **pinned** in the root `package.json`
(`"packageManager": "pnpm@9.15.0"`), activated via [corepack](https://nodejs.org/api/corepack.html)
so you never need a globally-installed pnpm:

```bash
# Prerequisites: Node.js >= 20.10.0 (see "engines" in package.json) and git.
git clone https://github.com/basilmentorcruise/caucus.git
cd caucus
corepack enable                 # activates the pinned pnpm 9.15.0
corepack pnpm install           # installs all workspace deps
corepack pnpm build             # builds every package
```

To additionally run the checks CI runs:

```bash
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test              # vitest + enforced coverage gate
```

This exact path was verified from a fresh `git clone` on a clean checkout (no global
pnpm, no pre-existing `node_modules`): `corepack pnpm install` and `corepack pnpm build`
both completed successfully.

## Out of scope / follow-ups

These are intentionally **not** done in this setup and are left as follow-ups for when the
project decides to publish:

- **No publish CI workflow.** `changeset init` / the changesets docs suggest a
  `changesets/action` GitHub Action that opens the version PR and runs `changeset publish`
  on merge to `main`. It is **deliberately not added** here — adding it would require npm
  tokens and would push artifacts outward. Add it (and an `NPM_TOKEN` secret) only when
  publishing is approved.
- **No tags or GitHub releases.** No version has been tagged or released.
- **No npm tokens / registry config.** Packages remain `private: true` until then.
- **Flip `access` to `"public"`** in `.changeset/config.json` and drop `private: true`
  from each package when public publishing is approved.
