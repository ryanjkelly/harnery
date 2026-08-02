/**
 * Preflight: would every specialist on this team land on the same adapter?
 *
 * Harnery does not auto-spread. A specialist without an `adapter` pin inherits
 * the run's default, so a team whose profiles all omit the pin puts every child
 * on one adapter. That is legal and sometimes intended. It is a problem when the
 * host is also `subscriptionOnly`, because then the concentration lands on one
 * seat's session meter rather than on metered per-token billing: the seat hits
 * its limit, and every specialist stops at once rather than the team degrading.
 *
 * The check is deliberately narrow, because a false refusal here is worse than
 * the miss it prevents. It fires only when all four hold:
 *
 *   1. more than one specialist (a solo team cannot spread),
 *   2. every specialist resolves to the same adapter,
 *   3. `subscriptionOnly` is on (otherwise concentration is a cost curve, not a
 *      cliff), and
 *   4. more than one adapter is ATTESTED REACHABLE.
 *
 * Condition 4 is the one worth insisting on. Counting *declared* adapters would
 * suggest spreading onto a seat that cannot run — a dead adapter passes a
 * declaration check and then fails every child it is handed. Only an
 * attestation records that the adapter actually completed a turn on this
 * machine, so only an attestation is grounds for telling someone to use it.
 */

export interface AdapterSpreadInput {
  /** Specialist id → its optional adapter pin. */
  specialists: Readonly<Record<string, { adapter?: string }>>;
  /** The adapter an unpinned specialist inherits. */
  defaultAdapter: string;
  /** Adapters with a live attestation on this machine — proven to run, not
   * merely registered. */
  reachable: readonly string[];
  /** Whether children are confined to subscription (logged-in) auth. */
  subscriptionOnly: boolean;
}

export interface AdapterSpreadVerdict {
  /** True when the team would put every child on one adapter AND that is worth
   * refusing over. False both when the team spreads and when concentrating is
   * unremarkable (single specialist, one reachable adapter, metered billing). */
  concentrated: boolean;
  /** The adapter everything would land on, when concentrated. */
  adapter?: string;
  /** Operator-facing explanation, present exactly when concentrated. */
  reason?: string;
  /** Attested-reachable adapters this team is not using. */
  unused: string[];
}

export function inspectAdapterSpread(input: AdapterSpreadInput): AdapterSpreadVerdict {
  const ids = Object.keys(input.specialists);
  const resolved = ids.map((id) => input.specialists[id]?.adapter ?? input.defaultAdapter);
  const distinct = [...new Set(resolved)];
  const unused = input.reachable.filter((a) => !distinct.includes(a));

  if (ids.length < 2 || distinct.length !== 1 || !input.subscriptionOnly || unused.length === 0) {
    return { concentrated: false, unused };
  }

  const adapter = distinct[0] as string;
  const pinned = ids.filter((id) => input.specialists[id]?.adapter).length;
  // Say which of the two shapes this is. "You wrote no pins" and "you pinned
  // them all to one" need different corrections, and a single generic message
  // would send half the readers looking in the wrong place.
  const how =
    pinned === 0
      ? `no specialist pins an adapter, so all ${ids.length} inherit the default (${adapter})`
      : `all ${ids.length} specialists resolve to ${adapter}`;
  return {
    concentrated: true,
    adapter,
    unused,
    reason:
      `${how}, and children are confined to subscription auth — so one seat carries the whole ` +
      `team and every specialist stops together when it hits its limit. ` +
      `${unused.length === 1 ? "This adapter is" : "These adapters are"} attested and idle: ` +
      `${unused.join(", ")}. Pin some specialists onto ${unused.length === 1 ? "it" : "them"}, ` +
      `or pass --allow-single-adapter if one seat is what you want.`,
  };
}
