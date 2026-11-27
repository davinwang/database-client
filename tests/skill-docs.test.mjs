/**
 * Documentation guards.
 *
 * Two failure modes this file exists to prevent:
 *  1) the skill `description` grows past the host limit (1024 chars) and the agent silently deactivates the
 *     skill — it is matched by description, so an over-long one is worse than a vague one;
 *  2) `SKILL.md` (fully loaded whenever the skill activates) grows back into a manual, so progressive
 *     disclosure is lost and every activation pays for content the task does not need.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from './helpers/util.mjs';

const SKILL_FILES = ['SKILL.md', 'SKILL.zh-CN.md'];
const REFERENCES_DIR = 'references';

/** Hosts deactivate a skill whose description exceeds this many characters. */
const MAX_DESCRIPTION_CHARS = 1024;
/** Entrypoint budget: details belong in references/, not here. */
const MAX_SKILL_BYTES = 12 * 1024;
const MAX_SKILL_LINES = 200;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/** Parse the leading YAML frontmatter as flat `key: value` pairs (nested keys such as metadata.bins are
 *  flattened — the skill files only use that shape). */
function frontmatter(text, file) {
  assert.ok(text.startsWith('---\n'), `${file} must start with a YAML frontmatter block`);
  const end = text.indexOf('\n---\n', 3);
  assert.ok(end > 0, `${file} frontmatter is not terminated`);
  const fields = {};
  for (const line of text.slice(4, end + 1).split('\n')) {
    const m = /^\s*([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (!m || m[1] in fields) continue;
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1).replace(/\\"/g, '"');
    fields[m[1]] = value;
  }
  return fields;
}

const packageVersion = JSON.parse(read('package.json')).version;

test('skill descriptions stay under the host limit (1024 chars)', () => {
  for (const file of SKILL_FILES) {
    const { description } = frontmatter(read(file), file);
    assert.ok(description, `${file} has no description`);
    assert.ok(
      description.length <= MAX_DESCRIPTION_CHARS,
      `${file} description is ${description.length} chars, over the ${MAX_DESCRIPTION_CHARS}-char host limit`,
    );
    assert.ok(!/\n/.test(description), `${file} description must stay on one line`);
  }
});

test('frontmatter identifies the skill and keeps the version in sync with package.json', () => {
  for (const file of SKILL_FILES) {
    const meta = frontmatter(read(file), file);
    assert.equal(meta.name, 'database-client', `${file} name`);
    assert.equal(meta.version, packageVersion, `${file} version must match package.json`);
    assert.match(meta.cliHelp ?? '', /bin\/dbcli\.mjs --help/, `${file} metadata.cliHelp`);
  }
});

test('SKILL.md stays a progressive-disclosure entrypoint', () => {
  const text = read('SKILL.md');
  const bytes = Buffer.byteLength(text, 'utf8');
  const lines = text.split('\n').length;
  assert.ok(bytes <= MAX_SKILL_BYTES, `SKILL.md is ${bytes} bytes, budget is ${MAX_SKILL_BYTES}`);
  assert.ok(lines <= MAX_SKILL_LINES, `SKILL.md has ${lines} lines, budget is ${MAX_SKILL_LINES}`);
  assert.match(text, /references\/engines\.md/, 'SKILL.md must point at the on-demand reference files');
});

test('every references/ path mentioned in docs or code exists', () => {
  const files = [
    ...SKILL_FILES,
    'README.md',
    ...walk(path.join(ROOT, 'lib')).map((abs) => path.relative(ROOT, abs).replace(/\\/g, '/')),
  ];
  const missing = [];
  for (const file of files) {
    for (const match of read(file).matchAll(new RegExp(`${REFERENCES_DIR}/([\\w./-]+\\.md)`, 'g'))) {
      if (!fs.existsSync(path.join(ROOT, REFERENCES_DIR, match[1]))) missing.push(`${file} → ${match[0]}`);
    }
  }
  assert.deepEqual(missing, [], `dangling reference links: ${missing.join(', ')}`);
});

test('every reference file is listed in both language entrypoints', () => {
  const onDisk = fs.readdirSync(path.join(ROOT, REFERENCES_DIR)).filter((f) => f.endsWith('.md')).sort();
  assert.ok(onDisk.length > 0, 'references/ is empty');
  for (const file of SKILL_FILES) {
    const text = read(file);
    const unlisted = onDisk.filter((ref) => !text.includes(`${REFERENCES_DIR}/${ref}`));
    assert.deepEqual(unlisted, [], `${file} does not point at: ${unlisted.join(', ')}`);
  }
});

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith('.mjs')) out.push(abs);
  }
  return out;
}
