PJ App Runner — Deploy / Upgrade Guide
===================================

This single-file guide explains how to safely build, push and deploy the updated `app-runner` image and how to revert if needed. It assumes you have Docker and (optionally) docker-compose on your host and you have credentials to push images to your container registry.

Quick checklist
- Build a new image with the latest code
- Push the image to your registry (e.g. Docker Hub or a private registry)
- Update the deployed container (docker run or docker-compose) and verify health
- Rollback if something goes wrong

1) Build and test locally

From the repo root (/home/pj_dev_sa/app-ruuner) you can build an image for manual testing.

```bash
# build locally with a tag (use your registry/username as appropriate)
docker build -t phil73/pj-images-utils-app-runner:local-test .

# run a new container for quick smoke tests (ports may differ in your environment)
docker run --rm -it -p 2001:2001 --name app-runner-test phil73/pj-images-utils-app-runner:local-test

# Access the runner at http://localhost:2001 and run a local build to verify
```

2) Build and push a released image

Tag by semantic version (recommended) or use a timestamp.

```bash
# build the image (always run from repo root)
docker build -t phil73/pj-images-utils-app-runner:0.0.3 .

# optionally also tag latest
docker tag phil73/pj-images-utils-app-runner:0.0.3 phil73/pj-images-utils-app-runner:latest

# push to registry (ensure you're logged in and have permissions)
docker push phil73/pj-images-utils-app-runner:0.0.3
docker push phil73/pj-images-utils-app-runner:latest
```

You can also use the helper script we added at `scripts/build_and_push.sh` to build + push in one step.

```bash
# build and push the default image
./scripts/build_and_push.sh

# or pass a custom tag
./scripts/build_and_push.sh myusername/my-image:0.0.1
```

3) Deploy with docker-compose (recommended for multi-container stacks)

Option A — quick one-liner restart (uses remote image):

```bash
# stop and remove the old container
docker rm -f app-runner || true

# run the new container using the pushed image (example flags)
docker run -d \
  --name app-runner \
  -p 2001:2001 \
  -v /host/path/to/data:/data:rw \
  --restart=unless-stopped \
  phil73/pj-images-utils-app-runner:0.0.3
```

Option B — compose upgrade (if you're using docker-compose)

1. Update your `docker-compose.yml` to reference the new image tag (phil73/pj-images-utils-app-runner:0.0.3).
2. Recreate the service:

```bash
docker compose pull app-runner        # fetch the new image
docker compose up -d --no-deps --force-recreate app-runner

# Or for older docker-compose versions
docker-compose pull app-runner
docker-compose up -d --no-deps --force-recreate app-runner
```

3) Optional: health check and log monitoring

```bash
docker logs --follow app-runner
curl -sS http://127.0.0.1:2001/api/projects | jq
```

4) Rollback / revert

If the new image has issues, roll back to a previous tag (e.g. 0.0.2):

```bash
docker pull phil73/pj-images-utils-app-runner:0.0.2
docker compose up -d --no-deps --force-recreate app-runner

# or manually stop and run previous tag
docker rm -f app-runner
docker run -d --name app-runner -p 2001:2001 phil73/pj-images-utils-app-runner:0.0.2
```

5) Safety & best practices
- Use immutable tags (avoid deploying `latest` in production)
- Keep a small automated smoke test (curl /games/api/projects) that runs after deploy and fails the deploy if the endpoint returns non-200
- Keep a short rollback window and keep older images available in your registry

6) Optional — CI/CD snippet (GitHub Actions)

If you want a minimal GitHub Actions workflow that builds, tags and pushes an image (and optionally deploys), here is a short example you can copy into `.github/workflows/deploy.yml`:

```yaml
name: Build and push app-runner
on:
  push:
    branches: [ main ]

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Log in to registry
        uses: docker/login-action@v3
        with:
          registry: docker.io
          username: ${{ secrets.DOCKERHUB_USERNAME }}
          password: ${{ secrets.DOCKERHUB_PASSWORD }}

      - name: Build and push
        uses: docker/build-push-action@v5
        with:
          push: true
          tags: |
            phil73/pj-images-utils-app-runner:${{ github.sha }}
            phil73/pj-images-utils-app-runner:latest

      # optional: call a deployment endpoint or SSH into host to update compose
      # - name: Trigger deploy
      #   run: curl -X POST <your-deploy-gateway>
```

7) Where you might want to change things in the repo
- The server fix is in `server/index.js` (install dev deps before building). Ensure this change is committed and included in your release tag
- Update your CI to build the image using the repository root

If you'd like, I can add a small smoke-test script and a GitHub Actions job that runs it post-deploy and fails CI if the runner's /api/projects does not return the expected data.

---
If you want the **one-line, ready-to-run** snippet to update with compose now (replace image tag with the tag you just pushed):

```bash
docker compose pull app-runner && docker compose up -d --no-deps --force-recreate app-runner && docker logs --follow app-runner
```

End of guide.
