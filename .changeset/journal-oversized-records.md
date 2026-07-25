---
"harnery": minor
---

Stop an oversized workflow journal record from breaking work listing or the run
that writes it.

The writer and the reader disagreed on size, and nothing kept them in agreement:
records were written up to 32 KiB while the reader refused anything over 16 KiB,
so a single large agent result made `work list` fail for every work item at once.
The engine also bypassed the bounded writer entirely with a raw append.

Both sides now hold. `appendWorkflowJournalEvent` is the only writer, and instead
of refusing an oversized record it drops the largest fields for a digest and byte
count, names them under `omitted_fields`, and always writes. Refusing was not an
option: `run.start` carries workflow metadata and frozen work context that
Harnery's own validators permit to exceed the limit, so a valid run could fail on
its opening line. On the read side, a journal that still cannot be parsed marks
that attempt `journal_unreadable` and blocks it with the reason, leaving every
other work item listable.
