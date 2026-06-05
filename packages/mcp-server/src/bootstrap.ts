/**
 * Startup bootstrap (CAU-12).
 *
 * {@link ensureChannel} guarantees the session's configured channel exists
 * before the stdio server starts serving. Without it, a freshly-spawned server
 * runs against a backbone that has never had `CAUCUS_CHANNEL` created, so every
 * `caucus_post` / `caucus_claim` fails with `unknown_channel` (reads tolerate a
 * missing room, writes do not) — the end-to-end gap validated by the CAU-10
 * gate.
 *
 * It is idempotent: an existing channel is a no-op (we never re-create or mutate
 * it), a missing one is created and attributed to the configured owner, and any
 * OTHER backbone error (a malformed channel slug from a bad `CAUCUS_CHANNEL`,
 * say) propagates untouched so it surfaces at startup rather than being
 * swallowed. It lives here — not inlined in `index.ts` — so it is unit-testable
 * without spawning a subprocess.
 */
import { ChannelExistsError, UnknownChannelError } from "@caucus/backbone";
import type { Backbone, ChannelDescriptor } from "@caucus/backbone";
import type { ServerConfig } from "./config.js";

/**
 * Ensure `config.channel` exists on `backbone`, creating it if absent.
 *
 * @returns the channel's descriptor (pre-existing or freshly created).
 * @throws any non-{@link UnknownChannelError} the backbone raises (e.g. an
 *   invalid channel slug), so a misconfiguration fails loudly at startup.
 */
export async function ensureChannel(
  backbone: Backbone,
  config: ServerConfig,
): Promise<ChannelDescriptor> {
  const { channel } = config;
  try {
    // Already created ⇒ no-op: never re-create or overwrite an existing room.
    return await backbone.describeChannel(channel);
  } catch (err) {
    // Only a genuinely-missing channel triggers creation. Anything else (a
    // malformed slug ⇒ InvalidChannelNameError) is a real misconfiguration and
    // must propagate, not be masked by a create attempt.
    if (!(err instanceof UnknownChannelError)) throw err;
    try {
      return await backbone.createChannel({
        channel,
        purpose: "caucus session channel (auto-created at startup)",
        created_by: config.identity.owner,
      });
    } catch (createErr) {
      // describe-then-create is a TOCTOU: two sessions booting concurrently
      // against a SHARED backbone (CAU-50, HttpBackbone) can both see
      // "missing" and race the create. Losing that race means the channel now
      // exists — which is this function's success condition, not a failure.
      // Caught by error type so it survives the HTTP 409 → ChannelExistsError
      // reconstruction. Anything else still propagates.
      if (!(createErr instanceof ChannelExistsError)) throw createErr;
      return backbone.describeChannel(channel);
    }
  }
}
