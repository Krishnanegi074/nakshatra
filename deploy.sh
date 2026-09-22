#!/bin/bash
# Nakshatra — one-command deploy to GitHub (Git Bash / any bash shell)
#
# One-time setup: put this file inside your "nakshatra" folder, next to
# the app/ and backend/ folders (same level as README.md).
#
# Every time after that, from inside that folder in Git Bash, run:
#   bash deploy.sh "describe what changed"
#
# It stages every change, commits it with your message, and pushes it to
# GitHub — nakshatra.ind.in then updates on its own within a minute or two.

set -e
cd "$(dirname "$0")"

MSG="${1:-Update site}"

echo "Staging changes..."
git add -A

if git diff --cached --quiet; then
  echo "Nothing to deploy — no files have changed since the last push."
  exit 0
fi

echo "Committing: $MSG"
git commit -m "$MSG"

echo "Pushing to GitHub..."
git push origin main

echo ""
echo "Done! nakshatra.ind.in will update automatically within a minute or two."
