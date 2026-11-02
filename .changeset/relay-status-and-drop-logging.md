---
"harnery": minor
---

New `presence relay-status` command shows whether the presence relay is working on this machine, using local files only. Its JSON lists the configured relay URL, the first 8 characters of the room id (never the key), the daemon's pid record and whether that process is alive, the latest connect, disconnect and idle exit from the presence-relay log, the other machines heard from over the relay and over git refs (names, agent counts and ages, no task text), and the last git publish. On a terminal without `--json` it prints a short summary.

The relay daemon now logs each dropped connection as a `relay.disconnected` record with the close code, a shortened reason, whether the close was clean, how long the socket was up, any socket error, and the reconnect delay. Before this change, drops showed up only as extra "connected" lines. Backoff now resets only after a connection has stayed up for 30 seconds, so a relay that accepts and immediately closes the socket no longer causes a reconnect every second. A run of failed attempts logs only a few records, and each one says how many were skipped since the last.
