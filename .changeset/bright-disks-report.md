---
"harnery": minor
---

Add a read-only `disk` command for checkout usage, including nested repositories
and submodules. Filter by Git state, file type, excluded paths, and minimum size;
group by directory, repository, extension, Git state, or largest files. Reports
distinguish allocated disk blocks from file lengths and deduplicate hard links.
