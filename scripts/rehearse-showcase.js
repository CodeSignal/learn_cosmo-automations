#!/usr/bin/env node
'use strict';

/**
 * Rehearsal for the payment-recovery showcase workflow.
 *
 *   npm run rehearse:showcase
 *
 * Every figure the showcase relies on is checked here against a real run. Same
 * purpose as `npm run rehearse`, which covers the eu-orders demo —
 * this one covers payment-recovery, and it checks the *finished* workflow because
 * that is what this demo presents, rather than building it node by node.
 *
 * It also runs the deliberately-broken variant from the last beat, because "and
 * now watch it get rejected" is the beat that decides whether anyone believes the
 * grading.
 */

const fs = require('fs');
const path = require('path');
const { run } = require('../engine');
const { readJson } = require('../engine/scenarios');
const { evaluateAssertions } = require('../grading/assertions');
const { formatReport } = require('../grading/format');

const DIR = path.join(__dirname, '..', 'scenarios', 'payment-recovery');
const scenario = readJson(path.join(DIR, 'scenario.json'));
const reference = readJson(path.join(DIR, 'reference_solution.json'));

const beats = [];
const check = (beat, what, ok, detail) => beats.push({ beat, what, ok, detail });

/** The line the graded report prints for one node, so the sheet can quote it. */
const lineFor = (report, name) => (report.split('\n')
  .find((l) => l.trim().startsWith(name) && l.includes('in=')) || '').trim();

(async () => {
  const trace = await run(scenario, reference);
  const assertions = evaluateAssertions(scenario, reference, trace);
  const report = formatReport({
    scenario, graph: reference, trace, assertions, graphHash: trace.graphHash,
  });
  const rec = (name) => trace.nodes.find((n) => n.name === name) || {};
  const calls = (path) => trace.httpCalls.filter((c) => c.path.includes(path)).length;

  check(1, 'The canvas is one screenful: 19 nodes, 6 services, no scrolling to find the point',
    reference.nodes.length === 19,
    `${reference.nodes.length} nodes, ${reference.connections.length} connections`);

  check(2, 'A full run completes, and takes long enough to watch',
    trace.status === 'completed',
    `status=${trace.status}, ${trace.httpCalls.length} API calls, `
    + `simulated ${scenario.limits.maxSimulatedMs}ms cap`);

  check(3, 'De-duplication: 14 rows arrive, 12 distinct invoices leave',
    rec('One Row Per Invoice').itemsIn === 14 && rec('One Row Per Invoice').itemsOut === 12,
    lineFor(report, 'One Row Per Invoice'));

  check(4, 'The join names both of its inputs, so 20 in / 12 out explains itself',
    rec('Attach Account').itemsIn === 20 && rec('Attach Account').itemsOut === 12
    && lineFor(report, 'Attach Account').includes('input 1=12')
    && lineFor(report, 'Attach Account').includes('input 2=8'),
    lineFor(report, 'Attach Account'));

  const ports = rec('Route By Tier').outputsByPort || [];
  const byName = Object.fromEntries(ports.map((p) => [p.name, p.count]));
  check(5, 'Four branches, named by the candidate — and the fallback caught the odd one out',
    byName.enterprise === 5 && byName['mid market'] === 4
    && byName['self serve'] === 2 && byName.fallback === 1,
    lineFor(report, 'Route By Tier'));

  check(6, 'The loop batches two at a time, and says how many passes it took',
    rec('Retry Two At A Time').batches === 2 && rec('Retry Charge').runs === 2
    && calls('/retry') === 4,
    `${lineFor(report, 'Retry Two At A Time')}  ·  ${calls('/retry')} retry calls`);

  check(7, 'Sort then Limit: five enterprise payments in, the three largest out',
    rec('Biggest First').itemsOut === 5 && rec('Top Three').itemsOut === 3,
    lineFor(report, 'Top Three'));

  const emails = trace.sinks['Email Account Manager'] || [];
  check(8, 'The largest failed payment is the first email, built by expression',
    emails.length === 3 && emails[0].subject === 'Failed payment: INV-9002 (12400 EUR)',
    emails.length ? `to=${emails[0].to}  subject="${emails[0].subject}"` : 'no emails sent');

  check(9, 'Every write lands on a fixture: 3 emails, 3 sheet rows, 2 records, 2 messages',
    calls('/v1/messages/send') === 3 && calls('Outreach:append') === 3
    && calls('DunningQueue') === 2 && calls('chat.postMessage') === 2,
    `gmail=${calls('/v1/messages/send')} sheets=${calls('Outreach:append')} `
    + `airtable=${calls('DunningQueue')} slack=${calls('chat.postMessage')}`);

  const summary = (trace.sinks['Post To Billing Ops'] || [])[0];
  check(10, 'One summary message, with figures computed across the whole run',
    summary && summary.text === 'Recovery run: 9 payments handled, 28558 EUR still at risk',
    summary ? `"${summary.text}"` : 'no summary posted');

  const resultLine = report.split('\n').find((l) => l.startsWith('RESULT:'));
  check(11, 'The graded STDOUT leads with a verdict the AI grader can quote',
    resultLine === 'RESULT: PASS (16 PASS, 0 FAIL)',
    resultLine || 'no RESULT line');

  /* ── the last beat: break it on purpose ───────────────────────────────── */

  const broken = JSON.parse(JSON.stringify(reference));
  broken.nodes.find((n) => n.name === 'Top Three').parameters.maxItems = 5;
  const brokenTrace = await run(scenario, broken);
  const brokenAssertions = evaluateAssertions(scenario, broken, brokenTrace);
  const brokenReport = formatReport({
    scenario, graph: broken, trace: brokenTrace, assertions: brokenAssertions,
    graphHash: brokenTrace.graphHash,
  });
  const brokenResult = brokenReport.split('\n').find((l) => l.startsWith('RESULT:'));
  const fails = brokenAssertions.filter((a) => !a.pass);

  check(12, 'Loosen "top three" to five and the grader rejects it, with the evidence',
    brokenResult && brokenResult.startsWith('RESULT: FAIL') && fails.length >= 3,
    `${brokenResult}\n         ` + fails.map((f) => `FAIL ${f.id}  ${f.detail}`).join('\n         '));

  /* ── report ──────────────────────────────────────────────────────────── */

  const pad = (s, n) => String(s).padEnd(n);
  for (const b of beats) {
    console.log(`${b.ok ? 'OK  ' : 'FAIL'} beat ${pad(b.beat + ':', 4)} ${b.what}`);
    console.log(`         ${b.detail}`);
  }
  const failed = beats.filter((b) => !b.ok);
  console.log('');
  console.log(failed.length
    ? `${failed.length}/${beats.length} beats FAILED — the showcase figures are out of date`
    : `${beats.length}/${beats.length} showcase beats verified`);

  const outDir = path.join(DIR, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'showcase.stdout.txt'), report);
  fs.writeFileSync(path.join(outDir, 'showcase-broken.stdout.txt'), brokenReport);
  console.log(`STDOUT captures: ${path.relative(process.cwd(), outDir)}/showcase*.stdout.txt`);

  process.exit(failed.length ? 1 : 0);
})();
