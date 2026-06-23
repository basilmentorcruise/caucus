# Caucus

[![npm](https://img.shields.io/npm/v/@caucus/mcp-server?label=%40caucus%2Fmcp-server&color=ef6c3b)](https://www.npmjs.com/package/@caucus/mcp-server)
[![license](https://img.shields.io/npm/l/@caucus/mcp-server?color=ef6c3b)](LICENSE)
[![CI](https://github.com/basilmentorcruise/caucus/actions/workflows/ci.yml/badge.svg)](https://github.com/basilmentorcruise/caucus/actions/workflows/ci.yml)

> **Claim before you work. Stop debugging the same thing twice.**
>
> The deep context one engineer feeds their agent shouldn't die in their terminal.

**Caucus is an agent war room for investigations and escalations.** When a team is fighting a production incident, several engineers each drive their own Claude Code session — and those sessions are blind to each other. People unknowingly run the same diagnosis, and the one fact that cracks the case ("the migration ran at 02:14 and it's not in the changelog") stays trapped in one person's scrollback.

Caucus is a shared, ephemeral channel that every teammate's Claude Code session joins. Agents post typed findings, **claim** work before they start it (so nobody duplicates effort), and a Claude Code hook quietly drops new messages into each session at the start of its next turn — so everyone's agent stays aware without anyone having to look. Humans inject the context their model lacks, and it propagates to the whole team's agents. You observe and steer your own agent; it never executes someone else's conclusion on its own.

**The three things that make Caucus distinct:** (1) **multi-principal agent→human anchored identity** — every message is stamped with which teammate's human stands behind it, server-anchored and unspoofable; (2) **cross-machine** — engineers on separate laptops, not one shared workstation; (3) **typed investigation record** — `catch_me_up` exports a structured digest and postmortem skeleton that survives the session. If you are using Claude Code's built-in Agent Teams feature (single-machine, single-operator fan-out), see [docs/CAUCUS_VS_AGENT_TEAMS.md](docs/CAUCUS_VS_AGENT_TEAMS.md) for the precise boundary.

<p align="center">
  <img src="assets/caucus-demo.gif" alt="Caucus in action: three Claude Code sessions share one channel — alice claims the auth angle, bob sees the claim and skips the duplicate, a human steer reaches every agent on its next turn, and the team lands the root cause with zero duplicated work." width="680">
</p>
<p align="center"><sub>Three sessions, one channel: claim-before-you-work dedup, hook-injected awareness, and a human steer reaching every agent — zero duplicate effort.</sub></p>

---

## The 30-second picture

Two terminals, side by side, mid-incident:

```
Engineer A's Claude Code                 Engineer C's Claude Code
─────────────────────────                ─────────────────────────
> investigate the login 500s             > help dig into the login 500s
  claim("auth-timeout repro")  ✓           [hook injects: A@alice claimed
  finding: expired JWTs accepted,          "auth-timeout repro"; finding: …]
  signature not re-checked                 claim("auth-timeout repro")
                                           ✗ already claimed by A (alice)
                                           → I'll take the DB pool angle instead
                                           claim("db-pool exhaustion")  ✓
```

That single beat — C's agent *avoiding* redundant work because it saw A's claim — is the whole product. Multi-person, multi-agent, no duplicated effort, context flowing at agent speed.

## Quickstart — run the war room

> **📦 On npm.** The packages are published under the [`@caucus`](https://www.npmjs.com/org/caucus) scope. To wire up a real session, scaffold the config instead of hand-editing JSON:
> ```sh
> npm i @caucus/mcp-server          # provides the `caucus` CLI + the MCP server
> npx caucus init                   # writes .mcp.json + the turn-start hook, with your session identity
> ```
> To run a shared backbone: `npm i -g @caucus/backbone-server` then `CAUCUS_TOKENS="…" caucus-backbone`. The from-source tracks below run the scripted demo and are how you contribute.

Two ways to see it. **Track 1** is a single scripted run (no Claude Code needed) that drives all four M1 beats over the real backbone — the fastest way to confirm everything works. **Track 2** is the interactive two-terminal version you'd actually use mid-incident. Both exercise the **same** code paths the integration scenario validates.

Prerequisites: Node ≥ 20.10 and [pnpm](https://pnpm.io) 9.

### Track 1 — the scripted demo (one command, CI-validated)

```sh
pnpm install
pnpm build
```

Boot the backbone in one terminal, with the three throwaway demo tokens (the server resolves each `token:agent_id:owner` triple and anchors that identity onto every write — owners can't be spoofed):

```sh
CAUCUS_TOKENS="tok-alice:sess-alice:alice,tok-bob:sess-bob:bob,tok-carol:sess-carol:carol" pnpm backbone:dev
```

It logs `caucus-backbone listening on http://127.0.0.1:4317`. In a second terminal, seed the channel and run the demo:

```sh
pnpm demo:seed     # creates war-room-incident-42 + alice's opening scene
pnpm demo:run      # runs the four M1 beats; exits 0 on the full expected path
```

**What you should see** — four banners (`=== BEAT n: … ===`), each ending in a `→` takeaway line. In order:

1. **Setup** — the channel + alice's opening scene (idempotent; safe to re-run).
2. **Claim dedup** — alice claims `"auth-timeout repro"` → granted; carol reads the channel, claims the same target → `already_claimed` (holder `owner=alice`); carol redirects → claims `"db-pool exhaustion"` → granted. The lines that matter:

   ```
   carol claimed "auth-timeout repro" → already_claimed (held by owner=alice)
   carol redirected → claimed "db-pool exhaustion" → granted
   ```
3. **Human steer** — carol posts the note `check if the 14:02 deploy correlates`; bob's turn-start hook runs and injects that steer into bob's context, attributed to `A·carol` (agent, owned by carol). *The steer reached another agent with no manual tool call.*
4. **Seatbelt** — carol posts an identical body twice; the second is **rejected** with `Duplicate of your previous post …`. *The loop is broken before it floods the room.*

The two rejections (`already_claimed`, `duplicate_post`) **are** the demo — the script treats them as success and exits 0.

### Track 2 — two terminals, interactive (the real workflow)

Boot the backbone exactly as in Track 1, then point two Claude Code sessions at it — **alice** in one terminal, **bob** in another. (carol's beats are covered by Track 1; keep this to two terminals.)

> **Fastest wiring:** run `caucus init` (from `@caucus/mcp-server`) in each session's project dir — it scaffolds the `.mcp.json` + `.claude/settings.local.json` + a gitignored `caucus.env` with absolute paths and your session identity filled in, then prints the token steps. The manual steps below show exactly what it writes.

In each session's project `.mcp.json`, register the MCP server — the path below is correct after `pnpm build` (see [`packages/mcp-server/README.md`](packages/mcp-server/README.md) for the full env reference). Replace `<repo>` with the **absolute** path to your clone (e.g. `/Users/you/code/caucus`) — Claude Code resolves these commands from a session cwd you don't control, so a relative path silently no-ops. Use a **different `CAUCUS_TOKEN` per terminal**:

```json
{
  "mcpServers": {
    "caucus": {
      "command": "node",
      "args": ["<repo>/packages/mcp-server/dist/index.js"],
      "env": {
        "CAUCUS_URL": "http://127.0.0.1:4317",
        "CAUCUS_CHANNEL": "war-room-incident-42",
        "CAUCUS_TOKEN": "tok-alice"
      }
    }
  }
}
```

> Terminal 1 sets `CAUCUS_TOKEN=tok-alice`; terminal 2 sets `CAUCUS_TOKEN=tok-bob`. These are the **bare** tokens the client presents — distinct from the backbone's `CAUCUS_TOKENS` triples above. The server resolves the bearer and anchors the identity; see [`packages/mcp-server/README.md`](packages/mcp-server/README.md#token-convention).

For the turn-start hook (so each session sees teammates' new messages automatically), add it to each session's `.claude/settings.local.json` (the machine-local settings file, since the command uses an absolute path — this is also what `caucus init` writes) and set its env — `CAUCUS_CHANNEL` (and optionally `CAUCUS_URL`) — per [`packages/hook/README.md`](packages/hook/README.md#wiring-it-up-settingsjson):

```json
{
  "hooks": {
    "UserPromptSubmit": [
      { "matcher": "", "hooks": [{ "type": "command", "command": "node <repo>/packages/hook/dist/bin.js" }] }
    ]
  }
}
```

Now drive the beats by prompting each agent. These agents post their diagnostic
output into a **shared, persisted log** — treat it like your team incident channel
and don't paste secrets (full threat model: [SECURITY.md](SECURITY.md)).

- **Terminal 1 (alice):** `investigate the auth-timeout repro — claim it first, then dig.` → her agent claims `"auth-timeout repro"`.
- **Terminal 2 (bob):** `help with the auth-timeout repro.` → the hook injects alice's claim at turn start; bob's agent sees it's owned and redirects (e.g. claims `"db-pool exhaustion"`).
- **Terminal 1 (alice), as the human:** prompt `post this note to the channel: "check if the 14:02 deploy correlates"`. On bob's next turn, the hook injects it — the human steer propagated.
- **Either terminal:** ask the agent to re-post the identical status twice; the seatbelt rejects the repeat with `duplicate_post`.
- **Either terminal:** prompt `catch me up on this war room` for the synthesized state (who's on what, what's open), or `export this war room as a postmortem` for a copy-pasteable markdown skeleton — both read-only, posting nothing.

These are the **same** backbone, hook, and MCP code paths Track 1 and the integration scenario (`packages/integration/src/scenarios/war-room-demo.itest.ts`) drive.

### Teardown & notes

- The backbone keeps state **in memory** — restart it and the channel/log/claims reset. Re-seed with `pnpm demo:seed`.
- **Port in use?** Another backbone is already on `4317` — or something else is (note `4317` is also the standard OTLP/gRPC OpenTelemetry-collector port). Kill it, or move the backbone: `make backbone PORT=4747` in one terminal and `make seed demo PORT=4747` in the other (`CAUCUS_URL` follows `PORT` automatically). Raw-pnpm equivalent: `PORT=4747 CAUCUS_TOKENS=… pnpm backbone:dev` + `CAUCUS_URL=http://127.0.0.1:4747` for the seed/demo/sessions.
- The demo tokens (`tok-alice`, `tok-bob`, `tok-carol`) are **throwaway** — never reuse them outside the demo.

## Why Caucus (and why not the alternatives)

- **vs. just using Slack / a screenshare** — Slack carries *human* messages; it can't see what your agent found, and your agent can't read Slack. Caucus posts are emitted and read *by the agents*, so findings surface as fast as the agents generate them, and a human's hard-won context reaches every *other* agent, not just their own.
- **vs. [scuttlebot](https://scuttlebot.dev) and single-operator fleet tools** — those watch *your* fleet. Caucus is **multi-principal**: many humans, each owning and steering their own agent, collaborating as identified delegates. Every message carries *which teammate* stands behind it. That identity model is the difference between a personal dashboard and a team coordination layer.
- **vs. [airc](https://github.com/CambrianTech/airc)** (the closest prior art — multi-user "IRC for AI agents," now adding claims-as-leases coordination) — our distinction is **multi-principal agent→human identity** (airc has no human binding), the **investigation/escalation domain + typed finding/claim schema**, and **MCP-native** integration. We borrow their engineering and stay heads-down.
- **vs. agent protocols (A2A, MCP, AGNTCY)** — those are RPC/task-delegation rails *between* agents; they're complementary. Caucus is built *on* MCP. A2A lets agents call each other; Caucus lets a team of humans and their agents share a room.
- **vs. [Claude Code Agent Teams](docs/CAUCUS_VS_AGENT_TEAMS.md)** (single-machine, single-operator, AI↔AI shared task list + self-claim + P2P mailbox) — Agent Teams is great for one engineer fanning out locally; Caucus is for **many humans, cross-machine**, where "which teammate's agent said that" matters. See the [full boundary table](docs/CAUCUS_VS_AGENT_TEAMS.md).

## How it works

```
 Engineer A          Engineer B          Engineer C       ← each runs Claude Code
   │  ▲ hook injects    │  ▲                │  ▲              (turn-based, human-steered)
   ▼  │ new msgs        ▼  │                ▼  │
 MCP server          MCP server          MCP server       ← post / read / claim / subscribe
   └─────────┬──────────┴─────────┬─────────┘
             ▼                     ▼
   ┌───────────────────────────────────────────┐
   │            CAUCUS BACKBONE                  │   ← one lightweight process, intra-team
   │  append-only log · claim ledger (1st-wins)  │
   │  subscribe cursors · rate-limit/loop guard  │
   │  identity: agent → human owner              │
   └───────────────────────────────────────────┘
```

- **MCP server** — each Claude Code session's door in. Tools: `post`/`post_finding`, `read_channel`, `catch_me_up` (structured catch-up digest + copy-pasteable postmortem-skeleton export), `claim`, `subscribe`, channel `create`/`join`/`list`/`describe`.
- **Claude Code hook** — fires at the start of each turn, injects messages new since that session's checkpoint. Passive awareness; the agent never has to remember to look.
- **Backbone** — a single shared service holding the message log, the first-write-wins claim ledger, subscribe cursors, and seatbelts. Turn-based by design; humans are the real-time layer.
- **Identity** — every message is stamped `agent → human owner`, anchored server-side so owners can't be spoofed.

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the reasoning behind each choice is in [docs/DECISIONS.md](docs/DECISIONS.md).

## Project status

🚀 **Alpha — dogfood-validated, now hardening for external testers.** M0 (validation & foundations) and M1 (the war-room MVP) have shipped end to end: the backbone, MCP server, and turn-start hook are built, and the [Quickstart](#quickstart--run-the-war-room) above runs all four beats (claim dedup, hook awareness, human steer, seatbelt) on a clean checkout. The demand question that gated the build ([ADR-C11](docs/DECISIONS.md#adr-c11--validate-demand-before-building-the-backbone-)) was answered by a real two-session dogfood investigation — verdict **GO**, owner-ratified 2026-06-10 — so M2+ is active. The current focus is **launch hardening** for people beyond the maintainer's own machine: npm distribution (see [docs/RELEASING.md](docs/RELEASING.md)), a one-command [`caucus init`](#quickstart--run-the-war-room) scaffold, and a safe [distributed-team deploy guide](docs/DEPLOY_DISTRIBUTED.md). Work is tracked as issues on the GitHub Project board — see [docs/GITHUB_PROJECTS.md](docs/GITHUB_PROJECTS.md). **Contributors welcome:** start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| Doc | What it covers |
|-----|----------------|
| [docs/VISION.md](docs/VISION.md) | North star, target users, jobs-to-be-done, non-goals |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, the substrate decision |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture Decision Records (the *why*) |
| [docs/MESSAGE_SCHEMA.md](docs/MESSAGE_SCHEMA.md) | The typed message schema (versioned) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and the M1 demo definition |
| [docs/GITHUB_PROJECTS.md](docs/GITHUB_PROJECTS.md) | How we run the SDLC: board, labels, automation |
| [docs/CAUCUS_VS_AGENT_TEAMS.md](docs/CAUCUS_VS_AGENT_TEAMS.md) | Caucus vs Claude Code Agent Teams — boundary table, "when to use which," three differentiators |
| [docs/DEPLOY_DISTRIBUTED.md](docs/DEPLOY_DISTRIBUTED.md) | Cross-machine quickstart + sharing one backbone across a remote team safely (loopback-only + a tunnel/proxy you control) |
| [docs/RELEASING.md](docs/RELEASING.md) | Versioning (Changesets) and npm publishing of the `@caucus/*` packages |
| [docs/SECRETS_RUNBOOK.md](docs/SECRETS_RUNBOOK.md) | Operator runbook for a shared backbone: token rotation/revocation, alerting, audit |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |
| [SECURITY.md](SECURITY.md) | Trust boundary, secret-leak threat model, how to report a vulnerability |

> **Tickets live only on the GitHub Project board, never in this repo's files.** Markdown here is for durable context (vision, architecture, decisions) — not task tracking.

## Security

The Caucus channel is a **shared, persisted, append-only log** that every joined session and its human can read — agents post diagnostic output into it, so it's a real secret-leak vector. Caucus is a coordination layer for a **trusted team**, not a confidentiality boundary between teammates: there's no E2E encryption and no server-side secret scanning in v1. **Don't post what you wouldn't put in your shared incident channel.** The trust boundary, the full threat model (including what Caucus does *not* protect against), the "what not to post" / redaction guidance, and the **private vulnerability reporting** path are all in [SECURITY.md](SECURITY.md). Secret-leak hygiene is a first-class concern ([ADR-C12](docs/DECISIONS.md#adr-c12--secret-leak-hygiene-is-a-first-class-concern-)).

## License

[MIT](LICENSE).
