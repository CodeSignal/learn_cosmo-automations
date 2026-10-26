#!/usr/bin/env node
'use strict';

/**
 * Build the release tarball: one minified file per entry point, no node_modules.
 *
 *   npm run build && npm run pack      → pack/ and release.tar.gz
 *
 * Every script a session runs is bundled with everything it requires — engine,
 * grading, the QuickJS bindings, ws — into a single file at its usual path, so
 * the base task's scripts work unchanged: `npm run start:prod`,
 * `node parse_automation_solution.js`, `node grading/score.js`, `npm run
 * validate`. Beside them go the built client (dist/), the bundled scenarios
 * (without their solutions),
 * the task generator's annotated example and README, and the QuickJS WASM once,
 * which every bundle loads (engine/sandbox.js).
 *
 * `npm run verify:release` then boots the tarball the way a session does.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PACK = path.join(ROOT, 'pack');
const TARBALL = path.join(ROOT, 'release.tar.gz');

/** What a session or the task generator runs. Each becomes one file at the same path. */
const ENTRY_POINTS = [
  'server.js',
  'parse_automation_solution.js',
  'run.js',
  'grading/score.js',
  'scripts/validate-scenario.js',
];

/** Read at runtime, copied as they are. */
const FILES = ['dist', 'scenarios', 'scenario.example.jsonc', 'README.md'];

const WASM = require.resolve('@jitl/quickjs-wasmfile-release-sync/wasm');

/**
 * Whether a file under FILES goes into the release. The release unpacks into
 * the candidate's workspace, so no answer may travel with it: a bundled
 * scenario's reference solution and its graded variants are the solved
 * workflow, and a task built on that scenario would hand it over. Grading
 * experiment captures (out/) are evidence for the repo, not runtime.
 */
function shipped(src) {
  const parts = src.split(path.sep);
  const name = parts[parts.length - 1];
  return !parts.includes('out') && !parts.includes('variants')
    && name !== 'reference_solution.json' && !name.startsWith('._');
}

async function main() {
  const esbuild = require('esbuild');
  if (!fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) {
    throw new Error('dist/ is missing: run `npm run build` first');
  }
  fs.rmSync(PACK, { recursive: true, force: true });
  fs.mkdirSync(PACK);

  for (const entry of ENTRY_POINTS) {
    await esbuild.build({
      absWorkingDir: ROOT,
      entryPoints: [entry],
      outfile: path.join(PACK, entry),
      bundle: true,
      platform: 'node',
      format: 'cjs',
      target: 'node22',
      minify: true,
      // Error messages and the report name functions; keep the names readable.
      keepNames: true,
      legalComments: 'none',
      // ws's optional native speed-ups; it runs without them.
      external: ['bufferutil', 'utf-8-validate'],
      // The QuickJS loader is written as ESM and asks for import.meta.url, which
      // a CommonJS bundle does not have: give it this file's URL.
      define: { 'import.meta.url': '__bundleUrl' },
      banner: { js: "const __bundleUrl = require('url').pathToFileURL(__filename).href;" },
      logLevel: 'warning',
    });
  }

  for (const rel of FILES) {
    fs.cpSync(path.join(ROOT, rel), path.join(PACK, rel), { recursive: true, filter: shipped });
  }
  fs.copyFileSync(WASM, path.join(PACK, 'quickjs.wasm'));

  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  fs.writeFileSync(path.join(PACK, 'package.json'), `${JSON.stringify({
    name: pkg.name,
    version: pkg.version,
    private: true,
    license: pkg.license,
    scripts: {
      start: 'npm run start:prod',
      'start:prod': 'IS_PRODUCTION=true node server.js',
      grade: 'node parse_automation_solution.js',
      validate: 'node scripts/validate-scenario.js',
    },
  }, null, 2)}\n`);

  fs.rmSync(TARBALL, { force: true });
  execFileSync('tar', ['-czf', TARBALL, '-C', PACK, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });

  process.stdout.write('Packed release (no node_modules):\n');
  for (const rel of [...ENTRY_POINTS, 'quickjs.wasm', 'dist', 'scenarios']) {
    process.stdout.write(`  ${rel.padEnd(32)} ${size(sizeOf(path.join(PACK, rel)))}\n`);
  }
  process.stdout.write(`  ${'pack/ (unpacked)'.padEnd(32)} ${size(sizeOf(PACK))}\n`);
  process.stdout.write(`  ${'release.tar.gz'.padEnd(32)} ${size(fs.statSync(TARBALL).size)}\n`);
}

function sizeOf(file) {
  const stat = fs.statSync(file);
  if (!stat.isDirectory()) return stat.size;
  return fs.readdirSync(file).reduce((sum, name) => sum + sizeOf(path.join(file, name)), 0);
}

function size(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`pack failed: ${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { ENTRY_POINTS, FILES, shipped };
