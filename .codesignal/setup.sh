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

wget https://github.com/CodeSignal/learn_cosmo-automations/releases/latest/download/release.tar.gz -O release.tar.gz
tar -xzf release.tar.gz && rm release.tar.gz

# One deliberate difference: NO `cd dist`. The template's release keeps
# package.json inside dist/; ours unpacks flat, with dist/ holding only the built
# client, so `cd dist && npm run start:prod` would fail here.
#
# Blocking is correct: every deployed bespoke base task ends on a foreground
# server start, so the platform does not expect this script to return.
export PORT=3000
IS_PRODUCTION=true npm run start:prod
