---
"harnery": patch
---

`schedule install` writes plain descriptions on its systemd units: the service "Starts any Harnery jobs that are due in <project> (harnery schedule tick)" and the timer "Checks every few minutes for Harnery jobs due in <project>". Reinstall the timer to pick them up.
