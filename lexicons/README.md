# Lexicons

AT Protocol schemas for the `app.openfirmware.*` namespace. They live under `app/openfirmware/`, following the NSID path layout used by `goat lex` and `@atproto/lex`.

| Group | Schemas | Used by code today |
|-------|---------|--------------------|
| `firmware` | `release`, `gate`, `channel`, `pipelineAck`, `releaseSeal`, shared `defs` | Yes: written by `ofw` and `@open-firmware/host`, read by `@open-firmware/client` (`releaseSeal` is written but not read) |
| `firmware` queries | `getLatest`, `listReleases`, `getRelease` | Served by the minimal `@open-firmware/appview` class; no consumer calls them |
| `actor` | `declaration` | Written at publish time (the publisher's product list); nothing reads it yet |
| `device` | `identity`, `status`, `capabilities`, `joinRequest` | Writers exist in `@open-firmware/fleet` for identity and status; nothing reads them |
| `fleet` | `enrollment`, `policy`, `updateOffer`, `adminGrant` | Writers exist in `@open-firmware/fleet`; nothing reads or enforces them |
| `authPublisher` | OAuth permission set | Not used; OAuth login is not implemented |

## Status

The schemas are **not yet published** to the network. Authority for `app.openfirmware.*` would come from DNS for `openfirmware.app` (a `_lexicon.openfirmware.app` TXT record naming a DID), after which they can be published with `goat lex publish`. Until then they are a local contract between the code in this repository.

The format is pre-1.0 and may change.
