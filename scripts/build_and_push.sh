#!/usr/bin/env bash
# Build and push helper for the Docker image used by this repo.
# Usage:
#   ./scripts/build_and_push.sh                # builds and pushes the default image
#   ./scripts/build_and_push.sh my/repo:tag    # builds & pushes a custom tag

set -euo pipefail

IMAGE=${1:-phil73/pj-images-utils-app-runner}

echo "🔧 Building Docker image: ${IMAGE}"
docker build -t "${IMAGE}" .

echo "📦 Pushing Docker image: ${IMAGE}"
docker push "${IMAGE}"

echo "✅ Build and push finished for ${IMAGE}"
