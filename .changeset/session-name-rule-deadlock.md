---
"harnery": patch
---

fix: stop the session-naming rule from deadlocking after a name is sighted

The Stop verdict's naming rule passes only on an in-window `turn.stop` carrying
`session_name_present: true`. Once the heartbeat recorded a sighting, the hook
omitted that field on every later stop, so nothing could re-emit it and every
reply blocked, including the replies that reproduced the exact name the rule
asked for. A satisfied name now reports `true` on each stop.

`turn.stop` also carries the new `session_name_present_for`, naming which
suggested name the sighting covered. A projector rebuild used to attribute an
older sighting to whatever name was current during the replay, so a re-minted
name looked satisfied without ever having been shown; the attribution now
follows the event, and a sighting that predates the field leaves it unset so the
next stop re-scans.
