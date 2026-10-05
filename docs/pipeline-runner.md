# The CI gate: publisher, attester, Sidekar

## Three roles

| Role | Who | Does what |
|------|-----|-----------|
| **Publisher** | `ofw publish`, run by a person or a CI job holding the publisher's app password | Uploads the artifact and creates the release; owns the gate and channel pointer |
| **Attester** | Any CI system (GitHub Actions, Jenkins, a script) with its **own** AT Protocol account | Runs build and test; records each stage result with `ofw pipeline-ack` in its own repository |
| **Sidekar** | Host agent | Installs only releases whose gate is `ready` and, if configured, whose required stages were acked by the attesters it trusts |

Sidekar does not run tests. The attester does not need, and should not have, the publisher's password.

## Flow

```
Publisher   ofw publish --require-pipeline --stages build,test
              → release created, gate = awaiting-pipeline, channel not moved

Attester    ofw pipeline-ack --author-did <publisher DID> --rkey <release key> --stage build --result passed
            ofw pipeline-ack --author-did <publisher DID> --rkey <release key> --stage test  --result passed
              → ack records in the attester's repository; the gate is unchanged

Publisher   ofw pipeline-promote --rkey <release key> --attester-did <attester DID>
              → checks the acks, then gate = ready and the channel pointer moves

Sidekar     OFW_ATTESTER_DIDS=<attester DID>
              → follows the channel, re-checks the attester's acks itself, then installs
```

The last ack does **not** flip the gate by itself. Only the publisher account can write the gate, so promotion is always a publisher action: either an explicit `pipeline-promote`, or the automatic check that runs when the publisher account itself writes a passing ack.

## Promotion rules (`ofw`)

- **CID-bound acks.** An ack counts only if it references the release's URI and CID. Since releases are create-only this normally always holds; the check means an ack can never cover different bytes.
- **Who counts.** Only acks stored in the repositories named by `--attester-did` (or `OFW_ATTESTER_DIDS`). The repository an ack lives in identifies its author; the `actor` field inside it is not trusted. The newest ack per stage wins.
- **Self-attestation.** With no `--attester-did`, or when it names only the publisher, the publisher's own acks are counted. This proves nothing about independent review, so `ofw` prints a warning, sets `"selfAttested": true` in JSON output, and writes `promoted on self-attested acks` into the gate's `reason`.
- **Auto-promotion.** `pipeline-ack` run by the publisher account with `passed` or `skipped` performs the promotion check afterwards (`--no-promote` turns that off). `pipeline-ack` run by another account only stores the ack.
- **Failures.** A `failed` ack from the publisher account sets the gate to `failed`. `pipeline-promote` refuses while the newest ack of a required stage is `failed`, and refuses a `failed` gate outright: a failed release is not re-promoted by later acks. Publish a new version.
- **Rewritten release.** Promotion is refused if the release record's CID is no longer the one the gate was created for.
- **Downgrade guard.** The channel pointer is not moved to an older version, or to one that cannot be compared with the current one, unless `--allow-downgrade` is passed. The check happens before the gate is written, so a refused move leaves the gate untouched.

`pipeline-promote` exits non-zero and writes nothing when it is waiting or refusing. `pipeline-ack --json` reports `promotion` as `promoted`, `waiting`, `refused` or `not-attempted`.

## Bypasses

```
ofw publish                    # default: no pipeline, ready immediately (same as --skip-pipeline)
ofw pipeline-skip --rkey …     # publisher forces ready, ignoring acks
                               #   --override-failed   required if the gate is failed
                               #   --allow-downgrade   required to move the channel backwards
OFW_CONSUMER_SKIP_PIPELINE=1   # on Sidekar: ignore pipeline acks (emergency; the gate must still be ready)
```

`OFW_SKIP_PIPELINE` is a publisher variable and has no effect on Sidekar.

## What Sidekar enforces

Sidekar never relies on the publisher having promoted correctly. With `OFW_ATTESTER_DIDS` set it requires, for every release whatever the release record declares, a `passed` or `skipped` ack per required stage, written by one of those DIDs and bound to the release CID. `OFW_REQUIRED_PIPELINE_STAGES` replaces the stage list taken from the release (default `build,test`).

Without `OFW_ATTESTER_DIDS`, Sidekar follows the policy the release itself declares and counts the publisher's own acks, which gives no protection against a compromised publisher account.

Limitation: acks are read from the same PDS URL as the release, so the attester account must be hosted on that PDS.

## The TypeScript library

`@open-firmware/host` offers `postPipelineAck`, `tryPromoteRelease` and `skipPipelineAndPromote`. It binds acks to the release CID and filters by attester, but has no downgrade guard, does not refuse to promote a failed gate when newer passing acks exist, and does not mark self-attestation. Prefer `ofw` for promotion.

## Examples

- `cli/examples/github-actions-publish.yml`: a workflow to copy into your own project, with separate jobs and GitHub environments for the publisher and attester identities. It is an example; this repository's own CI does not publish releases with it.
- `examples/full-stack`: includes a `pipeline-runner` service that acts as a demo attester. See [examples/full-stack/README.md](../examples/full-stack/README.md) and [demo-runbook.md](./demo-runbook.md).
