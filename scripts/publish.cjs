#!/usr/bin/env node
'use strict';

// No credentials, browser profile, account, or machine-specific runtime is bundled.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const HOME = 'https://creator.xiaohongshu.com';
const MANAGER = `${HOME}/new/note-manager`;
const UPLOAD = `${HOME}/publish/publish?from=homepage&target=image&openFilePicker=true`;
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const fileHash = file => digest(fs.readFileSync(file));
const normalize = value => value.replace(/\s+/gu, '');
function assert(ok, message) { if (!ok) throw new Error(message); }
function read(file) { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/u, '')); }
function save(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, {mode: 0o600});
  fs.renameSync(tmp, file);
}
function validateManifest(m) {
  assert(m.version === 1, 'Unsupported manifest version');
  assert(typeof m.id === 'string' && /^[a-z0-9][a-z0-9_-]{0,79}$/i.test(m.id), 'Invalid content id');
  assert(!/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(m.id), 'Reserved content id');
  assert(m.account && typeof m.account.name === 'string' && m.account.name.trim(), 'Account name required');
  assert(m.account.id === undefined || typeof m.account.id === 'string', 'Account id must be a string');
  assert(typeof m.title === 'string' && m.title.trim() && Array.from(m.title).length <= 20, 'Title must be 1–20 characters');
  assert(typeof m.body === 'string' && m.body.trim() && Array.from(m.body).length <= 1000, 'Body must be 1–1000 characters');
  assert(m.visibility === 'public', 'Automatic helper supports public visibility only; honor other visibility manually');
  assert(typeof m.ai_generated === 'boolean', 'Explicit ai_generated boolean required');
  assert(Array.isArray(m.images) && m.images.length > 0, 'Images required');
  const names = new Set();
  const hashes = new Set();
  for (const item of m.images) {
    assert(item && typeof item.path === 'string' && path.isAbsolute(item.path), 'Absolute image path required');
    assert(/\.(png|jpe?g)$/i.test(item.path), 'Unsupported image extension');
    assert(typeof item.sha256 === 'string' && /^[0-9a-f]{64}$/.test(item.sha256), 'SHA-256 required');
    assert(fs.statSync(item.path).isFile(), 'Image must be a regular file');
    assert(fileHash(item.path) === item.sha256, `Image changed: ${path.basename(item.path)}`);
    assert(!names.has(path.resolve(item.path).toLowerCase()) && !hashes.has(item.sha256), 'Duplicate image');
    names.add(path.resolve(item.path).toLowerCase()); hashes.add(item.sha256);
  }
  return digest(JSON.stringify(m));
}
function assertCanSubmit(state, fingerprint) {
  assert(state && state.fingerprint === fingerprint, 'Manifest changed; preserve previous attempt and investigate');
  assert(!state.attempted_at, 'Submission already attempted; reconcile instead of retrying');
  assert(state.phase === 'prepared', 'Prepare and review before submitting');
}
function validateReview(r, state, m, now = Date.now()) {
  assert(r.fingerprint === state.fingerprint, 'Review does not match prepared content');
  const age = now - Date.parse(r.reviewed_at);
  assert(Number.isFinite(age) && age >= 0 && age <= 600000, 'Review expired or invalid');
  assert(r.account_name === m.account.name && (!m.account.id || r.account_id === m.account.id), 'Reviewed account mismatch');
  for (const key of ['account_verified', 'images_reviewed', 'order_verified', 'settings_reviewed']) {
    assert(r[key] === true, `Review missing: ${key}`);
  }
  assert(r.original_declaration === false, 'Automatic helper requires original declaration off');
  assert(Array.isArray(r.screenshots) && r.screenshots.length === state.screenshots.length, 'Review both prepared screenshots');
  for (const shot of state.screenshots) {
    assert(r.screenshots.some(x => x.path === shot.path && x.sha256 === shot.sha256), 'Prepared screenshot not reviewed');
    assert(fileHash(shot.path) === shot.sha256, 'Prepared screenshot changed');
  }
}
function validateConfirmation(c, fingerprint, m) {
  assert(c && c.scope === 'exact-content' && c.fingerprint === fingerprint, 'Human content confirmation missing or content changed');
  assert(c.account_name === m.account.name && (!m.account.id || c.account_id === m.account.id), 'Human confirmation account mismatch');
  assert(typeof c.confirmed_by === 'string' && c.confirmed_by.trim(), 'Current human identity reference required');
  assert(typeof c.human_reference === 'string' && c.human_reference.trim(), 'Traceable direct human confirmation required');
  const time = Date.parse(c.confirmed_at);
  assert(Number.isFinite(time) && time <= Date.now(), 'Invalid human confirmation time');
}
function validatePoint(point, before, current, viewportBefore, viewportNow) {
  assert(point && Number.isFinite(point.x) && Number.isFinite(point.y), 'Fresh screenshot-derived publish_point required');
  assert(before && current, 'Publish host not visible');
  assert(JSON.stringify(viewportBefore) === JSON.stringify(viewportNow), 'Viewport changed; prepare again');
  for (const key of ['x', 'y', 'width', 'height']) assert(Math.abs(before[key] - current[key]) <= 2, 'Publish host moved; prepare again');
  assert(point.x > current.x && point.x < current.x + current.width && point.y > current.y && point.y < current.y + current.height, 'Publish point outside host');
  assert(point.x > 0 && point.x < viewportNow.width && point.y > 0 && point.y < viewportNow.height, 'Publish point outside viewport');
}
function args(argv) {
  const out = {command: argv[0]};
  for (let i = 1; i < argv.length; i++) {
    assert(argv[i].startsWith('--'), `Unexpected argument ${argv[i]}`);
    const key = argv[i].slice(2);
    if (key === 'authorized') out[key] = true;
    else { assert(argv[i + 1] && !argv[i + 1].startsWith('--'), `Missing --${key} value`); out[key] = argv[++i]; }
  }
  return out;
}
function validateCdp(address) {
  const u = new URL(address);
  assert(u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && !u.username && !u.password && !u.search && !u.hash && u.pathname === '/', 'CDP must use a loopback HTTP address');
  return u.href;
}
const text = p => p.locator('body').innerText();
const titleBox = p => p.getByPlaceholder('填写标题会有更多赞哦');
const bodyBox = p => p.locator('[contenteditable=true][role=textbox]');
const imageButtons = p => p.getByRole('button', {name: '编辑', exact: true});
async function ensureAccount(p, m) {
  assert(new URL(p.url()).origin === HOME, 'Unexpected browser origin');
  await p.getByText(m.account.name, {exact: true}).first().waitFor({timeout: 15000});
  const lines = (await text(p)).split(/\r?\n/u).map(x => x.trim());
  assert(lines.includes(m.account.name), 'Account name not verified or session expired');
  const idLine = lines.find(x => /小红书账号\s*[:：]/u.test(x));
  if (m.account.id && idLine) assert(idLine.split(/[:：]/u).pop().trim() === m.account.id, 'Account ID mismatch');
}
function submissionRowMatches(row, attempted, timezone = 'Asia/Shanghai') {
  if (!attempted) return false;
  const match = row.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})\s+(\d{1,2}):(\d{2})/u);
  if (!match) return false;
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'}).formatToParts(new Date(attempted)).map(x => [x.type, x.value]));
  const expected = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  const actual = Date.UTC(+match[1], +match[2] - 1, +match[3], +match[4], +match[5]);
  return Math.abs(expected - actual) <= 15 * 60000;
}
async function shot(p, dir, name) {
  const file = path.join(dir, `${name}.png`);
  assert(!fs.existsSync(file), 'Screenshot exists; preserve previous evidence');
  await p.screenshot({path: file});
  return {path: file, sha256: fileHash(file)};
}
async function verifyEditor(p, m) {
  await ensureAccount(p, m);
  assert(await titleBox(p).inputValue() === m.title, 'Editor title mismatch');
  assert(normalize(await bodyBox(p).innerText()) === normalize(m.body), 'Editor body mismatch');
  assert(await imageButtons(p).count() === m.images.length, 'Image upload count mismatch');
  const visible = await text(p);
  assert(visible.includes('公开可见'), 'Public visibility not verified');
  if (m.ai_generated) assert(visible.includes('笔记含AI合成内容'), 'AI declaration not verified');
}
async function prepare(p, m, state, dir) {
  await p.goto(MANAGER, {waitUntil: 'domcontentloaded'});
  await ensureAccount(p, m);
  await p.getByText('全部', {exact: false}).first().waitFor({timeout: 20000});
  // A visible duplicate is a stop signal. An absent row is not proof of absence.
  if (await p.getByText(m.title, {exact: true}).count()) {
    state.phase = 'existing-needs-review';
    throw new Error('Same title already visible in management; reconcile manually');
  }
  await p.goto(UPLOAD, {waitUntil: 'domcontentloaded'});
  await ensureAccount(p, m);
  await p.locator('input[type=file]').first().setInputFiles(m.images.map(x => x.path));
  await titleBox(p).waitFor({timeout: 45000});
  const guide = p.getByText('我知道了', {exact: true});
  if (await guide.isVisible().catch(() => false)) await guide.click();
  await titleBox(p).fill(m.title);
  await titleBox(p).press('End'); await titleBox(p).press('Space'); await titleBox(p).press('Backspace');
  await bodyBox(p).fill(m.body);
  await p.getByText('内容设置', {exact: true}).click();
  if (m.ai_generated && !(await text(p)).includes('笔记含AI合成内容')) {
    await p.getByText('添加内容类型声明', {exact: true}).click();
    await p.getByText('笔记含AI合成内容', {exact: true}).click();
  }
  const expand = p.getByText('展开所有图片', {exact: true});
  if (await expand.isVisible().catch(() => false)) await expand.click();
  const deadline = Date.now() + 45000;
  while (await imageButtons(p).count() !== m.images.length && Date.now() < deadline) await p.waitForTimeout(500);
  await verifyEditor(p, m);
  const stamp = Date.now();
  await p.getByText('图片编辑', {exact: true}).scrollIntoViewIfNeeded();
  const images = await shot(p, dir, `prepare-images-${stamp}`);
  await p.getByText('内容设置', {exact: true}).scrollIntoViewIfNeeded();
  const settings = await shot(p, dir, `prepare-settings-${stamp}`);
  const host = p.locator('xhs-publish-btn');
  state.host = await host.boundingBox();
  state.viewport = await p.evaluate(() => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio}));
  state.screenshots = [images, settings];
  state.phase = 'prepared'; state.prepared_at = new Date().toISOString();
}
async function rowText(locator) {
  return locator.evaluate(el => {
    let a = el;
    for (let i = 0; i < 7 && a.parentElement; i++, a = a.parentElement) {
      if (/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/u.test(a.innerText || '')) return a.innerText;
    }
    return el.parentElement?.innerText || el.innerText;
  });
}
async function reconcile(p, m, state, dir) {
  await p.goto(MANAGER, {waitUntil: 'domcontentloaded'});
  await ensureAccount(p, m);
  await p.getByText('已发布', {exact: true}).waitFor({timeout: 15000});
  state.public_note_url = null;
  for (const [label, phase] of [['已发布', 'published'], ['审核中', 'in-review'], ['未通过', 'rejected']]) {
    const tab = p.getByText(label, {exact: true});
    if (await tab.count() !== 1 || !(await tab.isVisible())) continue;
    const active = await tab.evaluate(el => el.classList.contains('tab-item--active'));
    if (!active) {
      const responsePromise = p.waitForResponse(response => {
        const url = new URL(response.url());
        return url.hostname.endsWith('.xiaohongshu.com') && url.pathname === '/api/galaxy/v2/creator/note/user/posted';
      }, {timeout: 15000});
      const results = await Promise.all([responsePromise, tab.click()]);
      assert(results[0].ok(), 'Management list request failed; inspect manually');
    }
    await p.waitForFunction(expected => document.querySelector('.tab-item--active')?.textContent.trim() === expected, label, {timeout: 3000});
    await p.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const item = p.getByText(m.title, {exact: true});
    await item.first().waitFor({timeout: 10000}).catch(() => {});
    const count = await item.count();
    if (count > 1) throw new Error('Ambiguous same-title notes; verify date, cover and detail manually');
    if (count === 1) {
      const row = await rowText(item);
      if (!submissionRowMatches(row, state.attempted_at, m.timezone)) {
        state.candidate_status = phase; state.candidate_row = row;
        state.reason = 'Existing title has no matching submission time; verify manually';
        continue;
      }
      state.phase = phase; state.verification_tab = label;
      state.management_row = row;
      state.verification_screenshot = await shot(p, dir, `verify-${phase}-${Date.now()}`);
      state.verified_at = new Date().toISOString(); state.management_url = p.url();
      return;
    }
  }
  state.phase = state.attempted_at ? 'uncertain' : 'existing-needs-review';
  state.verification_screenshot = await shot(p, dir, `verify-unresolved-${Date.now()}`);
  state.reason = 'No unique row found in loaded tabs; inspect pagination, date and account; do not resubmit';
}
async function commit(p, m, state, dir, review, confirmation, persist) {
  assertCanSubmit(state, validateManifest(m));
  validateConfirmation(confirmation, state.fingerprint, m);
  validateReview(review, state, m);
  await verifyEditor(p, m);
  const button = p.getByRole('button', {name: '发布', exact: true});
  const normal = await button.count() === 1 && await button.isVisible() && await button.isEnabled();
  if (!normal) {
    const host = p.locator('xhs-publish-btn');
    assert(await host.getAttribute('submit-disabled') === 'false', 'Publish host disabled or changed');
    const viewport = await p.evaluate(() => ({width: innerWidth, height: innerHeight, dpr: devicePixelRatio}));
    validatePoint(review.publish_point, state.host, await host.boundingBox(), state.viewport, viewport);
  }
  // Once this write succeeds, every failure must go to reconciliation, never retry click.
  state.content_confirmation = {fingerprint: confirmation.fingerprint, confirmed_at: confirmation.confirmed_at, confirmed_by: confirmation.confirmed_by, human_reference: confirmation.human_reference};
  state.quality_review = {reviewed_at: review.reviewed_at, screenshots: review.screenshots};
  state.phase = 'submission-attempted'; state.attempted_at = new Date().toISOString(); persist();
  try {
    if (normal) await button.click({timeout: 10000});
    else await p.mouse.click(review.publish_point.x, review.publish_point.y);
    await p.waitForURL(url => url.origin === HOME && url.pathname.includes('/publish/success'), {timeout: 25000});
    assert((await text(p)).includes('发布成功'), 'Success page not confirmed');
    state.phase = 'submitted'; state.submitted_at = new Date().toISOString();
    state.success_screenshot = await shot(p, dir, `submitted-${Date.now()}`); persist();
    await reconcile(p, m, state, dir);
  } catch (error) {
    state.phase = 'uncertain'; state.reason = error.message;
    throw new Error(`Submission outcome requires reconciliation: ${error.message}`);
  }
}
function acquireLock(dir) {
  const file = path.join(dir, 'run.lock');
  const fd = fs.openSync(file, 'wx', 0o600);
  fs.writeFileSync(fd, JSON.stringify({pid: process.pid, created_at: new Date().toISOString()}));
  return () => { fs.closeSync(fd); fs.unlinkSync(file); };
}
async function main(argv = process.argv.slice(2)) {
  const opt = args(argv);
  assert(['validate', 'inspect', 'prepare', 'commit', 'reconcile'].includes(opt.command), 'Use validate, inspect, prepare, commit or reconcile');
  const m = opt.command === 'inspect' ? null : read(opt.manifest);
  const fingerprint = m && validateManifest(m);
  if (opt.command === 'validate') return {valid: true, fingerprint, image_count: m.images.length};
  if (opt.command === 'commit') assert(opt.authorized === true && opt.review && opt.confirmation, 'Commit requires user authorization, --confirmation and --review');
  const cdp = validateCdp(opt.cdp || 'http://127.0.0.1:9227');
  let unlock, state, stateFile, browser;
  const persist = () => { state.updated_at = new Date().toISOString(); save(stateFile, state); };
  try {
    if (m) {
      assert(opt['work-dir'] && path.isAbsolute(opt['work-dir']), 'Absolute work-dir required');
      const dir = path.join(opt['work-dir'], m.id);
      fs.mkdirSync(dir, {recursive: true});
      unlock = acquireLock(dir);
      stateFile = path.join(dir, 'state.json');
      state = fs.existsSync(stateFile) ? read(stateFile) : {version: 1, id: m.id, fingerprint, account: m.account, title: m.title, image_count: m.images.length, phase: 'preparing', public_note_url: null};
    }
    if (state) {
      assert(state.fingerprint === fingerprint, 'Manifest fingerprint changed; do not replace historical state');
      if (opt.command === 'prepare') {
        assert(!state.attempted_at && ['preparing', 'prepared', 'blocked-before-submit'].includes(state.phase), 'Existing attempt/result; reconcile first');
      }
      if (opt.command === 'commit') assertCanSubmit(state, fingerprint);
    }
    const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
    browser = await chromium.connectOverCDP(cdp);
    const pages = browser.contexts().flatMap(c => c.pages()).filter(p => p.url().startsWith(`${HOME}/`));
    if (opt.command === 'inspect') {
      return await Promise.all(pages.map(async (p, index) => ({index, url: p.url(), visible_text: (await text(p)).slice(0,700)})));
    }
    assert(pages.length, 'No creator platform tab; log in to the dedicated window');
    assert(pages.length === 1 || opt['page-index'] !== undefined, 'Multiple creator tabs; inspect and specify --page-index');
    const index = Number(opt['page-index'] || 0);
    assert(Number.isInteger(index) && index >= 0 && index < pages.length, 'Invalid page-index');
    const p = pages[index], dir = path.dirname(stateFile);
    await ensureAccount(p, m);
    if (opt.command === 'prepare') { state.phase = 'preparing'; persist(); await prepare(p, m, state, dir); }
    if (opt.command === 'commit') await commit(p, m, state, dir, read(opt.review), read(opt.confirmation), persist);
    if (opt.command === 'reconcile') await reconcile(p, m, state, dir);
    persist(); return {state_file: stateFile, ...state};
  } catch (error) {
    if (state && state.fingerprint === fingerprint) {
      if (state.attempted_at && !['published', 'in-review', 'rejected', 'submitted'].includes(state.phase)) state.phase = 'uncertain';
      else if (state.phase === 'preparing') state.phase = 'blocked-before-submit';
      state.last_error = error.message; persist();
    }
    throw error;
  } finally {
    try { if (browser) await browser.close(); } finally { if (unlock) unlock(); }
  }
}
module.exports = {digest, fileHash, validateManifest, assertCanSubmit, validateReview, validateConfirmation, validatePoint, validateCdp, submissionRowMatches, acquireLock, commit, main};
if (require.main === module) main().then(result => console.log(JSON.stringify(result, null, 2))).catch(error => {console.error(error.message); process.exitCode = 1;});
