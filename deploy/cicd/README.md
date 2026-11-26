# Production CI/CD

`.github/workflows/opsbrain-ci.yml` runs the Deno/database tests and dashboard build for pull requests. A successful push to `main` also publishes the core/exporter and dashboard images to GHCR, then deploys their immutable digests. `workflow_dispatch` on `main` provides a manual rerun. Pull requests and other branches cannot deploy.

The existing VPS holds the runtime `.env`, human and agent keys, database and export volumes, networking and Pangolin routes. CI changes only image selections in `deploy/ci.override.yml`; Compose or infrastructure changes require a separate reviewed server update. The dashboard theme is built as Dautel. The Codex bridge published by Experts remains optional and is not enabled by these deployments.

## One-time provisioning

The owner runs `install.py` with sudo after reviewing `receiver.py` and its public-key manifest. It installs a root-owned receiver and a locked-password `dio-deploy` account with two exact sudo commands. Existing scoped SSH keys give no shell, PTY or forwarding access. CI cannot upload scripts, change Compose files or replace the receiver.

Hosted GitHub runners could not reach this VPS's SSH port. Production therefore uses `install-webhook.py` to install a signed HTTPS relay running as `dio-deploy`. Its listener binds only to the existing private Docker proxy bridge gateway on port 8765. Pangolin routes `https://opsbrain.dautel.cloud/_cicd/{opsbrain,experts}` to it, using the existing TLS hostname. No public TCP port or SSH firewall rule is added. Separate HMAC-SHA256 keys authenticate the app, timestamp and exact request body; requests older than five minutes are refused. The relay invokes only the existing per-app sudo receiver.

The relay installer expects `webhook.py`, its SHA-256 in `webhook-manifest.json`, and a private `webhook.env` containing `OPSBRAIN_DEPLOY_SECRET` and `EXPERTS_DEPLOY_SECRET` (independent random 32-byte hex values). It moves that environment file to root-private `/etc/dio-cicd/webhook.env` and removes the staging copy. Never commit a real environment file or authentication value.

Configure each repository's `production` environment to allow only branch `main`:

| Setting | Location | Value |
| --- | --- | --- |
| `DEPLOY_URL` | Environment variable | `https://opsbrain.dautel.cloud/_cicd/opsbrain` (Experts uses `/experts`) |
| `DEPLOY_WEBHOOK_SECRET` | Environment secret | This application's HMAC key |

GitHub's job-scoped `GITHUB_TOKEN` with `packages: read` travels in the signed HTTPS request, then stdin to the receiver for the private image pull. Redirects are refused. Its temporary Docker login directory is removed after pulling; no registry PAT is installed. The receiver allows only the fixed GHCR repositories, validates SHA-256 digests and OCI source/revision labels, and serializes the two applications with one server lock. Workflows also serialize their main runs and refuse deployments older than the last successful run number.

## Rollout and verification

Images are pulled before stopping services. For OpsBrain, the receiver pauses the core/exporter, creates a private database dump, restores it into a unique rehearsal database, runs the new migrations and checks that the old runtime can still read an existing attributed deployment record. It then migrates the live database while writes are paused and checks record contents and identity counts before starting the new core, exporter and dashboard. Human REST access, missing/agent key refusal, existing memory readback and public HTTPS must pass. The original deployment verification record `3581d274-ee6f-411f-8235-d99e384e2802` is an intentional acceptance fixture; archive it only after updating this check through a reviewed receiver installation.

Experts keeps the conversation volume, waits for container health, verifies its source revision and delegated OpsBrain `whoami`, and checks public HTTPS. No model calls or test record writes are made. A failed rollout restores the previous image override and restarts the prior services; it never overwrites a database with an older dump. A migration incompatible with the old runtime fails during rehearsal and requires an operator-led migration.

Sanitized results are in `/var/lib/dio-cicd/status/{opsbrain,experts}.json`; failure reports end in `-last-failure.json`. Private backups and previous overrides are under `/opt/dio-platform/ci/backups/`. No automatic image or backup pruning runs. Encrypted off-host backup scheduling remains a separate operations task.

## Recovery

Use a private sudo session. Read the failure report first. The selected release is the last Compose layer `deploy/ci.override.yml`; restore its preceding copy from the reported backup directory, or remove only that layer if `previous-config.json` says it did not exist. Start the same services with all three Compose layers and `--no-build`, keeping the original project name and `.env`. Verify health, authentication and memory before reopening work. Do not restore the database dump over newer writes or rerun the old bootstrap installer. Updating the receiver/relay or rotating server authentication keys requires a reviewed sudo provisioning run.

GitHub references: [publishing Docker images](https://docs.github.com/actions/publishing-packages/publishing-docker-images) and [Container registry authentication](https://docs.github.com/packages/working-with-a-github-packages-registry/working-with-the-container-registry).
