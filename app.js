/* Site Expenditure Tracker
 * Layout and wording follow Site_Expenditure_Tracker.xlsx.
 * Records are kept in this browser (IndexedDB) and, once "Online saving" is set up,
 * in an encrypted file (data.enc) in the GitHub repo, so every device sees the same records.
 */
'use strict';

const CUR = 'GH¢';
const DEFAULT_MODES = ['MoMo', 'Physical Cash'];

/* ---------------- Database ---------------- */
const DB_NAME = 'site-expenditure-tracker';
const STORES = ['sites', 'funds', 'expenses', 'images', 'pow', 'meta'];
const SYNCED = ['sites', 'funds', 'expenses', 'images', 'pow'];
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of [...STORES, 'queue']) {
        if (!d.objectStoreNames.contains(s)) {
          const store = d.createObjectStore(s, { keyPath: 'id' });
          if (!['sites', 'meta', 'queue'].includes(s)) store.createIndex('siteId', 'siteId');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const rawPut = (store, obj) => p(tx(store, 'readwrite').put(obj));
const rawDel = (store, id) => p(tx(store, 'readwrite').delete(id));
const clearStore = (store) => p(tx(store, 'readwrite').clear());
// put/del save on this device and, when online saving is on, queue the change for GitHub
async function put(store, rec) {
  let fileOp = null;
  if ((store === 'images' && rec.blob) || (store === 'pow' && rec.data)) {
    if (!rec.path) { rec.path = `${store}/${rec.id}-${Math.random().toString(36).slice(2, 8)}.bin`; fileOp = { t: 'file', s: store, id: rec.id, path: rec.path }; }
  }
  await rawPut(store, rec);
  if (SYNCED.includes(store) && canSync()) {
    if (fileOp) await enqueue(fileOp);
    await enqueue({ t: 'put', s: store, r: stripRec(store, rec) });
    scheduleFlush();
  }
}
async function del(store, id) {
  await rawDel(store, id);
  if (SYNCED.includes(store) && canSync()) { await enqueue({ t: 'del', s: store, id }); scheduleFlush(); }
}
function stripRec(store, rec) {
  const r = { ...rec };
  if (store === 'images') delete r.blob;
  if (store === 'pow') delete r.data;
  return r;
}
const get = (store, id) => p(tx(store).get(id));
const all = (store) => p(tx(store).getAll());
const bySite = (store, siteId) => p(tx(store).index('siteId').getAll(siteId));
let uidN = 0;
const uid = () => Date.now().toString(36) + (uidN++).toString(36) + Math.random().toString(36).slice(2, 6);

/* ---------------- Helpers ---------------- */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const today = () => { const d = new Date(); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 10); };
const num = (v) => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
const plain = (n) => (Number(n) || 0).toLocaleString('en-GB', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const money = (n) => CUR + ' ' + plain(n);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (d) => { if (!d) return ''; const [y, m, dd] = d.split('-'); return `${dd}/${m}/${y}`; };
const safeName = (s) => s.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
const opt = (v, label = v, sel = false) => `<option value="${esc(v)}"${sel ? ' selected' : ''}>${esc(label)}</option>`;

function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.add('hidden'), 2800);
}

// Dialog: resolves with {name: value} for every [name] field, or null on cancel
function ask(title, bodyHtml, { okText = 'OK', danger = false, onOpen } = {}) {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    $('#dialogTitle').textContent = title;
    $('#dialogBody').innerHTML = bodyHtml;
    const ok = $('#dialogOk');
    ok.textContent = okText;
    ok.className = 'btn ' + (danger ? 'btn-danger' : 'btn-primary');
    dlg.onclose = () => {
      if (dlg.returnValue !== 'ok') return resolve(null);
      const vals = {};
      $$('#dialogBody [name]').forEach((el) => { vals[el.name] = el.type === 'checkbox' ? el.checked : el.value; });
      resolve(vals);
    };
    dlg.returnValue = '';
    dlg.showModal();
    if (onOpen) onOpen();
    const first = $('#dialogBody input:not([type=checkbox]), #dialogBody textarea');
    if (first) first.focus();
  });
}
const confirmBox = (title, msg, okText = 'Delete') => ask(title, `<p>${esc(msg)}</p>`, { okText, danger: true }).then((v) => v !== null);

async function sha256(text) {
  if (window.crypto && crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 5381; for (const c of text) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return 'f' + h.toString(16);
}
function sessGet(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function sessSet(k, v) { try { sessionStorage.setItem(k, v); } catch { /* ignore */ } }

/* ---------------- State & calculations ---------------- */
let site = null;
let funds = [];
let entries = [];

const received = (f) => num(f.amount1) + num(f.amount2);
const fundUsed = (id) => entries.filter((e) => e.fundId === id).reduce((t, e) => t + e.amount, 0);
const totalReceived = () => funds.reduce((t, f) => t + received(f), 0);
const totalUsed = () => entries.reduce((t, e) => t + e.amount, 0);
const fundById = (id) => funds.find((f) => f.id === id);
const qtyField = (id) => site.qtyFields.find((q) => q.id === id);
const itemDef = (name) => site.items.find((i) => i.name === name);
const fundNo = (code) => { const m = /(\d+)\s*$/.exec(code || ''); return m ? +m[1] : 0; };
const nextFundCode = () => 'F' + (Math.max(0, ...funds.map((f) => fundNo(f.code))) + 1);

function qtyText(e) { // all quantities on an entry, e.g. "30 bags" or "Cement (bags): 30"
  const simple = e.q ? [`${plain(e.q)} ${e.unit || ''}`.trim()] : [];
  return [...simple, ...Object.entries(e.qty || {}).filter(([, v]) => v).map(([k, v]) => `${qtyField(k)?.label || k}: ${plain(v)}`)].join(', ');
}
// Categories sheet rows: item, quantity summary, total amount — like the Trench / Production Room sheets
function categorySheet(cat) {
  const inCat = entries.filter((e) => e.category === cat);
  const names = [...site.items.map((i) => i.name), ...new Set(inCat.map((e) => e.item))].filter((v, i, a) => a.indexOf(v) === i);
  const rows = [];
  for (const name of names) {
    const es = inCat.filter((e) => e.item === name);
    if (!es.length) continue;
    const def = itemDef(name);
    const q = (def?.qty || []).map(({ field, suffix }) => {
      const s = es.reduce((t, e) => t + num(e.qty?.[field]), 0);
      return s > 0 ? `${plain(s)} ${suffix}`.trim() : '';
    }).filter(Boolean);
    // plus the simple Quantity + Unit, added up per unit (e.g. "12 trips")
    const byUnit = new Map();
    for (const e of es) if (e.q) byUnit.set(e.unit || '', (byUnit.get(e.unit || '') || 0) + num(e.q));
    for (const [unit, s] of byUnit) q.push(`${plain(s)} ${unit}`.trim());
    rows.push({ item: name, quantity: q.join(", "), amount: es.reduce((t, e) => t + e.amount, 0) });
  }
  return { rows, total: inCat.reduce((t, e) => t + e.amount, 0) };
}
function allCategories() { return [...site.categories, ...new Set(entries.map((e) => e.category))].filter((v, i, a) => v && a.indexOf(v) === i); }
function sortedFunds() { return [...funds].sort((a, b) => fundNo(a.code) - fundNo(b.code) || a.createdAt - b.createdAt); }

/* ---------------- Seeding ---------------- */
function newSite(name, location, lists = {}) {
  return {
    id: uid(), name, location, status: 'active', overview: '', createdAt: Date.now(),
    categories: [...(lists.categories || [])],
    items: (lists.items || []).map((i) => ({ name: i.name, qty: i.qty.map((q) => ({ ...q })) })),
    qtyFields: (lists.qtyFields || []).map((q) => ({ ...q })),
    modes: [...(lists.modes || DEFAULT_MODES)],
  };
}
// Starting sites. Berekum gets the categories, items and quantity columns from the Excel
// (no money records: those come from the starting-data file, so nothing private is in the code).
async function seedIfEmpty() {
  if (await get('meta', 'seeded')) return;
  if ((await all('sites')).length) { await rawPut('meta', { id: 'seeded', value: true }); return; }
  const ber = newSite('Berekum Holy Family Hospital', 'Berekum', window.BEREKUM_LISTS || {});
  ber.createdAt = Date.now() - 2;
  await rawPut('sites', ber);
  const k = newSite('Komfo Anokye Teaching Hospital', 'Kumasi'); k.createdAt = Date.now() - 1; await rawPut('sites', k);
  await rawPut('sites', newSite('Tamale Teaching Hospital', 'Tamale'));
  await rawPut('meta', { id: 'seeded', value: true });
}

/* ---------------- Home ---------------- */
async function showHome() {
  site = null;
  $('#siteView').classList.add('hidden');
  $('#homeView').classList.remove('hidden');
  $('#backBtn').classList.add('hidden');
  $('#pageTitle').textContent = 'Site Expenditure Tracker';
  document.title = 'Site Expenditure Tracker';
  history.replaceState(null, '', location.pathname);

  if (onGithubPages() && !cfg.key) {
    $('#siteList').innerHTML = `<div class="card"><h3>Open the full link</h3><p>This link is missing its key, so the records can't be shown.
      Open the full link you were given (it ends with <strong>#k=…</strong>), or paste it here:</p>
      <form id="linkForm" class="list-add"><input id="linkInput" placeholder="Paste the full link" required><button class="btn btn-primary" type="submit">Open</button></form>
      <p class="small muted mt">Setting this up for the first time? Press <strong>Online</strong> at the top.</p></div>`;
    $('#linkForm').onsubmit = (e) => { e.preventDefault(); const k = keyFromLink($('#linkInput').value); if (!k) return toast('That link has no key'); cfg.key = k; saveCfg(); location.reload(); };
    return;
  }
  const sites = (await all('sites')).sort((a, b) => a.createdAt - b.createdAt);
  const allFunds = await all('funds');
  const allEx = await all('expenses');
  const card = (s) => {
    const r = allFunds.filter((x) => x.siteId === s.id).reduce((t, x) => t + received(x), 0);
    const u = allEx.filter((x) => x.siteId === s.id).reduce((t, x) => t + x.amount, 0);
    return `<button class="site-card" data-id="${s.id}" type="button">
      <h3>${esc(s.name)}<span class="badge ${s.status === 'active' ? 'active' : ''}">${s.status === 'active' ? 'Active' : 'Done'}</span></h3>
      <div class="meta">${esc(s.location || '')}</div>
      <div class="figures">
        <div>Received<strong>${money(r)}</strong></div>
        <div>Used<strong>${money(u)}</strong></div>
        <div>Balance<strong>${money(r - u)}</strong></div>
      </div></button>`;
  };
  const active = sites.filter((s) => s.status !== 'done');
  const done = sites.filter((s) => s.status === 'done');
  let html = active.length ? `<div class="site-list">${active.map(card).join('')}</div>` : '<p class="muted">No active sites. Add one with the button above.</p>';
  if (done.length) html += `<div class="section-label">Done / transferred</div><div class="site-list">${done.map(card).join('')}</div>`;
  if (!isOnline()) html = `<div class="notice owner-only">Records are only saved on this device. <button class="btn-link" id="setupLink" type="button">Set up online saving</button> so they open on any phone or computer.</div>` + html;
  $('#siteList').innerHTML = html;
  if ($('#setupLink')) $('#setupLink').onclick = onlineDialog;
  $$('.site-card').forEach((b) => b.addEventListener('click', () => openSite(b.dataset.id)));
}

async function addSite() {
  const sites = await all('sites');
  const v = await ask('Add new site', `
    <label>Site name<input name="name" required></label>
    <label>Location<input name="location"></label>
    <label>Copy categories, items, quantity columns and modes from
      <select name="copyFrom"><option value="">None (start empty)</option>${sites.map((s) => opt(s.id, s.name)).join('')}</select>
    </label>`, { okText: 'Add site' });
  if (!v || !v.name.trim()) return;
  const src = v.copyFrom ? await get('sites', v.copyFrom) : null;
  const s = newSite(v.name.trim(), v.location.trim(), src || {});
  await put('sites', s);
  openSite(s.id);
}

/* ---------------- Site view ---------------- */
async function openSite(id) {
  site = await get('sites', id);
  if (!site) return showHome();
  site.categories ||= []; site.items ||= []; site.qtyFields ||= []; site.modes ||= [...DEFAULT_MODES];
  $('#homeView').classList.add('hidden');
  $('#siteView').classList.remove('hidden');
  $('#backBtn').classList.remove('hidden');
  $('#pageTitle').textContent = site.name;
  document.title = site.name + ' – Expenditure';
  history.replaceState(null, '', '#site=' + id);
  $('#exDate').value = today();
  $('#nfDate').value = today();
  showAllQty = false;
  await reload();
  setKind(funds.length ? 'spent' : 'received');
  switchTab(sessGet('tab') || 'entries');
}
const saveSite = () => put('sites', site);

async function reload() {
  funds = await bySite('funds', site.id);
  entries = (await bySite('expenses', site.id)).sort((a, b) => a.createdAt - b.createdAt);
  renderSummaryBar();
  renderFormLists();
  renderEntries();
  renderFunds();
  renderCategorySheets();
  renderSummary();
  renderSettings();
}

function renderSummaryBar() {
  const r = totalReceived(), u = totalUsed();
  $('#sumFunds').textContent = money(r);
  $('#sumSpent').textContent = money(u);
  const b = $('#sumBalance'); b.textContent = money(r - u); b.classList.toggle('neg', r - u < 0);
  $('#sumCount').textContent = entries.length;
}

/* ---------------- Entry form ---------------- */
let showAllQty = false;

function renderFormLists() {
  // Fund select: funds with a balance first
  const sel = $('#fundSelect'); const prev = sel.value;
  const list = sortedFunds().map((f) => ({ f, bal: received(f) - fundUsed(f.id) }));
  list.sort((a, b) => (b.bal > 0.005) - (a.bal > 0.005) || fundNo(b.f.code) - fundNo(a.f.code));
  sel.innerHTML = list.length
    ? list.map(({ f, bal }) => opt(f.id, `${f.code}${f.receivedFrom ? ' – ' + f.receivedFrom : ''} — Balance ${money(bal)}`)).join('')
    : '<option value="">No funds yet — choose "A new fund"</option>';
  if (prev && funds.some((f) => f.id === prev)) sel.value = prev;
  if (!funds.length) $('input[name=fundMode][value=new]').checked = true;
  $('#nfCode').value = nextFundCode();

  const dl = (values) => [...new Set(values.filter(Boolean))].map((d) => `<option value="${esc(d)}">`).join('');
  $('#categoryList').innerHTML = dl(site.categories);
  renderItemList();
  $('#usedForList').innerHTML = dl(entries.map((e) => e.usedFor));
  $('#modeList').innerHTML = dl(site.modes);
  $('#unitList').innerHTML = dl([...entries.map((e) => e.unit), 'bags', 'trips', 'pcs', 'days', 'ft']);
  $('#fromList').innerHTML = dl(funds.map((f) => f.receivedFrom));

  // filters
  const fill = (el, first, values) => { const pv = el.value; el.innerHTML = `<option value="">${first}</option>` + values.map((v) => opt(v)).join(''); el.value = values.includes(pv) ? pv : ''; };
  const fF = $('#fFund'); const pf = fF.value;
  fF.innerHTML = '<option value="">All funds</option>' + sortedFunds().map((f) => opt(f.id, f.code)).join('');
  fF.value = funds.some((f) => f.id === pf) ? pf : '';
  fill($('#fCategory'), 'All categories', allCategories());
  fill($('#fItem'), 'All items', [...site.items.map((i) => i.name), ...new Set(entries.map((e) => e.item))].filter((v, i, a) => v && a.indexOf(v) === i));

  updateFundMode();
  renderQtyInputs();
}

// Items list: the ones already used under the chosen Category come first
function renderItemList() {
  const cat = $('#exCategory').value.trim();
  const used = [...new Set(entries.filter((e) => e.category === cat).map((e) => e.item))];
  const rest = site.items.map((i) => i.name).filter((n) => !used.includes(n));
  $('#itemList').innerHTML = [...used, ...rest].map((d) => `<option value="${esc(d)}">`).join('');
}
// Picking an item fills in what you used last time for it (amount, unit, category)
function onItemPicked() {
  renderQtyInputs();
  const name = $('#exItem').value.trim();
  const last = [...entries].reverse().find((e) => e.item.toLowerCase() === name.toLowerCase());
  if (!last) return;
  if (!$('#exCategory').value.trim()) $('#exCategory').value = last.category;
  if (!$('#exAmount').value) { $('#exAmount').value = last.amount; updateFundHint(); }
  if (!$('#exUnit').value && last.unit) $('#exUnit').value = last.unit;
}

let entryKind = 'spent';
function setKind(kind) {
  entryKind = kind;
  const f = $('#entryForm');
  f.classList.toggle('kind-received', kind === 'received');
  f.classList.toggle('kind-spent', kind === 'spent');
  $$('.seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.kind === kind));
  $('#entrySubmit').textContent = kind === 'received' ? 'Save money received' : 'Insert';
  updateFundMode();
}

function updateFundMode() {
  const isNew = entryKind === 'received' || $('input[name=fundMode]:checked').value === 'new';
  $('#newFundBox').classList.toggle('hidden', !isNew);
  $('#existingFundBox').classList.toggle('hidden', isNew);
  updateFundHint();
}

function updateFundHint() {
  if (entryKind === 'received') { $('#fundHint').textContent = ''; return; }
  const isNew = $('input[name=fundMode]:checked').value === 'new';
  const amt = num($('#exAmount').value);
  let bal;
  if (isNew) bal = num($('#nfAmount1').value) + num($('#nfAmount2').value);
  else { const f = fundById($('#fundSelect').value); bal = f ? received(f) - fundUsed(f.id) : 0; }
  const hint = $('#fundHint');
  if (!amt && !bal) { hint.textContent = ''; return; }
  const left = bal - amt;
  hint.textContent = `Fund balance after this entry: ${money(left)}`;
  hint.style.color = left < -0.005 ? 'var(--danger)' : '';
}

function renderQtyInputs() {
  const keep = {};
  $$('#qtyBox input').forEach((i) => { if (i.value !== '') keep[i.dataset.q] = i.value; });
  // Extra quantity columns (like the Berekum Excel) show only for items set up with them
  const linked = (itemDef($('#exItem').value.trim())?.qty || []).map((q) => q.field);
  const fields = site.qtyFields.filter((f) => showAllQty || linked.includes(f.id) || keep[f.id] !== undefined);
  $('#qtyBox').innerHTML = fields.map((f) => `<label>${esc(f.label)}<input type="number" step="any" min="0" data-q="${f.id}" value="${esc(keep[f.id] ?? '')}"></label>`).join('');
  $('#moreQtyBtn').classList.toggle('hidden', showAllQty || !site.qtyFields.length || fields.length === site.qtyFields.length);
  // the simple Quantity / Unit boxes are for items without their own quantity columns
  $$('#exQty, #exUnit').forEach((el) => el.closest('label').classList.toggle('hidden', linked.length > 0));
}

// Typed a new Category / Item / Mode? Remember it for this site so it can be picked next time.
async function learnLists(category, item, mode) {
  let changed = false;
  const find = (arr, v) => arr.find((x) => x.toLowerCase() === v.toLowerCase());
  if (category && !find(site.categories, category)) { site.categories.push(category); changed = true; }
  if (item && !find(site.items.map((i) => i.name), item)) { site.items.push({ name: item, qty: [] }); changed = true; }
  if (mode && !find(site.modes, mode)) { site.modes.push(mode); changed = true; }
  if (changed) await saveSite();
}
// Use the list's spelling if the typed text matches one already there (e.g. "cement" -> "Cement")
function canonical(list, v) { v = v.trim(); return list.find((x) => x.toLowerCase() === v.toLowerCase()) || v; }

async function addFundFromForm() {
  const a1 = num($('#nfAmount1').value), a2 = num($('#nfAmount2').value);
  if (a1 + a2 <= 0) { toast('Enter the amount received'); return null; }
  const code = $('#nfCode').value.trim() || nextFundCode();
  if (funds.some((f) => f.code.toLowerCase() === code.toLowerCase())) { toast(`Fund ID ${code} already exists`); return null; }
  const mode = canonical(site.modes, $('#nfMode').value);
  await learnLists('', '', mode);
  const f = { id: uid(), siteId: site.id, code, date: $('#nfDate').value, receivedFrom: $('#nfFrom').value.trim(), mode, amount1: a1, amount2: a2, createdAt: Date.now() };
  await put('funds', f);
  ['#nfAmount1', '#nfAmount2', '#nfFrom', '#nfMode'].forEach((s) => ($(s).value = ''));
  return f;
}

async function submitEntry(ev) {
  ev.preventDefault();
  if (entryKind === 'received') {
    const f = await addFundFromForm(); if (!f) return;
    $('input[name=fundMode][value=existing]').checked = true;
    await reload();
    $('#fundSelect').value = f.id; updateFundMode();
    toast(`Money received saved as ${f.code}`);
    return;
  }
  const isNew = $('input[name=fundMode]:checked').value === 'new';
  const amount = num($('#exAmount').value);
  const category = canonical(site.categories, $('#exCategory').value);
  const item = canonical(site.items.map((i) => i.name), $('#exItem').value);
  if (!$('#exUsedFor').value.trim()) return toast('Enter what it was Used For');
  if (!category) return toast('Enter a Category');
  if (!item) return toast('Enter an Item');
  if (amount <= 0) return toast('Enter the Amount');
  let fundId;
  if (isNew) {
    const f = await addFundFromForm(); if (!f) return;
    fundId = f.id;
  } else {
    fundId = $('#fundSelect').value;
    if (!fundId) return toast('Choose a fund, or select "A new fund"');
    const f = fundById(fundId);
    const bal = received(f) - fundUsed(fundId);
    if (amount - bal > 0.005 && !(await confirmBox('Not enough balance', `${f.code} has ${money(bal)} left but this entry is ${money(amount)}. Insert anyway?`, 'Insert anyway'))) return;
  }
  const qty = {};
  $$('#qtyBox input').forEach((i) => { if (num(i.value)) qty[i.dataset.q] = num(i.value); });
  const simpleShown = !$('#exQty').closest('label').classList.contains('hidden');
  await learnLists(category, item, '');
  await put('expenses', {
    id: uid(), siteId: site.id, fundId, date: $('#exDate').value, usedFor: $('#exUsedFor').value.trim(),
    category, item, amount, qty,
    q: simpleShown && num($('#exQty').value) ? num($('#exQty').value) : null,
    unit: simpleShown && num($('#exQty').value) ? $('#exUnit').value.trim() : '',
    createdAt: Date.now(),
  });
  ['#exUsedFor', '#exAmount', '#exCategory', '#exItem', '#exQty', '#exUnit'].forEach((s) => ($(s).value = ''));
  $$('#qtyBox input').forEach((i) => (i.value = ''));
  showAllQty = false;
  if (isNew) $('input[name=fundMode][value=existing]').checked = true;
  await reload();
  if (isNew) { $('#fundSelect').value = fundId; updateFundHint(); }
  $('#exUsedFor').focus();
  toast('Inserted');
}

/* ---------------- All Entries table ---------------- */
function filteredEntries() {
  const q = $('#fSearch').value.trim().toLowerCase();
  const f = $('#fFund').value, c = $('#fCategory').value, it = $('#fItem').value;
  return entries.filter((e) => (!f || e.fundId === f) && (!c || e.category === c) && (!it || e.item === it) &&
    (!q || `${e.usedFor} ${e.category} ${e.item} ${fundById(e.fundId)?.code || ''}`.toLowerCase().includes(q)));
}
function renderEntries() {
  const rows = filteredEntries();
  const no = new Map(entries.map((e, i) => [e.id, i + 1]));
  $('#entryTable tbody').innerHTML = rows.length ? rows.map((e) => `<tr>
    <td>${no.get(e.id)}</td><td>${esc(fundById(e.fundId)?.code || '')}</td><td>${fmtDate(e.date)}</td><td>${esc(e.usedFor)}</td>
    <td>${esc(e.category)}</td><td>${esc(e.item)}</td><td class="num">${plain(e.amount)}</td><td class="small">${esc(qtyText(e))}</td>
    <td class="num"><button class="icon-btn" data-edit="${e.id}" type="button">Edit</button><button class="icon-btn" data-del="${e.id}" title="Delete" type="button">&times;</button></td>
  </tr>`).join('') : '<tr><td colspan="9" class="empty">No entries yet.</td></tr>';
  $('#filteredTotal').textContent = money(rows.reduce((t, e) => t + e.amount, 0));
}

async function editEntry(id) {
  const e = entries.find((x) => x.id === id); if (!e) return;
  const v = await ask('Edit entry', `
    <label>Fund ID<select name="fundId">${sortedFunds().map((f) => opt(f.id, f.code + (f.receivedFrom ? ' – ' + f.receivedFrom : ''), f.id === e.fundId)).join('')}</select></label>
    <label>Date<input name="date" type="date" value="${e.date || ''}"></label>
    <label>Used For<input name="usedFor" value="${esc(e.usedFor)}"></label>
    <label>Category<input name="category" list="categoryList" value="${esc(e.category)}"></label>
    <label>Item<input name="item" list="itemList" value="${esc(e.item)}"></label>
    <label>Amount (${CUR})<input name="amount" type="number" step="0.01" value="${e.amount}"></label>
    <div class="qty-grid"><label>Quantity<input name="q" type="number" step="any" min="0" value="${e.q ?? ''}"></label><label>Unit<input name="unit" list="unitList" value="${esc(e.unit || '')}"></label>
    ${site.qtyFields.map((f) => `<label>${esc(f.label)}<input name="q_${f.id}" type="number" step="any" min="0" value="${e.qty?.[f.id] ?? ''}"></label>`).join('')}</div>`, { okText: 'Save' });
  if (!v) return;
  const qty = {};
  for (const f of site.qtyFields) if (num(v['q_' + f.id])) qty[f.id] = num(v['q_' + f.id]);
  for (const [k, val] of Object.entries(e.qty || {})) if (!qtyField(k)) qty[k] = val; // keep removed columns' data
  const category = canonical(site.categories, v.category), item = canonical(site.items.map((i) => i.name), v.item);
  if (!category || !item) return toast('Category and Item are needed');
  await learnLists(category, item, '');
  Object.assign(e, { fundId: v.fundId, date: v.date, usedFor: v.usedFor.trim(), category, item, amount: num(v.amount), qty, q: num(v.q) || null, unit: num(v.q) ? v.unit.trim() : '' });
  await put('expenses', e); await reload(); toast('Saved');
}

/* ---------------- Total (funds) ---------------- */
let selectedFund = null;
function renderFunds() {
  const fs = sortedFunds();
  $('#fundTable tbody').innerHTML = fs.length ? fs.map((f) => {
    const used = fundUsed(f.id), bal = received(f) - used;
    return `<tr class="clickable ${f.id === selectedFund ? 'selected' : ''}" data-fund="${f.id}"><td>${esc(f.code)}</td><td>${fmtDate(f.date)}</td><td>${esc(f.receivedFrom)}</td><td>${esc(f.mode)}</td>
      <td class="num">${f.amount1 ? plain(f.amount1) : ''}</td><td class="num">${f.amount2 ? plain(f.amount2) : ''}</td><td class="num">${plain(received(f))}</td>
      <td class="num">${plain(used)}</td><td class="num ${bal < -0.005 ? 'neg' : ''}">${plain(bal)}</td>
      <td class="num"><button class="icon-btn" data-fedit="${f.id}" type="button">Edit</button><button class="icon-btn" data-fdel="${f.id}" title="Delete" type="button">&times;</button></td></tr>`;
  }).join('') : '<tr><td colspan="10" class="empty">No funds added yet.</td></tr>';
  const s1 = funds.reduce((t, f) => t + num(f.amount1), 0), s2 = funds.reduce((t, f) => t + num(f.amount2), 0);
  $('#fundTable tfoot').innerHTML = `<tr><td colspan="4">TOTAL</td><td class="num">${plain(s1)}</td><td class="num">${plain(s2)}</td><td class="num">${plain(s1 + s2)}</td><td class="num">${plain(totalUsed())}</td><td class="num">${plain(s1 + s2 - totalUsed())}</td><td></td></tr>`;
  renderFundDetail();
}
function renderFundDetail() {
  const box = $('#fundDetail');
  const f = fundById(selectedFund);
  if (!f) { box.classList.add('hidden'); return; }
  const es = entries.filter((e) => e.fundId === f.id);
  const used = fundUsed(f.id);
  box.classList.remove('hidden');
  box.innerHTML = `<h3>Fund ${fundNo(f.code) || esc(f.code)}</h3>
    <table class="kv"><tbody>
      <tr><th>Fund ID</th><td>${esc(f.code)}</td></tr><tr><th>Received From</th><td>${esc(f.receivedFrom)}</td></tr>
      <tr><th>Mode</th><td>${esc(f.mode)}</td></tr><tr><th>Amount Received</th><td class="num">${plain(received(f))}</td></tr>
      <tr><th>Amount Used</th><td class="num">${plain(used)}</td></tr><tr><th>Balance</th><td class="num">${plain(received(f) - used)}</td></tr>
    </tbody></table>
    <div class="table-wrap mt"><table><thead><tr><th>#</th><th>Used For</th><th>Category</th><th class="num">Amount (${CUR})</th></tr></thead>
    <tbody>${es.map((e, i) => `<tr><td>${i + 1}</td><td>${esc(e.usedFor)}</td><td>${esc(e.category)}</td><td class="num">${plain(e.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing used from this fund yet.</td></tr>'}</tbody>
    <tfoot><tr><td colspan="3">TOTAL USED</td><td class="num">${plain(used)}</td></tr></tfoot></table></div>`;
}

async function fundDialog(f) {
  const isNew = !f;
  f ||= { code: nextFundCode(), date: today(), receivedFrom: '', mode: '', amount1: '', amount2: '' };
  const v = await ask(isNew ? 'Add fund' : 'Edit fund ' + f.code, `
    <label>Fund ID<input name="code" value="${esc(f.code)}" required></label>
    <label>Date<input name="date" type="date" value="${f.date || ''}"></label>
    <label>Received From<input name="receivedFrom" value="${esc(f.receivedFrom)}"></label>
    <label>Mode<input name="mode" value="${esc(f.mode)}" list="modeList"></label>
    <label>Amount 1 (${CUR})<input name="amount1" type="number" step="0.01" value="${f.amount1 || ''}"></label>
    <label>Amount 2 (${CUR})<input name="amount2" type="number" step="0.01" value="${f.amount2 || ''}"></label>`, { okText: isNew ? 'Add fund' : 'Save' });
  if (!v) return;
  const code = v.code.trim();
  if (!code) return toast('Fund ID is needed');
  if (funds.some((x) => x.id !== f.id && x.code.toLowerCase() === code.toLowerCase())) return toast(`Fund ID ${code} already exists`);
  if (num(v.amount1) + num(v.amount2) <= 0) return toast('Enter an amount');
  const mode = v.mode.trim();
  if (mode && !site.modes.includes(mode)) { site.modes.push(mode); await saveSite(); }
  Object.assign(f, { code, date: v.date, receivedFrom: v.receivedFrom.trim(), mode, amount1: num(v.amount1), amount2: num(v.amount2) });
  if (isNew) Object.assign(f, { id: uid(), siteId: site.id, createdAt: Date.now() });
  await put('funds', f); await reload(); toast(isNew ? 'Fund added' : 'Saved');
}

/* ---------------- Categories & Summary ---------------- */
function renderCategorySheets() {
  const cats = allCategories();
  $('#categorySheets').innerHTML = cats.length ? cats.map((c) => {
    const { rows, total } = categorySheet(c);
    return `<div class="card sheet-card"><h3>${esc(c)}</h3><div class="table-wrap"><table>
      <thead><tr><th>#</th><th>Item</th><th>Quantity</th><th class="num">Total Amount (${CUR})</th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.item)}</td><td>${esc(r.quantity)}</td><td class="num">${plain(r.amount)}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">Nothing spent here yet.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="3">TOTAL SPENT ON ${esc(c.toUpperCase())}</td><td class="num">${plain(total)}</td></tr></tfoot></table></div></div>`;
  }).join('') : '<div class="card"><p class="muted">No categories yet. Add them in Settings.</p></div>';
}

function renderSummary() {
  const r = totalReceived(), u = totalUsed();
  $('#sumTotals').innerHTML = `<tbody><tr><th>Total Received</th><td class="num">${plain(r)}</td></tr><tr><th>Total Used</th><td class="num">${plain(u)}</td></tr><tr><th>Balance</th><td class="num">${plain(r - u)}</td></tr></tbody>`;
  const cats = allCategories();
  $('#sumSpentOn').innerHTML = `<thead><tr><th>Spent On</th><th class="num">Amount (${CUR})</th><th class="num">% of Used</th></tr></thead><tbody>` +
    cats.map((c) => { const a = categorySheet(c).total; return `<tr><td>${esc(c)}</td><td class="num">${plain(a)}</td><td class="num">${u ? Math.round((a / u) * 100) : 0}%</td></tr>`; }).join('') +
    `</tbody><tfoot><tr><td>TOTAL</td><td class="num">${plain(u)}</td><td class="num">${u ? '100%' : '0%'}</td></tr></tfoot>`;
  $('#sumFundsTable').innerHTML = `<thead><tr><th>Fund</th><th class="num">Received (${CUR})</th><th class="num">Used (${CUR})</th><th class="num">Balance (${CUR})</th></tr></thead><tbody>` +
    sortedFunds().map((f) => { const us = fundUsed(f.id); return `<tr><td>${esc(f.code)}</td><td class="num">${plain(received(f))}</td><td class="num">${plain(us)}</td><td class="num ${received(f) - us < -0.005 ? 'neg' : ''}">${plain(received(f) - us)}</td></tr>`; }).join('') +
    `</tbody><tfoot><tr><td>TOTAL</td><td class="num">${plain(r)}</td><td class="num">${plain(u)}</td><td class="num">${plain(r - u)}</td></tr></tfoot>`;
}

/* ---------------- Settings: editable lists ---------------- */
function listEditor(el, rows, addPlaceholder) {
  el.innerHTML = `<ul class="list-ed">${rows.map((r, i) => `<li><span>${esc(r.label)}${r.sub ? `<span class="sub">${esc(r.sub)}</span>` : ''}</span><span>
    ${r.extra ? `<button class="icon-btn" data-act="extra" data-i="${i}" type="button">${r.extra}</button>` : ''}
    <button class="icon-btn" data-act="up" data-i="${i}" title="Move up" type="button">&uarr;</button>
    <button class="icon-btn" data-act="rename" data-i="${i}" type="button">Rename</button>
    <button class="icon-btn" data-act="del" data-i="${i}" title="Remove" type="button">&times;</button></span></li>`).join('') || '<li class="muted">None yet.</li>'}</ul>
    <form class="list-add"><input placeholder="${esc(addPlaceholder)}" required><button class="btn" type="submit">Add</button></form>`;
}

function renderSettings() {
  $('#sName').value = site.name; $('#sLocation').value = site.location || ''; $('#sStatus').value = site.status || 'active';
  listEditor($('#listCategories'), site.categories.map((c) => ({ label: c })), 'New category');
  listEditor($('#listItems'), site.items.map((i) => ({ label: i.name, sub: i.qty.map((q) => `${qtyField(q.field)?.label || q.field} → "${q.suffix}"`).join(', '), extra: 'Quantities' })), 'New item');
  listEditor($('#listQty'), site.qtyFields.map((q) => ({ label: q.label })), 'e.g. Cement (bags)');
  listEditor($('#listModes'), site.modes.map((m) => ({ label: m })), 'New mode');
}

// Config for each list: how to read names, rename (and update records), add and remove
const LISTS = {
  listCategories: {
    names: () => site.categories, arr: () => site.categories,
    add: (n) => site.categories.push(n),
    rename: async (i, nn) => { const old = site.categories[i]; site.categories[i] = nn; for (const e of entries.filter((x) => x.category === old)) { e.category = nn; await put('expenses', e); } },
    inUse: (i) => entries.filter((e) => e.category === site.categories[i]).length,
  },
  listItems: {
    names: () => site.items.map((x) => x.name), arr: () => site.items,
    add: (n) => site.items.push({ name: n, qty: [] }),
    rename: async (i, nn) => { const old = site.items[i].name; site.items[i].name = nn; for (const e of entries.filter((x) => x.item === old)) { e.item = nn; await put('expenses', e); } },
    inUse: (i) => entries.filter((e) => e.item === site.items[i].name).length,
  },
  listQty: {
    names: () => site.qtyFields.map((x) => x.label), arr: () => site.qtyFields,
    add: (n) => site.qtyFields.push({ id: uid(), label: n }),
    rename: async (i, nn) => { site.qtyFields[i].label = nn; },
    inUse: (i) => entries.filter((e) => num(e.qty?.[site.qtyFields[i].id])).length,
    onDelete: (f) => site.items.forEach((it) => (it.qty = it.qty.filter((q) => q.field !== f.id))),
  },
  listModes: {
    names: () => site.modes, arr: () => site.modes,
    add: (n) => site.modes.push(n),
    rename: async (i, nn) => { const old = site.modes[i]; site.modes[i] = nn; for (const f of funds.filter((x) => x.mode === old)) { f.mode = nn; await put('funds', f); } },
    inUse: () => 0,
  },
};

async function onListClick(e) {
  const box = e.target.closest('[id^=list]'); const L = box && LISTS[box.id]; const act = e.target.dataset.act;
  if (!L || !act) return;
  const i = +e.target.dataset.i; const arr = L.arr(); const name = L.names()[i];
  if (act === 'up' && i > 0) { [arr[i - 1], arr[i]] = [arr[i], arr[i - 1]]; }
  if (act === 'rename') {
    const v = await ask('Rename', `<label>Name<input name="n" value="${esc(name)}"></label>`, { okText: 'Rename' });
    const nn = v?.n.trim(); if (!nn || nn === name) return;
    if (L.names().includes(nn)) return toast('That name already exists');
    await L.rename(i, nn);
  }
  if (act === 'del') {
    const used = L.inUse(i);
    if (!(await confirmBox('Remove', `Remove "${name}" from the list?${used ? ` ${used} entr${used === 1 ? 'y uses' : 'ies use'} it; they will keep it.` : ''}`, 'Remove'))) return;
    const [gone] = arr.splice(i, 1); if (L.onDelete) L.onDelete(gone);
  }
  if (act === 'extra') return editItemQty(i);
  await saveSite(); await reload();
}
async function onListAdd(e) {
  e.preventDefault();
  const box = e.target.closest('[id^=list]'); const L = LISTS[box.id];
  const n = e.target.querySelector('input').value.trim();
  if (!n) return;
  if (L.names().includes(n)) return toast('That name already exists');
  L.add(n); await saveSite(); await reload();
  $('#' + box.id + ' .list-add input').focus();
}

async function editItemQty(i) {
  const it = site.items[i];
  if (!site.qtyFields.length) return toast('Add quantity columns first');
  const v = await ask(`Quantities for "${it.name}"`, `<p class="muted small">Tick the quantity boxes that show when this item is chosen. The words are used in the Categories sheets, e.g. "30 bags".</p>` +
    site.qtyFields.map((f) => { const q = it.qty.find((x) => x.field === f.id); return `<label class="check-row"><input type="checkbox" name="on_${f.id}" ${q ? 'checked' : ''}> <span style="min-width:150px">${esc(f.label)}</span><input type="text" name="sx_${f.id}" value="${esc(q?.suffix ?? defaultSuffix(f.label))}"></label>`; }).join(''), { okText: 'Save' });
  if (!v) return;
  it.qty = site.qtyFields.filter((f) => v['on_' + f.id]).map((f) => ({ field: f.id, suffix: v['sx_' + f.id].trim() }));
  await saveSite(); await reload();
}
const defaultSuffix = (label) => (/\(([^)]+)\)/.exec(label) || [, ''])[1];

/* ---------------- Images ---------------- */
// Only a device that can edit (has your GitHub key, or is not online yet) can add or remove images.
let objectUrls = [];
async function renderImages() {
  const owner = canEdit();
  $('#ownerControls').innerHTML = owner ? '<button class="btn" id="editOverview" type="button">Edit overview</button>' : '<span class="muted">View only</span>';
  $('#imageUpload').classList.toggle('hidden', !owner);
  $('#overviewBox').innerHTML = site.overview ? `<p>${esc(site.overview)}</p>` : (owner ? '<p class="muted">No overview yet. Click "Edit overview" to describe the site.</p>' : '');
  objectUrls.forEach(URL.revokeObjectURL); objectUrls = [];
  const imgs = (await bySite('images', site.id)).sort((a, b) => b.createdAt - a.createdAt);
  $('#gallery').innerHTML = imgs.length ? imgs.map((im) => `<figure><img alt="${esc(im.caption || 'Site image')}" data-img="${im.id}">
      <figcaption><span>${esc(im.caption || '')} <span class="muted">${fmtDate(im.date)}</span></span>
      ${owner ? `<button class="icon-btn" data-imgdel="${im.id}" title="Remove" type="button">&times;</button>` : ''}</figcaption></figure>`).join('')
    : '<p class="muted">No images yet.</p>';
  const siteId = site.id;
  for (const im of imgs) {
    const blob = await fileBlob('images', im).catch(() => null);
    if (!site || site.id !== siteId) return;
    const el = document.querySelector(`img[data-img="${im.id}"]`);
    if (!el) continue;
    if (!blob) { el.alt = 'Image could not load'; continue; }
    const u = URL.createObjectURL(blob); objectUrls.push(u);
    el.src = u; el.dataset.full = u;
  }
}
// Gets an image/POW file: from this device if saved here, otherwise from GitHub (then kept here)
async function fileBlob(store, rec) {
  if (store === 'images' && rec.blob) return rec.blob;
  if (store === 'pow' && rec.data) return new Blob([rec.data]);
  if (!rec.path || !isOnline()) return null;
  const bytes = await downloadFile(rec.path);
  const fresh = await get(store, rec.id);
  if (store === 'images') { if (fresh) await rawPut(store, { ...fresh, blob: new Blob([bytes], { type: 'image/jpeg' }) }); return new Blob([bytes], { type: 'image/jpeg' }); }
  if (fresh) await rawPut(store, { ...fresh, data: bytes });
  return new Blob([bytes]);
}

async function shrinkImage(file, maxSide = 1800) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size < 1.5e6) return file;
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((r) => c.toBlob((b) => r(b || file), 'image/jpeg', 0.85));
  } catch { return file; }
}
async function addImages(files) {
  if (!canEdit()) return toast('View only');
  const caption = $('#imageCaption').value.trim();
  for (const f of files) await put('images', { id: uid(), siteId: site.id, blob: await shrinkImage(f), caption, date: today(), createdAt: Date.now() });
  $('#imageCaption').value = '';
  toast(files.length + ' image(s) added');
  renderImages();
}

/* ---------------- POW ---------------- */
let powSheet = 0;
async function renderPow() {
  const pow = await get('pow', site.id);
  $('#powDownload').classList.toggle('hidden', !pow);
  $('#powRemove').classList.toggle('hidden', !pow);
  if (!pow) { $('#powInfo').textContent = 'No POW uploaded for this site yet.'; $('#powSheetTabs').innerHTML = ''; $('#powTable').innerHTML = ''; return; }
  $('#powInfo').textContent = `${pow.fileName} — uploaded ${new Date(pow.uploadedAt).toLocaleString()}`;
  let data;
  try { data = new Uint8Array(await (await fileBlob('pow', pow)).arrayBuffer()); } catch { $('#powInfo').textContent += ' (could not load the file right now)'; return; }
  const wb = XLSX.read(data, { type: 'array' });
  if (powSheet >= wb.SheetNames.length) powSheet = 0;
  $('#powSheetTabs').innerHTML = wb.SheetNames.length > 1
    ? wb.SheetNames.map((n, i) => `<button class="btn btn-small ${i === powSheet ? 'btn-primary' : ''}" data-sheet="${i}" type="button">${esc(n)}</button>`).join('') : '';
  const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[powSheet]], { header: 1, defval: '', raw: false }).filter((r) => r.some((c) => c !== ''));
  const width = Math.max(0, ...rows.map((r) => r.length));
  $('#powTable').innerHTML = rows.length
    ? '<tbody>' + rows.map((r, i) => `<tr>${Array.from({ length: width }, (_, j) => { const t = i === 0 ? 'th' : 'td'; return `<${t}>${esc(r[j] ?? '')}</${t}>`; }).join('')}</tr>`).join('') + '</tbody>'
    : '<tbody><tr><td class="empty">This sheet is empty.</td></tr></tbody>';
}
async function uploadPow(file) {
  const data = new Uint8Array(await file.arrayBuffer());
  try { XLSX.read(data, { type: 'array' }); } catch { return toast('Could not read that file'); }
  await put('pow', { id: site.id, siteId: site.id, fileName: file.name, data, uploadedAt: Date.now() });
  powSheet = 0; renderPow(); toast('POW uploaded');
}
async function downloadPow() {
  const pow = await get('pow', site.id); if (!pow) return;
  try { downloadBlob(await fileBlob('pow', pow), pow.fileName); } catch { toast('Could not load the POW file'); }
}
function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 3000);
}

/* ---------------- Excel export (same sheets as the original workbook) ---------------- */
function sheetName(n, used) {
  let s = String(n).replace(/[\\/?*[\]:]/g, '-').slice(0, 31) || 'Sheet';
  let k = 2; const base = s;
  while (used.has(s.toLowerCase())) s = (base.slice(0, 28) + ' ' + k++);
  used.add(s.toLowerCase()); return s;
}
function makeSheet(aoa, origin, cols, numCols, numFrom) {
  const ws = XLSX.utils.aoa_to_sheet(aoa, { origin });
  ws['!cols'] = cols.map((w) => ({ wch: w }));
  const range = XLSX.utils.decode_range(ws['!ref']);
  for (let r = numFrom; r <= range.e.r; r++) for (const c of numCols) {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell && cell.t === 'n') cell.z = '#,##0;-#,##0;0';
  }
  return ws;
}

function downloadExcel() {
  const wb = XLSX.utils.book_new(); const used = new Set();
  const fs = sortedFunds();
  const fundCode = (id) => fundById(id)?.code || '';

  // Fund 1, Fund 2 ...
  for (const f of fs) {
    const es = entries.filter((e) => e.fundId === f.id); const u = fundUsed(f.id);
    const title = 'Fund ' + (fundNo(f.code) || f.code);
    const aoa = [[title], [], ['Fund ID', f.code], ['Received From', f.receivedFrom], ['Mode', f.mode], ['Amount Received', received(f)], ['Amount Used', u], ['Balance', received(f) - u], [],
      ['#', 'Used For', 'Category', `Amount (${CUR})`], ...es.map((e, i) => [i + 1, e.usedFor, e.category, e.amount]), ['', 'TOTAL USED', '', u]];
    XLSX.utils.book_append_sheet(wb, makeSheet(aoa, 'B2', [2, 18, 60, 24, 14], [2, 4], 6), sheetName(title, used));
  }
  // Category sheets
  for (const c of allCategories()) {
    const { rows, total } = categorySheet(c);
    const aoa = [[c], [], ['#', 'Item', 'Quantity', `Total Amount (${CUR})`], ...rows.map((r, i) => [i + 1, r.item, r.quantity, r.amount]), ['', `TOTAL SPENT ON ${c.toUpperCase()}`, '', total]];
    XLSX.utils.book_append_sheet(wb, makeSheet(aoa, 'B2', [2, 5, 36, 40, 20], [4], 4), sheetName(c, used));
  }
  // Total
  const s1 = funds.reduce((t, f) => t + num(f.amount1), 0), s2 = funds.reduce((t, f) => t + num(f.amount2), 0);
  const tAoa = [['Total - Funds Received, Used and Balance'], [], [],
    ['Fund ID', 'Date', 'Received From', 'Mode', `Amount 1 (${CUR})`, `Amount 2 (${CUR})`, `Total Received (${CUR})`, `Used (${CUR})`, `Balance (${CUR})`],
    ...fs.map((f) => [f.code, fmtDate(f.date), f.receivedFrom, f.mode, f.amount1 || '', f.amount2 || '', received(f), fundUsed(f.id), received(f) - fundUsed(f.id)]),
    ['TOTAL', '', '', '', s1, s2, s1 + s2, totalUsed(), s1 + s2 - totalUsed()]];
  XLSX.utils.book_append_sheet(wb, makeSheet(tAoa, 'B2', [2, 9, 12, 28, 16, 16, 16, 20, 14, 14], [5, 6, 7, 8, 9], 5), sheetName('Total', used));
  // All Entries
  const qf = site.qtyFields;
  const simple = entries.some((e) => e.q); // Quantity + Unit columns only when used
  const sh = simple ? ['Quantity', 'Unit'] : [];
  const eAoa = [[], ['', 'All Entries'], [], ['', '', '', '', '', 'Total Used', totalUsed()],
    ['No.', 'Fund ID', 'Date', 'Used For', 'Category', 'Item', `Amount (${CUR})`, ...sh, ...qf.map((q) => q.label)],
    ...entries.map((e, i) => [i + 1, fundCode(e.fundId), fmtDate(e.date), e.usedFor, e.category, e.item, e.amount, ...(simple ? [e.q || '', e.q ? e.unit || '' : ''] : []), ...qf.map((q) => num(e.qty?.[q.id]) || '')])];
  XLSX.utils.book_append_sheet(wb, makeSheet(eAoa, 'A1', [6, 9, 12, 70, 24, 36, 14, ...(simple ? [10, 10] : []), ...qf.map((q) => Math.max(12, q.label.length + 2))], [6], 3), sheetName('All Entries', used));
  // Summary
  const r = totalReceived(), u = totalUsed(); const cats = allCategories();
  const left = [['Summary'], [], ['Total Received', r], ['Total Used', u], ['Balance', r - u], [], ['Spent On', `Amount (${CUR})`, '% of Used'],
    ...cats.map((c) => { const a = categorySheet(c).total; return [c, a, u ? a / u : 0]; }), ['TOTAL', u, u ? 1 : 0]];
  const right = [['Fund', `Received (${CUR})`, `Used (${CUR})`, `Balance (${CUR})`], ...fs.map((f) => [f.code, received(f), fundUsed(f.id), received(f) - fundUsed(f.id)]), ['TOTAL', r, u, r - u]];
  const rows = Math.max(left.length, right.length + 1);
  const sAoa = Array.from({ length: rows }, (_, i) => { const L = left[i] || []; const R = right[i - 1] || []; return [L[0] ?? '', L[1] ?? '', L[2] ?? '', '', ...R]; });
  const ws = makeSheet(sAoa, 'B2', [2, 26, 16, 12, 3, 10, 16, 14, 14], [2, 6, 7, 8], 3);
  for (let i = 0; i < rows; i++) { const cell = ws[XLSX.utils.encode_cell({ r: i + 1, c: 3 })]; if (cell && cell.t === 'n') cell.z = '0%'; }
  XLSX.utils.book_append_sheet(wb, ws, sheetName('Summary', used));

  XLSX.writeFile(wb, `${safeName(site.name)}_Expenditure_${today()}.xlsx`);
}

/* ---------------- PDF export ---------------- */
function downloadPdf() {
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  const style = { fontSize: 8.5, cellPadding: 3.5, lineColor: [200, 200, 200], lineWidth: 0.5 };
  const headStyles = { fillColor: [47, 74, 92], textColor: 255 };
  const footStyles = { fillColor: [238, 238, 235], textColor: 0, fontStyle: 'bold' };
  doc.autoTableSetDefaults({ showFoot: 'lastPage' });
  const right = (...cols) => Object.fromEntries(cols.map((c) => [c, { halign: 'right' }]));
  const heading = (text, y) => { doc.setFontSize(12); doc.setTextColor(0); doc.text(text, 40, y); return y + 8; };
  const r = totalReceived(), u = totalUsed();
  const fs = sortedFunds();

  doc.setFontSize(15); doc.text(`${site.name} – Expenditure`, 40, 40);
  doc.setFontSize(9); doc.setTextColor(100);
  doc.text(`${site.location ? site.location + ' · ' : ''}Generated ${new Date().toLocaleString()}`, 40, 56);

  let y = heading('Summary', 80);
  doc.autoTable({ startY: y, styles: style, headStyles, footStyles, tableWidth: 300, margin: { left: 40 },
    body: [['Total Received', plain(r)], ['Total Used', plain(u)], ['Balance', plain(r - u)]], columnStyles: right(1) });
  const afterTotals = doc.lastAutoTable.finalY;
  doc.autoTable({ startY: afterTotals + 10, styles: style, headStyles, footStyles, tableWidth: 300, margin: { left: 40 },
    head: [['Spent On', `Amount (${CUR})`, '% of Used']],
    body: allCategories().map((c) => { const a = categorySheet(c).total; return [c, plain(a), (u ? Math.round((a / u) * 100) : 0) + '%']; }),
    foot: [['TOTAL', plain(u), u ? '100%' : '0%']], columnStyles: right(1, 2) });
  const leftEnd = doc.lastAutoTable.finalY;
  doc.autoTable({ startY: y, styles: style, headStyles, footStyles, tableWidth: 380, margin: { left: 420 },
    head: [['Fund', `Received (${CUR})`, `Used (${CUR})`, `Balance (${CUR})`]],
    body: fs.map((f) => [f.code, plain(received(f)), plain(fundUsed(f.id)), plain(received(f) - fundUsed(f.id))]),
    foot: [['TOTAL', plain(r), plain(u), plain(r - u)]], columnStyles: right(1, 2, 3) });
  y = Math.max(leftEnd, doc.lastAutoTable.finalY) + 26;

  if (y > doc.internal.pageSize.getHeight() - 140) { doc.addPage(); y = 40; }
  y = heading('Total - Funds Received, Used and Balance', y);
  const s1 = funds.reduce((t, f) => t + num(f.amount1), 0), s2 = funds.reduce((t, f) => t + num(f.amount2), 0);
  doc.autoTable({ startY: y, styles: style, headStyles, footStyles,
    head: [['Fund ID', 'Date', 'Received From', 'Mode', `Amount 1 (${CUR})`, `Amount 2 (${CUR})`, `Total Received (${CUR})`, `Used (${CUR})`, `Balance (${CUR})`]],
    body: fs.map((f) => [f.code, fmtDate(f.date), f.receivedFrom, f.mode, f.amount1 ? plain(f.amount1) : '', f.amount2 ? plain(f.amount2) : '', plain(received(f)), plain(fundUsed(f.id)), plain(received(f) - fundUsed(f.id))]),
    foot: [['TOTAL', '', '', '', plain(s1), plain(s2), plain(s1 + s2), plain(u), plain(s1 + s2 - u)]], columnStyles: right(4, 5, 6, 7, 8) });

  doc.addPage(); y = heading('All Entries', 40);
  doc.autoTable({ startY: y, styles: style, headStyles, footStyles,
    head: [['No.', 'Fund ID', 'Date', 'Used For', 'Category', 'Item', `Amount (${CUR})`, 'Quantity']],
    body: entries.map((e, i) => [i + 1, fundById(e.fundId)?.code || '', fmtDate(e.date), e.usedFor, e.category, e.item, plain(e.amount), qtyText(e)]),
    foot: [['', '', '', '', '', 'Total Used', plain(u), '']], columnStyles: { 3: { cellWidth: 230 }, 6: { halign: 'right' } } });

  for (const c of allCategories()) {
    const { rows, total } = categorySheet(c);
    y = doc.lastAutoTable.finalY + 26;
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = 40; }
    y = heading(c, y);
    doc.autoTable({ startY: y, styles: style, headStyles, footStyles,
      head: [['#', 'Item', 'Quantity', `Total Amount (${CUR})`]],
      body: rows.map((rw, i) => [i + 1, rw.item, rw.quantity, plain(rw.amount)]),
      foot: [['', `TOTAL SPENT ON ${c.toUpperCase()}`, '', plain(total)]], columnStyles: right(3) });
  }

  const pages = doc.getNumberOfPages();
  for (let i = 1; i <= pages; i++) { doc.setPage(i); doc.setFontSize(8); doc.setTextColor(120); doc.text(`${site.name} · Page ${i} of ${pages}`, doc.internal.pageSize.getWidth() - 40, doc.internal.pageSize.getHeight() - 20, { align: 'right' }); }
  doc.save(`${safeName(site.name)}_Expenditure_${today()}.pdf`);
}

/* ---------------- Import from Excel (Total + All Entries sheets) ---------------- */
async function importExcel(file) {
  let wb;
  try { wb = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array', cellDates: true }); } catch { return toast('Could not read that file'); }
  const rowsOf = (name) => { const s = wb.SheetNames.find((n) => n.trim().toLowerCase() === name.toLowerCase()); return s ? XLSX.utils.sheet_to_json(wb.Sheets[s], { header: 1, defval: '' }) : null; };
  const findHeader = (rows, first) => rows.findIndex((r) => r.some((c) => String(c).trim().toLowerCase() === first.toLowerCase()));
  const toISO = (v) => { if (v instanceof Date) return new Date(v.getTime() - v.getTimezoneOffset() * 60000).toISOString().slice(0, 10); const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(v).trim()); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; };

  const T = rowsOf('Total'), A = rowsOf('All Entries');
  if (!T && !A) return toast('No "Total" or "All Entries" sheet found');
  let nf = 0, ne = 0;
  const codeToId = Object.fromEntries(funds.map((f) => [f.code.toLowerCase(), f.id]));
  let t = Date.now();
  if (T) {
    const h = findHeader(T, 'Fund ID');
    if (h >= 0) {
      const H = T[h].map((c) => String(c).trim().toLowerCase()); const col = (n) => H.findIndex((x) => x.startsWith(n));
      for (const row of T.slice(h + 1)) {
        const code = String(row[col('fund id')] ?? '').trim();
        if (!code || code.toUpperCase() === 'TOTAL' || codeToId[code.toLowerCase()]) continue;
        const a1 = num(row[col('amount 1')]), a2 = num(row[col('amount 2')]);
        const f = { id: uid(), siteId: site.id, code, date: toISO(row[col('date')]), receivedFrom: String(row[col('received from')] ?? '').trim(), mode: String(row[col('mode')] ?? '').trim(), amount1: a1, amount2: a2, createdAt: t++ };
        if (f.mode && !site.modes.includes(f.mode)) site.modes.push(f.mode);
        await put('funds', f); codeToId[code.toLowerCase()] = f.id; nf++;
      }
    }
  }
  if (A) {
    const h = findHeader(A, 'Used For');
    if (h >= 0) {
      const raw = A[h].map((c) => String(c).trim()); const H = raw.map((c) => c.toLowerCase());
      const col = (n) => H.indexOf(n);
      const base = ['no.', 'fund id', 'date', 'used for', 'category', 'item'];
      const amtCol = H.findIndex((x) => x.startsWith('amount'));
      // every other headed column after Amount is a quantity column
      const qCols = raw.map((label, i) => ({ label, i })).filter(({ label, i }) => label && i > amtCol && !base.includes(label.toLowerCase()));
      const qIds = qCols.map(({ label }) => { let f = site.qtyFields.find((q) => q.label.toLowerCase() === label.toLowerCase()); if (!f) { f = { id: uid(), label }; site.qtyFields.push(f); } return f.id; });
      for (const row of A.slice(h + 1)) {
        const usedFor = String(row[col('used for')] ?? '').trim();
        if (!usedFor) continue;
        let code = String(row[col('fund id')] ?? '').trim();
        if (code && !codeToId[code.toLowerCase()]) { const f = { id: uid(), siteId: site.id, code, date: '', receivedFrom: '', mode: '', amount1: 0, amount2: 0, createdAt: t++ }; await put('funds', f); codeToId[code.toLowerCase()] = f.id; nf++; }
        const category = String(row[col('category')] ?? '').trim(), item = String(row[col('item')] ?? '').trim();
        if (category && !site.categories.includes(category)) site.categories.push(category);
        if (item && !site.items.some((i) => i.name === item)) site.items.push({ name: item, qty: [] });
        const qty = {}; qCols.forEach(({ i }, k) => { if (num(row[i])) qty[qIds[k]] = num(row[i]); });
        await put('expenses', { id: uid(), siteId: site.id, fundId: code ? codeToId[code.toLowerCase()] : '', date: toISO(row[col('date')]), usedFor, category, item, amount: num(row[amtCol]), qty, createdAt: t++ });
        ne++;
      }
    }
  }
  await saveSite(); await reload();
  toast(`Imported ${nf} fund(s) and ${ne} entr${ne === 1 ? 'y' : 'ies'}`);
}

/* ---------------- Backup / Restore ---------------- */
const blobToDataUrl = (b) => new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(b); });
const dataUrlToBlob = async (u) => (await fetch(u)).blob();

async function backup() {
  toast('Preparing backup…');
  const out = { app: 'site-expenditure-tracker', version: 2, savedAt: new Date().toISOString() };
  for (const s of SYNCED) out[s] = await all(s);
  out.meta = [{ id: 'seeded', value: true }];
  out.images = await Promise.all(out.images.map(async (im) => { const b = await fileBlob('images', im).catch(() => null); const r = stripRec('images', im); if (b) r.blob = await blobToDataUrl(b); return r; }));
  out.pow = await Promise.all(out.pow.map(async (pw) => { const b = await fileBlob('pow', pw).catch(() => null); const r = stripRec('pow', pw); if (b) r.data = Array.from(new Uint8Array(await b.arrayBuffer())); return r; }));
  downloadBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), `Expenditure_Backup_${today()}.json`);
  toast('Backup saved to your Downloads');
}
async function readBackupFile(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return null; }
  return data && data.app === 'site-expenditure-tracker' ? data : null;
}
// Replaces everything on this device with a backup; when online, also replaces the online copy
async function loadBackupData(data) {
  for (const s of [...STORES, 'queue']) await clearStore(s);
  for (const s of SYNCED) {
    for (let rec of data[s] || []) {
      if (s === 'images' && rec.blob) { rec = { ...rec, blob: await dataUrlToBlob(rec.blob) }; delete rec.path; }
      if (s === 'pow' && rec.data) { rec = { ...rec, data: new Uint8Array(rec.data) }; delete rec.path; }
      await rawPut(s, rec);
    }
  }
  await rawPut('meta', { id: 'seeded', value: true });
  if (canSync()) await pushEverything();
}
async function restore(file) {
  const data = await readBackupFile(file);
  if (!data) return toast('That is not a backup file');
  const where = canSync() ? 'on this device and online' : 'on this device';
  if (!(await confirmBox('Restore backup', `Replace everything ${where} with the backup from ${new Date(data.savedAt).toLocaleString()}?`, 'Restore'))) return;
  await loadBackupData(data);
  toast('Backup restored');
  showHome();
}

/* ---------------- Online saving (encrypted file in the GitHub repo) ----------------
 * data.enc  = all records, encrypted (AES-GCM) with the key that is in your link (#k=...)
 * images/*.bin, pow/*.bin = image and POW files, encrypted the same way
 * Anyone with the full link can read. Only a device holding your GitHub token can save.
 */
let cfg = loadCfg();
function loadCfg() { try { return JSON.parse(localStorage.getItem('sync') || 'null') || {}; } catch { return {}; } }
function saveCfg() { try { localStorage.setItem('sync', JSON.stringify(cfg)); } catch { /* private window */ } }
const onGithubPages = () => /\.github\.io$/i.test(location.hostname);
const isOnline = () => !!(cfg.owner && cfg.repo && cfg.key);
const canSync = () => isOnline() && !!cfg.token;
const canEdit = () => !isOnline() || !!cfg.token;
const shareLink = () => `https://${cfg.owner.toLowerCase()}.github.io/${cfg.repo}/#k=${cfg.key}`;
function keyFromLink(s) { const m = /[#&?]k=([\w-]{16,})/.exec(String(s || '').trim()); return m ? m[1] : (/^[\w-]{20,}$/.test(String(s).trim()) ? String(s).trim() : null); }

function bytesToB64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
function b64ToBytes(b64) { const s = atob(b64.replace(/\s/g, '')); const out = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i); return out; }
const b64url = (bytes) => bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => b64ToBytes(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

let cryptoKey = null, cryptoKeyFor = null;
async function getKey() {
  if (cryptoKeyFor !== cfg.key) { cryptoKey = await crypto.subtle.importKey('raw', unb64url(cfg.key), 'AES-GCM', false, ['encrypt', 'decrypt']); cryptoKeyFor = cfg.key; }
  return cryptoKey;
}
async function encrypt(bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await getKey(), bytes));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
async function decrypt(bytes) {
  try { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await getKey(), bytes.slice(12))); }
  catch { throw new Error('badkey'); }
}

async function gh(path, { method = 'GET', body, raw = false, token = cfg.token } = {}) {
  const headers = { Accept: raw ? 'application/vnd.github.raw' : 'application/vnd.github+json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const url = `https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}` + (method === 'GET' ? (path.includes('?') ? '&' : '?') + 't=' + Date.now() : '');
  return fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
}
async function downloadFile(path) {
  const r = await gh('/contents/' + path, { raw: true });
  if (!r.ok) throw new Error('GitHub ' + r.status);
  return decrypt(new Uint8Array(await r.arrayBuffer()));
}
async function uploadFile(path, plainBytes, sha, message) {
  return gh('/contents/' + path, { method: 'PUT', body: { message, content: bytesToB64(await encrypt(plainBytes)), ...(sha ? { sha } : {}) } });
}
async function fetchDoc() { // -> { doc, sha } or null when nothing is online yet
  const r = await gh('/contents/data.enc');
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub ' + r.status);
  const j = await r.json();
  let bytes;
  if (j.content) bytes = b64ToBytes(j.content);
  else { const rr = await gh('/contents/data.enc', { raw: true }); if (!rr.ok) throw new Error('GitHub ' + rr.status); bytes = new Uint8Array(await rr.arrayBuffer()); }
  return { doc: JSON.parse(new TextDecoder().decode(await decrypt(bytes))), sha: j.sha };
}

// Pending changes waiting to reach GitHub (kept on this device, so nothing is lost offline)
let qSeq = 0;
const enqueue = (op) => rawPut('queue', { id: Date.now() * 1000 + (qSeq++ % 1000), op });
function applyOp(doc, op) {
  if (op.t === 'replace') { Object.assign(doc, op.doc); return; }
  const arr = (doc[op.s] ||= []);
  const i = arr.findIndex((r) => r.id === (op.t === 'put' ? op.r.id : op.id));
  if (op.t === 'put') { if (i >= 0) arr[i] = op.r; else arr.push(op.r); }
  if (op.t === 'del' && i >= 0) arr.splice(i, 1);
}
async function localDoc() {
  const d = { version: 1 };
  for (const s of SYNCED) d[s] = (await all(s)).map((r) => stripRec(s, r));
  return d;
}
async function pushEverything() {
  await clearStore('queue');
  for (const s of ['images', 'pow']) {
    for (const rec of await all(s)) {
      if ((rec.blob || rec.data) && !rec.path) { rec.path = `${s}/${rec.id}-${Math.random().toString(36).slice(2, 8)}.bin`; await rawPut(s, rec); }
      if (rec.blob || rec.data) await enqueue({ t: 'file', s, id: rec.id, path: rec.path });
    }
  }
  await enqueue({ t: 'replace', doc: await localDoc() });
  return flush();
}

let flushTimer = null, flushing = false, flushAgain = false, lastError = '';
function scheduleFlush() { clearTimeout(flushTimer); flushTimer = setTimeout(flush, 700); setSync('saving'); }
async function flush() {
  if (!canSync()) return;
  if (flushing) { flushAgain = true; return; }
  flushing = true;
  try {
    let q = await all('queue');
    if (!q.length) { setSync('saved'); return; }
    setSync('saving');
    for (const item of q.filter((x) => x.op.t === 'file')) {
      const rec = await get(item.op.s, item.op.id);
      const bytes = rec && (rec.blob ? new Uint8Array(await rec.blob.arrayBuffer()) : rec.data);
      if (bytes && rec.path === item.op.path) {
        const r = await uploadFile(item.op.path, bytes, undefined, 'Add file');
        if (!r.ok && r.status !== 422) throw new Error('GitHub ' + r.status);
      }
      await rawDel('queue', item.id);
    }
    q = (await all('queue')).filter((x) => x.op.t !== 'file');
    if (q.length) {
      for (let attempt = 0; ; attempt++) {
        const cur = await fetchDoc();
        const doc = cur ? cur.doc : { version: 1 };
        for (const item of q) applyOp(doc, item.op);
        doc.savedAt = new Date().toISOString();
        const r = await uploadFile('data.enc', new TextEncoder().encode(JSON.stringify(doc)), cur?.sha, `Update records (${q.length} change${q.length === 1 ? '' : 's'})`);
        if (r.ok) break;
        if ((r.status === 409 || r.status === 422) && attempt < 4) continue; // someone else saved first: reload and try again
        throw new Error('GitHub ' + r.status);
      }
      for (const item of q) await rawDel('queue', item.id);
    }
    lastError = '';
    setSync((await all('queue')).length ? 'saving' : 'saved');
  } catch (e) {
    lastError = e.message === 'badkey' ? 'The key in your link does not match the online records.' : /40[13]/.test(e.message) ? 'GitHub refused your key. It may have expired: set it again in Online saving.' : 'No internet or GitHub not reachable. Will retry.';
    setSync('pending');
  } finally {
    flushing = false;
    if (flushAgain) { flushAgain = false; flush(); }
  }
}
// Load the latest records from GitHub onto this device
async function pull() {
  const cur = await fetchDoc();
  if (!cur) return false;
  const pending = (await all('queue')).map((x) => x.op);
  const doc = cur.doc;
  for (const op of pending) if (op.t !== 'file') applyOp(doc, op); // keep changes not uploaded yet
  for (const s of ['sites', 'funds', 'expenses']) { await clearStore(s); for (const r of doc[s] || []) await rawPut(s, r); }
  for (const s of ['images', 'pow']) {
    const local = new Map((await all(s)).map((r) => [r.id, r]));
    const keep = new Set(pending.filter((o) => o.t === 'file' && o.s === s).map((o) => o.id));
    await clearStore(s);
    for (const r of doc[s] || []) {
      const l = local.get(r.id);
      await rawPut(s, l && l.path === r.path ? { ...r, blob: l.blob, data: l.data } : r);
      local.delete(r.id);
    }
    for (const [id, l] of local) if (keep.has(id)) await rawPut(s, l);
  }
  await rawPut('meta', { id: 'seeded', value: true });
  await rawPut('meta', { id: 'pulledAt', value: doc.savedAt || new Date().toISOString() });
  return true;
}

function setSync(state) {
  const el = $('#syncBtn'); if (!el) return;
  const txt = !isOnline() ? 'Offline only' : !cfg.token ? 'View only' : { saved: 'Saved online ✓', saving: 'Saving…', pending: 'Not saved online yet' }[state] || 'Online';
  el.textContent = txt;
  el.classList.toggle('warn', state === 'pending' || !isOnline());
  el.title = lastError || '';
  document.body.classList.toggle('readonly', !canEdit());
}

async function checkToken(token) {
  const r = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}`, { headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer ' + token }, cache: 'no-store' });
  if (r.status === 404 || r.status === 401) return 'GitHub did not accept that key for ' + cfg.owner + '/' + cfg.repo + '. Check the username, repository name and key.';
  if (!r.ok) return 'Could not reach GitHub (' + r.status + ').';
  const j = await r.json();
  if (j.permissions && !j.permissions.push) return 'That key can only read. Give it "Contents: Read and write".';
  return '';
}

const TOKEN_HELP = `<p class="small muted">Get your key on GitHub: <strong>Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token</strong>.
  Repository access: <em>Only select repositories</em> → your repo. Permissions: <em>Contents → Read and write</em>. Copy the key (starts with github_pat_).</p>`;

async function onlineDialog() {
  if (!isOnline()) {
    const guess = onGithubPages() ? { owner: location.hostname.split('.')[0], repo: location.pathname.split('/').filter(Boolean)[0] || '' } : {};
    const v = await ask('Set up online saving', `
      <p>Your records will be saved (encrypted) in your GitHub repository, so you can open them on any phone or computer with your link.</p>
      <label>GitHub username<input name="owner" value="${esc(cfg.owner || guess.owner || '')}" required></label>
      <label>Repository<input name="repo" value="${esc(cfg.repo || guess.repo || 'Site_Expenditure_Recorder')}" required></label>
      <label>GitHub key (token)<input name="token" type="password" required></label>
      ${TOKEN_HELP}
      <label>Starting data (backup file, optional)<input name="start" type="file" accept=".json"></label>
      <label>Already set up on another device? Paste your link<input name="link" placeholder="https://…#k=…"></label>`, { okText: 'Connect' });
    if (!v) return;
    const file = $('#dialogBody input[name=start]').files[0];
    Object.assign(cfg, { owner: v.owner.trim(), repo: v.repo.trim() });
    const token = v.token.trim();
    toast('Checking with GitHub…');
    const err = await checkToken(token);
    if (err) { toast(err); return; }
    const linkKey = keyFromLink(v.link);
    cfg.token = token;
    let existing = null;
    try { existing = await fetchDocExists(); } catch { cfg.token = undefined; return toast('Could not reach GitHub. Try again.'); }
    if (existing) {
      if (!linkKey) { cfg.token = undefined; return toast('Records are already online. Paste your link (with #k=…) to connect.'); }
      cfg.key = linkKey;
      try { await pull(); } catch (e) { cfg.key = undefined; cfg.token = undefined; return toast(e.message === 'badkey' ? 'That link does not match the online records.' : 'Could not load the online records.'); }
      saveCfg(); setSync('saved'); toast('Connected. Records loaded.'); showHome(); return;
    }
    cfg.key = linkKey || b64url(crypto.getRandomValues(new Uint8Array(16)));
    saveCfg();
    if (file) { const data = await readBackupFile(file); if (!data) { toast('Starting file is not a backup file; uploading what is on this device'); } else { await loadBackupData(data); } }
    await seedIfEmpty();
    toast('Uploading your records…');
    await pushEverything();
    setSync(lastError ? 'pending' : 'saved');
    showHome();
    return showLinkDialog(true);
  }
  if (!cfg.token) {
    const v = await ask('View only on this device', `<p>Anyone with your link can read the records. To add or change anything on this device, enter your GitHub key.</p>
      <label>GitHub key (token)<input name="token" type="password"></label>${TOKEN_HELP}
      <label class="check-row"><input type="checkbox" name="forget"> Remove the records and link from this device</label>`, { okText: 'OK' });
    if (!v) return;
    if (v.forget) { await forgetDevice(); return; }
    const token = v.token.trim(); if (!token) return;
    const err = await checkToken(token);
    if (err) return toast(err);
    cfg.token = token; saveCfg(); setSync('saved'); toast('You can now add and edit on this device');
    if (site) openSite(site.id); else showHome();
    flush();
    return;
  }
  return showLinkDialog(false);
}
async function fetchDocExists() { const r = await gh('/contents/data.enc'); if (r.status === 404) return false; if (!r.ok) throw new Error('GitHub ' + r.status); return true; }

async function showLinkDialog(first) {
  const pend = (await all('queue')).length;
  const v = await ask(first ? 'Online saving is on' : 'Online saving', `
    <p>${first ? 'Your records are now saved online. ' : ''}Open this link on any phone or computer to see all the records. <strong>Anyone with the link can read them</strong>, so share it only with your bosses. Only devices with your GitHub key can add or change anything.</p>
    <label>Your link<input id="shareLinkInput" readonly value="${esc(shareLink())}"></label>
    <button class="btn" id="copyLinkBtn" type="button">Copy link</button>
    <p class="small muted">${pend ? pend + ' change(s) waiting to upload. ' + esc(lastError) : 'Everything is saved online.'}</p>
    <p class="small muted">The app must be published with GitHub Pages for the link to open (repo Settings → Pages).</p>
    <label class="check-row"><input type="checkbox" name="stop"> Stop editing on this device (it becomes view only)</label>`, {
    okText: 'Done',
    onOpen: () => { $('#copyLinkBtn').onclick = async () => { const i = $('#shareLinkInput'); i.select(); try { await navigator.clipboard.writeText(i.value); } catch { document.execCommand('copy'); } toast('Link copied'); }; },
  });
  if (v && v.stop) { cfg.token = undefined; saveCfg(); setSync(); toast('This device is now view only'); if (site) openSite(site.id); else showHome(); }
}
async function forgetDevice() {
  for (const s of [...STORES, 'queue']) await clearStore(s);
  cfg = {}; saveCfg();
  try { localStorage.removeItem('sync'); } catch { /* ignore */ }
  location.href = location.pathname;
}

/* ---------------- Tabs & events ---------------- */
function switchTab(name) {
  if (!$('#tab-' + name) || (name === 'settings' && !canEdit())) name = 'entries';
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-panel').forEach((pn) => pn.classList.toggle('hidden', pn.id !== 'tab-' + name));
  sessSet('tab', name);
  if (name === 'images') renderImages();
  if (name === 'pow') renderPow();
}

function bind() {
  $('#backBtn').onclick = showHome;
  $('#addSiteBtn').onclick = addSite;
  $('#backupBtn').onclick = backup;
  $('#syncBtn').onclick = onlineDialog;
  $('#restoreInput').onchange = (e) => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; };
  $$('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

  // Entry form
  $$('input[name=fundMode]').forEach((r) => (r.onchange = updateFundMode));
  ['#fundSelect', '#exAmount', '#nfAmount1', '#nfAmount2'].forEach((s) => $(s).addEventListener('input', updateFundHint));
  $('#fundSelect').addEventListener('change', updateFundHint);
  $$('.seg-btn').forEach((b) => (b.onclick = () => setKind(b.dataset.kind)));
  $('#exItem').addEventListener('change', onItemPicked);
  $('#exItem').addEventListener('input', renderQtyInputs);
  $('#exCategory').addEventListener('input', renderItemList);
  $('#moreQtyBtn').onclick = () => { showAllQty = true; renderQtyInputs(); };
  $('#entryForm').onsubmit = submitEntry;
  // Typing a "Used For" used before fills in its Category and Item
  $('#exUsedFor').addEventListener('change', () => {
    const v = $('#exUsedFor').value.trim().toLowerCase();
    const last = [...entries].reverse().find((e) => e.usedFor.toLowerCase() === v);
    if (!last) return;
    $('#exCategory').value = last.category; renderItemList();
    $('#exItem').value = last.item; renderQtyInputs();
    if (!$('#exAmount').value) { $('#exAmount').value = last.amount; updateFundHint(); }
    if (!$('#exUnit').value && last.unit) $('#exUnit').value = last.unit;
  });
  ['#fSearch', '#fFund', '#fCategory', '#fItem'].forEach((s) => $(s).addEventListener('input', renderEntries));
  $$('.xlsxBtn').forEach((b) => (b.onclick = downloadExcel));
  $$('.pdfBtn').forEach((b) => (b.onclick = downloadPdf));

  $('#entryTable').onclick = async (e) => {
    const d = e.target.dataset;
    if (d.edit) editEntry(d.edit);
    if (d.del && await confirmBox('Delete entry', 'Delete this entry?')) { await del('expenses', d.del); await reload(); toast('Deleted'); }
  };

  // Funds
  $('#addFundBtn').onclick = () => fundDialog(null);
  $('#fundTable').onclick = async (e) => {
    const d = e.target.dataset;
    if (d.fedit) return fundDialog(fundById(d.fedit));
    if (d.fdel) {
      const n = entries.filter((x) => x.fundId === d.fdel).length;
      if (n) return toast(`This fund is used by ${n} entr${n === 1 ? 'y' : 'ies'}. Move or delete them first.`);
      if (await confirmBox('Delete fund', 'Delete this fund?')) { await del('funds', d.fdel); await reload(); toast('Deleted'); }
      return;
    }
    const tr = e.target.closest('tr[data-fund]');
    if (tr) { selectedFund = selectedFund === tr.dataset.fund ? null : tr.dataset.fund; renderFunds(); if (selectedFund) $('#fundDetail').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
  };

  // Images, lightbox, POW sheet tabs
  document.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.id === 'editOverview' && canEdit()) {
      const v = await ask('Site overview', `<label>Overview<textarea name="overview" rows="7" style="font:inherit;padding:8px;border:1px solid var(--line);border-radius:4px">${esc(site.overview || '')}</textarea></label>`, { okText: 'Save' });
      if (v) { site.overview = v.overview.trim(); await saveSite(); renderImages(); }
    }
    if (t.dataset.imgdel && canEdit() && await confirmBox('Remove image', 'Remove this image?', 'Remove')) { await del('images', t.dataset.imgdel); renderImages(); }
    if (t.dataset.full) {
      const lb = document.createElement('div'); lb.className = 'lightbox'; lb.innerHTML = `<img src="${t.dataset.full}" alt="">`;
      lb.onclick = () => lb.remove(); document.body.appendChild(lb);
    }
    if (t.dataset.sheet) { powSheet = +t.dataset.sheet; renderPow(); }
  });
  $('#imageInput').onchange = (e) => { if (e.target.files.length) addImages([...e.target.files]); e.target.value = ''; };
  $('#powInput').onchange = (e) => { if (e.target.files[0]) uploadPow(e.target.files[0]); e.target.value = ''; };
  $('#powDownload').onclick = downloadPow;
  $('#powRemove').onclick = async () => { if (await confirmBox('Remove POW', 'Remove the POW file from this site?', 'Remove')) { await del('pow', site.id); renderPow(); } };

  // Settings
  $('#siteForm').onsubmit = async (e) => {
    e.preventDefault();
    site.name = $('#sName').value.trim() || site.name; site.location = $('#sLocation').value.trim(); site.status = $('#sStatus').value;
    await saveSite(); $('#pageTitle').textContent = site.name; toast('Saved');
  };
  for (const id of Object.keys(LISTS)) {
    $('#' + id).addEventListener('click', onListClick);
    $('#' + id).addEventListener('submit', onListAdd);
  }
  $('#importInput').onchange = (e) => { if (e.target.files[0]) importExcel(e.target.files[0]); e.target.value = ''; };
  $('#deleteSiteBtn').onclick = async () => {
    const v = await ask('Delete site', `<p>Type the site name to confirm: <strong>${esc(site.name)}</strong></p><label>Site name<input name="name"></label>`, { okText: 'Delete site', danger: true });
    if (!v) return;
    if (v.name.trim() !== site.name) return toast('Name did not match');
    for (const s of ['funds', 'expenses', 'images']) for (const r of await bySite(s, site.id)) await del(s, r.id);
    await del('pow', site.id); await del('sites', site.id);
    toast('Site deleted'); showHome();
  };
}

/* ---------------- Start ---------------- */
(async function start() {
  try { db = await openDB(); } catch {
    document.body.innerHTML = '<main><p>This browser blocked storage. Open the file in Chrome or Edge (not a private window).</p></main>';
    return;
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  // A link like https://<user>.github.io/<repo>/#k=KEY: remember the repo and key on this device
  const k = keyFromLink(location.hash);
  if (onGithubPages()) {
    const owner = location.hostname.split('.')[0], repo = location.pathname.split('/').filter(Boolean)[0] || '';
    if (cfg.owner?.toLowerCase() !== owner.toLowerCase() || cfg.repo !== repo) { cfg = { owner, repo }; }
  }
  if (k && k !== cfg.key) { if (cfg.key) await clearStore('queue'); cfg.key = k; }
  saveCfg();
  if (k) history.replaceState(null, '', location.pathname);

  if (!isOnline() && !onGithubPages()) await seedIfEmpty();
  bind();
  setSync();
  if (isOnline()) {
    $('#siteList').innerHTML = '<p class="muted">Loading the latest records…</p>';
    try {
      const found = await pull();
      if (!found && canSync()) await pushEverything();
      if (!found && !canSync()) toast('No records online yet');
    } catch (e) {
      lastError = e.message === 'badkey' ? 'This link does not match the online records.' : 'No internet: showing the copy saved on this device.';
      toast(lastError);
    }
    if (canSync()) flush(); else setSync();
  }
  const m = location.hash.match(/site=([\w]+)/);
  if (m) openSite(m[1]); else showHome();

  // keep in step: retry uploads, and fetch others' changes when you come back to the app
  window.addEventListener('online', flush);
  setInterval(async () => { if (canSync() && (await all('queue')).length) flush(); }, 30000);
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible' || !isOnline() || flushing || document.querySelector('dialog[open]')) return;
    try { if (!(await all('queue')).length && await pull()) { if (site) { site = await get('sites', site.id); if (site) await reload(); else showHome(); } else showHome(); } } catch { /* offline */ }
  });
})();
