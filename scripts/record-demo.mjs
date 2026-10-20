#!/usr/bin/env node

/**
 * Record the showcase demo as a video.
 *
 *   npm run record                        # both halves, ~30s
 *   npm run record -- --part=showcase     # just the finished workflow running
 *   npm run record -- --part=build        # just building a small one from scratch
 *
 * Writes docs/media/showcase.webm, and an .mp4 alongside it if Playwright's
 * bundled ffmpeg is available — a deck is more likely to accept mp4.
 *
 * Two halves, in this order, because that is the order that answers a room's two
 * questions:
 *
 *   1. "What does this thing actually do?"  — the finished 19-node workflow runs,
 *      nodes light up, item counts appear, the summary posts.
 *   2. "Could someone learn on it?"          — a blank canvas, and a workflow
 *      built and run from nothing in a few clicks.
 *
 * It drives the real app in a real browser against `npm run start:dev`. Nothing is
 * staged for the camera, so if the video shows it working, it works. That also
 * makes this the only end-to-end browser check in the repo — everything else is
 * headless engine tests.
 *
 * Start the server first:
 *   npm run demo payment-recovery
 *   npm run start:dev
 */

import { chromium } from 'playwright';
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'media');

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const PART = argOf('part', 'all');
const BASE = argOf('url', 'http://127.0.0.1:3000');

// 1280×800 keeps the 19-node graph legible once the video is scaled down in a
// deck. Wider shrinks the node text; narrower and the graph does not fit.
const SIZE = { width: 1280, height: 800 };

const wait = (ms) => new Promise((r) => { setTimeout(r, ms); });
const beat = (text) => console.log(`  · ${text}`);

/**
 * Stage the demo scenario into the session filesystem.
 *
 * The recorder has to do this itself, because its second half RESETS the canvas
 * and saves that — so without re-staging, a second recording would open on
 * whatever the last one left behind. Called before the showcase half and again at
 * the end, so the repo is left with the full workflow loaded and ready to present.
 */
function stage(scenario = 'payment-recovery') {
  const res = spawnSync(process.execPath,
    [path.join(ROOT, 'scripts', 'stage-demo.js'), scenario],
    { stdio: 'ignore' });
  if (res.status !== 0) throw new Error(`could not stage "${scenario}"`);
}

async function fitView(page) {
  await page.locator('.react-flow__controls-fitview').click();
  await wait(700);
}

/** Run the workflow and hold on the finished state. */
async function execute(page, { hold = 2000 } = {}) {
  await page.getByRole('button', { name: /execute workflow/i }).click();
  // The run animates for as long as the scenario's simulated-latency budget, and
  // watching it is the point, so wait for the verdict rather than guess a sleep.
  await page.getByText(/last run passed|last run failed/i).waitFor({ timeout: 30_000 });
  await wait(hold);
}

/**
 * Open a node's settings from the logs panel, which is the reliable handle. A
 * clean run leaves the logs collapsed, so expand them first.
 */
async function openNode(page, name, { hold = 2400 } = {}) {
  const toggle = page.locator('.ca-logs-toggle');
  if (await toggle.getAttribute('aria-expanded') === 'false') await toggle.click();
  await page.locator('.ca-log-line-name', { hasText: name }).first().click();
  await page.locator('.ca-detail-head').waitFor();
  await wait(hold);
}

async function backToCanvas(page) {
  await page.getByRole('button', { name: /^Back/ }).click();
  await wait(600);
}

/* ── half one: the finished workflow ─────────────────────────────────────── */

async function recordShowcase(page) {
  beat('open the staged workflow');
  stage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('.ca-node').first().waitFor();
  await wait(700);

  beat('fit the whole graph on screen');
  await fitView(page);
  await wait(900);

  beat('execute — the items flow through');
  await execute(page, { hold: 2000 });

  beat('the Switch: four branches the candidate named');
  await openNode(page, 'Route By Tier', { hold: 2400 });
  await backToCanvas(page);
}

/* ── half two: building one from nothing ─────────────────────────────────── */

/**
 * Wire two nodes together with a real mouse drag from output handle to input
 * handle. React Flow's connection logic runs on pointer events, so a synthesised
 * click never reaches it — this has to be actual mouse movement.
 */
async function connect(page, fromName, toName) {
  const wrap = (name) => `.ca-node-wrap:has(.ca-node-name:text-is("${name}"))`;
  const source = page.locator(`${wrap(fromName)} .react-flow__handle-right`).first();
  const target = page.locator(`${wrap(toName)} .react-flow__handle-left`).first();

  const a = await source.boundingBox();
  const b = await target.boundingBox();
  if (!a || !b) throw new Error(`no handles found for ${fromName} → ${toName}`);

  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // An intermediate move so the wire is visibly dragged rather than snapping.
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2 - 50, { steps: 14 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 14 });
  await page.mouse.up();
  await wait(500);
}

/**
 * Add a node by clicking its node panel row. Rows are draggable too, but HTML5
 * drag-and-drop does not survive CDP reliably; the click path is the same code and
 * places the node to the right of the rightmost one, which builds a tidy chain.
 */
async function addNode(page, label) {
  // The node panel starts hidden; open it the way a candidate would.
  const open = page.getByRole('button', { name: /^Add node/ });
  if (await open.isVisible()) await open.click();
  await page.locator('.ca-nodes-item', { hasText: new RegExp(`^${label}`) }).first().click();
  await wait(700);
}

async function recordBuild(page) {
  beat('back to the starting canvas');
  stage();
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.locator('.ca-node').first().waitFor();
  await wait(400);

  // Reset is undoable and asks nothing, so this is one click.
  await page.getByRole('button', { name: /reset/i }).click();
  await wait(1200);
  // fitView on a single node goes straight to max zoom, which is what we want
  // here — the starting canvas should look like a starting point, not like a
  // mistake. (Clicking zoom-in afterwards would fail: it is disabled at max.)
  await fitView(page);
  await wait(900);

  beat('add Edit Fields');
  await addNode(page, 'Edit Fields');
  await fitView(page);
  await connect(page, 'Nightly Recovery Run', 'Edit Fields');

  beat('add Aggregate');
  await addNode(page, 'Aggregate');
  await fitView(page);
  await connect(page, 'Edit Fields', 'Aggregate');
  await wait(700);

  beat('configure Edit Fields — three panes, live preview');
  // Double-click opens a node; a single click only selects it.
  await page.locator('.ca-node-wrap:has(.ca-node-name:text-is("Edit Fields")) .ca-node').dblclick();
  await page.locator('.ca-detail-head').waitFor();
  await wait(900);
  await page.getByPlaceholder('name').first().fill('status');
  await wait(500);
  await page.getByPlaceholder(/value or/).first().fill('checked');
  await wait(900);
  await backToCanvas(page);

  beat('name the aggregate output');
  await page.locator('.ca-node-wrap:has(.ca-node-name:text-is("Aggregate")) .ca-node').dblclick();
  await page.locator('.ca-detail-head').waitFor();
  await wait(700);
  await page.getByPlaceholder('output field name').first().fill('itemsSeen');
  await wait(900);
  await backToCanvas(page);

  beat('execute the small one');
  await execute(page, { hold: 2200 });
  await fitView(page);
  await wait(1400);
}

/* ── encoding ────────────────────────────────────────────────────────────── */

/**
 * An ffmpeg that can encode h264.
 *
 * Playwright caches its own ffmpeg, but it is a minimal build with libvpx and
 * nothing else — fine for muxing the webm it records, useless for an mp4. So this
 * looks for a real one on PATH and says so plainly when there is none, rather than
 * skipping the mp4 in silence and leaving someone wondering.
 */
function findFfmpeg() {
  const which = spawnSync('sh', ['-c', 'command -v ffmpeg'], { encoding: 'utf8' });
  const onPath = which.status === 0 ? which.stdout.trim() : '';
  return onPath || null;
}

function toMp4(webm) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  const mp4 = webm.replace(/\.webm$/, '.mp4');
  const res = spawnSync(ffmpeg, [
    '-y', '-i', webm,
    // yuv420p + even dimensions: what Keynote, Slides and Slack all accept.
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-movflags', '+faststart',
    mp4,
  ], { stdio: 'ignore' });
  return res.status === 0 ? mp4 : null;
}

/* ── main ────────────────────────────────────────────────────────────────── */

(async () => {
  fs.mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: SIZE,
    recordVideo: { dir: OUT, size: SIZE },
    colorScheme: 'light',
  });
  const page = await context.newPage();

  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 8000 });
  } catch {
    await context.close();
    await browser.close();
    console.error(`Nothing is serving ${BASE}. Start it first:\n`
      + '  npm run demo payment-recovery\n  npm run start:dev\n'
      + 'Or point this at another port with --url=http://127.0.0.1:3100');
    process.exit(1);
  }

  let failure = null;
  try {
    if (PART === 'all' || PART === 'showcase') await recordShowcase(page);
    if (PART === 'all' || PART === 'build') await recordBuild(page);
  } catch (err) {
    failure = err;
  }

  const video = page.video();
  await context.close();          // flushes the video file
  await browser.close();

  if (video) {
    const raw = await video.path();
    const webm = path.join(OUT, PART === 'all' ? 'showcase.webm' : `showcase-${PART}.webm`);
    fs.renameSync(raw, webm);
    const kb = (f) => Math.round(fs.statSync(f).size / 1024);
    console.log(`\n  ${path.relative(ROOT, webm)}  (${kb(webm)} KB)`);
    const mp4 = toMp4(webm);
    if (mp4) {
      console.log(`  ${path.relative(ROOT, mp4)}  (${kb(mp4)} KB)`);
    } else {
      console.log('  (webm only — Chrome, Slack and Google Slides play it.');
      console.log('   For an mp4, e.g. for Keynote: brew install ffmpeg, then re-run.)');
    }
  }

  // Leave the repo ready to present live, not holding the four-node workflow the
  // build half finished on.
  stage();
  console.log('  canvas re-staged with the full workflow');

  if (failure) {
    console.error(`\nrecording incomplete: ${failure.message}`);
    process.exit(1);
  }
})();
