---
"harnery": patch
---

`harn computer status --json` and `harn computer sign-in --json` report `person_sign_in`, the person's saved agent sign-in choice before the project and desktop gates. When their own desktop mode is off, the `sign-in:` status line says a saved `on` is inactive, returns with desktop control, and can be removed with `sign-in off`. The dashboard's Permissions page no longer treats a person's own computer-use Off as the project's, so the mode buttons stay available; it shows invalid computer settings as an error, keeps sign-in Off selectable while computer use is off, and allows one settings change at a time across its routes.
