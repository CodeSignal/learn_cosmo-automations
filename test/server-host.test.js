'use strict';

/**
 * Where the server listens.
 *
 * Loopback in development; all interfaces in an Engine session, where the
 * platform's preview ingress forwards to the pod's port 3000 directly and a
 * loopback-bound server shows a blank preview. Found by booting the base task in
 * a local session — this pins it so a "safer" loopback bind cannot come back.
 */

const test = require('node:test');
const assert = require('node:assert');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/**
 * Production mode serves the built client and refuses to start without it, so
 * the production cases need `npm run build` first. CI builds before testing; a
 * local checkout that has not built skips them rather than failing.
 */
function needsBuild(t) {
  if (fs.existsSync(path.join(ROOT, 'dist', 'index.html'))) return false;
  if (process.env.CI) assert.fail('dist/ is missing: run `npm run build` before the tests');
  t.skip('needs `npm run build` (production mode serves dist/)');
  return true;
}

function boot(env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '0', STATE_DIR: require('os').tmpdir(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`no banner. stdout: ${out.trim() || '(none)'} stderr: ${err.trim().split('\n')[0] || '(none)'}`));
    }, 8000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const m = /Cosmo Automations server: http:\/\/([^:]+):/.exec(out);
      if (m) { clearTimeout(timer); child.kill(); resolve(m[1]); }
    });
  });
}

test('development listens on loopback only', async () => {
  assert.strictEqual(await boot({ IS_PRODUCTION: 'false', HOST: '' }), '127.0.0.1');
});

test('a session (IS_PRODUCTION=true) listens on all interfaces, or the preview is blank', async (t) => {
  if (needsBuild(t)) return;
  assert.strictEqual(await boot({ IS_PRODUCTION: 'true', HOST: '' }), '0.0.0.0');
});

test('HOST overrides both', async (t) => {
  if (needsBuild(t)) return;
  assert.strictEqual(await boot({ IS_PRODUCTION: 'true', HOST: '127.0.0.1' }), '127.0.0.1');
});
