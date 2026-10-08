#!/bin/bash
# Publish the PUBLIC website files (and only those) from this source repo to the public site repo.
#
#   scripts/publish-site.sh --dest ~/Developer/nakshatra-site -m "Release: what changed"      # real: asks, commits, pushes, polls the live site
#   scripts/publish-site.sh --dest ~/Developer/nakshatra-site --dry-run                       # real repo, lists the changes, writes nothing
#   scripts/publish-site.sh --dest /tmp/site-scratch --scratch --compare-live                 # plain folder: copies, then proves byte-equality with the live site
#
# Options:
#   --dest DIR          the site repo checkout (must be a git repo with a clean tree), or a scratch folder with --scratch
#   -m "message"        commit message title (required unless --dry-run / --scratch)
#   --dry-run           do all checks and list the changes; write nothing
#   --scratch           DEST is a plain folder, not a git repo: copy files there, no git, no push (for testing)
#   --no-push           commit but do not push (and so no polling)
#   --no-poll           push but do not poll the live site
#   --cname DOMAIN      also write a CNAME file containing DOMAIN (only at domain cutover; otherwise CNAME is left alone)
#   --live-url URL      the site to poll / compare against (default https://nakshatra.ind.in)
#   --compare-live      after the copy, fetch every published file from the live site and compare bytes
#   --poll-timeout S    seconds to wait for the live site to match (default 180)
#   --branch NAME       branch of the site repo to push (default main)
#
# Guarantees: refuses to run if THIS source tree is dirty; publishes only what scripts/site-files.txt lists and only files that
# git tracks (plus the freshly built app); never uses "git add -A" (every path is added by name); runs the beta-marker check, the
# secret scan and the email allow-list (scripts/site-checks.js); shows the exact changed-file list and asks before committing;
# records the source commit id in the site commit message; polls the live hash after pushing.

set -euo pipefail

die() { echo "ERROR: $*" >&2; exit 1; }
sha() { shasum -a 256 "$1" | cut -c1-64; }

DEST=""; MSG=""; DRY=0; SCRATCH=0; NOPUSH=0; NOPOLL=0; CNAME=""; LIVE_URL="https://nakshatra.ind.in"; COMPARE=0; POLL_TIMEOUT=180; BRANCH="main"
while [ $# -gt 0 ]; do
  case "$1" in
    --dest) DEST="${2:-}"; shift 2 ;;
    -m) MSG="${2:-}"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    --scratch) SCRATCH=1; shift ;;
    --no-push) NOPUSH=1; shift ;;
    --no-poll) NOPOLL=1; shift ;;
    --cname) CNAME="${2:-}"; shift 2 ;;
    --live-url) LIVE_URL="${2:-}"; shift 2 ;;
    --compare-live) COMPARE=1; shift ;;
    --poll-timeout) POLL_TIMEOUT="${2:-180}"; shift 2 ;;
    --branch) BRANCH="${2:-main}"; shift 2 ;;
    -h|--help) sed -n '2,28p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done
[ -n "$DEST" ] || die "--dest is required"
[ -z "$CNAME" ] || echo "$CNAME" | grep -Eq '^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$' || die "--cname must be a plain domain name"
LIVE_URL="${LIVE_URL%/}"

# ---------------------------------------------------------------- 1. the source repo must be clean
SRC="$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel)"
cd "$SRC"
[ -f scripts/site-files.txt ] || die "scripts/site-files.txt is missing"
DIRTY="$(git status --porcelain)"
if [ -n "$DIRTY" ]; then echo "$DIRTY" | head -10 >&2; die "the source working tree is not clean (commit or discard the changes above first)"; fi
SRC_ID="$(git rev-parse HEAD)"; SRC_SHORT="$(git rev-parse --short HEAD)"; SRC_SUBJECT="$(git log -1 --format=%s)"
if ! git branch -r --contains HEAD 2>/dev/null | grep -q 'origin/'; then echo "note: source commit $SRC_SHORT is not pushed to origin yet"; fi
echo "source: $SRC_SHORT  $SRC_SUBJECT"

# ---------------------------------------------------------------- 2. build the app from this exact commit
( cd app && node build.js ) || die "app/build.js failed"
BUILT="app/nakshatra-app.html"
[ -f "$BUILT" ] || die "$BUILT was not produced"
BUILT_SHA="$(shasum "$BUILT" | cut -c1-10)"
echo "built app: sha1 $BUILT_SHA ($(wc -c < "$BUILT" | tr -d ' ') bytes)"

# ---------------------------------------------------------------- 3. read the file list (the ONLY source of what may be published)
STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE" "$STAGE.list" "$STAGE.changes"' EXIT
LIST="$STAGE.list"; : > "$LIST"
while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(echo "$raw" | sed -e 's/#.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -n "$line" ] || continue
  if echo "$line" | grep -q '=>'; then src="$(echo "${line%%=>*}" | sed 's/[[:space:]]*$//')"; dst="$(echo "${line#*=>}" | sed 's/^[[:space:]]*//')"; else src="$line"; dst="$line"; fi
  case "$src$dst" in /*|*..*|*"//"*) die "unsafe path in site-files.txt: $line" ;; esac
  [ -n "$src" ] && [ -n "$dst" ] || die "bad line in site-files.txt: $line"
  [ -f "$src" ] && [ ! -L "$src" ] || die "listed source is missing or a symlink: $src"
  if [ "$src" != "$BUILT" ]; then git ls-files --error-unmatch -- "$src" >/dev/null 2>&1 || die "listed source is not tracked by git: $src"; fi
  echo "$src|$dst" >> "$LIST"
done < scripts/site-files.txt
[ -s "$LIST" ] || die "site-files.txt lists no files"
DUP="$(cut -d'|' -f2 "$LIST" | sort | uniq -d)"; [ -z "$DUP" ] || die "duplicate destination(s) in site-files.txt: $DUP"

# ---------------------------------------------------------------- 4. stage exactly those files
while IFS='|' read -r src dst; do mkdir -p "$STAGE/$(dirname "$dst")"; cp "$src" "$STAGE/$dst"; done < "$LIST"
[ -z "$CNAME" ] || printf '%s\n' "$CNAME" > "$STAGE/CNAME"
cmp -s "$STAGE/index.html" "$STAGE/app/index.html" || die "index.html and app/index.html are not byte-identical"
echo "staged $(cut -d'|' -f2 "$LIST" | wc -l | tr -d ' ') file(s)${CNAME:+ + CNAME}"

# ---------------------------------------------------------------- 5. safety checks (beta markers, secrets, emails)
node scripts/site-checks.js --dir "$STAGE" || die "site-checks failed: nothing was published"

# ---------------------------------------------------------------- 6. work out the exact change list against DEST
MODE=git
if [ -d "$DEST/.git" ]; then
  [ "$SCRATCH" = 0 ] || die "--scratch given but $DEST is a git repo"
  [ -z "$(git -C "$DEST" status --porcelain)" ] || die "the site repo at $DEST has uncommitted changes: clean it first"
elif [ "$SCRATCH" = 1 ]; then
  MODE=scratch; mkdir -p "$DEST"
  if [ -n "$(ls -A "$DEST" 2>/dev/null)" ] && [ ! -f "$DEST/.publish-site-scratch" ]; then die "$DEST is not empty and is not a previous scratch folder"; fi
else
  die "$DEST is not a git repo (use --scratch to copy into a plain folder for testing)"
fi
PROTECTED=".git|.publish-site-scratch|.nojekyll|README.md|LICENSE|.gitignore"
[ -n "$CNAME" ] || PROTECTED="$PROTECTED|CNAME"
CHANGES="$STAGE.changes"; : > "$CHANGES"
( cd "$STAGE" && find . -type f | sed 's#^\./##' | sort ) | while IFS= read -r f; do
  if [ ! -f "$DEST/$f" ]; then echo "A $f" >> "$CHANGES"; elif ! cmp -s "$STAGE/$f" "$DEST/$f"; then echo "M $f" >> "$CHANGES"; fi
done
( cd "$DEST" && find . -type f -not -path './.git/*' | sed 's#^\./##' | sort ) | while IFS= read -r f; do
  top="${f%%/*}"
  if echo "|$PROTECTED|" | grep -q "|$f|" || echo "|$PROTECTED|" | grep -q "|$top|"; then continue; fi
  [ -f "$STAGE/$f" ] || echo "D $f" >> "$CHANGES"
done
N_ALL="$(wc -l < "$CHANGES" | tr -d ' ')"
echo; echo "== exact file changes for $DEST ($N_ALL)"
if [ "$N_ALL" = 0 ]; then echo "   none: the site already matches"; else sort -k2 "$CHANGES" | while read -r st f; do printf '   %s  %s\n' "$st" "$f"; done; fi
N_A="$(grep -c '^A ' "$CHANGES" || true)"; N_M="$(grep -c '^M ' "$CHANGES" || true)"; N_D="$(grep -c '^D ' "$CHANGES" || true)"

verify_live() {   # compare every staged file with the live site; prints mismatches; returns 1 if any
  local bad=0 f tmp; tmp="$(mktemp)"
  while IFS= read -r f; do
    [ "$f" = CNAME ] && continue
    if ! curl -s -f -m 30 -o "$tmp" "$LIVE_URL/$f?cb=$RANDOM"; then echo "   MISSING on the live site: $f"; bad=1; continue; fi
    if [ "$(sha "$tmp")" != "$(sha "$STAGE/$f")" ]; then echo "   DIFFERS from the live site: $f"; bad=1; fi
  done < <( cd "$STAGE" && find . -type f | sed 's#^\./##' | sort )
  rm -f "$tmp"; return $bad
}

# ---------------------------------------------------------------- 7. scratch folder: copy, optionally compare with live, stop
if [ "$MODE" = scratch ]; then
  touch "$DEST/.publish-site-scratch"
  while IFS= read -r f; do mkdir -p "$DEST/$(dirname "$f")"; cp "$STAGE/$f" "$DEST/$f"; done < <(cd "$STAGE" && find . -type f | sed 's#^\./##' | sort)
  while IFS= read -r line; do st="${line%% *}"; f="${line#* }"; [ "$st" = D ] && rm -f "$DEST/$f"; done < "$CHANGES"
  echo; echo "scratch copy written to $DEST (no git, no push)"
  if [ "$COMPARE" = 1 ]; then
    echo "== comparing every file with $LIVE_URL"
    if verify_live; then echo "   all $(cd "$STAGE" && find . -type f | grep -vc '^./CNAME$') file(s) are BYTE-IDENTICAL to the live site"; else die "the scratch copy differs from the live site"; fi
  fi
  exit 0
fi

# ---------------------------------------------------------------- 8. real repo: dry run stops here; otherwise ask
if [ "$DRY" = 1 ]; then echo; echo "dry run: nothing was written to $DEST"; exit 0; fi
[ "$N_ALL" != 0 ] || exit 0
[ -n "$MSG" ] || die "-m \"message\" is required to publish"
echo
printf 'Publish these %s change(s) (%s added, %s modified, %s deleted) to %s as source %s? [y/N] ' "$N_ALL" "$N_A" "$N_M" "$N_D" "$DEST" "$SRC_SHORT"
ans=""; read -r ans || true
case "$ans" in y|Y|yes|YES) ;; *) echo "aborted: nothing was written."; exit 1 ;; esac

# ---------------------------------------------------------------- 9. apply, stage by NAME (never git add -A), commit
ADD_PATHS=(); DEL_PATHS=()
while IFS= read -r line; do
  st="${line%% *}"; f="${line#* }"
  case "$st" in
    A|M) mkdir -p "$DEST/$(dirname "$f")"; cp "$STAGE/$f" "$DEST/$f"; ADD_PATHS+=("$f") ;;
    D) DEL_PATHS+=("$f") ;;
  esac
done < "$CHANGES"
[ "${#ADD_PATHS[@]}" -eq 0 ] || git -C "$DEST" add -- "${ADD_PATHS[@]}"
[ "${#DEL_PATHS[@]}" -eq 0 ] || git -C "$DEST" rm -q -- "${DEL_PATHS[@]}"
EXPECT="$(sed -E 's/^(A|M|D) /\1 /' "$CHANGES" | awk '{print ($1=="M"?"M":$1)" "$2}' | sort)"
GOT="$(git -C "$DEST" diff --cached --name-status | awk '{print $1" "$2}' | sort)"
if [ "$EXPECT" != "$GOT" ]; then git -C "$DEST" reset -q; die "staged changes do not match the list shown (nothing committed)"; fi
{
  echo "$MSG"; echo
  echo "Source: nakshatra $SRC_ID"
  echo "        $SRC_SUBJECT"
  echo "Built app: sha1 $BUILT_SHA"
  echo "Files: $N_A added, $N_M modified, $N_D deleted"; echo
  sort -k2 "$CHANGES" | sed 's/^/  /'
} | git -C "$DEST" commit -q -F -
SITE_ID="$(git -C "$DEST" rev-parse --short HEAD)"
echo "committed in the site repo: $SITE_ID"

# ---------------------------------------------------------------- 10. push, then poll the live hash
if [ "$NOPUSH" = 1 ]; then echo "--no-push: not pushed."; exit 0; fi
git -C "$DEST" push origin "HEAD:$BRANCH" || die "push failed (the commit $SITE_ID is local in $DEST)"
echo "pushed $SITE_ID to $BRANCH"
if [ "$NOPOLL" = 1 ]; then echo "--no-poll: not checking the live site."; exit 0; fi
echo "waiting for $LIVE_URL to serve build $BUILT_SHA (up to ${POLL_TIMEOUT}s)..."
T0="$(date +%s)"; ok=0
while [ $(( $(date +%s) - T0 )) -lt "$POLL_TIMEOUT" ]; do
  h="$(curl -s -m 20 "$LIVE_URL/index.html?cb=$RANDOM" | shasum | cut -c1-10 || true)"
  if [ "$h" = "$BUILT_SHA" ]; then ok=1; break; fi
  sleep 10
done
[ "$ok" = 1 ] || die "the live site did not serve the new build within ${POLL_TIMEOUT}s (it is pushed as $SITE_ID: check Pages, or roll back)"
echo "live root matches after ~$(( $(date +%s) - T0 ))s; checking every published file..."
verify_live || die "some live files differ from what was published"
LA="$(curl -s "$LIVE_URL/index.html?cb=$RANDOM")"
echo "live beta markers: NAKSHATRA_BETA=true $(echo "$LA" | grep -c 'window.NAKSHATRA_BETA=true') | noindex $(echo "$LA" | grep -c noindex) | PRIVATE BETA $(echo "$LA" | grep -c 'PRIVATE BETA')"
echo "DONE: source $SRC_SHORT -> site $SITE_ID, live and byte-identical."
