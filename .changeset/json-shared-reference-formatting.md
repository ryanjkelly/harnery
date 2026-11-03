---
"harnery": patch
---

Render repeated object and array references in colorJson without falsely marking them circular. Guard cycles introduced by toJSON and handle toJSON returning the original object without unbounded recursion.
