#!/usr/bin/env bash
# Crée (une seule fois) la clé qui signe l'APK de l'espace membre, puis :
#   - écrit l'empreinte SHA-256 dans public/.well-known/assetlinks.json
#   - enregistre les 4 secrets GitHub attendus par .github/workflows/android-apk.yml
#     (via la CLI `gh` si elle est installée et connectée, sinon les affiche)
#
# À lancer depuis la racine du dépôt :  bash scripts/make-keystore.sh
# Prérequis : un JDK (commande `keytool`) et `openssl`.
#
# ⚠ Cette clé est LA identité de l'application : si elle est perdue, plus aucune
#   mise à jour n'est possible pour les gens qui ont déjà installé l'app.
#   Gardez android/keystore/ (ignoré par git) dans un endroit sûr.
set -euo pipefail
cd "$(dirname "$0")/.."

KS_DIR="android/keystore"
KS="$KS_DIR/affbc-release.keystore"
ALIAS="affbc"
ASSETLINKS="public/.well-known/assetlinks.json"
PACKAGE="fr.americanfullfightingbons.espacemembre"

command -v keytool >/dev/null || { echo "keytool introuvable : installez un JDK (ex. Temurin 17)."; exit 1; }
command -v openssl >/dev/null || { echo "openssl introuvable."; exit 1; }
if [ -f "$KS" ]; then
  echo "La clé $KS existe déjà — je ne l'écrase pas."
  exit 1
fi

mkdir -p "$KS_DIR"
OK=0
trap 'if [ "$OK" != 1 ]; then rm -f "$KS" "$KS_DIR/SECRETS.txt"; fi' EXIT
PASS="$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | cut -c1-28)"

keytool -genkeypair \
  -keystore "$KS" -storetype PKCS12 \
  -alias "$ALIAS" -keyalg RSA -keysize 2048 -validity 10000 \
  -storepass "$PASS" \
  -dname "CN=AFFBC Espace membre, O=American Full Fighting Bons en Chablais, L=Bons-en-Chablais, C=FR" \
  >/dev/null

FP="$(keytool -J-Duser.language=en -J-Duser.country=US -list -v -keystore "$KS" -alias "$ALIAS" -storepass "$PASS" \
  | sed -n 's/^[[:space:]]*SHA256[[:space:]]*:[[:space:]]*//p' | head -n1)"
[ -n "$FP" ] || { echo "Impossible de lire l'empreinte SHA-256."; exit 1; }

cat > "$ASSETLINKS" <<JSON
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "$PACKAGE",
      "sha256_cert_fingerprints": [
        "$FP"
      ]
    }
  }
]
JSON

KS_B64="$(base64 < "$KS" | tr -d '\n')"
SECRETS_FILE="$KS_DIR/SECRETS.txt"
{
  echo "ANDROID_KEYSTORE_PASSWORD=$PASS"
  echo "ANDROID_KEY_ALIAS=$ALIAS"
  echo "ANDROID_KEY_PASSWORD=$PASS"
  echo "ANDROID_KEYSTORE_BASE64=$KS_B64"
} > "$SECRETS_FILE"
chmod 600 "$SECRETS_FILE" "$KS"
OK=1

echo
echo "✔ Clé créée            : $KS"
echo "✔ Empreinte SHA-256    : $FP"
echo "✔ assetlinks.json mis à jour : $ASSETLINKS  (à déployer avec le Worker)"
echo "✔ Copie des secrets    : $SECRETS_FILE  (ne pas committer, ne pas partager)"
echo

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  read -r -p "Enregistrer les 4 secrets dans le dépôt GitHub courant avec gh ? [O/n] " REP || REP=n
  if [ "${REP:-O}" != "n" ] && [ "${REP:-O}" != "N" ]; then
    gh secret set ANDROID_KEYSTORE_BASE64   --body "$KS_B64"
    gh secret set ANDROID_KEYSTORE_PASSWORD --body "$PASS"
    gh secret set ANDROID_KEY_ALIAS         --body "$ALIAS"
    gh secret set ANDROID_KEY_PASSWORD      --body "$PASS"
    echo "✔ Secrets GitHub enregistrés."
    exit 0
  fi
fi
echo "Ajoutez à la main dans GitHub → Settings → Secrets and variables → Actions"
echo "les 4 secrets listés dans $SECRETS_FILE (nom=valeur, une ligne chacun)."
