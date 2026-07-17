#!/usr/bin/env bash
# Runs INSIDE buildr-android. All I/O via the mounted /work:
#   in : /work/params.json  { manifestUrl, host, appName, packageId, keyPassword }
#        /work/in.keystore   (optional — present on a REBUILD to reuse the project's key)
#   out: /work/out/{app.apk, app.aab, app.keystore, fingerprint.txt}
# Emits a signed APK + AAB; generates the keystore on first build, reuses the passed one after.
set -euo pipefail

# The container runs as root; the shell (ubuntu) owns the mount and must be able to delete it —
# make /work deletable on EVERY exit, success or failure.
trap 'chmod -R a+rwX /work 2>/dev/null || true' EXIT

WORK=/work
OUT="$WORK/out"
mkdir -p "$OUT"

MANIFEST_URL=$(node -e 'console.log(require("/work/params.json").manifestUrl)')
HOST=$(node -e 'console.log(require("/work/params.json").host)')
APP_NAME=$(node -e 'console.log(require("/work/params.json").appName)')
PACKAGE_ID=$(node -e 'console.log(require("/work/params.json").packageId)')
KS_PASS=$(node -e 'console.log(require("/work/params.json").keyPassword)')

KEYSTORE="$WORK/app.keystore"
ALIAS=buildr

if [ -f "$WORK/in.keystore" ]; then
  cp "$WORK/in.keystore" "$KEYSTORE"        # rebuild — reuse the project's existing key
else
  keytool -genkeypair -keystore "$KEYSTORE" -alias "$ALIAS" \
    -storepass "$KS_PASS" -keypass "$KS_PASS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=$APP_NAME, O=Buildr101" >/dev/null 2>&1
fi

# SHA-256 fingerprint (colon-hex) for assetlinks.
keytool -list -v -keystore "$KEYSTORE" -alias "$ALIAS" -storepass "$KS_PASS" 2>/dev/null \
  | grep -oE 'SHA256: [0-9A-F:]+' | head -1 | sed 's/SHA256: //' > "$OUT/fingerprint.txt"

PROJ="$WORK/twa"
rm -rf "$PROJ"; mkdir -p "$PROJ"; cd "$PROJ"

# Drive Bubblewrap non-interactively from a pre-written twa-manifest.json.
node -e '
const p = require("/work/params.json");
const fs = require("fs");
fs.writeFileSync("twa-manifest.json", JSON.stringify({
  packageId: p.packageId,
  host: p.host,
  name: p.appName,
  launcherName: p.appName.slice(0, 30),
  display: "standalone",
  themeColor: p.themeColor || "#0a0c0f",
  themeColorDark: p.themeColor || "#0a0c0f",
  navigationColor: "#000000",
  navigationColorDark: "#000000",
  navigationDividerColor: "#000000",
  navigationDividerColorDark: "#000000",
  backgroundColor: p.backgroundColor || "#ffffff",
  enableNotifications: false,
  startUrl: "/",
  iconUrl: p.iconUrl || (p.origin + "/icons/icon-512.png"),
  maskableIconUrl: p.iconUrl || (p.origin + "/icons/icon-512.png"),
  splashScreenFadeOutDuration: 300,
  signingKey: { path: "/work/app.keystore", alias: "buildr" },
  appVersionName: "1",
  appVersionCode: 1,
  webManifestUrl: p.manifestUrl,
  fallbackType: "customtabs",
  enableSiteSettingsShortcut: true,
  isChromeOSOnly: false,
  isMetaQuest: false,
  fullScopeUrl: p.origin + "/",
  minSdkVersion: 21,
  orientation: "default",
  generatorApp: "bubblewrap-cli"
}, null, 2));
'

export BUBBLEWRAP_KEYSTORE_PASSWORD="$KS_PASS"
export BUBBLEWRAP_KEY_PASSWORD="$KS_PASS"
# `update` regenerates the Android project from twa-manifest.json (non-interactive with
# --skipVersionUpgrade), then `build` compiles it. Doing `build` alone on a fresh dir triggers
# interactive project regeneration + a free-text version prompt — avoid that entirely.
bubblewrap update --skipVersionUpgrade
bubblewrap build --skipPwaValidation

# Collect artifacts (bubblewrap names vary slightly by version — take the first match).
cp "$(ls -1 app-release-signed.apk ./app/build/outputs/**/app-release-signed.apk 2>/dev/null | head -1)" "$OUT/app.apk"
cp "$(ls -1 app-release-bundle.aab ./app/build/outputs/**/*.aab 2>/dev/null | head -1)" "$OUT/app.aab"
cp "$KEYSTORE" "$OUT/app.keystore"

echo "android build OK: $PACKAGE_ID"
ls -la "$OUT"

# The container runs as root; the shell (ubuntu) owns the mount and must be able to delete it.
chmod -R a+rwX /work 2>/dev/null || true
