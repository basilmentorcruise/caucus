/**
 * The seatbelt (ADR-C8) — per-agent rate limiting + loop/duplicate detection,
 * plus the CAU-74 resource-cap hardening (a cross-channel global rate counter,
 * a channel-create throttle, and bounded internal state via idle eviction with
 * an LRU backstop).
 *
 * Pure, synchronous policy + state. NO `await` anywhere — and NO timers: the
 * backbone calls into the seatbelt from inside its claim critical section (the
 * first-write-wins compare-and-set), where any `await` would break atomicity,
 * and a `setInterval` would keep the process alive / introduce nondeterminism.
 * Everything here is plain in-memory bookkeeping; housekeeping happens lazily
 * on the write paths (see "Eviction" below).
 *
 * Protections:
 * - **Rate limit (per channel)** — a sliding window: at most
 *   {@link SeatbeltOptions.maxPostsPerMinute} posts per `(channel, agent_id)`
 *   per {@link SEATBELT_WINDOW_MS}. Over-cap throws {@link RateLimitedError}
 *   with an actionable message + `retryAfterMs`.
 * - **Rate limit (global, CAU-74)** — a second sliding window keyed by
 *   `agent_id` alone, capping an agent's posts ACROSS all channels at
 *   {@link SeatbeltOptions.globalMaxPostsPerMinute} (default
 *   {@link DEFAULT_GLOBAL_RATE_MULTIPLIER} × the effective per-channel cap).
 *   Without it, spreading a flood across channels multiplies the budget.
 * - **Create throttle (CAU-74)** — {@link admitChannelCreate} caps channel
 *   creates per creator identity at
 *   {@link SeatbeltOptions.maxChannelCreatesPerMinute}, closing the
 *   channel-minting amplification loop.
 * - **Loop/dup** — an agent posting content identical to its own
 *   immediately-previous post (`type + " " + body.trim()`) throws
 *   {@link DuplicatePostError}. MVP compares the last post (N=1 consecutive);
 *   the {@link SeatbeltOptions.dupWindow} knob exists for a future widening.
 *
 * **Eviction (CAU-74).** Seatbelt state used to grow one entry per
 * `(channel, agent_id)` forever. Now a lazy sweep — run at the top of every
 * public mutator, at most once per `windowMs`, never from a timer — prunes
 * each entry's window and EVICTS an entry once it is idle: no in-window posts
 * AND no activity for at least a full window. Evicting an entry drops its
 * `lastDupKey` too, which is a documented dup-forgetting nuance: an identical
 * re-post more than a window after the original is ADMITTED. ADR-C8 targets
 * consecutive tight loops, not repeats separated by 60+ seconds of quiet, so
 * this is acceptable. An LRU backstop additionally caps each internal map at
 * {@link SeatbeltOptions.maxTrackedAgents} entries (insertion order is kept as
 * recency order via touch-on-access), so even a constant stream of brand-new
 * identities cannot grow state without bound.
 *
 * The clock is injectable ({@link SeatbeltOptions.clock}, default `Date.now`) so
 * window behavior is deterministic in tests without real waits. The seatbelt
 * uses this clock — NOT the backbone's monotonic `ts` stamp — for windowing.
 *
 * The append/claim split: callers can stage the work so a *losing* claim is not
 * charged budget. {@link Seatbelt.checkRate} throws if at cap but records
 * nothing; {@link Seatbelt.recordRate} records a post; {@link Seatbelt.admit}
 * is the combined check + dup-check + record used on the unconditional append
 * path. (See `claim()` in `in-memory.ts` for why the split matters.) Both
 * budgets — per-channel and global — follow the same split: a losing claim
 * charges neither.
 */
import { DuplicatePostError, RateLimitedError } from "./errors.js";

/** Default per-agent posts/minute cap. Normal demo traffic stays well under it. */
export const DEFAULT_MAX_POSTS_PER_MINUTE = 30;

/**
 * Default consecutive-duplicate window (N). MVP behavior compares the agent's
 * single immediately-previous post; the knob exists for a future widening.
 */
export const DEFAULT_DUP_WINDOW = 1;

/** The rate-limit sliding-window span, in milliseconds (one minute). */
export const SEATBELT_WINDOW_MS = 60_000;

/**
 * Default multiplier deriving the agent-global (cross-channel) posts/minute cap
 * from the effective per-channel cap: `4 × maxPostsPerMinute` (so 120/min with
 * the defaults). An explicitly supplied `globalMaxPostsPerMinute` wins as-given.
 */
export const DEFAULT_GLOBAL_RATE_MULTIPLIER = 4;

/** Default channel-creates/minute cap per creator identity (CAU-74). */
export const DEFAULT_MAX_CHANNEL_CREATES_PER_MINUTE = 10;

/**
 * Default LRU backstop: the maximum number of entries EACH internal seatbelt
 * map may hold (per-`(channel, agent)`, per-agent global, per-creator). Idle
 * eviction is the primary bound; this cap is the hard ceiling against a stream
 * of brand-new identities arriving faster than they go idle.
 */
export const DEFAULT_MAX_TRACKED_AGENTS = 4096;

/** Tunables for the {@link Seatbelt}. All optional; defaults match the constants. */
export interface SeatbeltOptions {
  /** Per-agent posts/minute cap. Default {@link DEFAULT_MAX_POSTS_PER_MINUTE}. */
  readonly maxPostsPerMinute?: number;
  /**
   * Agent-global (cross-channel) posts/minute cap (CAU-74). Default:
   * {@link DEFAULT_GLOBAL_RATE_MULTIPLIER} × the effective `maxPostsPerMinute`.
   * An explicitly supplied value is used as-given (no multiplier applied).
   */
  readonly globalMaxPostsPerMinute?: number;
  /**
   * Channel-creates/minute cap per creator identity (CAU-74). Default
   * {@link DEFAULT_MAX_CHANNEL_CREATES_PER_MINUTE}.
   */
  readonly maxChannelCreatesPerMinute?: number;
  /**
   * LRU backstop: maximum entries per internal seatbelt map (CAU-74). Default
   * {@link DEFAULT_MAX_TRACKED_AGENTS}.
   */
  readonly maxTrackedAgents?: number;
  /** Consecutive-duplicate window N. Default {@link DEFAULT_DUP_WINDOW}. */
  readonly dupWindow?: number;
  /** Sliding-window span in ms. Default {@link SEATBELT_WINDOW_MS}. */
  readonly windowMs?: number;
  /** Injectable clock (ms since epoch). Default `Date.now`, for determinism. */
  readonly clock?: () => number;
}

/**
 * The sliding-window state every seatbelt map entry carries: in-window post
 * timestamps plus the last instant the entry was touched (read or written),
 * which drives idle eviction.
 */
interface WindowState {
  /**
   * Ascending timestamps of in-window posts. Entries older than `now - windowMs`
   * are dropped on each access, so the array is bounded by the cap.
   */
  readonly postTimes: number[];
  /** Last instant this entry was accessed (any check or record). */
  lastActivity: number;
}

/** Per-`(channel, agent_id)` mutable seatbelt state. */
interface AgentState extends WindowState {
  /** dupKey of the agent's immediately-previous post (`undefined` until first). */
  lastDupKey: string | undefined;
}

/**
 * Compose the loop-detection key for a post: its type and trimmed body. Trimming
 * means whitespace-only variations of the same content still count as a repeat.
 * A different `type` with the same body is NOT a duplicate.
 */
export function dupKeyFor(type: string, body: string): string {
  return `${type} ${body.trim()}`;
}

export class Seatbelt {
  readonly #maxPostsPerMinute: number;
  readonly #globalMaxPostsPerMinute: number;
  readonly #maxChannelCreatesPerMinute: number;
  readonly #maxTrackedAgents: number;
  readonly #windowMs: number;
  readonly #clock: () => number;

  /**
   * State keyed by {@link Seatbelt.#key}: `channel + "\u0000" + agent_id`.
   * NUL is a safe separator because it genuinely cannot appear in either
   * part: channel slugs forbid it, and write-time validation (CAU-71)
   * rejects every control character in `agent_id` — whereas plain spaces
   * ARE allowed in `agent_id`, so a printable separator could collide
   * distinct pairs.
   */
  readonly #agents = new Map<string, AgentState>();

  /** Cross-channel rate state keyed by `agent_id` alone (CAU-74). */
  readonly #global = new Map<string, WindowState>();

  /** Channel-create rate state keyed by creator identity string (CAU-74). */
  readonly #creators = new Map<string, WindowState>();

  /**
   * When the last full eviction sweep ran. Starts at `-Infinity` so the first
   * mutator call sweeps (a sweep over empty maps is free).
   */
  #lastSweep = -Infinity;

  constructor(opts: SeatbeltOptions = {}) {
    this.#maxPostsPerMinute =
      opts.maxPostsPerMinute ?? DEFAULT_MAX_POSTS_PER_MINUTE;
    this.#globalMaxPostsPerMinute =
      opts.globalMaxPostsPerMinute ??
      this.#maxPostsPerMinute * DEFAULT_GLOBAL_RATE_MULTIPLIER;
    this.#maxChannelCreatesPerMinute =
      opts.maxChannelCreatesPerMinute ?? DEFAULT_MAX_CHANNEL_CREATES_PER_MINUTE;
    this.#maxTrackedAgents = opts.maxTrackedAgents ?? DEFAULT_MAX_TRACKED_AGENTS;
    this.#windowMs = opts.windowMs ?? SEATBELT_WINDOW_MS;
    this.#clock = opts.clock ?? Date.now;
    // `dupWindow` is accepted for forward-compatibility; MVP behavior is N=1
    // (compare the immediately-previous post) regardless of the supplied value.
    void (opts.dupWindow ?? DEFAULT_DUP_WINDOW);
  }

  /**
   * The current time from the injected clock (default `Date.now`). The backbone
   * reads this once per operation and passes it as the `now` argument to
   * {@link checkRate} / {@link recordRate} / {@link admit} /
   * {@link admitChannelCreate}, so a single op sees a single consistent instant
   * and tests can drive windows deterministically by injecting a clock.
   */
  now(): number {
    return this.#clock();
  }

  /**
   * Total entries currently tracked across the three internal maps
   * (per-`(channel, agent)` + per-agent global + per-creator). Read-only and
   * exposed ONLY as a test/operational diagnostic for the CAU-74 eviction and
   * LRU-backstop behavior — production callers never branch on it, and its
   * exact value (a function of sweep timing) is not part of the contract.
   */
  get trackedEntryCount(): number {
    return this.#agents.size + this.#global.size + this.#creators.size;
  }

  #key(channel: string, agentId: string): string {
    // NUL separator, written as an escape sequence (a literal NUL byte in
    // source would make git treat the file as binary). See the `#agents` doc
    // for why NUL is the one safe choice: spaces may appear inside `agent_id`.
    return `${channel}\u0000${agentId}`;
  }

  /**
   * Resolve (creating if absent) the entry for `key` in `map`, with the CAU-74
   * bookkeeping: touch-on-access re-insertion (delete + set) keeps the Map's
   * insertion order equal to recency order, `lastActivity` is stamped on EVERY
   * access (so an actively-throttled spammer is never evicted mid-flood), and
   * after inserting a brand-new entry the LRU backstop evicts from the front
   * (the least-recently-used key) while the map exceeds `maxTrackedAgents`.
   */
  #resolve<S extends WindowState>(
    map: Map<string, S>,
    key: string,
    create: () => S,
    now: number,
  ): S {
    let state = map.get(key);
    if (state === undefined) {
      state = create();
      map.set(key, state);
      // LRU backstop: insertion order IS recency order (touch-on-access below),
      // so the front of the map is the least-recently-used entry.
      while (map.size > this.#maxTrackedAgents) {
        const oldest = map.keys().next();
        /* v8 ignore next -- unreachable: a non-empty map always yields a key */
        if (oldest.done === true) break;
        map.delete(oldest.value);
      }
    } else {
      // Touch-on-access: re-insert so this entry moves to the back (most
      // recently used).
      map.delete(key);
      map.set(key, state);
    }
    state.lastActivity = now;
    return state;
  }

  /** Resolve (creating if absent) the per-`(channel, agent)` state. */
  #state(channel: string, agentId: string, now: number): AgentState {
    return this.#resolve(
      this.#agents,
      this.#key(channel, agentId),
      () => ({ postTimes: [], lastDupKey: undefined, lastActivity: now }),
      now,
    );
  }

  /** Resolve (creating if absent) the per-agent global (cross-channel) state. */
  #globalState(agentId: string, now: number): WindowState {
    return this.#resolve(
      this.#global,
      agentId,
      () => ({ postTimes: [], lastActivity: now }),
      now,
    );
  }

  /** Resolve (creating if absent) the per-creator channel-create state. */
  #creatorState(creator: string, now: number): WindowState {
    return this.#resolve(
      this.#creators,
      creator,
      () => ({ postTimes: [], lastActivity: now }),
      now,
    );
  }

  /**
   * Drop in-place every timestamp older than `now - windowMs`. Leaves only the
   * still-in-window entries, ascending. Keeps memory bounded by the cap.
   */
  #prune(postTimes: number[], now: number): void {
    const cutoff = now - this.#windowMs;
    let drop = 0;
    while (drop < postTimes.length && postTimes[drop]! <= cutoff) drop++;
    if (drop > 0) postTimes.splice(0, drop);
  }

  /**
   * Lazy eviction sweep (CAU-74): at most once per `windowMs`, walk all three
   * maps, prune each entry's window, and evict every entry that is fully idle
   * (no in-window posts AND untouched for at least a full window). Runs at the
   * top of every public mutator — NO timers, NO `setInterval` — so the seatbelt
   * stays pure/synchronous and safe inside the claim critical section. O(n) in
   * tracked entries, amortized to once per window.
   *
   * Eviction drops a per-`(channel, agent)` entry's `lastDupKey` with it: an
   * identical re-post arriving more than a window after the original is
   * therefore ADMITTED. That is deliberate — ADR-C8's loop detector targets
   * consecutive tight loops, not repeats separated by 60+ seconds of quiet.
   */
  #maybeSweep(now: number): void {
    if (now - this.#lastSweep < this.#windowMs) return;
    this.#lastSweep = now;
    this.#sweep(this.#agents, now);
    this.#sweep(this.#global, now);
    this.#sweep(this.#creators, now);
  }

  /** Prune every entry in `map`; evict the entries that are fully idle. */
  #sweep<S extends WindowState>(map: Map<string, S>, now: number): void {
    for (const [key, state] of map) {
      this.#prune(state.postTimes, now);
      if (
        state.postTimes.length === 0 &&
        now - state.lastActivity >= this.#windowMs
      ) {
        map.delete(key);
      }
    }
  }

  /**
   * Throw {@link RateLimitedError} if the agent is already at the per-channel
   * cap OR the cross-channel global cap for the window ending at `now`;
   * otherwise return having recorded NOTHING. Safe to call before a conditional
   * write (e.g. a claim that may lose) so a no-op write is not charged budget.
   * The per-channel budget is checked first; a global rejection carries a
   * distinct ("across all channels") message via `scope: "global"`.
   *
   * `retryAfterMs` is how long until the oldest in-window post of the bound
   * budget ages out: `oldestKept + windowMs - now`.
   */
  checkRate(channel: string, agentId: string, now: number): void {
    this.#maybeSweep(now);
    const state = this.#state(channel, agentId, now);
    this.#prune(state.postTimes, now);
    const global = this.#globalState(agentId, now);
    this.#prune(global.postTimes, now);
    if (state.postTimes.length >= this.#maxPostsPerMinute) {
      const oldest = state.postTimes[0]!;
      const retryAfterMs = oldest + this.#windowMs - now;
      throw new RateLimitedError(this.#maxPostsPerMinute, retryAfterMs);
    }
    if (global.postTimes.length >= this.#globalMaxPostsPerMinute) {
      const oldest = global.postTimes[0]!;
      const retryAfterMs = oldest + this.#windowMs - now;
      throw new RateLimitedError(
        this.#globalMaxPostsPerMinute,
        retryAfterMs,
        "global",
      );
    }
  }

  /**
   * Record a post at `now` against BOTH the agent's per-channel and global rate
   * windows. Never throws.
   */
  recordRate(channel: string, agentId: string, now: number): void {
    this.#maybeSweep(now);
    const state = this.#state(channel, agentId, now);
    this.#prune(state.postTimes, now);
    state.postTimes.push(now);
    const global = this.#globalState(agentId, now);
    this.#prune(global.postTimes, now);
    global.postTimes.push(now);
  }

  /**
   * Throw {@link DuplicatePostError} if `dupKey` equals the agent's
   * immediately-previous post key; otherwise return having recorded NOTHING.
   */
  checkDup(channel: string, agentId: string, dupKey: string): void {
    const state = this.#state(channel, agentId, this.#clock());
    if (state.lastDupKey === dupKey) {
      throw new DuplicatePostError();
    }
  }

  /** Record `dupKey` as the agent's most-recent post key. Never throws. */
  recordDup(channel: string, agentId: string, dupKey: string): void {
    this.#state(channel, agentId, this.#clock()).lastDupKey = dupKey;
  }

  /**
   * The combined gate for the unconditional append path: rate-check (per-channel
   * AND global), dup-check, then (only if both pass) record both. Throws BEFORE
   * recording anything on either failure, so a rejected post consumes no budget
   * and does not become the new dup baseline.
   */
  admit(channel: string, agentId: string, dupKey: string, now: number): void {
    this.#maybeSweep(now);
    this.checkRate(channel, agentId, now);
    this.checkDup(channel, agentId, dupKey);
    this.recordRate(channel, agentId, now);
    this.recordDup(channel, agentId, dupKey);
  }

  /**
   * The channel-create throttle (CAU-74): throw {@link RateLimitedError} (scope
   * `"create"`) if `creator` is already at `maxChannelCreatesPerMinute` for the
   * window ending at `now`; otherwise RECORD the create and return. Check and
   * record are deliberately combined — the backbone calls this as the LAST gate
   * before an infallible `Map.set`, so a recorded create always corresponds to
   * a created channel.
   */
  admitChannelCreate(creator: string, now: number): void {
    this.#maybeSweep(now);
    const state = this.#creatorState(creator, now);
    this.#prune(state.postTimes, now);
    if (state.postTimes.length >= this.#maxChannelCreatesPerMinute) {
      const oldest = state.postTimes[0]!;
      const retryAfterMs = oldest + this.#windowMs - now;
      throw new RateLimitedError(
        this.#maxChannelCreatesPerMinute,
        retryAfterMs,
        "create",
      );
    }
    state.postTimes.push(now);
  }
}
