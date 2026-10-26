'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The directory holding package.json: the repository root in a checkout, the
 * unpacked release in a session.
 *
 * A release bundles each entry point into one file (scripts/pack-release.js),
 * so `__dirname` is wherever that file sits — the release root for server.js,
 * `grading/` for score.js — and no longer this module's own directory. Paths
 * relative to `__dirname` would point somewhere different in every bundle;
 * walking up to package.json finds the same place from all of them.
 */
function packageRoot(start = __dirname) {
  let dir = start;
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) return path.join(start, '..');
    dir = up;
  }
}

module.exports = { packageRoot };
