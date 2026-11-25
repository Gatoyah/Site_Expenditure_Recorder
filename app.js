/* Site Expenditure Tracker
 * Layout and wording follow Site_Expenditure_Tracker.xlsx.
 * Everything is saved in this browser on this computer (IndexedDB).
 * Use Backup / Restore to move data to another computer or keep a safe copy.
 */
'use strict';

const CUR = 'GH¢';
const DEFAULT_MODES = ['MoMo', 'Physical Cash'];

/* ---------------- Database ---------------- */
const DB_NAME = 'site-expenditure-tracker';
const STORES = ['sites', 'funds', 'expenses', 'images', 'pow', 'meta'];
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const s of STORES) {
        if (!d.objectStoreNames.contains(s)) {
          const store = d.createObjectStore(s, { keyPath: 'id' });
          if (s !== 'sites' && s !== 'meta') store.createIndex('siteId', 'siteId');
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
const tx = (store, mode = 'readonly') => db.transaction(store, mode).objectStore(store);
const p = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const put = (store, obj) => p(tx(store, 'readwrite').put(obj));
const del = (store, id) => p(tx(store, 'readwrite').delete(id));
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

function qtyText(e) { // all quantities on an entry, e.g. "Cement (bags): 30"
  return Object.entries(e.qty || {}).filter(([, v]) => v).map(([k, v]) => `${qtyField(k)?.label || k}: ${plain(v)}`).join(', ');
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
    }).filter(Boolean).join(', ');
    rows.push({ item: name, quantity: q, amount: es.reduce((t, e) => t + e.amount, 0) });
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
async function seedIfEmpty() {
  if (await get('meta', 'seeded')) return;
  const B = window.BEREKUM_DATA;
  const ber = newSite('Berekum Holy Family Hospital', 'Berekum', B);
  ber.createdAt = Date.now() - 2;
  await put('sites', ber);
  const ids = {};
  let t = Date.now() - 100000;
  for (const f of B.funds) {
    const rec = { id: uid(), siteId: ber.id, code: f.code, date: f.date, receivedFrom: f.receivedFrom, mode: f.mode, amount1: f.amount1, amount2: f.amount2, createdAt: t++ };
    ids[f.code] = rec.id; await put('funds', rec);
  }
  for (const e of B.entries) {
    await put('expenses', { id: uid(), siteId: ber.id, fundId: ids[e.fund], date: e.date, usedFor: e.usedFor, category: e.category, item: e.item, amount: e.amount, qty: e.qty, createdAt: t++ });
  }
  const k = newSite('Komfo Anokye Teaching Hospital', 'Kumasi'); k.createdAt = Date.now() - 1; await put('sites', k);
  await put('sites', newSite('Tamale Teaching Hospital', 'Tamale'));
  await put('meta', { id: 'seeded', value: true });
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
  $('#siteList').innerHTML = html;
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

  const cSel = $('#exCategory'); const cPrev = cSel.value;
  cSel.innerHTML = site.categories.length ? '<option value="">— choose —</option>' + site.categories.map((c) => opt(c)).join('') : '<option value="">Add categories in Settings</option>';
  cSel.value = site.categories.includes(cPrev) ? cPrev : '';
  const iSel = $('#exItem'); const iPrev = iSel.value;
  iSel.innerHTML = site.items.length ? '<option value="">— choose —</option>' + site.items.map((i) => opt(i.name)).join('') : '<option value="">Add items in Settings</option>';
  iSel.value = site.items.some((i) => i.name === iPrev) ? iPrev : '';

  $('#usedForList').innerHTML = [...new Set(entries.map((e) => e.usedFor))].map((d) => `<option value="${esc(d)}">`).join('');
  $('#modeList').innerHTML = site.modes.map((m) => `<option value="${esc(m)}">`).join('');

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

function updateFundMode() {
  const isNew = $('input[name=fundMode]:checked').value === 'new';
  $('#newFundBox').classList.toggle('hidden', !isNew);
  $('#existingFundBox').classList.toggle('hidden', isNew);
  updateFundHint();
}

function updateFundHint() {
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
  const linked = (itemDef($('#exItem').value)?.qty || []).map((q) => q.field);
  const fields = site.qtyFields.filter((f) => showAllQty || linked.includes(f.id) || keep[f.id] !== undefined);
  $('#qtyBox').innerHTML = fields.map((f) => `<label>${esc(f.label)}<input type="number" step="any" min="0" data-q="${f.id}" value="${esc(keep[f.id] ?? '')}"></label>`).join('');
  $('#moreQtyBtn').classList.toggle('hidden', showAllQty || !site.qtyFields.length || fields.length === site.qtyFields.length);
}

async function submitEntry(ev) {
  ev.preventDefault();
  const isNew = $('input[name=fundMode]:checked').value === 'new';
  const amount = num($('#exAmount').value);
  if (!$('#exCategory').value) return toast('Choose a Category');
  if (!$('#exItem').value) return toast('Choose an Item');
  if (amount <= 0) return toast('Enter the Amount');
  let fundId;
  if (isNew) {
    const a1 = num($('#nfAmount1').value), a2 = num($('#nfAmount2').value);
    if (a1 + a2 <= 0) return toast('Enter the amount received for the new fund');
    const code = $('#nfCode').value.trim() || nextFundCode();
    if (funds.some((f) => f.code.toLowerCase() === code.toLowerCase())) return toast(`Fund ID ${code} already exists`);
    const mode = $('#nfMode').value.trim();
    if (mode && !site.modes.includes(mode)) { site.modes.push(mode); await saveSite(); }
    const f = { id: uid(), siteId: site.id, code, date: $('#nfDate').value, receivedFrom: $('#nfFrom').value.trim(), mode, amount1: a1, amount2: a2, createdAt: Date.now() };
    await put('funds', f);
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
  await put('expenses', {
    id: uid(), siteId: site.id, fundId, date: $('#exDate').value, usedFor: $('#exUsedFor').value.trim(),
    category: $('#exCategory').value, item: $('#exItem').value, amount, qty, createdAt: Date.now(),
  });
  $('#exUsedFor').value = ''; $('#exAmount').value = '';
  $('#exCategory').value = ''; $('#exItem').value = '';
  $$('#qtyBox input').forEach((i) => (i.value = ''));
  showAllQty = false;
  ['#nfAmount1', '#nfAmount2', '#nfFrom', '#nfMode'].forEach((s) => ($(s).value = ''));
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
  const cats = [...new Set([...site.categories, e.category])];
  const items = [...new Set([...site.items.map((i) => i.name), e.item])];
  const v = await ask('Edit entry', `
    <label>Fund ID<select name="fundId">${sortedFunds().map((f) => opt(f.id, f.code + (f.receivedFrom ? ' – ' + f.receivedFrom : ''), f.id === e.fundId)).join('')}</select></label>
    <label>Date<input name="date" type="date" value="${e.date || ''}"></label>
    <label>Used For<input name="usedFor" value="${esc(e.usedFor)}"></label>
    <label>Category<select name="category">${cats.map((c) => opt(c, c, c === e.category)).join('')}</select></label>
    <label>Item<select name="item">${items.map((c) => opt(c, c, c === e.item)).join('')}</select></label>
    <label>Amount (${CUR})<input name="amount" type="number" step="0.01" value="${e.amount}"></label>
    <div class="qty-grid">${site.qtyFields.map((f) => `<label>${esc(f.label)}<input name="q_${f.id}" type="number" step="any" min="0" value="${e.qty?.[f.id] ?? ''}"></label>`).join('')}</div>`, { okText: 'Save' });
  if (!v) return;
  const qty = {};
  for (const f of site.qtyFields) if (num(v['q_' + f.id])) qty[f.id] = num(v['q_' + f.id]);
  for (const [k, val] of Object.entries(e.qty || {})) if (!qtyField(k)) qty[k] = val; // keep removed columns' data
  Object.assign(e, { fundId: v.fundId, date: v.date, usedFor: v.usedFor.trim(), category: v.category, item: v.item, amount: num(v.amount), qty });
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

/* ---------------- Owner PIN (images) ---------------- */
async function pinHash() { return (await get('meta', 'pin'))?.value || null; }
async function isOwner() {
  const h = await pinHash(); if (!h) return false;
  try { return localStorage.getItem('ownerKey') === h; } catch { return false; }
}
function rememberOwner(h) { try { localStorage.setItem('ownerKey', h); } catch { /* private window */ } }

async function unlockOwner() {
  const h = await pinHash();
  if (!h) {
    const v = await ask('Set your owner PIN', `<p>Only someone with this PIN can add or remove site images. This computer will remember it.</p>
      <label>New PIN<input name="pin" type="password" inputmode="numeric" required></label>
      <label>Type it again<input name="pin2" type="password" inputmode="numeric" required></label>`, { okText: 'Set PIN' });
    if (!v) return;
    if (v.pin.length < 4) return toast('PIN must be at least 4 characters');
    if (v.pin !== v.pin2) return toast('The two PINs do not match');
    const nh = await sha256('ste:' + v.pin);
    await put('meta', { id: 'pin', value: nh });
    rememberOwner(nh);
    toast('PIN set. Images unlocked on this computer.');
  } else {
    const v = await ask('Enter owner PIN', '<label>PIN<input name="pin" type="password" inputmode="numeric" required></label>', { okText: 'Unlock' });
    if (!v) return;
    if ((await sha256('ste:' + v.pin)) !== h) return toast('Wrong PIN');
    rememberOwner(h);
    toast('Unlocked');
  }
  renderImages();
}
function lockOwner() { try { localStorage.removeItem('ownerKey'); } catch { /* ignore */ } renderImages(); toast('Locked'); }

/* ---------------- Images ---------------- */
let objectUrls = [];
async function renderImages() {
  const owner = await isOwner();
  $('#ownerControls').innerHTML = owner
    ? '<button class="btn" id="editOverview" type="button">Edit overview</button> <button class="btn" id="lockBtn" type="button">Lock</button>'
    : '<span class="muted">View only</span> <button class="btn btn-small" id="unlockBtn" type="button">Owner</button>';
  $('#imageUpload').classList.toggle('hidden', !owner);
  $('#overviewBox').innerHTML = site.overview ? `<p>${esc(site.overview)}</p>` : (owner ? '<p class="muted">No overview yet. Click "Edit overview" to describe the site.</p>' : '');
  objectUrls.forEach(URL.revokeObjectURL); objectUrls = [];
  const imgs = (await bySite('images', site.id)).sort((a, b) => b.createdAt - a.createdAt);
  $('#gallery').innerHTML = imgs.length ? imgs.map((im) => {
    const u = URL.createObjectURL(im.blob); objectUrls.push(u);
    return `<figure><img src="${u}" alt="${esc(im.caption || 'Site image')}" data-full="${u}">
      <figcaption><span>${esc(im.caption || '')} <span class="muted">${fmtDate(im.date)}</span></span>
      ${owner ? `<button class="icon-btn" data-imgdel="${im.id}" title="Remove" type="button">&times;</button>` : ''}</figcaption></figure>`;
  }).join('') : '<p class="muted">No images yet.</p>';
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
  if (!(await isOwner())) return toast('Locked');
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
  const wb = XLSX.read(pow.data, { type: 'array' });
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
  downloadBlob(new Blob([pow.data]), pow.fileName);
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
  const eAoa = [[], ['', 'All Entries'], [], ['', '', '', '', '', 'Total Used', totalUsed()],
    ['No.', 'Fund ID', 'Date', 'Used For', 'Category', 'Item', `Amount (${CUR})`, ...qf.map((q) => q.label)],
    ...entries.map((e, i) => [i + 1, fundCode(e.fundId), fmtDate(e.date), e.usedFor, e.category, e.item, e.amount, ...qf.map((q) => num(e.qty?.[q.id]) || '')])];
  XLSX.utils.book_append_sheet(wb, makeSheet(eAoa, 'A1', [6, 9, 12, 70, 24, 36, 14, ...qf.map((q) => Math.max(12, q.label.length + 2))], [6], 3), sheetName('All Entries', used));
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
  const out = { app: 'site-expenditure-tracker', version: 2, savedAt: new Date().toISOString() };
  for (const s of STORES) out[s] = await all(s);
  out.images = await Promise.all(out.images.map(async (im) => ({ ...im, blob: await blobToDataUrl(im.blob) })));
  out.pow = out.pow.map((pw) => ({ ...pw, data: Array.from(pw.data) }));
  downloadBlob(new Blob([JSON.stringify(out)], { type: 'application/json' }), `Expenditure_Backup_${today()}.json`);
  toast('Backup saved to your Downloads');
}
async function restore(file) {
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('That is not a backup file'); }
  if (data.app !== 'site-expenditure-tracker') return toast('That is not a backup file');
  if (!(await confirmBox('Restore backup', `Replace everything on this computer with the backup from ${new Date(data.savedAt).toLocaleString()}?`, 'Restore'))) return;
  for (const s of STORES) await p(tx(s, 'readwrite').clear());
  for (const s of STORES) {
    for (let rec of data[s] || []) {
      if (s === 'images') rec = { ...rec, blob: await dataUrlToBlob(rec.blob) };
      if (s === 'pow') rec = { ...rec, data: new Uint8Array(rec.data) };
      await put(s, rec);
    }
  }
  await put('meta', { id: 'seeded', value: true });
  toast('Backup restored');
  showHome();
}

/* ---------------- Tabs & events ---------------- */
function switchTab(name) {
  if (!$('#tab-' + name)) name = 'entries';
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
  $('#restoreInput').onchange = (e) => { if (e.target.files[0]) restore(e.target.files[0]); e.target.value = ''; };
  $$('.tab').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));

  // Entry form
  $$('input[name=fundMode]').forEach((r) => (r.onchange = updateFundMode));
  ['#fundSelect', '#exAmount', '#nfAmount1', '#nfAmount2'].forEach((s) => $(s).addEventListener('input', updateFundHint));
  $('#fundSelect').addEventListener('change', updateFundHint);
  $('#exItem').addEventListener('change', renderQtyInputs);
  $('#moreQtyBtn').onclick = () => { showAllQty = true; renderQtyInputs(); };
  $('#entryForm').onsubmit = submitEntry;
  // Typing a "Used For" used before fills in its Category and Item
  $('#exUsedFor').addEventListener('change', () => {
    const v = $('#exUsedFor').value.trim().toLowerCase();
    const last = [...entries].reverse().find((e) => e.usedFor.toLowerCase() === v);
    if (!last) return;
    if (site.categories.includes(last.category)) $('#exCategory').value = last.category;
    if (itemDef(last.item)) { $('#exItem').value = last.item; renderQtyInputs(); }
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
    if (t.id === 'unlockBtn') unlockOwner();
    if (t.id === 'lockBtn') lockOwner();
    if (t.id === 'editOverview' && await isOwner()) {
      const v = await ask('Site overview', `<label>Overview<textarea name="overview" rows="7" style="font:inherit;padding:8px;border:1px solid var(--line);border-radius:4px">${esc(site.overview || '')}</textarea></label>`, { okText: 'Save' });
      if (v) { site.overview = v.overview.trim(); await saveSite(); renderImages(); }
    }
    if (t.dataset.imgdel && await isOwner() && await confirmBox('Remove image', 'Remove this image?', 'Remove')) { await del('images', t.dataset.imgdel); renderImages(); }
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
  await seedIfEmpty();
  bind();
  const m = location.hash.match(/site=([\w]+)/);
  if (m) openSite(m[1]); else showHome();
})();
