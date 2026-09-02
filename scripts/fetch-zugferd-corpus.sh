#!/usr/bin/env bash
#
# Vendors the official ZUGFeRD corpus for the classification regression test.
#
# Pinned to a commit, not a branch. The point of the test is that a change in
# our classification shows up as a diff; if the fixtures moved underneath it,
# every such diff would be ambiguous - ours or theirs? A pin makes the answer
# always "ours", and bumping the pin is a deliberate, reviewable act.
#
# The corpus is ~170 MB and is NOT committed: corpus/vendor/ is git-ignored, and
# the test skips when it is absent. Run this once locally, or in CI, to enable
# it.
set -euo pipefail

REPO="https://github.com/ZUGFeRD/corpus.git"
# ZUGFeRD/corpus @ 2026-08-11. Bump deliberately; expect snapshot churn.
COMMIT="d891458e9822e34271a5438497bf924e89955979"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/corpus/vendor/zugferd-corpus"

if [ -d "$DEST/.git" ] && [ "$(git -C "$DEST" rev-parse HEAD)" = "$COMMIT" ]; then
  echo "zugferd-corpus already at $COMMIT"
  exit 0
fi

rm -rf "$DEST"
mkdir -p "$(dirname "$DEST")"

# Fetch the single commit rather than the history: the repository carries every
# revision of 150 PDFs, and we need one revision of each.
git init -q "$DEST"
git -C "$DEST" remote add origin "$REPO"
git -C "$DEST" fetch -q --depth 1 origin "$COMMIT"
git -C "$DEST" checkout -q FETCH_HEAD

actual="$(git -C "$DEST" rev-parse HEAD)"
if [ "$actual" != "$COMMIT" ]; then
  echo "refusing: checked out $actual, expected $COMMIT" >&2
  exit 1
fi
echo "zugferd-corpus vendored at $COMMIT -> $DEST"
