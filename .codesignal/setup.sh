#!/bin/sh
# BASE-TASK CONTENT — paste into the base task's .codesignal/setup.sh.
# Not run from this repo. See .codesignal/README.md.
#
# ONE directory, named after the simulation, holds the code, the config.json
# the task delivers as a project file, and the activity log the platform reads
# back. The task's project file is `cosmo-automations/config.json`, so it is
# already sitting in this directory when the release unpacks next to it.

mkdir -p cosmo-automations
cd cosmo-automations

# Production runs the latest release; staging runs the newest build, which a
# build from main becomes before anyone promotes it (README, "Releases").
RELEASE_URL="https://github.com/CodeSignal/learn_cosmo-automations/releases/latest/download/release.tar.gz"
if [ "$APP_ENVIRONMENT" = "staging" ]; then
  RELEASE_URL="https://github.com/CodeSignal/learn_cosmo-automations/releases/download/prerelease/release.tar.gz"
fi

wget "$RELEASE_URL" -O release.tar.gz
tar -xzf release.tar.gz && rm release.tar.gz

# One deliberate difference: NO `cd dist`. The template's release keeps
# package.json inside dist/; ours unpacks flat — one bundled file per entry point,
# no node_modules — with dist/ holding only the built client, so
# `cd dist && npm run start:prod` would fail here.
#
# Blocking is correct: every deployed bespoke base task ends on a foreground
# server start, so the platform does not expect this script to return.
export PORT=3000
IS_PRODUCTION=true npm run start:prod
