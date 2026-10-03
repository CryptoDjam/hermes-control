#!/bin/bash
# Publie les deux paquets Hermes Control sur npm (plugin + adaptateur), après vérifications.
# Usage : scripts/publish.sh            → publie avec le jeton de ~/.npmrc (jeton granulaire « bypass 2FA » requis)
#         scripts/publish.sh 123456     → publie avec un code 2FA à usage unique (--otp)
# Prérequis : npm whoami répond (voir PUBLISHING.md).
set -e
cd "$(dirname "$0")/.."
OTP="${1:-}"
[ -n "$OTP" ] && OTPARG="--otp=$OTP" || OTPARG=""
echo "== Compte npm : $(npm whoami)"
echo "== Vérifications (tests + build)"
npm run check >/dev/null
(cd adapter && npm run check >/dev/null)
for d in adapter .; do
  name=$(node -p "require('./$d/package.json').name"); ver=$(node -p "require('./$d/package.json').version")
  if npm view "$name@$ver" version >/dev/null 2>&1; then echo "== $name@$ver déjà publié, on passe"; continue; fi
  echo "== Publication de $name@$ver"
  (cd "$d" && npm publish $OTPARG)
done
echo "== Terminé. Prochaine étape : soumettre au Paperclip Hub (voir PUBLISHING.md)."
