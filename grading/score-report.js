'use strict';

/**
 * A graded run as a score and a report, for a command grader.
 *
 * `evaluate()` in parse_automation_solution.js produces the verdict — a fresh
 * run, every assertion's result, the trace signature. This turns it into the
 * two things a command grader hands back: a score with one entry per assertion,
 * and a Markdown report for whoever reviews the submission.
 */

const { secretsIn } = require('../engine/credentials');
const { formatReport, redact, oneLine } = require('./format');

/**
 * Checks `evaluate()` adds for a file that could not be read. They explain the
 * report, but they are not part of the task's definition of correct, so they
 * are left out of the score — a missing workflow already fails every real check.
 */
const SYNTHETIC = new Set(['solution-readable', 'assertions-readable']);

/**
 * What a reviewer should know about how the workflow was run, or null.
 *
 * The score always comes from running the submitted workflow now, so a workflow
 * never run in the simulation, or changed after its last run, still scores what
 * it does. The report says so: it is how the candidate worked, not what they built.
 */
function signatureNote(signature) {
  if (signature === 'VALID') return null;
  if (signature === 'MISSING') {
    return 'The workflow was never run in the simulation before it was submitted. '
      + 'The score is from running it at Submit.';
  }
  return 'The workflow was changed after its last run in the simulation. '
    + 'The score is from running the submitted version at Submit.';
}

/**
 * `{ totalScore, maxScore, breakoutScores }`: one point per assertion that
 * passes on the fresh run, titled by its author-written message.
 */
function scoreOf(result) {
  const breakoutScores = result.assertions
    .filter((a) => !SYNTHETIC.has(a.id))
    .map((a) => ({ title: oneLine(a.message || a.id), score: a.pass ? 1 : 0, maxScore: 1 }));
  return {
    totalScore: breakoutScores.reduce((sum, b) => sum + b.score, 0),
    maxScore: breakoutScores.length,
    breakoutScores,
  };
}

/**
 * The report a reviewer reads: the score, a table of the checks, and the full
 * grading report underneath for anyone who wants the workflow and the run.
 *
 * Node names, values and error messages are the candidate's and reach this
 * report, so every cell is escaped — no line breaks, pipes or HTML — and the
 * full report sits in a code fence longer than any run of backticks inside it.
 * Secrets are redacted as in the plain report. A private assertion's FAIL keeps
 * its expected value to itself, as there.
 */
function markdownReport(result, score = scoreOf(result)) {
  const secrets = new Set([
    ...secretsIn(result.scenario, result.graph), process.env.OPENAI_API_KEY,
  ].filter(Boolean));
  // Author-written text (titles, messages) may use Markdown; anything that can
  // carry the candidate's words (details) is shown literally, so a node name
  // cannot turn into a link or a heading in the reviewer's report.
  const safe = (text) => text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|');
  const clean = (text) => oneLine(redact(text, secrets));
  const cell = (text) => safe(clean(text));
  // Markdown punctuation first, so the backslash added for a pipe stays single.
  const literal = (text) => safe(clean(text).replace(/[\\`*_[\]()#~!]/g, (c) => `\\${c}`));

  const note = signatureNote(result.signature);
  const lines = [`# ${cell(result.scenario.title || 'Cosmo Automations')}`, ''];

  lines.push(`**Score: ${score.totalScore} of ${score.maxScore}** — `
    + `${score.totalScore} of ${score.maxScore} ${score.maxScore === 1 ? 'check passes' : 'checks pass'}.`);
  if (note) lines.push('', `> ${note}`);
  for (const a of result.assertions.filter((x) => SYNTHETIC.has(x.id))) {
    lines.push('', `> ${cell(a.message)} ${literal(a.detail)}`);
  }
  lines.push('');

  if (score.maxScore) {
    lines.push('| Result | Check | Details |', '| --- | --- | --- |');
    for (const a of result.assertions.filter((x) => !SYNTHETIC.has(x.id))) {
      const detail = a.pass ? '' : (a.private ? 'Details withheld' : a.detail);
      lines.push(`| ${a.pass ? '✅ Pass' : '❌ Fail'} | ${cell(a.message || a.id)} | ${literal(detail)} |`);
    }
    lines.push('');
  }

  const full = formatReport(result);
  const longest = Math.max(0, ...(full.match(/`+/g) || []).map((run) => run.length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  lines.push('## Workflow and run', '', `${fence}text`, full.trimEnd(), fence, '');
  return lines.join('\n');
}

module.exports = { scoreOf, markdownReport, signatureNote };
