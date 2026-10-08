#!/bin/bash
# READ-ONLY health check of a live site. Only GET requests, dig, openssl and "gh api -X GET": it changes nothing anywhere.
#
#   scripts/check-live.sh DOMAIN --holder old|new|staging [--compare] [--expect-build SHA1PREFIX]
#
#   DOMAIN            nakshatra.ind.in  or  staging.nakshatra.ind.in
#   --holder old      the OLD repo (Krishnanegi074/nakshatra) should be serving it     (before the cutover, and after a rollback)
#   --holder new      the NEW repo (Krishnanegi074/nakshatra-site) should serve it     (after the cutover)
#   --holder staging  the NEW repo serves the staging domain; the old repo keeps nakshatra.ind.in
#   --compare         also build the 30-file set from the clean source tree and compare it, byte for byte, with the live site
#   --expect-build X  the root page's sha1 must start with X (for example f3d4af81ac)
#
# Output: PASS / FAIL / INFO lines and a summary. Exit code 1 if any FAIL. "who serves" is decided by two probes: the old repo
# serves /TODO.md and /backend/SETUP.md (200); the new repo does not (404).
# www note: https://www.<domain> has a certificate mismatch TODAY (www points at the apex, not at the github.io host), so it is
# reported as INFO, never FAIL. http://www -> https://<domain> is checked.

set -uo pipefail
OLD="Krishnanegi074/nakshatra"; NEW="Krishnanegi074/nakshatra-site"
GH_IPS="185.199.108.153 185.199.109.153 185.199.110.153 185.199.111.153"
DOMAIN=""; HOLDER=""; COMPARE=0; BUILD=""
while [ $# -gt 0 ]; do
  case "$1" in
    --holder) HOLDER="${2:-}"; shift 2 ;;
    --compare) COMPARE=1; shift ;;
    --expect-build) BUILD="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,19p' "$0"; exit 0 ;;
    -*) echo "unknown option: $1" >&2; exit 2 ;;
    *) DOMAIN="$1"; shift ;;
  esac
done
[ -n "$DOMAIN" ] && [ -n "$HOLDER" ] || { echo "usage: check-live.sh DOMAIN --holder old|new|staging [--compare] [--expect-build X]" >&2; exit 2; }
case "$HOLDER" in old|new|staging) ;; *) echo "--holder must be old, new or staging" >&2; exit 2 ;; esac
case "$DOMAIN" in *.*) ;; *) echo "DOMAIN looks wrong: $DOMAIN" >&2; exit 2 ;; esac
IS_STAGING=0; case "$DOMAIN" in staging.*) IS_STAGING=1 ;; esac

PASS=0; FAIL=0; INFO=0
ok()   { PASS=$((PASS+1)); echo "PASS - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1"; }
info() { INFO=$((INFO+1)); echo "INFO - $1"; }
chk()  { if [ "$1" = "$2" ]; then ok "$3 ($1)"; else bad "$3: got '$1', wanted '$2'"; fi; }
code() { curl -s -o /dev/null -m 25 -w '%{http_code}' "$1"; }
cb()   { echo "$RANDOM$RANDOM"; }
dg()   { dig +short +time=3 +tries=1 "$@" 2>/dev/null; }
T="$(date '+%H:%M:%S')"; echo "check-live: $DOMAIN, expecting the $HOLDER repo to hold it ($T)"

echo; echo "== DNS (unchanged by the move)"
if [ "$IS_STAGING" = 1 ]; then
  chk "$(dg CNAME "$DOMAIN" | head -1)" "krishnanegi074.github.io." "CNAME of $DOMAIN"
else
  A="$(dg A "$DOMAIN" | grep -E '^[0-9]' | sort | tr '\n' ' ' | sed 's/ $//')"; chk "$A" "$GH_IPS" "A records of $DOMAIN (the four GitHub Pages addresses)"
  chk "$(dg CNAME "www.$DOMAIN" | head -1)" "$DOMAIN." "www.$DOMAIN CNAME (as before)"
  N="$(dg TXT "_github-pages-challenge-Krishnanegi074.$DOMAIN" | wc -l | tr -d ' ')"; [ "$N" -ge 1 ] && ok "domain-verification TXT record present" || bad "domain-verification TXT record missing"
fi

echo; echo "== who is serving this domain"
TODO="$(code "https://$DOMAIN/TODO.md?x=$(cb)")"; BE="$(code "https://$DOMAIN/backend/SETUP.md?x=$(cb)")"
if [ "$HOLDER" = old ]; then chk "$TODO" 200 "/TODO.md is served (the old repo serves it)"; chk "$BE" 200 "/backend/SETUP.md is served (old repo)"
else chk "$TODO" 404 "/TODO.md is NOT served (the new repo does not publish it)"; chk "$BE" 404 "/backend/SETUP.md is NOT served (new repo)"; fi

echo; echo "== HTTPS"
R="$(curl -sS -o /dev/null -m 25 -w '%{http_code} %{ssl_verify_result}' "https://$DOMAIN/?x=$(cb)" 2>&1 | tail -1)"; chk "$R" "200 0" "https://$DOMAIN/ answers with a valid certificate (status, verify result)"
CERT="$(echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -subject -issuer -enddate 2>/dev/null)"
CN="$(echo "$CERT" | sed -n 's/^subject=.*CN *= *//p' | head -1)"; chk "$CN" "$DOMAIN" "certificate is issued for $DOMAIN"
echo "$CERT" | grep -q "Let's Encrypt" && ok "issuer is Let's Encrypt" || bad "issuer is not Let's Encrypt: $(echo "$CERT" | grep issuer)"
if echo | openssl s_client -connect "$DOMAIN:443" -servername "$DOMAIN" 2>/dev/null | openssl x509 -noout -checkend $((14*86400)) >/dev/null 2>&1; then ok "certificate valid for at least 14 more days ($(echo "$CERT" | sed -n 's/^notAfter=//p'))"; else bad "certificate expires within 14 days or is invalid"; fi

echo; echo "== HTTP redirects (no redirect following)"
for p in "" app/ expert/ robots.txt; do
  r="$(curl -s -o /dev/null -m 25 -w '%{http_code} %{redirect_url}' "http://$DOMAIN/$p?x=$(cb)" | sed -E 's/\?x=[0-9]+//')"; chk "$r" "301 https://$DOMAIN/$p" "http://$DOMAIN/$p redirects to https"
done
if [ "$IS_STAGING" = 0 ]; then
  r="$(curl -s -o /dev/null -m 25 -w '%{http_code} %{redirect_url}' "http://www.$DOMAIN/?x=$(cb)" | sed -E 's/\?x=[0-9]+//')"; chk "$r" "301 https://$DOMAIN/" "http://www.$DOMAIN/ redirects to the apex over https"
  w="$(curl -sS -o /dev/null -m 25 -w '%{http_code} verify=%{ssl_verify_result}' "https://www.$DOMAIN/" 2>&1 | tail -1)"; info "https://www.$DOMAIN/ -> $w   (baseline today: certificate error; a regression only if it became WORSE)"
fi

echo; echo "== pages and paths"
for p in "" app/ expert/ robots.txt sitemap.xml about.html kundli-matching.html pricing.html privacy.html terms.html favicon.ico og-image.png; do chk "$(code "https://$DOMAIN/$p?x=$(cb)")" 200 "/$p"; done
for p in docs/ CNAME does-not-exist.html; do chk "$(code "https://$DOMAIN/$p")" 404 "/$p is not published"; done
RH="$(curl -s -m 25 "https://$DOMAIN/?x=$(cb)" | shasum -a 256 | cut -c1-16)"; AH="$(curl -s -m 25 "https://$DOMAIN/app/?x=$(cb)" | shasum -a 256 | cut -c1-16)"; IH="$(curl -s -m 25 "https://$DOMAIN/index.html?x=$(cb)" | shasum -a 256 | cut -c1-16)"
if [ "$RH" = "$AH" ] && [ "$RH" = "$IH" ] && [ "$RH" != "e3b0c44298fc1c14" ]; then ok "/, /index.html and /app/ are byte-identical (sha256 $RH)"; else bad "/, /index.html and /app/ differ or are empty ($RH / $IH / $AH)"; fi
if [ -n "$BUILD" ]; then S1="$(curl -s -m 25 "https://$DOMAIN/?x=$(cb)" | shasum | cut -c1-${#BUILD})"; chk "$S1" "$BUILD" "the root page is the expected build (sha1 prefix)"; fi
LA="$(curl -s -m 25 "https://$DOMAIN/?x=$(cb)")"
M1="$(echo "$LA" | grep -c 'window.NAKSHATRA_BETA=true')"; M2="$(echo "$LA" | grep -c 'noindex')"; M3="$(echo "$LA" | grep -c 'PRIVATE BETA')"; chk "$M1/$M2/$M3" "0/0/0" "beta markers on the live app (NAKSHATRA_BETA=true / noindex / PRIVATE BETA)"

echo; echo "== response headers on https://$DOMAIN/"
H="$(curl -s -D - -o /dev/null -m 25 "https://$DOMAIN/?x=$(cb)" | tr -d '\r')"
hv() { echo "$H" | grep -i "^$1:" | head -1 | sed -E "s/^[^:]*: *//"; }
chk "$(hv server)" "GitHub.com" "server header"; chk "$(hv content-type)" "text/html; charset=utf-8" "content-type"; chk "$(hv cache-control)" "max-age=600" "cache-control"; chk "$(hv access-control-allow-origin)" "*" "access-control-allow-origin"
for x in strict-transport-security x-robots-tag content-security-policy set-cookie; do [ -z "$(hv $x)" ] && ok "no $x header (as before)" || info "unexpected header present: $x"; done

echo; echo "== GitHub Pages settings (read-only API, explicit GET)"
if gh auth status >/dev/null 2>&1; then
  pg() { gh api -X GET "repos/$1/pages" --jq "$2" 2>/dev/null; }
  OC="$(pg $OLD '.cname // "none"')"; NC="$(pg $NEW '.cname // "none"')"
  if [ "$HOLDER" = old ]; then
    chk "$OC" "$DOMAIN" "old repo holds the domain"; chk "$(pg $OLD .https_enforced)" true "old repo: Enforce HTTPS"; chk "$(pg $OLD '.https_certificate.state // "none"')" approved "old repo: certificate state"
    [ "$NC" = "$DOMAIN" ] && bad "new repo ALSO holds $DOMAIN" || ok "new repo does not hold $DOMAIN (holds: $NC)"
  elif [ "$HOLDER" = new ]; then
    chk "$NC" "$DOMAIN" "new repo holds the domain"; chk "$(pg $NEW .https_enforced)" true "new repo: Enforce HTTPS"; chk "$(pg $NEW '.https_certificate.state // "none"')" approved "new repo: certificate state"; chk "$(pg $NEW .status)" built "new repo: Pages build status"
    [ "$OC" = "$DOMAIN" ] && bad "old repo STILL holds $DOMAIN" || ok "old repo has released $DOMAIN (holds: $OC)"
  else
    chk "$NC" "$DOMAIN" "new repo holds the staging domain"; chk "$(pg $NEW .https_enforced)" true "new repo: Enforce HTTPS"; chk "$(pg $NEW '.https_certificate.state // "none"')" approved "new repo: certificate state"; chk "$(pg $NEW .status)" built "new repo: Pages build status"
    chk "$OC" "nakshatra.ind.in" "old repo still holds the production domain (untouched)"
  fi
else info "gh is not logged in: Pages settings not checked"; fi

if [ "$COMPARE" = 1 ]; then
  echo; echo "== the 30 published files, byte for byte"
  SRC="$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel)"; TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  OUT="$("$SRC/scripts/publish-site.sh" --dest "$TMP/set" --scratch --compare-live --live-url "https://$DOMAIN" 2>&1)"; RC=$?
  if [ $RC -eq 0 ] && echo "$OUT" | grep -q "BYTE-IDENTICAL"; then ok "$(echo "$OUT" | grep BYTE-IDENTICAL | sed 's/^ *//')"; else bad "publish-site.sh --compare-live failed: $(echo "$OUT" | tail -3 | tr '\n' ' ' | cut -c1-200)"; fi
  n=0; d=0; if [ -d "$TMP/set" ]; then for f in $(cd "$TMP/set" && find . -type f -not -name .publish-site-scratch | sed 's#^\./##' | sort); do a="$(shasum -a 256 "$TMP/set/$f" | cut -c1-16)"; b="$(curl -s -m 30 "https://$DOMAIN/$f?x=$(cb)" | shasum -a 256 | cut -c1-16)"; n=$((n+1)); [ "$a" = "$b" ] || { d=$((d+1)); echo "   DIFFERENT: $f"; }; done; fi
  [ "$n" -ge 30 ] && [ "$d" = 0 ] && ok "independent sha256 check: $n of $n files identical" || bad "independent sha256 check: $d different out of $n"
fi

echo; echo "=== $DOMAIN ($HOLDER): $PASS passed, $FAIL failed, $INFO info ==="
[ "$FAIL" = 0 ]
