---
"harnery": minor
---

Add a local server registry (`harnery/core/servers`) and `servers list|stop|gc|logs|open|register|unregister|touch`. Tools record the servers they start under `.harnery/servers/`; the list also scans for listening processes inside the project that never registered. `gc` stops idle session servers whose starting agent has ended. Tunnels now register on `up` and `reload`, are removed on `down`, and are adopted when found running without a record.
