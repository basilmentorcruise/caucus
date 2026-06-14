# Releasing & versioning

Caucus uses [Changesets](https://github.com/changesets/changesets) to track changes,
compute version bumps, and generate changelogs across the monorepo, and to **publish** the
public packages to npm.

> **Status:** the public `@caucus/*` packages are **published to npm** under the `@caucus`
> scope (`publishConfig.access: "public"`). The "do not publish yet" posture was reversed
> for the frictionless-alpha launch (owner-ratified 2026-06-14). The only remaining manual
> step is a one-time owner action — provisioning the npm org and the `NPM_TOKEN` repo
> secret — see [Owner action required before first publish](#owner-action-required-before-first-publish).

## Published vs. private packages

Five packages are **public** (publishable to npm):

- `@caucus/schema`
- `@caucus/backbone`
- `@caucus/backbone-server`
- `@caucus/mcp-server`
- `@caucus/hook`

Two packages stay **private** (never published — `"private": true`):

- `@caucus/integration` — the test-only cross-package integration harness; not a shipped
  artifact. It matches the `@caucus/*` glob in the `fixed` group (so it version-bumps in
  lockstep), but `changeset publish` / `pnpm publish -r` skip any `private` package, so npm
  never receives it.
- `caucus` (the repo root) — the workspace container; not scoped under `@caucus/*` and not
  part of the lockstep group.

## Versioning model: fixed (lockstep)

All packages matching `@caucus/*` are versioned **together** as one unit:

```json
"fixed": [["@caucus/*"]]
```

**Why fixed and not independent:** `@caucus/schema`, `@caucus/backbone`,
`@caucus/backbone-server`, `@caucus/mcp-server`, and `@caucus/hook` are one cohesive system
that co-evolves around a single shared, versioned message schema. Pre-1.0, lockstep
versioning keeps version reasoning trivial — there is exactly **one** Caucus version number,
and any change ships the whole set in step. We can revisit independent versioning if/when the
packages develop genuinely independent release cadences. The first public release is
`0.1.0`.

The `examples/*` workspace is a demo/quickstart, not a publishable library, and currently
contributes no npm package (no `package.json`), so it is not versioned or published.

Config lives in [`.changeset/config.json`](../.changeset/config.json):

- `"baseBranch": "main"` — changesets diffs against `main`.
- `"access": "public"` — the `@caucus/*` packages publish publicly. (Private packages are
  still never published regardless of this setting.)
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
corepack pnpm changeset:version   # = changeset version
# (the script is deliberately NOT named `version` — that name collides with pnpm's
#  built-in `pnpm version` command, which would silently not run changesets)
```

This consumes all pending `.changeset/*.md` files, bumps every package's `version`, and
updates each `CHANGELOG.md`. Commit the result on a branch and open a **version PR**
(conventionally titled `Version Packages`). Review the version bumps and changelogs, then
merge.

> This version PR is normally opened and kept up to date **automatically** by the
> [`changesets/action`](https://github.com/changesets/action) in
> [`.github/workflows/release.yml`](../.github/workflows/release.yml) on every push to
> `main`.

### 3. Publish to npm (automated)

The release is automated by `.github/workflows/release.yml`. On every push to `main` it:

1. Runs the **full CI gate** first — `pnpm lint`, `pnpm typecheck`, `pnpm test` (with the
   enforced coverage gate), `pnpm build` — exactly mirroring `ci.yml`. Publishing only
   happens **after** all of these pass.
2. Hands off to the Changesets action, which:
   - **opens / updates** the `Version Packages` PR when changesets are pending; or
   - **runs `pnpm release`** (= `pnpm build && changeset publish`) once that version PR is
     merged, publishing the five public `@caucus/*` packages to npm and tagging the release.

**`workspace:*` rewriting:** the public packages depend on each other via `workspace:*`.
`changeset publish` (pnpm under the hood) rewrites every `workspace:*` range to the
concrete published version at pack time, so the tarballs on npm carry real semver ranges,
never the `workspace:` protocol. Private packages (`@caucus/integration`, root `caucus`)
are skipped entirely.

**Safe without a token.** The publish step is gated on the `NPM_TOKEN` repo secret. When
the secret is absent the publish is skipped and the workflow still passes — it never errors
CI. This means the workflow is inert until the owner completes the one-time setup below.

## Root scripts

| Script | Command | Purpose |
| --- | --- | --- |
| `pnpm changeset` | `changeset` | Add a changeset for your change. |
| `pnpm changeset:version` | `changeset version` | Consume changesets, bump versions, write changelogs. |
| `pnpm release` | `pnpm build && changeset publish` | Build then publish the public `@caucus/*` packages to npm. Run by `release.yml` (gated on `NPM_TOKEN`); private packages are skipped. |

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

## Owner action required before first publish

Everything in the repo is prepped: the five public packages are configured with
`publishConfig.access: "public"`, `.changeset/config.json` is `"public"`, and
`release.yml` runs the full gate and publishes via Changesets. The publish step is a safe
no-op until the **owner** completes two manual steps that agents/CI cannot do:

1. **Create / own the `@caucus` org on npmjs.com.** Sign in at <https://www.npmjs.com/>,
   create the `@caucus` scope/organization, and confirm the publishing account is an
   org member with publish rights. The package names (`@caucus/schema`, `@caucus/backbone`,
   `@caucus/backbone-server`, `@caucus/mcp-server`, `@caucus/hook`) must be available under
   that scope.
2. **Add an `NPM_TOKEN` repo secret.** Create an **automation** access token with publish
   rights (`npm login`, then npm website → *Access Tokens* → *Generate New Token* →
   *Automation*), and add it as a repository secret named `NPM_TOKEN`
   (GitHub → repo *Settings* → *Secrets and variables* → *Actions* → *New repository
   secret*). The release workflow maps it to `NODE_AUTH_TOKEN` for `changeset publish`.

That is the entire manual surface: **`npm login` + paste the token as `NPM_TOKEN`.** Once
the secret exists, the next push to `main` will run the gate and publish (or, with pending
changesets, open the `Version Packages` PR first). Until then, the workflow stays green and
publishes nothing.

## Out of scope / follow-ups

- **GitHub Releases bodies.** The Changesets action tags published versions; richer
  GitHub Release notes can be layered on later if desired.
