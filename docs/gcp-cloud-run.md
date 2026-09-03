# GCP Cloud Run deployment

This repo includes a GitHub Actions workflow at [`.github/workflows/deploy-gcp.yml`](../.github/workflows/deploy-gcp.yml) that builds `apps/server` with its Dockerfile, pushes the image to Artifact Registry, and deploys it to Cloud Run.

## What the workflow deploys

- Service: `@open-firmware/server`
- Container port: `8787`
- Image target: `REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/open-firmware-server:<tag>`
- Runtime data file: `/tmp/control-store.json`

The server is file-backed, so Cloud Run will run it correctly, but the state file is ephemeral unless you move storage to an external system later.

## Required GitHub settings

Repository variables:

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `GCP_ARTIFACT_REPOSITORY`
- `GCP_CLOUD_RUN_SERVICE`

Repository secrets:

- `GCP_WORKLOAD_IDENTITY_PROVIDER`
- `GCP_SERVICE_ACCOUNT`

## GCP setup

1. Create an Artifact Registry Docker repository in the region you want to deploy to.
2. Create a Cloud Run service account and grant it the roles it needs for your app.
3. Create a Workload Identity Pool and Provider for GitHub Actions.
4. Grant the GitHub Actions principal permission to impersonate the service account.
5. Add the variables and secrets above in the GitHub repository settings.

## Triggering a deploy

- Push to `main` after changes under `apps/server/**` or the Docker/build inputs.
- Or run the workflow manually with an optional `image_tag`.

## Notes

- The workflow keeps the service authenticated by default. If you want public access, add Cloud Run IAM bindings separately.
- If you need durable state, replace the local JSON file with external storage before treating this as production ready.