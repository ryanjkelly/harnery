---
"harnery": patch
---

fix(agents): arm the claim-ordering rule only on genuine cross-agent contention

The ordering rule (acquire file claims in sorted-path order to prevent a
circular wait) previously armed whenever ANY fresh peer held ANY claim, so a
peer editing completely unrelated files across the repo walled off every
backward-order edit an agent tried to make. That was the dominant real-world
cost of the rule: it fired almost never on a genuine deadlock but forced agents
into awkward subprocess/heredoc write workarounds all session long — workarounds
that are themselves uncoordinated, defeating the guard's purpose.

A wait-for cycle is a strongly-connected set of agents linked by shared files.
If no fresh peer shares any file with our footprint (held claims ∪ the path
being requested), we sit in a disjoint component of the resource graph and
cannot be part of any cycle, so sorted-order acquisition buys nothing. The rule
now arms only when a fresh peer's held set intersects that footprint. Sharing a
file is the necessary condition for a cycle through this agent, so the
deadlock-prevention invariant is unchanged for genuine contention; only the
false positives (an unrelated peer arming the rule) are removed.

This is the fourth narrowing of the same rule, following committed-clean
exemption (0b4ed15), out-of-repo skip (1b130a9), and the re-edit exemption
(e41fb65).
