# Lexicons

Canonical schemas live under `app/openfirmware/`, matching NSID path layout used by `goat lex` / `@atproto/lex`.

Authority for `app.openfirmware.*` is DNS for `openfirmware.app` (`_lexicon.openfirmware.app` TXT `did=...`). Publish with `goat lex publish` once that DID is live.

Do not use the legacy `lexicons/firmware|device|fleet` tree; it has been removed.
