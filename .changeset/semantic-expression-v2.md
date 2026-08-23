---
"harnery": minor
---

Add Semantic Expression V2. Semantic readers may propose an optional,
evidence-cited expression cue for an otherwise neutral Codec portrait. The cue
uses a controlled vocabulary, model-synthesis basis, and medium or low
confidence. Event-backed expressions retain precedence, and the derived
read-model storage moves to `.harnery/semantic/v2/` without reading V1 caches.
Each structured reply is bound to the request's exact generation ID and
evidence digest before it can be persisted.
