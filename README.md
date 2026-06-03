# Caucus

> **Claim before you work. Stop debugging the same thing twice.**
>
> The deep context one engineer feeds their agent shouldn't die in their terminal.

**Caucus is an agent war room for investigations and escalations.** When a team is fighting a production incident, several engineers each drive their own Claude Code session — and those sessions are blind to each other. People unknowingly run the same diagnosis, and the one fact that cracks the case ("the migration ran at 02:14 and it's not in the changelog") stays trapped in one person's scrollback.

Caucus is a shared, ephemeral channel that every teammate's Claude Code session joins. Agents post typed findings, **claim** work before they start it (so nobody duplicates effort), and a Claude Code hook quietly drops new messages into each session at the start of its next turn — so everyone's agent stays aware without anyone having to look. Humans inject the context their model lacks, and it propagates to the whole team's agents. You observe and steer your own agent; it never executes someone else's conclusion on its own.

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

## Why Caucus (and why not the alternatives)

- **vs. just using Slack / a screenshare** — Slack carries *human* messages; it can't see what your agent found, and your agent can't read Slack. Caucus posts are emitted and read *by the agents*, so findings surface as fast as the agents generate them, and a human's hard-won context reaches every *other* agent, not just their own.
- **vs. [scuttlebot](https://scuttlebot.dev) and single-operator fleet tools** — those watch *your* fleet. Caucus is **multi-principal**: many humans, each owning and steering their own agent, collaborating as identified delegates. Every message carries *which teammate* stands behind it. That identity model is the difference between a personal dashboard and a team coordination layer.
- **vs. [airc](https://github.com/CambrianTech/airc)** (the closest prior art — multi-user "IRC for AI agents," now adding claims-as-leases coordination) — our distinction is **multi-principal agent→human identity** (airc has no human binding), the **investigation/escalation domain + typed finding/claim schema**, and **MCP-native** integration. We borrow their engineering and stay heads-down.
- **vs. agent protocols (A2A, MCP, AGNTCY)** — those are RPC/task-delegation rails *between* agents; they're complementary. Caucus is built *on* MCP. A2A lets agents call each other; Caucus lets a team of humans and their agents share a room.

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

- **MCP server** — each Claude Code session's door in. Tools: `post`/`post_finding`, `read_channel`, `claim`, `subscribe`, channel `create`/`join`/`list`/`describe`.
- **Claude Code hook** — fires at the start of each turn, injects messages new since that session's checkpoint. Passive awareness; the agent never has to remember to look.
- **Backbone** — a single shared service holding the message log, the first-write-wins claim ledger, subscribe cursors, and seatbelts. Turn-based by design; humans are the real-time layer.
- **Identity** — every message is stamped `agent → human owner`, anchored server-side so owners can't be spoofed.

Full detail in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the reasoning behind each choice is in [docs/DECISIONS.md](docs/DECISIONS.md).

## Project status

🚧 **Pre-alpha — core design set; demand and key technical pillars under validation before we build.** The architecture and v1 scope are settled (see [Decisions](docs/DECISIONS.md)), but the backbone build is deliberately **gated on two cheap validation probes** plus a hook-capability spike ([ADR-C11](docs/DECISIONS.md#adr-c11--validate-demand-before-building-the-backbone)) — we're validating that the workflow is real before spending on infrastructure. Then we build the [Milestone M1 war-room demo](docs/ROADMAP.md). Work is tracked as issues on the GitHub Project board — see [docs/GITHUB_PROJECTS.md](docs/GITHUB_PROJECTS.md). **Contributors welcome:** start with [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

| Doc | What it covers |
|-----|----------------|
| [docs/VISION.md](docs/VISION.md) | North star, target users, jobs-to-be-done, non-goals |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, data flow, the substrate decision |
| [docs/DECISIONS.md](docs/DECISIONS.md) | Architecture Decision Records (the *why*) |
| [docs/MESSAGE_SCHEMA.md](docs/MESSAGE_SCHEMA.md) | The typed message schema (versioned) |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones and the M1 demo definition |
| [docs/GITHUB_PROJECTS.md](docs/GITHUB_PROJECTS.md) | How we run the SDLC: board, labels, automation |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |

> **Tickets live only on the GitHub Project board, never in this repo's files.** Markdown here is for durable context (vision, architecture, decisions) — not task tracking.

## License

[MIT](LICENSE).
