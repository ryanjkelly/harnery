---
"harnery": minor
---

qa-run now takes turns and survives disconnects. Every run queues on the
machine-wide "browser-qa" admission resource by default (capacity 2, tunable
via HARNERY_QA_ADMISSION_CAPACITY or --queue-capacity, opt out with
--no-queue); the wait is recorded as wall_time_ms.queue and never counted in
total, and an admission timeout (--queue-timeout, default 20 minutes)
finalizes a normal incomplete result with an "admission" blocker so the
evidence trail survives a full queue. Runs are durable: every run directory
now carries job.json (the effective validated job, usable with qa-verify
--job) and run-status.json (live state, current stage, and a 15-second
heartbeat), and --detach launches the matrix as a detached background process
with output in runner.log, printing the run directory and returning
immediately. Two new commands complete the loop: qa-status reports a run's
live state (launching/queued/running/completed, plus derived dead), reconnects
to detached runs with --wait using the runner's own exit codes, and shows the
admission queue with --queue; admission is the generic wrapper (admission run
--resource <name> -- <command...>, admission status) that makes any heavy job
take turns on one machine via crash-safe FIFO file tickets with dead-PID and
TTL pruning under $TMPDIR/harnery-admission or HARNERY_ADMISSION_DIR.
