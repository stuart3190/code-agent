# Buildr capability runtime

The capability runtime turns generated-app features into trusted server actions instead of client-side placeholders or exposed provider keys.

## Execution lanes

- **Managed**: Buildr reserves an owner's credits, runs the provider, then settles the actual configured charge and refunds the unused reservation.
- **BYOK**: the encrypted per-project key is decrypted only inside the worker; Buildr credits are not charged for provider inference.
- **Internal**: media and document work runs in the isolated worker container with one heavy job at a time.

Generated apps call `backend.actions.invoke(key, input)` and observe the returned job with `subscribe()` or `wait()`. Inputs are schema-checked and rate-limited. Jobs support idempotency, progress, cancellation, persistent private outputs, and separate end-user usage units.

## Included operations

- OpenAI text/vision, structured output, image generation, and embeddings.
- Replicate asynchronous image-to-video predictions with signed webhook support and output persistence.
- Social-video composition with aspect presets, burned-in captions, a logo, and music.
- Image optimization, PDF text extraction, PDF merging, and ZIP archives.
- Private knowledge-base ingestion and vector search.
- Safe public HTTPS actions with redirect, response-size, timeout, and private-network protections.
- Interval schedules and Stripe Connect usage-unit packs.

## Production

`buildr-runtime-worker.service` runs `buildr-runtime-worker:latest` with a 3 GB memory limit. `/etc/buildr/runtime-worker.env` contains only the Supabase service variables, the project-secret encryption key, public app URL, optional managed-provider keys, and concurrency settings. It must not reuse the full shell environment.

Required variables are `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (or the legacy role name), and `PLATFORM_ENC_KEY`/`BYOK_ENC_KEY`. Optional managed lanes use `RUNTIME_OPENAI_API_KEY` and `RUNTIME_REPLICATE_API_TOKEN`. Meta publishing uses `META_APP_ID` and `META_APP_SECRET`; keep the same values in the shell's private environment for OAuth callbacks.

The worker code is copied into the image. After deploying any change under `runtime-worker/`, `src/`, or worker-imported `shell/server/` modules, rebuild before restarting:

```sh
cd ~/app-builder
docker build -t buildr-runtime-worker:latest -f runtime-worker/Dockerfile .
sudo systemctl restart buildr-runtime-worker
```
