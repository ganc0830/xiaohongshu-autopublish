'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {fileHash, validateManifest, assertCanSubmit, validateReview, validateConfirmation, validatePoint, validateCdp, submissionRowMatches, acquireLock, commit, main} = require('../scripts/publish.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'xhs-skill-test-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const image = path.join(dir, '01.png');
  fs.writeFileSync(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5z8AAAAASUVORK5CYII=', 'base64'));
  const m = {version: 1, id: 'example-01', account: {name: '示例账号', id: 'example-id'}, title: '示例标题', body: '一段正文', visibility: 'public', ai_generated: true, images: [{path: image, sha256: fileHash(image)}]};
  return {dir, m, image};
}
test('valid content, ordered manifest fingerprint and changed file rejection', t => {
  const {m, image, dir} = fixture(t);
  const first = validateManifest(m);
  const second = path.join(dir, '02.png'); fs.writeFileSync(second, 'different image bytes');
  m.images.push({path: second, sha256: fileHash(second)});
  const ordered = validateManifest(m); m.images.reverse();
  assert.notEqual(ordered, validateManifest(m)); assert.notEqual(first, ordered);
  fs.appendFileSync(image, 'tamper');
  assert.throws(() => validateManifest(m), /Image changed/);
});
test('duplicate images, traversal ids and changing visibility cannot silently publish', t => {
  const {m} = fixture(t);
  assert.throws(() => validateManifest({...m, id: '../escape'}), /Invalid content id/);
  assert.throws(() => validateManifest({...m, images: [...m.images, ...m.images]}), /Duplicate image/);
  assert.throws(() => validateManifest({...m, visibility: 'private'}), /public visibility only/);
});
test('any prior click blocks another commit, including uncertain outcomes', () => {
  for (const phase of ['submission-attempted', 'uncertain', 'published', 'in-review']) {
    assert.throws(() => assertCanSubmit({fingerprint: 'a', phase, attempted_at: '2026-01-01T00:00:00Z'}, 'a'), /reconcile instead/);
  }
  assert.doesNotThrow(() => assertCanSubmit({fingerprint: 'a', phase: 'prepared'}, 'a'));
  assert.throws(() => assertCanSubmit({fingerprint: 'a', phase: 'prepared'}, 'b'), /Manifest changed/);
});
test('review rejects stale, wrong-account and changed screenshot evidence', t => {
  const {dir, m} = fixture(t);
  const shot = path.join(dir, 'screen.png'); fs.writeFileSync(shot, 'screenshot');
  const screenshots = [{path: shot, sha256: fileHash(shot)}];
  const state = {fingerprint: 'a', screenshots};
  const now = Date.now();
  const r = {fingerprint: 'a', reviewed_at: new Date(now).toISOString(), account_name: m.account.name, account_id: m.account.id, account_verified: true, images_reviewed: true, order_verified: true, settings_reviewed: true, original_declaration: false, screenshots};
  assert.doesNotThrow(() => validateReview(r, state, m, now));
  assert.throws(() => validateReview(r, state, m, now + 600001), /expired/);
  assert.throws(() => validateReview({...r, account_id: 'another'}, state, m, now), /account mismatch/);
  assert.throws(() => validateReview({...r, order_verified: false}, state, m, now), /order_verified/);
  fs.appendFileSync(shot, 'changed'); assert.throws(() => validateReview(r, state, m, now), /screenshot changed/);
});
test('coordinate fallback rejects moved host, changed viewport and points outside host', () => {
  const rect = {x: 100, y: 700, width: 600, height: 80}, vp = {width: 1000, height: 900, dpr: 1};
  assert.doesNotThrow(() => validatePoint({x: 550, y: 740}, rect, rect, vp, vp));
  assert.throws(() => validatePoint({x: 550, y: 740}, rect, {...rect, y: 704}, vp, vp), /host moved/);
  assert.throws(() => validatePoint({x: 550, y: 740}, rect, rect, vp, {...vp, height: 901}), /Viewport changed/);
  assert.throws(() => validatePoint({x: 50, y: 740}, rect, rect, vp, vp), /outside host/);
});
test('remote debugging accepts only loopback without embedded credentials', () => {
  assert.equal(validateCdp('http://127.0.0.1:9227'), 'http://127.0.0.1:9227/');
  for (const url of ['http://example.com:9227', 'http://0.0.0.0:9227', 'http://user:pass@localhost:9227', 'https://localhost:9227']) {
    assert.throws(() => validateCdp(url), /loopback/);
  }
});
test('exclusive task lock prevents concurrent browser mutations', t => {
  const {dir} = fixture(t); const release = acquireLock(dir);
  try { assert.throws(() => acquireLock(dir), /EEXIST/); } finally { release(); }
  const next = acquireLock(dir); next();
});
test('validation CLI works without browser, authorization is required before any commit', async t => {
  const {dir, m} = fixture(t);
  const manifest = path.join(dir, 'manifest.json'); fs.writeFileSync(manifest, JSON.stringify(m));
  const result = await main(['validate', '--manifest', manifest]);
  assert.equal(result.valid, true); assert.equal(result.image_count, 1);
  await assert.rejects(main(['commit', '--manifest', manifest]), /authorization/);
});
test('timeout after click persists attempted state and blocks another actual click', async t => {
  const {dir, m} = fixture(t);
  const shot = path.join(dir, 'screen.png'); fs.writeFileSync(shot, 'reviewed screenshot');
  const screenshots = [{path: shot, sha256: fileHash(shot)}];
  const state = {phase: 'prepared', fingerprint: validateManifest(m), screenshots};
  const review = {fingerprint: state.fingerprint, reviewed_at: new Date().toISOString(), account_name: m.account.name, account_id: m.account.id, account_verified: true, images_reviewed: true, order_verified: true, settings_reviewed: true, original_declaration: false, screenshots};
  const confirmation = {scope: 'exact-content', fingerprint: state.fingerprint, account_name: m.account.name, account_id: m.account.id, confirmed_at: new Date().toISOString(), confirmed_by: 'fixture-human', human_reference: 'test fixture approval'};
  let clicks = 0, attemptedWasPersisted = false;
  const button = {count: async () => 1, isVisible: async () => true, isEnabled: async () => true, click: async () => {assert.equal(attemptedWasPersisted, true); clicks++;}};
  const p = {
    url: () => 'https://creator.xiaohongshu.com/publish/publish',
    getByText: () => ({first: () => ({waitFor: async () => {}})}),
    locator: selector => ({innerText: async () => selector === 'body' ? `${m.account.name}\n公开可见\n笔记含AI合成内容` : m.body}),
    getByPlaceholder: () => ({inputValue: async () => m.title}),
    getByRole: (_, options) => options.name === '编辑' ? {count: async () => 1} : button,
    waitForURL: async () => {throw new Error('simulated network timeout');}
  };
  const persist = () => {if (state.phase === 'submission-attempted' && state.attempted_at) attemptedWasPersisted = true;};
  await assert.rejects(commit(p, m, state, dir, review, confirmation, persist), /requires reconciliation/);
  assert.equal(state.phase, 'uncertain'); assert.equal(clicks, 1);
  await assert.rejects(commit(p, m, state, dir, review, confirmation, persist), /reconcile instead/);
  assert.equal(clicks, 1);
});
test('human confirmation is bound to exact content and account and cannot be replaced by QA', t => {
  const {m} = fixture(t), fingerprint = validateManifest(m);
  const c = {scope: 'exact-content', fingerprint, account_name: m.account.name, account_id: m.account.id, confirmed_at: new Date().toISOString(), confirmed_by: 'fixture-human', human_reference: 'explicit approval of final images and copy'};
  assert.doesNotThrow(() => validateConfirmation(c, fingerprint, m));
  assert.throws(() => validateConfirmation(null, fingerprint, m), /Human content confirmation/);
  assert.throws(() => validateConfirmation(c, 'changed-content', m), /content changed/);
  assert.throws(() => validateConfirmation({...c, account_id: 'another-owner'}, fingerprint, m), /account mismatch/);
  assert.throws(() => validateConfirmation({...c, scope: 'all-future-posts'}, fingerprint, m), /Human content confirmation/);
  assert.throws(() => validateConfirmation({...c, human_reference: ''}, fingerprint, m), /Traceable/);
});
test('old same-title notes or unattempted content cannot be reported as this submission', () => {
  const row = '示例标题\n2026-10-10 17:47\n1\n0';
  assert.equal(submissionRowMatches(row, '2026-10-10T09:47:49Z'), true);
  assert.equal(submissionRowMatches(row, '2026-10-09T09:47:49Z'), false);
  assert.equal(submissionRowMatches(row, undefined), false);
  assert.equal(submissionRowMatches('示例标题，没有日期', '2026-10-10T09:47:49Z'), false);
});
