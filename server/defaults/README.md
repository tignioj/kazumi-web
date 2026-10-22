# Initial source rules

`DM84.json` and `7sefun.json` are copied unchanged from the original Kazumi
project's `assets/plugins` directory (https://github.com/Predidit/Kazumi).
They are inserted only when a data directory has no `rules.json` yet. Changes
and deletions thereafter are preserved. Source availability is external to this
application; users can update rules from the official KazumiRules repository.

`official-rules.json` is the complete, commit-pinned KazumiRules snapshot used
both by offline catalog fallback and the compatibility corpus. It does not seed
or overwrite installed rules. Only the default official repository can use this
fallback; custom repositories use their own persisted cache. The upstream rule
update workflow updates this single snapshot after review, keeping runtime and
compatibility fixtures aligned.
