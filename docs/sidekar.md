# Sidekar

**Sidekar** is the **server-side** update and deployment agent for Open Firmware.

## Name

“Sidekar” ≈ sidecar for the host: a managed agent that rides alongside your services and keeps them current from a **cryptographically signed** distribution center.

## What it is for

- NAS boxes, home servers, edge servers, always-on hosts
- Distributing **Docker-based apps** (Plex, media stacks, internal tools, …)
- **Self-managing** software on the host: reconcile desired containers with runtime state
- Updating Sidekar itself through the same signed channel

## What it is not

- Not the IoT firmware agent (use `@open-firmware/client` — **no Docker**)
- Not a replacement for the AT Protocol PDS (it consumes signed releases from one)
- Not a trust root (verification always happens before apply)

## Typical deployment

```text
┌─────────────────────────────────────────────┐
│ Host (Linux)                                │
│  docker engine                              │
│    ┌─────────────┐   ┌──────────┐           │
│    │  Sidekar    │──▶│  Plex    │  …        │
│    │  container  │   │  other   │           │
│    └─────────────┘   └──────────┘           │
└─────────────────────────────────────────────┘
         │
         │ AT Protocol (private or public)
         ▼
   Signed distribution center
```

Common pattern: run Sidekar as a container with a **tightly scoped** Docker socket mount (or remote Docker API + TLS), least privilege, and read-only root FS where possible.

## Artifact kinds Sidekar cares about

| Kind | Action |
|------|--------|
| `container` | Verify archive/image → load → create/update container |
| `deployment` | Verify compose/bundle → apply stack |
| `bundle` | Ordered steps (e.g. container then deployment) |
| `package` | Optional host-level package hooks |

Firmware kind is supported by the protocol but **IoT client** is the primary consumer; Sidekar may ignore `firmware` unless configured.

## Security notes

- Socket access is powerful: treat Sidekar config and credentials like root.
- Only `trustedAuthors` release DIDs may supply images.
- Phase A audit must pass before any `docker load` / stack apply.
- Prefer private AT networks for internal app catalogs.
