# Initial source rules

`DM84.json` and `7sefun.json` are copied unchanged from the original Kazumi
project's `assets/plugins` directory (https://github.com/Predidit/Kazumi).
They are inserted only when a data directory has no `rules.json` yet. Changes
and deletions thereafter are preserved. Source availability is external to this
application; users can update rules from the official KazumiRules repository.

The rule catalog reads the configured repository and persists successfully read
indexes and rule details in `DATA_DIR/rule-catalog/`. On a repository outage it
can reuse that repository's cache. Without a cache it reports the repository as
unavailable. The runtime does not bundle a complete official rule snapshot.

Commit-pinned official rule samples live in `test/compatibility/official-rules.json`
for repeatable compatibility tests. They are not loaded by the application or
included in the production image, and are refreshed manually when needed by tests.
