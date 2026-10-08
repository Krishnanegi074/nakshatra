#!/bin/bash
# Tests for scripts/publish-site.sh and scripts/site-checks.js. Nothing here touches GitHub, DNS or the live site's settings:
# the "site repos" are scratch git repos in a temp folder with a local bare repo as their remote, and the "live site" used for
# the polling test is a local web server.   Run from a clean source tree:   bash scripts/test-publish-site.sh
set -uo pipefail
SRC="$(cd "$(dirname "$0")/.." && git rev-parse --show-toplevel)"; cd "$SRC"
PUB="$SRC/scripts/publish-site.sh"; CHK="$SRC/scripts/site-checks.js"
T="$(mktemp -d)"; PASS=0; FAIL=0; SERVER_PID=""
cleanup() { [ -z "$SERVER_PID" ] || kill "$SERVER_PID" 2>/dev/null || true; rm -f "$SRC/app/verify-shots-publish-test.png"; rm -rf "$T"; }
trap cleanup EXIT
ok()   { PASS=$((PASS+1)); echo "PASS - $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL - $1${2:+  [$2]}"; }
expect_fail() { local label="$1" want="$2"; shift 2; local out rc; out="$("$@" 2>&1)"; rc=$?; if [ $rc -ne 0 ] && echo "$out" | grep -q -- "$want"; then ok "$label"; else bad "$label" "rc=$rc; wanted '$want'; got: $(echo "$out" | tail -2 | tr '\n' ' ' | cut -c1-160)"; fi; }
expect_ok()   { local label="$1"; shift; local out rc; out="$("$@" 2>&1)"; rc=$?; if [ $rc -eq 0 ]; then ok "$label"; else bad "$label" "rc=$rc: $(echo "$out" | tail -2 | tr '\n' ' ' | cut -c1-160)"; fi; }

[ -z "$(git status --porcelain)" ] || { echo "run this from a clean source tree"; exit 2; }

echo "== static: the script can never do a blanket add or a force push"
if grep -n -E "git[^|;&]* add (-A|--all|-u|\.)( |$)|push[^|;&]*(--force|-f )" "$PUB" >/dev/null; then bad "publish-site.sh contains a blanket add or force push"; else ok "no 'git add -A' / 'add .' / force-push anywhere in publish-site.sh"; fi

echo; echo "== site-checks.js on fixture folders"
mk() { rm -rf "$T/fx"; mkdir -p "$T/fx/app"; echo '<html><body>hello</body></html>' > "$T/fx/index.html"; cp "$T/fx/index.html" "$T/fx/app/index.html"; }
mk; expect_ok "clean fixture passes" node "$CHK" --dir "$T/fx"
mk; echo '<script>window.NAKSHATRA_BETA=true;</script>' >> "$T/fx/index.html"; expect_fail "beta flag is caught" "NAKSHATRA_BETA" node "$CHK" --dir "$T/fx"
mk; echo '<div>PRIVATE BETA - test payments only</div>' >> "$T/fx/app/index.html"; expect_fail "beta banner is caught" "PRIVATE BETA" node "$CHK" --dir "$T/fx"
mk; echo '<meta name="robots" content="noindex,nofollow">' >> "$T/fx/index.html"; expect_fail "noindex in the app is caught" "noindex" node "$CHK" --dir "$T/fx"
mk; echo '<p>write to stranger.person@gmail.com</p>' >> "$T/fx/index.html"; expect_fail "an email not on the allow-list is caught" "allow-list" node "$CHK" --dir "$T/fx"
mk; echo '<p>stranger.person@gmail.com</p>' >> "$T/fx/index.html"; out="$(node "$CHK" --dir "$T/fx" 2>&1)"; if echo "$out" | grep -q "stranger.person@gmail.com"; then bad "the finding printed the full address"; else ok "the finding masks the address (str***@gmail.com)"; fi
mk; printf '%s\n' '<p>support@nakshatra.ind.in, a@example.com, b@example.org</p>' '/* Copyright (c) 2019 Some Author <author.name@gmail.com> */' '<input placeholder="you@email.com">' >> "$T/fx/index.html"; expect_ok "allow-listed emails pass (support@, @example.*, a library licence line, the Kundli placeholder)" node "$CHK" --dir "$T/fx"
mk; echo "const k='sb_secret_$(printf 'A%.0s' 1 2 3 4 5 6 7 8 9 10 11 12)';" >> "$T/fx/main.js"; expect_fail "an sb_secret_ key is caught" "sb_secret_" node "$CHK" --dir "$T/fx"
mk; H="$(printf '{"alg":"HS256"}' | base64 | tr '+/' '-_' | tr -d '=')"; P="$(printf '{"role":"service_role"}' | base64 | tr '+/' '-_' | tr -d '=')"; echo "var j='eyJ${H#eyJ}.eyJ${P#eyJ}.abcdefghijklmnop';" >> "$T/fx/main.js"; out="$(node "$CHK" --dir "$T/fx" 2>&1)"; echo "$out" | grep -q "service_role" && ok "a JWT with role service_role is caught and flagged CRITICAL" || bad "service_role JWT not caught" "$(echo "$out" | tail -2 | tr '\n' ' ')"
mk; printf '%s\n' '-----BEGIN PRIVATE KEY-----' 'AAAA' '-----END PRIVATE KEY-----' > "$T/fx/key.txt"; expect_fail "a private key block is caught" "private key" node "$CHK" --dir "$T/fx"
mk; VAL="$(grep -E '^SWEEP_SECRET=' ~/.nakshatra-realtime-test.env 2>/dev/null | cut -d= -f2- | head -1)"
if [ -n "$VAL" ]; then echo "x=$VAL" > "$T/fx/notes.txt"; out="$(node "$CHK" --dir "$T/fx" 2>&1)"; if echo "$out" | grep -q "REAL SECRET VALUE" && ! echo "$out" | grep -qF -- "$VAL"; then ok "your real sweep secret in a file is caught, and the output does not contain it"; else bad "real secret not caught or leaked into output"; fi; else echo "SKIP - no local env file to test the exact-value check"; fi

echo; echo "== publish-site.sh guards (each must refuse)"
touch "$SRC/zz-dirty-test.txt"; expect_fail "refuses when the source tree is dirty" "not clean" "$PUB" --dest "$T/s1" --scratch; rm -f "$SRC/zz-dirty-test.txt"
echo "a" > "$T/m.txt"; expect_fail "refuses a manifest entry whose file does not exist" "missing or a symlink" "$PUB" --dest "$T/s2" --scratch --manifest "$T/m.txt"
echo "../outside.txt" > "$T/m.txt"; expect_fail "refuses a path with .." "unsafe path" "$PUB" --dest "$T/s3" --scratch --manifest "$T/m.txt"
echo "/etc/hosts" > "$T/m.txt"; expect_fail "refuses an absolute path" "unsafe path" "$PUB" --dest "$T/s4" --scratch --manifest "$T/m.txt"
printf 'about.html => x.html\nfaq.html => x.html\n' > "$T/m.txt"; expect_fail "refuses two files with the same destination" "duplicate destination" "$PUB" --dest "$T/s5" --scratch --manifest "$T/m.txt"
echo x > "$SRC/app/verify-shots-publish-test.png"; echo "app/verify-shots-publish-test.png" > "$T/m.txt"; expect_fail "refuses a file that exists but is not tracked by git" "not tracked" "$PUB" --dest "$T/s6" --scratch --manifest "$T/m.txt"; rm -f "$SRC/app/verify-shots-publish-test.png"
# a manifest that stages a tracked file containing beta-marker text under an .html name: publish-site.sh itself must stop on the check
printf 'app/nakshatra-app.html => index.html\napp/nakshatra-app.html => app/index.html\napp/build.js => leak.html\n' > "$T/m.txt"; expect_fail "publish-site.sh stops when site-checks finds a violation in what it would publish" "site-checks failed" "$PUB" --dest "$T/s7" --scratch --manifest "$T/m.txt"
[ ! -e "$T/s7/leak.html" ] && ok "...and nothing was copied to the destination" || bad "files were copied despite the failed check"
mkdir -p "$T/notrepo"; echo y > "$T/notrepo/f"; expect_fail "refuses a destination that is neither a git repo nor a --scratch folder" "not a git repo" "$PUB" --dest "$T/notrepo" --dry-run
mkdir -p "$T/full"; echo y > "$T/full/other.txt"; expect_fail "refuses --scratch into a non-empty folder it did not create" "not empty" "$PUB" --dest "$T/full" --scratch

echo; echo "== real-repo behaviour against a scratch repo with a local bare remote"
git init -q --bare -b main "$T/remote.git"; git init -q -b main "$T/site"; git -C "$T/site" config user.email t@example.com; git -C "$T/site" config user.name tester; git -C "$T/site" remote add origin "$T/remote.git"
echo "# site repo" > "$T/site/README.md"; git -C "$T/site" add README.md; git -C "$T/site" commit -q -m init; git -C "$T/site" push -q origin main
out="$(echo n | "$PUB" --dest "$T/site" -m "should not happen" --no-poll 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "aborted" && [ "$(git -C "$T/site" rev-list --count HEAD)" = 1 ] && [ ! -f "$T/site/index.html" ]; then ok "answering 'n' aborts: nothing written, no commit"; else bad "answering n did not abort cleanly" "rc=$rc"; fi
out="$("$PUB" --dest "$T/site" --dry-run 2>&1)"; if echo "$out" | grep -q "dry run" && [ ! -f "$T/site/index.html" ]; then ok "--dry-run on a real repo lists the changes and writes nothing"; else bad "dry run wrote something"; fi
echo junk > "$T/site/junk.txt"; expect_fail "refuses when the site repo has uncommitted changes" "uncommitted changes" "$PUB" --dest "$T/site" -m x; rm -f "$T/site/junk.txt"
git -C "$T/site" status --porcelain | grep -q . && bad "site repo not clean after test" || true
echo stray > "$T/site/stray.html"; git -C "$T/site" add stray.html; git -C "$T/site" commit -q -m "stray file that is not in the manifest"; git -C "$T/site" push -q origin main
out="$(echo y | "$PUB" --dest "$T/site" -m "First publish" --no-poll 2>&1)"; rc=$?
SID="$(git rev-parse HEAD)"
if [ $rc -eq 0 ] && echo "$out" | grep -q "^   D  stray.html"; then ok "a stray file in the site repo is listed as D and removed"; else bad "stray file not handled" "rc=$rc"; fi
N="$(git -C "$T/site" show --name-only --format= HEAD | grep -c .)"; EXPECTN="$(grep -v -E '^\s*(#|$)' scripts/site-files.txt | wc -l | tr -d ' ')"
if [ "$N" = "$((EXPECTN+1))" ]; then ok "the commit holds exactly the $EXPECTN manifest files plus the one deletion"; else bad "commit has $N paths" "wanted $((EXPECTN+1))"; fi
[ -f "$T/site/README.md" ] && ok "protected README.md in the site repo was left alone" || bad "README.md was deleted"
git -C "$T/site" log -1 --format=%B | grep -q "Source: nakshatra $SID" && ok "the site commit message names the full source commit id" || bad "source commit id missing from the message"
git -C "$T/site" log -1 --format=%B | grep -q "Built app: sha1 " && ok "...and the built app hash" || bad "build hash missing"
cmp -s "$T/site/index.html" "$T/site/app/index.html" && ok "index.html and app/index.html are byte-identical in the site repo" || bad "root and /app/ differ"
out="$("$PUB" --dest "$T/site" -m "again" --no-poll 2>&1)"; echo "$out" | grep -q "none: the site already matches" && ok "publishing again with no changes is a no-op" || bad "second run not a no-op"

echo; echo "== push + polling against a local 'live site'"
PORT=$(( 20000 + RANDOM % 20000 ))
( cd "$T/site" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) & SERVER_PID=$!; sleep 1
# change the site repo so there is something to publish: remove a published file locally and commit, so the script must restore it
git -C "$T/site" rm -q about.css; git -C "$T/site" commit -q -m "remove about.css (test)"; git -C "$T/site" push -q origin main
out="$(echo y | "$PUB" --dest "$T/site" -m "Second publish" --live-url "http://127.0.0.1:$PORT" --poll-timeout 40 2>&1)"; rc=$?
if [ $rc -eq 0 ] && echo "$out" | grep -q "pushed" && echo "$out" | grep -q "DONE:" && echo "$out" | grep -q "live root matches"; then ok "push, then poll the live hash, then check every file: all passed"; else bad "push/poll run failed" "rc=$rc: $(echo "$out" | tail -3 | tr '\n' ' ' | cut -c1-200)"; fi
[ "$(git -C "$T/remote.git" rev-parse main)" = "$(git -C "$T/site" rev-parse HEAD)" ] && ok "the commit reached the (local) remote" || bad "remote not updated"
# stale 'live' site: serve an old copy, the poll must fail
kill "$SERVER_PID" 2>/dev/null; wait "$SERVER_PID" 2>/dev/null; SERVER_PID=""
for i in 1 2 3 4 5 6 7 8 9 10; do curl -s -m 1 -o /dev/null "http://127.0.0.1:$PORT/" || break; sleep 1; done      # wait until the old server has really stopped
PORT=$(( PORT + 1 )); mkdir -p "$T/stale"; echo "<html>old</html>" > "$T/stale/index.html"
( cd "$T/stale" && python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) & SERVER_PID=$!; sleep 1
curl -s "http://127.0.0.1:$PORT/index.html" | grep -q "old" || bad "test setup: the stale server is not the one answering"
git -C "$T/site" rm -q favicon-16.png; git -C "$T/site" commit -q -m "remove favicon-16 (test)"; git -C "$T/site" push -q origin main
out="$(echo y | "$PUB" --dest "$T/site" -m "Third publish" --live-url "http://127.0.0.1:$PORT" --poll-timeout 12 2>&1)"; rc=$?
if [ $rc -ne 0 ] && echo "$out" | grep -q "did not serve the new build"; then ok "if the live site never matches, the script reports failure instead of success"; else bad "stale live site was not detected" "rc=$rc: $(echo "$out" | tail -3 | tr '\n' ' ' | cut -c1-220)"; fi

echo; echo "== source tree untouched by all of this"; [ -z "$(git status --porcelain)" ] && ok "source working tree still clean" || bad "the tests left the source tree dirty" "$(git status --porcelain | head -3 | tr '\n' ' ')"
echo; echo "=== RESULT: $PASS passed, $FAIL failed ==="
[ "$FAIL" = 0 ]
