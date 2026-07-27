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
       → status: awaiting_pipeline
pipeline-runner / GHA
       → pipeline-ack build=passed, test=passed
       → status: ready
Sidekar
       → install
```

## Skip

```
ofw publish --skip-pipeline          # ready immediately
ofw pipeline-skip --rkey …           # force ready later
OFW_SKIP_PIPELINE=1 on Sidekar       # emergency consumer override
```

## Example stack

- Service `pipeline-runner` auto-acks `build` + `test` for demos.
- Scripts: `publish-with-pipeline.sh`, `pipeline-runner-once.sh`
- Walkthrough UI shows stage results live at `:8099`
