#!/usr/bin/env bash
#
# Download a couple of public PDFs into test-fixtures/ for use as
# inputs to the smoke test or as click-around demo content. Idempotent:
# files that already exist are not re-downloaded.
#
# Usage:
#   scripts/seed-fixtures.sh
#
# What you get:
#   test-fixtures/attention-is-all-you-need.pdf  (~2 MB, arXiv 1706.03762)
#   test-fixtures/dinov2.pdf                     (~6 MB, arXiv 2304.07193)
#
# Source choice: arXiv URLs are stable, the licensing is clear, and the
# documents have enough varied text to exercise chunking and retrieval
# without being so large that the smoke test takes forever.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/test-fixtures"
mkdir -p "$DIR"

require() { command -v "$1" >/dev/null || { echo "missing dependency: $1" >&2; exit 1; }; }
require curl

fetch() {
  local url=$1 dest=$2
  if [[ -s "$DIR/$dest" ]]; then
    echo "  $dest already present, skipping"
    return
  fi
  echo "  fetching $dest"
  # -L follows arXiv's redirect to the actual PDF mirror.
  # --fail returns non-zero on HTTP errors so we don't end up with an
  # HTML error page saved as a .pdf.
  curl -sSL --fail --max-time 60 -o "$DIR/$dest" "$url"
}

echo "Seeding test-fixtures/"
fetch "https://arxiv.org/pdf/1706.03762" attention-is-all-you-need.pdf
fetch "https://arxiv.org/pdf/2304.07193" dinov2.pdf

echo
echo "Done. Try:"
echo "  scripts/smoke-test.sh test-fixtures/attention-is-all-you-need.pdf"
