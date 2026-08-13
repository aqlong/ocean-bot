/**
 * Single source of truth for "does this commit message reference this
 * backlog id?" matching. Shared between the send-side ship-gate
 * (runner.ts ensureBacklogIdFooter) and the receive-side auto-close
 * (journal.ts findReferencedBacklogIds).
 *
 * Kebab-case-id-safe: rejects substring matches like `svc-1` inside
 * `svc-10`. JS \b doesn't treat `-` as a word-boundary character
 * (hyphen is non-word, so \b fires AT the hyphen), so explicit
 * lookarounds include `-` in the "still inside an id" predicate.
 *
 * Load-bearing because send + receive must agree: a drift means either
 * the ship-gate adds redundant footers (the receive side already saw
 * the id) or the receive side misses a footer the gate thought it
 * added. Consolidating here makes the matching rule one diff away from
 * impossible to mismatch.
 */

const REGEX_META = /[.*+?^${}()|[\]\\]/g;

export function isBacklogIdReferenced(message: string, id: string): boolean {
  if (!message || !id) return false;
  const escaped = id.replace(REGEX_META, "\\$&");
  return new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(message);
}
