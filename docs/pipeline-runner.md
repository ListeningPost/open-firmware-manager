# Pipeline runner vs Sidekar

## Two different jobs

| Role | Who | Does what |
|------|-----|-----------|
| **Publisher** | `ofw publish` / CI upload step | Puts artifact + release on the PDS |
| **Pipeline runner / validator** | GitHub Actions, Jenkins, a container, any agent | Runs build/test; posts `pipeline-ack` |
| **Sidekar** | Host agent | Installs only **ready** releases after verify |

**Sidekar does not run your tests.** A generic runner (or your existing CI) validates and acks.

## Flow

```
ofw publish --require-pipeline
       → gate: awaiting-pipeline
CI account (optional OFW_CI_*)
       → ofw pipeline-ack --author-did <publisher>  (acks live in the CI repo)
Publisher
       → ofw pipeline-promote --attester-did <ci>
       → gate: ready + channel pointer
Sidekar (OFW_ATTESTER_DIDS=<ci>)
       → getRecord(channel) → require CI acks → install

If OFW_CI_* is unset, GHA acks with the publisher account (demo / single-identity).
```

## Skip

```
ofw publish --skip-pipeline          # ready immediately
ofw pipeline-skip --rkey …           # force ready later
OFW_CONSUMER_SKIP_PIPELINE=1 on Sidekar   # emergency consumer override (not OFW_SKIP_PIPELINE)
```

## Example stack

- Service `pipeline-runner` auto-acks `build` + `test` for demos.
- Scripts: `publish-with-pipeline.sh`, `pipeline-runner-once.sh`
- Walkthrough UI shows stage results live at `:8099`
