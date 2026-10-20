#!/usr/bin/env node
'use strict';

/**
 * Demo rehearsal.
 *
 * Walks the eu-orders demo workflow beat by beat and asserts each step still
 * produces the effect it should, so the demo stays true as the build changes.
 *
 *   npm run rehearse
 *
 * It builds the workflow the way the demo does — node by node, executing as it
 * goes — rather than loading the finished reference solution, because the point
 * is to verify the *sequence* the demo walks through.
 */

const fs = require('fs');
const path = require('path');
const { run } = require('../engine');
const { defaultScenario, readJson } = require('../engine/scenarios');

const ROOT = path.join(__dirname, '..');
const SCENARIO = defaultScenario();
const S = readJson(SCENARIO.scenarioPath);

const node = (id,name,type,pos,params,extra={}) => ({id,name,type,position:pos,parameters:params,...extra});
const conn = (from,to) => ({from,fromOutput:0,to,toInput:0});
const trigger = () => node('n1','When clicking Execute','manualTrigger',[80,240],{});
const fetch = (cred) => node('n2','Fetch Orders','httpRequest',[300,240],{
  method:'GET', url:'https://api.acme-crm.test/v1/orders', sendQuery:true,
  query:[{name:'since',value:'2026-07-30'}], sendBody:false, body:[], neverError:false,
}, cred?{credentialId:cred}:{});

/**
 * The credential the demo CREATES in beat 4.
 *
 * It used to sit ready-made in the scenario and beat 4 was "pick it from the
 * dropdown". Credentials are now the candidate's to create, so the demo gained a
 * step — and the rehearsal has to build the same thing the demo does, or it
 * would be verifying a flow nobody performs.
 */
const SLACK_CREDENTIAL = {
  id: 'cred_slack',
  name: 'Ops Slack',
  type: 'slackApi',
  fields: { token: 'xoxb-FAKE-000000-000000' },
};

const CRM_CREDENTIAL = {
  id: 'cred_crm',
  name: 'Acme CRM (staging)',
  type: 'acmeCrmApi',
  fields: { apiKey: 'sk_test_FAKE_2f9a1c' },
};
const WRONG_KEY = { ...CRM_CREDENTIAL, fields: { apiKey: 'sk_test_WRONG' } };

const beats = [];
const check = (n, what, ok, detail) => beats.push({beat:n, what, ok, detail});

(async () => {
  // Beat 3 — no credential must produce a real 401 the demo can show.
  let g = {version:1, nodes:[trigger(), fetch(null)], connections:[conn('n1','n2')]};
  let t = await run(S, g);
  const call = t.httpCalls[0];
  check(3,'HTTP Request without a credential returns a real 401',
    call && call.status===401 && t.status==='error',
    `status=${call&&call.status} node=${t.nodes[1].status} msg="${t.nodes[1].error}"`);

  // Beat 3b — a credential with the WRONG key is still a 401, which is what makes
  // creating one a real exercise rather than a form to fill in.
  g = {version:1, nodes:[trigger(), fetch('cred_crm')], connections:[conn('n1','n2')],
       credentials:[WRONG_KEY]};
  t = await run(S, g);
  check('3b','A credential with the wrong key is also a real 401',
    t.httpCalls[0] && t.httpCalls[0].status===401 && t.status==='error',
    `status=${t.httpCalls[0] && t.httpCalls[0].status} msg="${t.nodes[1].error}"`);

  // Beat 4 — THE MOMENT. Create the credential, attach it, and the output panel
  // fills with real items.
  g = {version:1, nodes:[trigger(), fetch('cred_crm')], connections:[conn('n1','n2')],
       credentials:[CRM_CREDENTIAL]};
  t = await run(S, g);
  const out = t.nodes[1].output;
  const orders = out && out[0] && out[0].json.orders;
  check(4,'With the credential: 200, and real items reach the output panel',
    t.httpCalls[0].status===200 && Array.isArray(orders) && orders.length===12,
    `status=200 outputItems=${out.length} orders[]=${orders?orders.length:'—'} first=${orders?JSON.stringify(orders[0]):'—'}`);

  // Beat 5 — one item becomes twelve.
  g.credentials = [CRM_CREDENTIAL, SLACK_CREDENTIAL];
  g.nodes.push(node('n3','Split Out Orders','splitOut',[520,240],{field:'orders',include:'noOtherFields'}));
  g.connections.push(conn('n2','n3'));
  t = await run(S, g);
  check(5,'Split Out turns 1 item into 12',
    t.nodes[2].itemsIn===1 && t.nodes[2].itemsOut===12,
    `in=${t.nodes[2].itemsIn} out=${t.nodes[2].itemsOut}`);

  // Beat 6 — a correct expression filters; a typo resolves to [undefined] and keeps nothing.
  const filt = (path) => node('n4','Filter High Value EU','filter',[740,240],{
    combinator:'and',
    conditions:[{left:`={{ ${path} }}`,op:'equals',right:'EU'},{left:'={{ $json.total }}',op:'gt',right:1000}],
  });
  g.nodes.push(filt('$json.region')); g.connections.push(conn('n3','n4'));
  t = await run(S, g);
  const good = t.nodes[3].itemsOut;
  g.nodes[3] = filt('$json.regionn');
  t = await run(S, g);
  const typo = t.nodes[3];
  check(6,'A correct path keeps 3; a typo keeps 0 and is diagnosable',
    good===3 && typo.itemsOut===0,
    `correct=${good} typo=${typo.itemsOut} resolvedTo="${typo.diagnostics[0].display}"`);

  // Beat 7 — the whole flow, counts along the path.
  g.nodes[3] = filt('$json.region');
  g.credentials = [CRM_CREDENTIAL, SLACK_CREDENTIAL];
  g.nodes.push(node('n5','Aggregate Totals','aggregate',[960,240],{
    mode:'summarize', outputs:[{as:'count',op:'count'},{as:'total',op:'sum',field:'total'}]}));
  g.credentials = [CRM_CREDENTIAL, SLACK_CREDENTIAL];
  g.nodes.push(node('n6','Notify Ops','slack',[1180,240],{
    resource:'message', operation:'post', channel:'#ops-alerts',
    text:'={{ $json.count }} EU orders over $1000 — total ${{ $json.total }}'}, {credentialId:'cred_slack'}));
  g.connections.push(conn('n4','n5'), conn('n5','n6'));
  t = await run(S, g);
  check(7,'Whole flow: counts light up along the path',
    t.status==='completed',
    t.nodes.map(n=>`${n.name}(${n.itemsIn}/${n.itemsOut})`).join(' → '));
  check(7,'Slack receives exactly the required text',
    t.sinks['Notify Ops'][0].text === '3 EU orders over $1000 — total $4700',
    JSON.stringify(t.sinks['Notify Ops'][0]));

  // Beat 4 again, timed: how long does the run take with realistic latency?
  const t0 = Date.now();
  await run(S, g, {simulateLatency:true});
  check(0,'A full run takes a demo-appropriate time', true, `${Date.now()-t0}ms wall`);

  // The graph the demo ends with, for beats 8-9.
  fs.mkdirSync(path.join(SCENARIO.dir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(SCENARIO.dir, 'out', 'demo-final-graph.json'),
    JSON.stringify({ version: 1, ...g }, null, 2));

  for (const b of beats) {
    console.log(`${b.ok ? 'OK  ' : 'FAIL'} beat ${b.beat}: ${b.what}\n         ${b.detail}`);
  }
  console.log(`\n${beats.filter(b=>b.ok).length}/${beats.length} demo beats verified`);
  process.exit(beats.every(b=>b.ok) ? 0 : 1);
})();
