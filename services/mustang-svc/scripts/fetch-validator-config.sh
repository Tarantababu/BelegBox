#!/usr/bin/env bash
# Fetches the official KoSIT validator configuration and verifies its checksum.
#
# The configuration is what decides every form verdict, so it is pinned by
# release tag AND by digest: R-2 requires a 2026 verdict to be re-derivable in
# 2033, and "whatever was on the release page that day" is not a pin. Changing
# either value below is a deliberate, reviewed act - the corpus snapshots will
# show exactly which verdicts moved.
set -euo pipefail

TAG="v2026-01-31"
ASSET="xrechnung-3.0.2-validator-configuration-2026-01-31.zip"
SHA256="6a5a5911a421b25fbc423f62f93f894df7b236f5d73ca4f84bb222a945082704"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="$DIR/validator-config"
URL="https://github.com/itplr-kosit/validator-configuration-xrechnung/releases/download/$TAG/$ASSET"

if [ -f "$TARGET/scenarios.xml" ] && [ "${FORCE:-}" != "1" ]; then
  echo "validator configuration already present ($TAG)"
  exit 0
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "fetching $ASSET"
curl -fsSL -o "$tmp/config.zip" "$URL"

# sha256sum on Linux, shasum on macOS. The image builds are Debian, the
# developer machines are not, and the digest check must run on both - a
# verification step that silently is not there is worse than none.
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/config.zip" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/config.zip" | cut -d' ' -f1)"
fi
if [ "$actual" != "$SHA256" ]; then
  echo "checksum mismatch for $ASSET" >&2
  echo "  expected $SHA256" >&2
  echo "  actual   $actual" >&2
  echo "Refusing to install. Either the release was replaced or the download was tampered with." >&2
  exit 1
fi

rm -rf "$TARGET"
mkdir -p "$TARGET"
unzip -q "$tmp/config.zip" -d "$TARGET"
echo "$TAG" > "$TARGET/.version"
echo "installed KoSIT validator configuration $TAG"
