# GCP Cloud Run deployment

This repo includes a GitHub Actions workflow at [`.github/workflows/deploy-gcp.yml`](../.github/workflows/deploy-gcp.yml) that builds `apps/server` with its Dockerfile, pushes the image to Artifact Registry, and deploys it to Cloud Run.

## What the workflow deploys

- Service: `@open-firmware/server`
- Container port: `8787`
- Image target: `REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/open-firmware-server:<tag>`
- Runtime data file: `/tmp/control-store.json`
- Branch trigger: `kan-test-deploy`

The server is file-backed, so Cloud Run will run it correctly, but the state file is ephemeral unless you move storage to an external system later.

The service is deployed private by default (`--no-allow-unauthenticated`). That means:

- the public `https://...a.run.app` URL is not the normal test path
- curl testing should happen from the staging network path, VPN, or another VM inside the VPC
- if your environment exposes an internal HTTPS load balancer or private DNS name, curl that endpoint from inside the network

For a quick connectivity check from the VPC, use a temporary micro VM with no external IP and IAP SSH, then run the curl from inside that VM against the internal staging endpoint.

## Required GitHub settings

Repository variables:

- `GCP_PROJECT_ID`
- `GCP_REGION`
- `GCP_ARTIFACT_REPOSITORY`
- `GCP_CLOUD_RUN_SERVICE`
- `GCP_RUNTIME_SERVICE_ACCOUNT`

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

- Push to `kan-test-deploy` after changes under `apps/server/**` or the Docker/build inputs.
- Or run the workflow manually with an optional `image_tag`.

## Internal testing

If the service stays private, test it from a VM inside the staging network path. A simple pattern is to use a temporary micro VM with no external IP and SSH to it through IAP.

Create the VM and a minimal VPC if you do not already have one:

```bash
export PROJECT_ID="open-firmware-manager"
export REGION="us-central1"
export ZONE="us-central1-a"
export VPC="tmp-test-vpc"
export SUBNET="tmp-test-subnet"
export VM="tmp-test-vm"

gcloud config set project "$PROJECT_ID"

gcloud compute networks create "$VPC" --subnet-mode=custom || true
gcloud compute networks subnets create "$SUBNET" --network="$VPC" --region="$REGION" --range=10.10.0.0/24 || true

gcloud compute firewall-rules create allow-iap-ssh-to-tmp-test \
	--network="$VPC" \
	--allow=tcp:22 \
	--source-ranges=35.235.240.0/20 \
	--target-tags=iap-ssh || true

gcloud compute instances create "$VM" \
	--zone="$ZONE" \
	--machine-type=e2-micro \
	--network="$VPC" \
	--subnet="$SUBNET" \
	--no-address \
	--tags=iap-ssh \
	--image-family=debian-12 \
	--image-project=debian-cloud
```

SSH into the VM over IAP and run the curl from inside that VM against the internal staging endpoint:

```bash
gcloud compute ssh "$VM" \
	--project "$PROJECT_ID" \
	--zone "$ZONE" \
	--tunnel-through-iap

curl -i http://YOUR_INTERNAL_STAGING_HOST/healthz
```

Clean up the temporary resources when you are done:

```bash
gcloud compute instances delete "$VM" --project "$PROJECT_ID" --zone "$ZONE" --quiet
gcloud compute firewall-rules delete allow-iap-ssh-to-tmp-test --project "$PROJECT_ID" --quiet
gcloud compute networks subnets delete "$SUBNET" --project "$PROJECT_ID" --region="$REGION" --quiet
gcloud compute networks delete "$VPC" --project "$PROJECT_ID" --quiet
```
```

If you just want to prove a 200 from inside the VM, you can also run a temporary local responder and curl it locally from the same VM:

```bash
gcloud compute ssh "$VM" \
	--project "$PROJECT_ID" \
	--zone "$ZONE" \
	--tunnel-through-iap \
	--command 'python3 - <<"PY"
from http.server import BaseHTTPRequestHandler, HTTPServer

class Handler(BaseHTTPRequestHandler):
		def do_GET(self):
				if self.path == "/healthz":
						self.send_response(200)
						self.send_header("Content-Type", "text/plain")
						self.end_headers()
						self.wfile.write(b"ok\n")
				else:
						self.send_response(404)
						self.send_header("Content-Type", "text/plain")
						self.end_headers()
						self.wfile.write(b"not found\n")

		def log_message(self, format, *args):
				return

HTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
PY'
```

From a second SSH session, verify the local 200:

```bash
gcloud compute ssh "$VM" \
	--project "$PROJECT_ID" \
	--zone "$ZONE" \
	--tunnel-through-iap \
	--command 'curl -i http://127.0.0.1:8080/healthz'
```

Clean up when done:

```bash
gcloud compute instances delete "$VM" --project "$PROJECT_ID" --zone "$ZONE" --quiet
gcloud compute firewall-rules delete allow-iap-ssh-to-tmp-test --project "$PROJECT_ID" --quiet
gcloud compute networks subnets delete "$SUBNET" --project "$PROJECT_ID" --region="$REGION" --quiet
gcloud compute networks delete "$VPC" --project "$PROJECT_ID" --quiet
```

## Tailscale auto-join for GCP VMs

If you want GCP test VMs to join Tailscale automatically and carry a tag like `tag:gcp`, use a startup script plus a Tailscale auth key.

Example startup script:

```bash
#!/usr/bin/env bash
set -euo pipefail

curl -fsSL https://tailscale.com/install.sh | sh
systemctl enable --now tailscaled

tailscale up \
	--auth-key="${TAILSCALE_AUTH_KEY}" \
	--hostname="$(hostname)" \
	--advertise-tags="tag:gcp" \
	--accept-dns=true
```

Recommended pattern:

- keep the Tailscale auth key in Secret Manager
- inject it into the VM at boot via metadata or a startup-script wrapper
- use a consistent tag such as `tag:gcp` or `tag:staging`
- let the VM join Tailscale, then curl the internal staging endpoint from that VM

## Notes

- The workflow keeps the service authenticated by default. If you want public access, add Cloud Run IAM bindings separately.
- The workflow deploys with `--no-allow-unauthenticated` and an explicit runtime service account so GitHub Actions does not get stuck on interactive prompts.
- If you need durable state, replace the local JSON file with external storage before treating this as production ready.