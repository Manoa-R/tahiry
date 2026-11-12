// Interface Tahiry : vues rendues depuis la base locale, jamais depuis le réseau.
import { store } from './store.js';
import {
  syncNow, startSync, syncState, onSyncState, registerDevice, loginOnline, verifyShopKey, useAdminKey, hasSession,
  listDevices, revokeDevice, defaultDeviceLabel, isNative, normalizeServerUrl,
} from './sync.js';
import {
  newId, computeStock, stockAt, stockTotal, saleTotals, buildSale, buildCancellation,
  buildTransfer, buildInventory, averageCosts, costOf, buildPurchase, salesReport,
  ROLES, SELLER_ROUTES, makeCredentials, checkPin, validatePin, assertKeepsManager,
  buildInvoice, buildCreditNote, buildQuote, quoteStatus, nextDocNumber, QUOTE_DAYS, findByCode, round3,
} from './domain.js';
import { openScanner } from './scanner.js';

// --- Rendu : toute valeur interpolée est échappée, y compris les données synchronisées.
class Safe { constructor(s) { this.s = s; } toString() { return this.s; } }
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const fmtVal = (v) => (v instanceof Safe ? v.s : Array.isArray(v) ? v.map(fmtVal).join('')
  : v === null || v === undefined || v === false ? '' : esc(v));
const html = (strings, ...vals) => new Safe(strings.reduce((out, s, i) => out + fmtVal(vals[i - 1]) + s));

const $ = (sel) => document.querySelector(sel);
const num = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 3 });
const ar = (n) => `${num.format(Math.round(n))} Ar`;
const dt = (ms) => new Date(ms).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });

const icon = (d) => new Safe(`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${d}"/></svg>`);
const ROUTES = {
  dashboard: ['Tableau de bord', 'M3 13h8V3H3zM13 21h8V11h-8zM13 3v4h8V3zM3 21h8v-4H3z'],
  pos: ['Caisse', 'M4 7h16v13H4zM8 7V4h8v3M8 12h8M8 16h3'],
  scan: ['Scanner', 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 8v8M10 8v8M13 8v8M17 8v8'],
  articles: ['Articles', 'M3 8l9-5 9 5v8l-9 5-9-5zM3 8l9 5 9-5M12 13v8'],
  movements: ['Mouvements', 'M7 4v15M7 19l-4-4M7 19l4-4M17 20V5M17 5l-4 4M17 5l4 4'],
  purchases: ['Achats', 'M3 4h2l2 11h11l2-8H6M9 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2M17 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2'],
  inventory: ['Inventaire', 'M9 4h6v3H9zM6 5h3M15 5h3v16H6V5M9 12l2 2 4-4'],
  sales: ['Ventes', 'M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6'],
  reports: ['Rapports', 'M4 20V10M10 20V4M16 20v-7M22 20H2'],
  partners: ['Partenaires', 'M16 19c0-3-2-5-5-5s-5 2-5 5M11 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M17 11a3 3 0 0 0 0-6M21 19c0-2-1-4-3-4.500'],
  settings: ['Réglages', 'M4 6h10M18 6h2M4 12h2M10 12h10M4 18h8M16 18h4M14 4h4v4h-4zM6 10h4v4H6zM12 16h4v4h-4z'],
};

const state = { cart: new Map(), discount: 0, payment: 'Espèces', partnerId: '', posQuery: '', articleQuery: '', counts: {}, installEvent: null, reportPeriod: 'd7', devices: null, scanned: null, salesTab: 'ventes', quoteId: null };
let renderPending = false;

const route = () => { const r = location.hash.slice(1); return ROUTES[r] ? r : 'dashboard'; };
const articles = () => store.list('articles').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
const depots = () => store.list('depots').sort((a, b) => a.name.localeCompare(b.name, 'fr'));
const partners = (kind) => store.list('partners').filter((p) => !kind || p.kind === kind).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
const stock = () => computeStock(store.list('movements'));
const costs = () => averageCosts(store.list('movements'));
// --- Utilisateurs : sans aucun compte actif, l'application reste ouverte (mode boutique seule).
const SESSION_KEY = 'tahiry-user';
const session = {
  get() { try { return sessionStorage.getItem(SESSION_KEY); } catch { return null; } },
  set(id) { try { if (id) sessionStorage.setItem(SESSION_KEY, id); else sessionStorage.removeItem(SESSION_KEY); } catch { /* navigation privée */ } },
};
let currentUserId = session.get();
let recovery = false;
const activeUsers = () => store.list('users').filter((u) => u.active !== false).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
const usersEnabled = () => activeUsers().length > 0;
function currentUser() {
  if (recovery) return { id: null, name: 'Récupération gérant', role: 'gerant' };
  const u = store.get('users', currentUserId);
  return u && u.active !== false ? u : null;
}
const isManager = () => !usersEnabled() || currentUser()?.role === 'gerant';
const isLocked = () => usersEnabled() && !currentUser();
const allowedRoute = (r) => isManager() || SELLER_ROUTES.has(r);
const MANAGER_ACTIONS = new Set([
  'demo', 'articleNew', 'articleEdit', 'articleDelete', 'partnerNew', 'partnerEdit', 'partnerDelete', 'depotNew', 'depotEdit',
  'moveNew', 'transferNew', 'inventorySave', 'saleCancel', 'purchaseNew', 'userNew', 'userEdit', 'userToggle', 'exportReport',
  'devicesLoad', 'deviceRevoke', 'shopEdit',
  'scanInventory', 'scanPurchase', 'scanCreate', 'scanAssign', 'scanEntry', 'creditIssue',
]);
const LOCKED_ACTIONS = new Set(['pickUser', 'forgotPin', 'lockBack', 'sync']);
const seller = () => currentUser()?.name || store.meta.seller || 'Appareil';
const currentDepot = () => {
  const d = store.meta.depotId;
  if (store.get('depots', d)) return d;
  return store.get('depots', 'depot-principal') ? 'depot-principal' : depots()[0]?.id;
};
const rawName = (c, id) => store.data[c].get(id)?.data.name ?? '—';
const options = (list, selected) => list.map((o) => html`<option value="${o.id}" ${selected === o.id ? new Safe('selected') : ''}>${o.name}</option>`);
const depotSelect = (act) => html`<select aria-label="Dépôt" data-change="${act}">${options(depots(), currentDepot())}</select>`;

// --- Formulaire générique en boîte de dialogue
function openForm({ title, fields, values = {}, submit = 'Enregistrer', onSubmit }) {
  const dlg = $('#dlg');
  const control = (f) => {
    const v = values[f.name] ?? f.value ?? '';
    if (f.type === 'select') {
      return html`<select name="${f.name}" ${f.required ? new Safe('required') : ''}>
        ${f.options.map((o) => html`<option value="${o.value}" ${String(v) === String(o.value) ? new Safe('selected') : ''}>${o.label}</option>`)}</select>`;
    }
    return html`<input name="${f.name}" type="${f.type ?? 'text'}" value="${v}" ${f.required ? new Safe('required') : ''}
      ${f.type === 'number' ? new Safe(`step="any" min="${f.min ?? 0}"`) : ''} autocomplete="off">`;
  };
  dlg.innerHTML = html`<form method="dialog"><h2>${title}</h2>
    ${fields.map((f) => (f.scan
      ? html`<div class="field"><span>${f.label}</span><div class="with-btn">${control(f)}<button class="btn" type="button" data-act="scanField" data-field="${f.name}" aria-label="Scanner le code">${icon(SCAN_ICON)}</button></div></div>`
      : html`<label class="field"><span>${f.label}</span>${control(f)}</label>`))}
    <p class="error" hidden></p>
    <div class="row"><button class="btn" type="button" data-act="closeDlg">Annuler</button>
    <button class="btn primary" type="submit">${submit}</button></div></form>`;
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = {};
    for (const f of fields) {
      const raw = e.target.elements[f.name].value.trim();
      out[f.name] = f.type === 'number' ? (raw === '' ? (f.optional ? null : 0) : Number(raw)) : raw;
    }
    try {
      await onSubmit(out);
      dlg.close();
      render();
    } catch (err) {
      const box = dlg.querySelector('.error');
      box.textContent = err.message;
      box.hidden = false;
    }
  });
  dlg.showModal();
}

// --- Vues
const views = {
  dashboard() {
    const st = stock();
    const list = articles();
    const cmp = costs();
    const value = list.reduce((s, a) => s + Math.max(0, stockTotal(st, a.id)) * costOf(cmp, a), 0);
    const today = new Date().setHours(0, 0, 0, 0);
    const todaySales = store.list('sales').filter((s) => s.at >= today && !s.cancelled);
    const low = list.filter((a) => { const q = stockTotal(st, a.id); return q >= 0 && q <= (a.min || 0); });
    const negative = [];
    for (const a of list) for (const d of depots()) {
      const q = stockAt(st, a.id, d.id);
      if (q < 0) negative.push({ a, d, q });
    }
    const recent = store.list('movements').sort((a, b) => b.at - a.at).slice(0, 8);
    if (!list.length) {
      return html`<div class="card empty"><p>Aucun article pour le moment.</p>
        <div class="row" style="justify-content:center">
        <a class="btn primary" href="#articles" style="text-decoration:none">Créer un article</a>
        <button class="btn" data-act="demo">Charger des données de démo</button></div></div>`;
    }
    return html`<div class="kpis">
      <div class="card kpi"><div class="label">Ventes du jour</div><div class="value">${ar(todaySales.reduce((s, v) => s + v.total, 0))}</div><div class="muted small">${todaySales.length} ticket(s)</div></div>
      <div class="card kpi"><div class="label">Valeur du stock (au coût)</div><div class="value">${ar(value)}</div><div class="muted small">${list.length} article(s)</div></div>
      <div class="card kpi"><div class="label">À réapprovisionner</div><div class="value ${low.length ? 'alert' : ''}">${low.length}</div><div class="muted small">sous le seuil minimum</div></div>
      <div class="card kpi"><div class="label">Écarts à vérifier</div><div class="value ${negative.length ? 'alert' : ''}">${negative.length}</div><div class="muted small">stock négatif après synchro</div></div>
    </div>
    <div class="columns">
      <section class="card"><h2>Réapprovisionnement</h2>${[...negative.map(({ a, d, q }) => html`<div class="totals"><span>${a.name} <span class="muted small">· ${d.name}</span></span><span class="badge danger">${num.format(q)}</span></div>`),
        ...low.slice(0, 10).map((a) => html`<div class="totals"><span>${a.name}</span><span class="badge warn">${num.format(stockTotal(st, a.id))} / min ${num.format(a.min || 0)}</span></div>`)]}
        ${!low.length && !negative.length ? html`<p class="muted">Aucune alerte.</p>` : ''}</section>
      <section class="card"><h2>Derniers mouvements</h2>${recent.map((m) => html`<div class="totals"><span>${rawName('articles', m.articleId)} <span class="muted small">· ${m.type}</span></span><span class="num">${m.qty > 0 ? '+' : ''}${num.format(m.qty)}</span></div>`)}</section>
    </div>`;
  },

  pos() {
    return html`<div class="pos"><div>
      <div class="toolbar"><input class="grow" id="pos-search" data-filter="pos" placeholder="Rechercher ou scanner un code-barres" value="${state.posQuery}" autocomplete="off">
        <button class="btn" data-act="scanPos">${icon(SCAN_ICON)} Scanner</button>${depotSelect('setDepot')}</div>
      <div class="products" id="pos-list">${posList()}</div></div>
      <aside class="card cart" id="cart">${cartView()}</aside></div>`;
  },

  scan() {
    const a = state.scanned && byCode(state.scanned.code);
    const st = stock();
    const card = !state.scanned ? html`<div class="card empty">Scannez un article pour voir son prix et son stock dans chaque dépôt.</div>`
      : !a ? html`<div class="card"><h2>Code inconnu</h2><p class="mono">${state.scanned.code}</p>
          <p class="muted small">Aucun article ne porte ce code.</p>
          ${isManager() ? html`<div class="row" style="justify-content:flex-start"><button class="btn primary" data-act="scanCreate">Créer l’article avec ce code</button>
            <button class="btn" data-act="scanAssign">Attribuer à un article existant</button></div>` : ''}</div>`
      : html`<div class="card scan-card"><div class="totals"><h2>${a.name}</h2><span class="value">${ar(a.price || 0)}</span></div>
          <p class="muted small">${[a.category, a.code, a.unit].filter(Boolean).join(' · ')}</p>
          <table><thead><tr><th>Dépôt</th><th class="num">Stock</th></tr></thead><tbody>
          ${depots().map((d) => html`<tr><td>${d.name}</td><td class="num">${num.format(stockAt(st, a.id, d.id))} ${a.unit}</td></tr>`)}
          <tr><td><strong>Total</strong></td><td class="num"><strong>${num.format(stockTotal(st, a.id))} ${a.unit}</strong></td></tr></tbody></table>
          ${isManager() ? html`<p class="muted small">Coût moyen : ${ar(costOf(costs(), a))}${a.min ? ` · seuil minimum ${num.format(a.min)}` : ''}</p>` : ''}
          <div class="row" style="justify-content:flex-start"><button class="btn primary" data-act="scanToCart" data-id="${a.id}">Ajouter au panier</button>
          ${isManager() ? html`<button class="btn" data-act="scanEntry" data-id="${a.id}">Entrée de stock</button><button class="btn" data-act="articleEdit" data-id="${a.id}">Modifier</button>` : ''}</div></div>`;
    return html`<div class="scan-page"><button class="btn primary scan-big" data-act="scanLookup">${icon(SCAN_ICON)} Scanner un article</button>
      <form id="scan-lookup" class="toolbar"><input class="grow" name="code" placeholder="Ou saisir / douchette : code-barres" autocomplete="off"><button class="btn" type="submit">Chercher</button></form>
      ${card}</div>`;
  },

  articles() {
    return html`<div class="toolbar"><input class="grow" data-filter="articles" placeholder="Rechercher un article" value="${state.articleQuery}" autocomplete="off">
      <button class="btn" data-act="scanArticle">${icon(SCAN_ICON)} Scanner</button>
      <button class="btn primary" data-act="articleNew">Nouvel article</button>
      <button class="btn" data-act="exportCsv">Exporter CSV</button></div>
      <div id="articles-list">${articlesTable()}</div>`;
  },

  movements() {
    const rows = store.list('movements').sort((a, b) => b.at - a.at).slice(0, 200);
    const noArticle = !articles().length;
    return html`<div class="toolbar">
      <button class="btn primary" data-act="moveNew" data-kind="entree" ${noArticle ? new Safe('disabled') : ''}>Entrée</button>
      <button class="btn" data-act="moveNew" data-kind="sortie" ${noArticle ? new Safe('disabled') : ''}>Sortie</button>
      <button class="btn" data-act="transferNew" ${noArticle || depots().length < 2 ? new Safe('disabled') : ''}>Transfert</button></div>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>Article</th><th>Dépôt</th><th>Type</th><th class="num">Quantité</th><th>Référence</th><th>Par</th></tr></thead><tbody>
      ${rows.map((m) => html`<tr><td class="small">${dt(m.at)}</td><td>${rawName('articles', m.articleId)}</td><td>${rawName('depots', m.depotId)}</td><td><span class="badge">${m.type}</span></td><td class="num">${m.qty > 0 ? '+' : ''}${num.format(m.qty)}</td><td class="small">${m.ref || m.note}</td><td class="small">${m.by}</td></tr>`)}
      </tbody></table></div>` : html`<div class="card empty">Aucun mouvement enregistré.</div>`}`;
  },

  purchases() {
    const rows = store.list('purchases').sort((a, b) => b.at - a.at).slice(0, 200);
    return html`<div class="toolbar"><button class="btn primary" data-act="purchaseNew" ${articles().length ? '' : new Safe('disabled')}>Nouvelle réception</button>
      <span class="muted small">Chaque réception met à jour le stock et le coût moyen pondéré.</span></div>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>N°</th><th>Fournisseur</th><th>Dépôt</th><th class="num">Lignes</th><th class="num">Total</th><th></th></tr></thead><tbody>
      ${rows.map((p) => html`<tr><td class="small">${dt(p.at)}</td><td class="small">${p.number}</td><td>${p.partnerId ? rawName('partners', p.partnerId) : '—'}</td><td>${rawName('depots', p.depotId)}</td>
        <td class="num">${p.lines.length}</td><td class="num">${ar(p.total)}</td><td class="actions"><button class="btn small" data-act="purchaseShow" data-id="${p.id}">Détail</button></td></tr>`)}
      </tbody></table></div>` : html`<div class="card empty">Aucune réception enregistrée.</div>`}`;
  },

  inventory() {
    const st = stock();
    const depot = currentDepot();
    const list = articles();
    return html`<div class="toolbar">${depotSelect('setDepotInv')}<span class="grow muted small">Saisissez les quantités comptées, ou scannez chaque pièce. Les lignes vides sont ignorées.</span>
      <button class="btn" data-act="scanInventory" ${list.length ? '' : new Safe('disabled')}>${icon(SCAN_ICON)} Compter au scanner</button>
      <button class="btn primary" data-act="inventorySave" ${list.length ? '' : new Safe('disabled')}>Valider l’inventaire</button></div>
      ${list.length ? html`<div class="table-wrap"><table><thead><tr><th>Article</th><th class="num">Théorique</th><th style="width:130px">Compté</th><th class="num">Écart</th></tr></thead><tbody>
      ${list.map((a) => { const q = stockAt(st, a.id, depot); return html`<tr><td>${a.name}</td><td class="num">${num.format(q)}</td><td><input type="number" step="any" min="0" inputmode="decimal" aria-label="Quantité comptée de ${a.name}" data-count="${a.id}" data-theory="${q}" value="${state.counts[a.id] ?? ''}"></td><td class="num" id="gap-${a.id}">${gapText(a.id, q)}</td></tr>`; })}
      </tbody></table></div>` : html`<div class="card empty">Créez d’abord des articles.</div>`}`;
  },

  reports() {
    const r = currentReport();
    const pct = (part, total) => (total ? Math.round((part / total) * 100) : 0);
    const bars = (entries) => entries.map(([label, value]) => html`<div class="bar-row"><span>${label}</span><span class="num">${ar(value)}</span>
      <div class="bar"><div style="width:${pct(value, r.revenue)}%"></div></div></div>`);
    return html`<div class="toolbar"><select aria-label="Période" data-change="setPeriod">${Object.entries(PERIODS).map(([k, label]) => html`<option value="${k}" ${k === state.reportPeriod ? new Safe('selected') : ''}>${label}</option>`)}</select>
      <span class="grow"></span><button class="btn" data-act="exportReport" ${r.count ? '' : new Safe('disabled')}>Exporter CSV</button></div>
      <div class="kpis">
        <div class="card kpi"><div class="label">Chiffre d’affaires</div><div class="value">${ar(r.revenue)}</div><div class="muted small">dont ${ar(r.discount)} de remises</div></div>
        <div class="card kpi"><div class="label">Tickets</div><div class="value">${r.count}</div><div class="muted small">panier moyen ${ar(r.average)}</div></div>
        <div class="card kpi"><div class="label">Marge brute</div><div class="value">${ar(r.margin)}</div><div class="muted small">taux ${pct(r.margin, r.revenue)} %</div></div>
        <div class="card kpi"><div class="label">Coût des ventes</div><div class="value">${ar(r.cost)}</div><div class="muted small">au coût moyen du jour de vente</div></div>
      </div>
      ${r.uncosted ? html`<p class="muted small">${r.uncosted} ligne(s) de vente sans coût enregistré (ventes antérieures à cette version) : leur marge est surestimée.</p>` : ''}
      ${r.count ? html`<div class="columns">
        <section class="card"><h2>Par mode de paiement</h2>${bars(r.byPayment)}</section>
        <section class="card"><h2>Par vendeur</h2>${bars(r.bySeller)}</section></div>
        <h2 style="margin-top:16px">Articles vendus</h2>
        <div class="table-wrap"><table><thead><tr><th>Article</th><th class="num">Qté</th><th class="num">CA</th><th class="num">Marge</th><th class="num">Taux</th></tr></thead><tbody>
        ${r.articles.map((a) => html`<tr><td>${store.get('articles', a.articleId)?.name ?? a.name}</td><td class="num">${num.format(a.qty)}</td><td class="num">${ar(a.revenue)}</td>
          <td class="num ${a.margin < 0 ? 'neg' : ''}">${ar(a.margin)}</td><td class="num">${pct(a.margin, a.revenue)} %</td></tr>`)}
        </tbody></table></div>` : html`<div class="card empty">Aucune vente sur cette période.</div>`}`;
  },

  sales() {
    const tabs = html`<div class="toolbar tabs">${[['ventes', 'Ventes'], ['devis', 'Devis']].map(([k, label]) => html`<button class="btn ${state.salesTab === k ? 'primary' : ''}" data-act="salesTab" data-tab="${k}">${label}</button>`)}</div>`;
    if (state.salesTab === 'devis') return html`${tabs}${quotesTable()}`;
    const rows = store.list('sales').sort((a, b) => b.at - a.at).slice(0, 200);
    if (!rows.length) return html`${tabs}<div class="card empty">Aucune vente enregistrée.</div>`;
    return html`${tabs}<div class="table-wrap"><table><thead><tr><th>Date</th><th>N°</th><th>Paiement</th><th>Vendeur</th><th class="num">Total</th><th></th></tr></thead><tbody>
      ${rows.map((s) => html`<tr><td class="small">${dt(s.at)}</td><td class="small">${s.number}</td><td>${s.payment}</td><td class="small">${s.by}</td>
        <td class="num">${ar(s.total)} ${s.cancelled ? html`<span class="badge danger">annulée</span>` : ''}</td>
        <td class="actions"><button class="btn small" data-act="ticket" data-id="${s.id}">Ticket</button>
        ${invoiceOf(s.id) || !s.cancelled ? html`<button class="btn small" data-act="invoice" data-id="${s.id}">${invoiceOf(s.id)?.number ?? 'Facture'}</button>` : ''}
        ${creditOf(s.id) ? html`<button class="btn small" data-act="creditShow" data-id="${s.id}">${creditOf(s.id).number}</button>` : ''}
        ${s.cancelled ? '' : html`<button class="btn small danger" data-act="saleCancel" data-id="${s.id}">Annuler</button>`}</td></tr>`)}
      </tbody></table></div>`;
  },

  partners() {
    const rows = partners();
    return html`<div class="toolbar"><button class="btn primary" data-act="partnerNew">Nouveau partenaire</button></div>
      ${rows.length ? html`<div class="table-wrap"><table><thead><tr><th>Nom</th><th>Type</th><th>Téléphone</th><th></th></tr></thead><tbody>
      ${rows.map((p) => html`<tr><td>${p.name}</td><td><span class="badge">${p.kind === 'client' ? 'Client' : 'Fournisseur'}</span></td><td>${p.phone}</td>
        <td class="actions"><button class="btn small" data-act="partnerEdit" data-id="${p.id}">Modifier</button>
        <button class="btn small danger" data-act="partnerDelete" data-id="${p.id}">Supprimer</button></td></tr>`)}
      </tbody></table></div>` : html`<div class="card empty">Aucun client ni fournisseur.</div>`}`;
  },

  settings() {
    const m = store.meta;
    return html`<div class="settings">
      <section class="card"><h2>Synchronisation</h2><form id="sync-form">
        <label class="field"><span>Nom du vendeur sur cet appareil</span><input name="seller" value="${m.seller ?? ''}" autocomplete="off"></label>
        <label class="field"><span>Nom de cet appareil (visible par le gérant)</span><input name="deviceLabel" value="${m.deviceLabel ?? ''}" placeholder="${defaultDeviceLabel()}" maxlength="60" autocomplete="off"></label>
        <label class="field"><span>${isNative ? 'Adresse du serveur de la boutique' : 'Adresse du serveur (vide = ce site)'}</span><input name="serverUrl" inputmode="url" value="${m.serverUrl ?? ''}" placeholder="${isNative ? 'http://192.168.1.10:8787' : location.origin}" autocomplete="off" ${isNative ? 'required' : ''}></label>
        <label class="field"><span>${m.deviceToken ? 'Clé boutique (pour réenregistrer l’appareil)' : 'Clé boutique'}</span><input name="token" type="password" autocomplete="off" placeholder="${m.deviceToken || m.token ? 'Enregistrée — laisser vide pour conserver' : 'Clé affichée par le serveur'}"></label>
        <p class="muted small">${m.deviceToken ? 'Appareil enregistré : la clé boutique n’est pas conservée.' : m.token ? 'Clé boutique conservée (aucun utilisateur pour l’instant).' : 'Appareil non relié à un serveur.'}</p>
        <div class="row"><button class="btn primary" type="submit">Enregistrer et synchroniser</button></div></form>
        <p class="muted small">En attente d’envoi : <span id="pending-count">${store.outboxCount}</span> · Appareil ${m.deviceId}</p></section>
      <section class="card"><h2>Utilisateurs</h2>
        ${usersEnabled() ? '' : html`<p class="muted small">Aucun utilisateur : l’application est ouverte à tous. Créez un gérant pour activer les codes PIN et les rôles.</p>`}
        ${store.list('users').sort((a, b) => a.name.localeCompare(b.name, 'fr')).map((u) => html`<div class="totals"><span>${u.name} <span class="badge">${ROLES[u.role]}</span>
          ${u.active === false ? html`<span class="badge danger">désactivé</span>` : ''}</span>
          <span><button class="btn small" data-act="userEdit" data-id="${u.id}">Modifier</button>
          <button class="btn small ${u.active === false ? '' : 'danger'}" data-act="userToggle" data-id="${u.id}">${u.active === false ? 'Réactiver' : 'Désactiver'}</button></span></div>`)}
        <div class="row"><button class="btn" data-act="userNew">${usersEnabled() ? 'Ajouter un utilisateur' : 'Créer le premier gérant'}</button></div>
        <p class="muted small">Les codes PIN contrôlent l’accès entre collègues ; ils ne chiffrent pas les données de l’appareil.</p></section>
      ${(m.deviceToken || m.token) && usersEnabled() ? devicesSection() : ''}
      ${shopSection()}
      <section class="card"><h2>Dépôts</h2>${depots().map((d) => html`<div class="totals"><span>${d.name}</span><button class="btn small" data-act="depotEdit" data-id="${d.id}">Renommer</button></div>`)}
        <div class="row"><button class="btn" data-act="depotNew">Ajouter un dépôt</button></div></section>
      <section class="card"><h2>Application</h2><div class="row" style="justify-content:flex-start">
        ${state.installEvent ? html`<button class="btn primary" data-act="install">Installer l’application</button>` : ''}
        <button class="btn" data-act="demo">Charger des données de démo</button></div></section></div>`;
  },
};

function posList() {
  const q = state.posQuery.toLowerCase();
  const st = stock();
  const depot = currentDepot();
  const list = articles().filter((a) => !q || a.name.toLowerCase().includes(q) || (a.code || '').toLowerCase().includes(q)).slice(0, 60);
  if (!list.length) return html`<div class="empty">Aucun article trouvé.</div>`;
  return list.map((a) => html`<button class="product" data-act="cartAdd" data-id="${a.id}"><strong>${a.name}</strong>
    <span class="num">${ar(a.price || 0)}</span><br><span class="muted small">Stock : ${num.format(stockAt(st, a.id, depot))} ${a.unit}</span></button>`);
}

function cartView() {
  const lines = [...state.cart.values()];
  const st = stock();
  const depot = currentDepot();
  const totals = saleTotals(lines, state.discount);
  const pay = ['Espèces', 'MVola', 'Orange Money', 'Airtel Money', 'Carte', 'Chèque'];
  return html`<h2>Panier</h2>
    ${lines.length ? lines.map((l) => html`<div class="cart-line"><div>${l.name}<div class="muted small">${ar(l.price)}</div>
      ${l.qty > stockAt(st, l.articleId, depot) ? html`<div class="short">Stock insuffisant</div>` : ''}</div>
      <input type="number" step="any" min="0" inputmode="decimal" aria-label="Quantité de ${l.name}" data-cart="${l.articleId}" value="${l.qty}">
      <button class="btn small" data-act="cartRemove" data-id="${l.articleId}" aria-label="Retirer ${l.name}">×</button></div>`) : html`<p class="muted">Touchez un article pour l’ajouter.</p>`}
    <div class="stack">
      <label class="field"><span>Remise (Ar)</span><input type="number" min="0" step="1" inputmode="numeric" id="discount" value="${state.discount || ''}"></label>
      <label class="field"><span>Paiement</span><select id="payment">${pay.map((p) => html`<option ${p === state.payment ? new Safe('selected') : ''}>${p}</option>`)}</select></label>
      <label class="field"><span>Client (facultatif)</span><select id="partner"><option value="">Client de passage</option>${options(partners('client'), state.partnerId)}</select></label>
    </div>
    <div class="totals"><span class="muted">Sous-total</span><span class="num">${ar(totals.subtotal)}</span></div>
    <div class="totals grand"><span>Total</span><span class="num" id="cart-total">${ar(totals.total)}</span></div>
    ${state.quoteId ? html`<p class="muted small">Depuis le devis ${store.get('quotes', state.quoteId)?.number ?? ''} · <button class="link" data-act="quoteDetach">détacher</button></p>` : ''}
    <div class="cart-actions"><button class="btn" data-act="quoteNew" ${lines.length ? '' : new Safe('disabled')}>Devis</button>
    <button class="btn primary" data-act="checkout" ${lines.length ? '' : new Safe('disabled')}>Encaisser</button></div>`;
}

function articlesTable() {
  const q = state.articleQuery.toLowerCase();
  const st = stock();
  const list = articles().filter((a) => !q || a.name.toLowerCase().includes(q) || (a.code || '').toLowerCase().includes(q) || (a.category || '').toLowerCase().includes(q));
  if (!list.length) return html`<div class="card empty">Aucun article.</div>`;
  return html`<div class="table-wrap"><table><thead><tr><th>Article</th><th>Catégorie</th><th>Code</th><th class="num">Coût</th><th class="num">Prix</th><th class="num">Stock</th><th></th></tr></thead><tbody>
    ${list.map((a) => { const q2 = stockTotal(st, a.id); return html`<tr><td>${a.name}</td><td>${a.category}</td><td class="small">${a.code}</td><td class="num">${ar(a.cost || 0)}</td><td class="num">${ar(a.price || 0)}</td>
      <td class="num">${num.format(q2)} ${a.unit} ${q2 <= (a.min || 0) ? html`<span class="badge warn">bas</span>` : ''}</td>
      <td class="actions"><button class="btn small" data-act="articleEdit" data-id="${a.id}">Modifier</button>
      <button class="btn small danger" data-act="articleDelete" data-id="${a.id}">Supprimer</button></td></tr>`; })}
    </tbody></table></div>`;
}

function gapText(id, theory) {
  const v = state.counts[id];
  if (v === undefined || v === '') return '';
  const gap = Math.round((Number(v) - theory) * 1000) / 1000;
  return `${gap > 0 ? '+' : ''}${num.format(gap)}`;
}

// --- Rendu général
function render() {
  renderPending = false;
  document.body.classList.toggle('locked', isLocked());
  renderChip();
  if (isLocked()) { $('#user-chip').hidden = true; renderLock(); return; }
  const r = allowedRoute(route()) ? route() : 'dashboard';
  $('#title').textContent = ROUTES[r][0];
  $('#nav').innerHTML = html`<div class="brand">Tahiry</div>${Object.entries(ROUTES).filter(([k]) => allowedRoute(k)).map(([k, [label, d]]) => html`<a href="#${k}" ${k === r ? new Safe('aria-current="page"') : ''}>${icon(d)}<span>${label}</span></a>`)}`;
  $('#view').innerHTML = views[r]();
  // Le vendeur ne voit pas les boutons réservés au gérant (le clic est aussi refusé).
  if (!isManager()) document.querySelectorAll('main [data-act]').forEach((el) => { if (MANAGER_ACTIONS.has(el.dataset.act)) el.remove(); });
  const user = currentUser();
  const chip = $('#user-chip');
  chip.hidden = !user;
  if (user) chip.innerHTML = html`${user.name} · ${ROLES[user.role]} · <u>Verrouiller</u>`;
}

// --- Écran de verrouillage
const lock = { userId: null, failures: 0, blockedUntil: 0, forgot: false };

function renderLock() {
  $('#title').textContent = 'Connexion';
  $('#nav').innerHTML = html`<div class="brand">Tahiry</div>`;
  const user = store.get('users', lock.userId);
  if (lock.forgot) {
    $('#view').innerHTML = html`<form class="card lock" id="recovery-form"><h2>PIN oublié</h2>
      <p class="muted small">Saisissez la clé de synchronisation de la boutique pour ouvrir une session gérant temporaire, puis redéfinissez le PIN dans Réglages.</p>
      <label class="field"><span>Clé de synchronisation</span><input name="key" type="password" autocomplete="off" required></label>
      <p class="error" hidden></p>
      <div class="row"><button class="btn" type="button" data-act="lockBack">Retour</button><button class="btn primary" type="submit">Déverrouiller</button></div></form>`;
    return;
  }
  if (!user) {
    $('#view').innerHTML = html`<div class="card lock"><h2>Qui êtes-vous ?</h2><div class="user-grid">
      ${activeUsers().map((u) => html`<button class="btn user-btn" data-act="pickUser" data-id="${u.id}"><strong>${u.name}</strong><span class="muted small">${ROLES[u.role]}</span></button>`)}</div>
      <div class="row"><button class="btn small" data-act="forgotPin">PIN oublié ?</button></div></div>`;
    return;
  }
  $('#view').innerHTML = html`<form class="card lock" id="pin-form"><h2>${user.name}</h2>
    <label class="field"><span>Code PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="off" required autofocus></label>
    <p class="error" hidden></p>
    <div class="row"><button class="btn" type="button" data-act="lockBack">Changer d’utilisateur</button><button class="btn primary" type="submit">Entrer</button></div></form>`;
  $('#pin-form input').focus();
}

function lockError(form, message) {
  const box = form.querySelector('.error');
  box.textContent = message;
  box.hidden = false;
}

async function submitPin(form) {
  const wait = Math.ceil((lock.blockedUntil - Date.now()) / 1000);
  if (wait > 0) return lockError(form, `Trop d’essais. Réessayez dans ${wait} s.`);
  const user = store.get('users', lock.userId);
  try {
    const pin = form.elements.pin.value;
    if (await checkPin(user, pin)) {
      Object.assign(lock, { userId: null, failures: 0, blockedUntil: 0 });
      currentUserId = user.id;
      session.set(user.id);
      render();
      // En ligne : ouvre la session serveur qui autorise l'envoi de ses modifications.
      loginOnline(user.id, pin);
      return undefined;
    }
  } catch (err) {
    return lockError(form, err.message);
  }
  lock.failures += 1;
  form.elements.pin.value = '';
  // Au-delà de 4 erreurs, attente croissante : 30 s, 60 s, 90 s…
  if (lock.failures >= 5) lock.blockedUntil = Date.now() + (lock.failures - 4) * 30_000;
  return lockError(form, 'Code PIN incorrect');
}

function lockNow() {
  currentUserId = null;
  recovery = false;
  useAdminKey(null);
  session.set(null);
  if ($('#dlg').open) $('#dlg').close();
  Object.assign(state, { cart: new Map(), discount: 0 });
  render();
}

// Verrouillage automatique après 15 minutes sans activité.
let idleTimer = null;
const IDLE_MS = 15 * 60_000;
function resetIdle() {
  clearTimeout(idleTimer);
  if (usersEnabled() && currentUser()) idleTimer = setTimeout(lockNow, IDLE_MS);
}
['pointerdown', 'keydown'].forEach((evt) => addEventListener(evt, resetIdle, { passive: true }));

// --- Gestion des utilisateurs (gérant)
function userForm(u = null) {
  const first = !usersEnabled();
  openForm({
    title: u ? 'Modifier l’utilisateur' : first ? 'Créer le premier gérant' : 'Nouvel utilisateur',
    values: u ? { name: u.name, role: u.role } : { role: first ? 'gerant' : 'vendeur' },
    fields: [
      { name: 'name', label: 'Nom', required: true },
      { name: 'role', label: 'Rôle', type: 'select', options: (first ? ['gerant'] : Object.keys(ROLES)).map((k) => ({ value: k, label: ROLES[k] })) },
      { name: 'pin', label: u ? 'Nouveau code PIN (vide = inchangé)' : 'Code PIN (4 à 8 chiffres)', type: 'password', required: !u },
      { name: 'pin2', label: 'Confirmer le code PIN', type: 'password', required: !u },
    ],
    onSubmit: async (v) => {
      if (v.pin !== v.pin2) throw new Error('Les deux codes PIN ne correspondent pas');
      if (v.pin || !u) validatePin(v.pin);
      const id = u?.id ?? newId();
      const { id: _ignored, ...previous } = u ?? {};
      const next = { ...previous, name: v.name, role: v.role, active: true };
      assertKeepsManager(store.list('users'), id, next);
      if (v.pin) Object.assign(next, await makeCredentials(v.pin));
      await store.save('users', id, next);
      if (first) {
        currentUserId = id;
        session.set(id);
        // Envoie le gérant au serveur (clé boutique), puis ouvre sa session.
        await syncNow();
        await loginOnline(id, v.pin);
      }
    },
  });
}

// --- Appareils reliés au serveur (gérant, en ligne)
function devicesSection() {
  const d = state.devices;
  const ago = (ms) => (ms ? dt(ms) : 'jamais');
  return html`<section class="card" id="devices"><h2>Appareils</h2>
    ${!d ? html`<p class="muted small">Liste des appareils reliés au serveur, pour révoquer un téléphone perdu ou volé.</p>` : ''}
    ${d?.error ? html`<p class="error">${d.error}</p>` : ''}
    ${d?.list ? html`<div class="table-wrap"><table><thead><tr><th>Appareil</th><th>Enregistré</th><th>Dernière activité</th><th></th></tr></thead><tbody>
      ${d.list.map((x) => html`<tr><td>${x.label} ${x.id === d.current ? html`<span class="badge ok">cet appareil</span>` : ''}</td>
        <td class="small">${dt(x.created)}</td><td class="small">${ago(x.lastSeen)}</td>
        <td class="actions">${x.revoked ? html`<span class="badge danger">révoqué</span>` : html`<button class="btn small danger" data-act="deviceRevoke" data-id="${x.id}">Révoquer</button>`}</td></tr>`)}
      </tbody></table></div>` : ''}
    <div class="row"><button class="btn" data-act="devicesLoad">${d?.list ? 'Actualiser' : 'Afficher les appareils'}</button></div></section>`;
}

async function loadDevices() {
  try {
    const { devices, current } = await listDevices();
    state.devices = { list: devices, current };
  } catch (err) {
    state.devices = { error: err.status === 403 ? 'Réservé au gérant connecté en ligne : verrouillez puis ressaisissez votre PIN.' : err.message };
  }
  if (route() === 'settings') render();
}

async function toggleUser({ id }) {
  const { id: _ignored, ...u } = store.get('users', id);
  const next = { ...u, active: u.active === false };
  assertKeepsManager(store.list('users'), id, next);
  if (!next.active && !confirm(`Désactiver ${u.name} ? Il ne pourra plus se connecter.`)) return;
  await store.save('users', id, next);
  if (!next.active && id === currentUserId) lockNow(); else render();
}

// Une synchro en arrière-plan ne doit pas effacer une saisie en cours.
function safeRender() {
  const active = document.activeElement;
  if ($('#dlg').open || (active && active.matches('main input, main select, main textarea'))) {
    renderPending = true;
    return;
  }
  render();
}

function renderChip() {
  const n = store.outboxCount;
  const pending = n ? ` · ${n} en attente` : '';
  const labels = {
    idle: ['', 'Prêt'], syncing: ['warn', 'Synchronisation…'], ok: ['ok', 'Synchronisé'],
    offline: ['warn', 'Hors ligne'], unconfigured: ['', 'Local uniquement'], error: ['err', syncState.message],
  };
  const [cls, text] = labels[syncState.status];
  const user = currentUser();
  const needsLogin = syncState.held > 0 && user?.id && !hasSession(user.id);
  $('#sync-chip').innerHTML = html`<span class="dot ${needsLogin ? 'warn' : cls}"></span>${needsLogin ? 'Reconnexion requise' : text}${pending}`;
  $('#sync-chip').title = needsLogin
    ? 'Vos modifications attendent une connexion en ligne : touchez pour saisir votre PIN'
    : syncState.lastSync ? `Dernière synchro : ${syncState.lastSync.toLocaleTimeString('fr-FR')}` : 'Synchroniser maintenant';
  if (syncState.rejected.length) {
    const reasons = [...new Set(syncState.rejected.map((r) => r.reason))].join(', ');
    alert(`${syncState.rejected.length} modification(s) refusée(s) par le serveur et annulée(s) sur cet appareil : ${reasons}.`);
    syncState.rejected = [];
  }
  const count = $('#pending-count');
  if (count) count.textContent = n;
}

// --- Métier côté interface
function articleForm(a = {}) {
  openForm({
    title: a.id ? 'Modifier l’article' : 'Nouvel article',
    values: { unit: 'pièce', ...a },
    fields: [
      { name: 'name', label: 'Désignation', required: true },
      { name: 'category', label: 'Catégorie' },
      { name: 'code', label: 'Code-barres ou référence', scan: true },
      { name: 'unit', label: 'Unité' },
      { name: 'cost', label: 'Coût d’achat (Ar)', type: 'number' },
      { name: 'price', label: 'Prix de vente (Ar)', type: 'number' },
      { name: 'min', label: 'Seuil minimum', type: 'number' },
    ],
    onSubmit: (v) => store.save('articles', a.id ?? newId(), v),
  });
  $('#dlg').dataset.articleId = a.id ?? '';
}

function partnerForm(p = {}) {
  openForm({
    title: p.id ? 'Modifier le partenaire' : 'Nouveau partenaire',
    values: p,
    fields: [
      { name: 'name', label: 'Nom', required: true },
      { name: 'kind', label: 'Type', type: 'select', options: [{ value: 'client', label: 'Client' }, { value: 'fournisseur', label: 'Fournisseur' }] },
      { name: 'phone', label: 'Téléphone', type: 'tel' },
      { name: 'address', label: 'Adresse (facultatif)' },
      { name: 'nif', label: 'NIF (facultatif)' },
      { name: 'stat', label: 'STAT (facultatif)' },
    ],
    onSubmit: (v) => store.save('partners', p.id ?? newId(), v),
  });
}

function depotForm(d = {}) {
  openForm({
    title: d.id ? 'Renommer le dépôt' : 'Nouveau dépôt',
    values: d,
    fields: [{ name: 'name', label: 'Nom', required: true }],
    onSubmit: (v) => store.save('depots', d.id ?? newId(), v),
  });
}

const articleOptions = () => articles().map((a) => ({ value: a.id, label: a.name }));
const depotOptions = () => depots().map((d) => ({ value: d.id, label: d.name }));
const positive = (qty) => { if (!(qty > 0)) throw new Error('La quantité doit être supérieure à zéro'); };

// Numéro unique hors ligne : préfixe, date, appareil, compteur local de l'appareil.
function docNumber(prefix, collection) {
  const tag = store.meta.deviceId.slice(0, 4).toUpperCase();
  const d = new Date();
  const day = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const n = store.list(collection).filter((s) => s.number.includes(`-${tag}-`)).length + 1;
  return `${prefix}${day}-${tag}-${n}`;
}
const saleNumber = () => docNumber('V', 'sales');

// --- Réception fournisseur multi-lignes
function purchaseForm() {
  state.purchase = { partnerId: '', depotId: currentDepot(), note: '', lines: [{ articleId: '', qty: '', cost: '' }] };
  renderPurchaseForm();
  $('#dlg').showModal();
}

function purchaseTotal() {
  return Math.round(state.purchase.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.cost) || 0), 0));
}

function renderPurchaseForm() {
  const p = state.purchase;
  const list = articles();
  $('#dlg').innerHTML = html`<form id="purchase-form" class="wide"><h2>Réception fournisseur</h2>
    <label class="field"><span>Fournisseur</span><select data-pf="partnerId"><option value="">—</option>${options(partners('fournisseur'), p.partnerId)}</select></label>
    <label class="field"><span>Dépôt de réception</span><select data-pf="depotId">${options(depots(), p.depotId)}</select></label>
    <div class="table-wrap"><table><thead><tr><th>Article</th><th style="width:90px">Qté</th><th style="width:110px">Coût unit.</th><th></th></tr></thead><tbody>
    ${p.lines.map((l, i) => html`<tr>
      <td><select aria-label="Article ligne ${i + 1}" data-pl="${i}:articleId"><option value="">Choisir…</option>${options(list, l.articleId)}</select></td>
      <td><input aria-label="Quantité ligne ${i + 1}" type="number" step="any" min="0" inputmode="decimal" data-pl="${i}:qty" value="${l.qty}"></td>
      <td><input aria-label="Coût ligne ${i + 1}" type="number" step="any" min="0" inputmode="decimal" data-pl="${i}:cost" value="${l.cost}"></td>
      <td><button class="btn small" type="button" data-act="purchaseRemoveLine" data-i="${i}" aria-label="Retirer la ligne ${i + 1}">×</button></td></tr>`)}
    </tbody></table></div>
    <div class="row" style="justify-content:space-between"><span><button class="btn" type="button" data-act="purchaseAddLine">Ajouter une ligne</button>
      <button class="btn" type="button" data-act="scanPurchase">${icon(SCAN_ICON)} Scanner</button></span>
      <strong>Total : <span id="purchase-total">${ar(purchaseTotal())}</span></strong></div>
    <label class="field"><span>Référence (bon de livraison, facture…)</span><input data-pf="note" value="${p.note}" autocomplete="off"></label>
    <p class="error" hidden></p>
    <div class="row"><button class="btn" type="button" data-act="closeDlg">Annuler</button><button class="btn primary" type="submit">Réceptionner</button></div></form>`;
}

function showPurchase(p) {
  $('#dlg').innerHTML = html`<h2>Réception ${p.number}</h2>
    <p class="muted small">${dt(p.at)} · ${p.partnerId ? rawName('partners', p.partnerId) : 'Sans fournisseur'} · ${rawName('depots', p.depotId)} · ${p.by}</p>
    <div class="table-wrap"><table><thead><tr><th>Article</th><th class="num">Qté</th><th class="num">Coût</th><th class="num">Montant</th></tr></thead><tbody>
    ${p.lines.map((l) => html`<tr><td>${rawName('articles', l.articleId)}</td><td class="num">${num.format(l.qty)}</td><td class="num">${ar(l.cost)}</td><td class="num">${ar(l.qty * l.cost)}</td></tr>`)}
    </tbody></table></div>
    <div class="totals grand"><span>Total</span><span class="num">${ar(p.total)}</span></div>
    ${p.note ? html`<p class="muted small">Réf. : ${p.note}</p>` : ''}
    <div class="row"><button class="btn" data-act="closeDlg">Fermer</button></div>`;
  $('#dlg').showModal();
}

function showTicket(sale) {
  const dlg = $('#dlg');
  dlg.innerHTML = html`<div id="ticket" class="ticket"><div class="center"><strong>Tahiry</strong><br>${sale.number}<br>${dt(sale.at)}</div><hr>
    ${sale.lines.map((l) => html`<div class="line"><span>${num.format(l.qty)} × ${l.name}</span><span>${ar(l.price * l.qty)}</span></div>`)}<hr>
    ${sale.discount ? html`<div class="line"><span>Remise</span><span>-${ar(sale.discount)}</span></div>` : ''}
    <div class="line"><strong>TOTAL</strong><strong>${ar(sale.total)}</strong></div>
    <div class="line"><span>Paiement</span><span>${sale.payment}</span></div>
    <div class="line"><span>Vendeur</span><span>${sale.by}</span></div>
    ${sale.cancelled ? html`<p class="center"><strong>VENTE ANNULÉE</strong></p>` : ''}</div>
    <div class="row"><button class="btn" data-act="closeDlg">Fermer</button>
    ${sale.cancelled || !sale.id ? '' : html`<button class="btn" data-act="invoice" data-id="${sale.id}">Facture</button>`}
    <button class="btn primary" data-act="print">Imprimer</button></div>`;
  dlg.showModal();
}

// --- Factures
const shopProfile = () => store.get('settings', 'shop') ?? {};
const invoiceOf = (saleId) => store.get('invoices', `${saleId}:f`);
const creditOf = (saleId) => store.get('invoices', `${saleId}:av`);
const withoutId = ({ id, ...rest }) => rest;
// Séries par appareil, année et type de document : FA, AV, DV.
const nextNumber = (prefix, collection) => nextDocNumber(store.list(collection).map((d) => d.number), prefix, store.meta.deviceId.slice(0, 4).toUpperCase(), new Date().getFullYear());
const creditNoteFor = (invoice) => buildCreditNote({ number: nextNumber('AV', 'invoices'), invoice, reason: `Annulation de la vente ${invoice.saleNumber}`, by: seller(), at: Date.now() });

function quotesTable() {
  const rows = store.list('quotes').sort((a, b) => b.at - a.at).slice(0, 200);
  if (!rows.length) return html`<div class="card empty">Aucun devis. Remplissez le panier de la caisse puis touchez « Devis ».</div>`;
  const badge = { 'en cours': '', expiré: 'warn', transformé: 'ok' };
  return html`<div class="table-wrap"><table><thead><tr><th>Date</th><th>N°</th><th>Client</th><th>Valable jusqu’au</th><th class="num">Total</th><th></th></tr></thead><tbody>
    ${rows.map((q) => { const st = quoteStatus(q); return html`<tr><td class="small">${dt(q.at)}</td><td class="small">${q.number}</td><td>${q.client.name}</td>
      <td class="small">${new Date(q.validUntil).toLocaleDateString('fr-FR')}</td>
      <td class="num">${ar(q.total)} <span class="badge ${badge[st]}">${st}${q.saleNumber ? ` · ${q.saleNumber}` : ''}</span></td>
      <td class="actions"><button class="btn small" data-act="quoteShow" data-id="${q.id}">Voir</button>
      ${q.saleId ? '' : html`<button class="btn small primary" data-act="quoteToSale" data-id="${q.id}">Encaisser</button>`}</td></tr>`; })}
    </tbody></table></div>`;
}

function quoteForm() {
  const lines = [...state.cart.values()].filter((l) => l.qty > 0);
  if (!lines.length) return;
  const dlg = $('#dlg');
  dlg.innerHTML = html`<form id="quote-form"><h2>Devis</h2>
    <label class="field"><span>Client enregistré</span><select name="partnerId"><option value="">—</option>${options(partners('client'), state.partnerId)}</select></label>
    <label class="field"><span>Ou nom du client</span><input name="clientName" autocomplete="off" placeholder="Client de passage"></label>
    <label class="field"><span>Validité (jours)</span><input name="days" type="number" min="1" step="1" value="${QUOTE_DAYS}"></label>
    <p class="muted small">Total ${ar(saleTotals(lines, state.discount).total)}. Le devis fige les prix ; il ne touche pas au stock.</p>
    <div class="row"><button class="btn" type="button" data-act="closeDlg">Annuler</button><button class="btn primary" type="submit">Établir le devis</button></div></form>`;
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const partner = f.partnerId.value ? store.get('partners', f.partnerId.value) : null;
    const client = partner ?? (f.clientName.value.trim() ? { name: f.clientName.value.trim() } : null);
    const quote = buildQuote({
      number: nextNumber('DV', 'quotes'), lines, discount: state.discount, client, partnerId: partner?.id, shop: shopProfile(),
      by: seller(), userId: currentUser()?.id ?? null, at: Date.now(), days: Math.max(1, Number(f.days.value) || QUOTE_DAYS),
    });
    const quoteId = newId();
    await store.write([{ c: 'quotes', id: quoteId, data: quote }]);
    Object.assign(state, { cart: new Map(), discount: 0, partnerId: '', quoteId: null });
    render();
    showDocument({ ...quote, id: quoteId, kind: 'devis' });
  });
  dlg.showModal();
}
const fiscalIds = (o) => [o.nif && `NIF : ${o.nif}`, o.stat && `STAT : ${o.stat}`, o.rcs && `RCS : ${o.rcs}`].filter(Boolean).join(' · ');

function shopSection() {
  const shop = shopProfile();
  return html`<section class="card"><h2>Fiche boutique</h2>
    ${shop.name ? html`<p><strong>${shop.name}</strong><br><span class="muted small">${[shop.address, fiscalIds(shop)].filter(Boolean).join(' · ')}</span></p>`
      : html`<p class="muted small">Raison sociale, adresse, NIF et STAT : ils apparaissent en tête des factures.</p>`}
    <p class="muted small">TVA : ${shop.vat ? 'assujetti, 20 % incluse dans les prix' : 'non assujetti'}</p>
    <div class="row"><button class="btn" data-act="shopEdit">Modifier la fiche boutique</button></div></section>`;
}

function shopForm() {
  const shop = shopProfile();
  openForm({
    title: 'Fiche boutique',
    values: { ...shop, vat: shop.vat ? 'oui' : 'non' },
    fields: [
      { name: 'name', label: 'Raison sociale', required: true },
      { name: 'address', label: 'Adresse' },
      { name: 'phone', label: 'Téléphone', type: 'tel' },
      { name: 'nif', label: 'NIF' },
      { name: 'stat', label: 'STAT' },
      { name: 'rcs', label: 'RCS (facultatif)' },
      { name: 'vat', label: 'TVA', type: 'select', options: [{ value: 'non', label: 'Non assujetti' }, { value: 'oui', label: 'Assujetti — TVA 20 % incluse dans les prix' }] },
      { name: 'footer', label: 'Mention en bas de facture (facultatif)' },
    ],
    onSubmit: (v) => store.save('settings', 'shop', { ...v, vat: v.vat === 'oui' }),
  });
}

// Émettre une facture : on choisit le client, puis la facture est figée et numérotée.
function invoiceForm(saleId) {
  const existing = invoiceOf(saleId);
  if (existing) return showDocument(existing);
  const sale = store.get('sales', saleId);
  // Vente issue d'un devis : on reprend le client saisi sur le devis.
  const quote = sale?.quoteId ? store.get('quotes', sale.quoteId) : null;
  const quoteClient = quote && !quote.partnerId && quote.client.name !== 'Client de passage' ? quote.client.name : '';
  if (!sale || sale.cancelled) return;
  if (usersEnabled() && !isManager() && sale.userId !== currentUser()?.id) {
    alert('Seuls le gérant et la personne qui a fait la vente peuvent la facturer.');
    return;
  }
  const dlg = $('#dlg');
  dlg.innerHTML = html`<form id="invoice-form"><h2>Facturer la vente ${sale.number}</h2>
    ${shopProfile().name ? '' : html`<p class="error">La fiche boutique est vide : le gérant peut la remplir dans Réglages.</p>`}
    <label class="field"><span>Client enregistré</span><select name="partnerId"><option value="">—</option>${options(partners('client'), sale.partnerId)}</select></label>
    <label class="field"><span>Ou nom du client</span><input name="clientName" autocomplete="off" placeholder="Client de passage" value="${quoteClient}"></label>
    <p class="muted small">Total ${ar(sale.total)}. Une fois émise, la facture ne peut plus être modifiée.</p>
    <div class="row"><button class="btn" type="button" data-act="closeDlg">Annuler</button><button class="btn primary" type="submit">Émettre la facture</button></div></form>`;
  dlg.querySelector('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const partner = f.partnerId.value ? store.get('partners', f.partnerId.value) : null;
    const client = partner ?? (f.clientName.value.trim() ? { name: f.clientName.value.trim() } : null);
    const number = nextNumber('FA', 'invoices');
    const invoice = buildInvoice({ number, saleId, sale, client, shop: shopProfile(), by: seller(), at: Date.now() });
    await store.write([{ c: 'invoices', id: `${saleId}:f`, data: invoice }]);
    showDocument(invoice);
  });
  if (!dlg.open) dlg.showModal();
}

const DOC = {
  facture: { title: 'FACTURE', to: 'Facturé à', stop: 'Arrêtée la présente facture' },
  avoir: { title: 'AVOIR', to: 'Client', stop: 'Arrêté le présent avoir' },
  devis: { title: 'DEVIS', to: 'Client', stop: 'Arrêté le présent devis' },
};

// Facture, avoir ou devis : même mise en page A4, imprimable ou enregistrable en PDF.
function showDocument(doc) {
  if (!doc) return;
  const kind = doc.kind ?? 'facture';
  const { shop, client } = doc;
  const day = (ms) => new Date(ms).toLocaleDateString('fr-FR');
  const sale = doc.saleId ? store.get('sales', doc.saleId) : null;
  const credit = kind === 'facture' && doc.saleId ? creditOf(doc.saleId) : null;
  const banner = kind === 'facture' && sale?.cancelled
    ? (credit ? html`<p class="muted small">Facture annulée par l’avoir ${credit.number}.</p>`
      : html`<p class="error">Vente annulée après facturation : émettez l’avoir correspondant.
        ${isManager() ? html`<button class="btn small" data-act="creditIssue" data-id="${doc.saleId}">Émettre l’avoir</button>` : ''}</p>`)
    : kind === 'devis' ? html`<p class="muted small">Statut : ${quoteStatus(doc)}${doc.saleNumber ? ` (vente ${doc.saleNumber})` : ''}</p>` : '';
  const ref = kind === 'facture' ? `Vente ${doc.saleNumber}` : kind === 'avoir' ? `Annule la facture N° ${doc.invoiceNumber}` : `Valable jusqu’au ${day(doc.validUntil)}`;
  const dlg = $('#dlg');
  dlg.innerHTML = html`${banner}
  <div id="invoice" class="invoice wide">
    <header class="inv-head">
      <div><strong class="inv-shop">${shop.name || 'Boutique'}</strong>${shop.address ? html`<br>${shop.address}` : ''}${shop.phone ? html`<br>Tél. ${shop.phone}` : ''}
        ${fiscalIds(shop) ? html`<br><span class="small">${fiscalIds(shop)}</span>` : ''}</div>
      <div class="inv-title"><strong>${DOC[kind].title}</strong><br>N° ${doc.number}<br>Date : ${day(doc.at)}<br><span class="small">${ref}</span></div>
    </header>
    <div class="inv-client"><span class="small muted">${DOC[kind].to}</span><br><strong>${client.name}</strong>${client.address ? html`<br>${client.address}` : ''}${client.phone ? html`<br>Tél. ${client.phone}` : ''}
      ${fiscalIds(client) ? html`<br><span class="small">${fiscalIds(client)}</span>` : ''}</div>
    <table><thead><tr><th>Désignation</th><th class="num">Qté</th><th class="num">Prix unitaire</th><th class="num">Montant</th></tr></thead><tbody>
      ${doc.lines.map((l) => html`<tr><td>${l.name}</td><td class="num">${num.format(l.qty)}</td><td class="num">${ar(l.price)}</td><td class="num">${ar(l.price * l.qty)}</td></tr>`)}
    </tbody></table>
    <div class="inv-totals">
      ${doc.discount ? html`<div class="totals"><span>Sous-total</span><span class="num">${ar(doc.subtotal)}</span></div><div class="totals"><span>Remise</span><span class="num">-${ar(doc.discount)}</span></div>` : ''}
      ${doc.vat ? html`<div class="totals"><span>Total HT</span><span class="num">${ar(doc.vat.base)}</span></div><div class="totals"><span>TVA ${doc.vat.rate * 100} %</span><span class="num">${ar(doc.vat.amount)}</span></div>` : ''}
      <div class="totals grand"><span>${kind === 'avoir' ? 'Montant de l’avoir' : doc.vat ? 'Total TTC' : 'Total'}</span><span class="num">${ar(doc.total)}</span></div>
    </div>
    <p>${DOC[kind].stop} à la somme de : <strong>${doc.words[0].toUpperCase() + doc.words.slice(1)}</strong>.</p>
    <p class="small">${kind === 'facture' ? `Règlement : ${doc.payment}` : kind === 'avoir' ? `Motif : ${doc.reason}` : 'Prix fermes jusqu’à la date de validité.'}${doc.vat ? '' : ' · TVA non applicable'}</p>
    ${shop.footer ? html`<p class="small muted">${shop.footer}</p>` : ''}
  </div>
  <div class="row"><button class="btn" data-act="closeDlg">Fermer</button>
    ${kind === 'devis' && !doc.saleId ? html`<button class="btn" data-act="quoteToSale" data-id="${doc.id}">Encaisser ce devis</button>` : ''}
    <button class="btn primary" data-act="print">Imprimer / PDF</button></div>`;
  if (!dlg.open) dlg.showModal();
}


async function loadDemo() {
  const items = [
    ['riz', 'Riz Makalioka 1 kg', 'Épicerie', '6200000000015', 'kg', 3200, 4000, 20, 120],
    ['huile', 'Huile 1 L', 'Épicerie', '6200000000022', 'bouteille', 8500, 10500, 10, 40],
    ['sucre', 'Sucre 1 kg', 'Épicerie', '6200000000039', 'kg', 4200, 5200, 10, 8],
    ['savon', 'Savon de ménage', 'Hygiène', '6200000000046', 'pièce', 1500, 2200, 15, 60],
    ['eau', 'Eau minérale 1,5 L', 'Boissons', '6200000000053', 'bouteille', 2200, 3000, 24, 96],
    ['cahier', 'Cahier 100 pages', 'Papeterie', '6200000000060', 'pièce', 1800, 2800, 12, 30],
  ];
  const now = Date.now();
  await store.write([
    { c: 'depots', id: 'demo-tana', data: { name: 'Boutique Analakely' } },
    { c: 'partners', id: 'demo-c1', data: { name: 'Épicerie Soa', kind: 'client', phone: '034 00 000 01' } },
    { c: 'partners', id: 'demo-f1', data: { name: 'Grossiste Mahajanga', kind: 'fournisseur', phone: '032 00 000 02' } },
    ...items.map(([id, name, category, code, unit, cost, price, min]) => ({ c: 'articles', id: `demo-${id}`, data: { name, category, code, unit, cost, price, min } })),
    ...items.map(([id, , , , , cost, , , qty]) => ({ c: 'movements', id: `demo-init-${id}`, data: { articleId: `demo-${id}`, depotId: 'depot-principal', qty, cost, type: 'entree', ref: 'Stock initial', note: '', by: 'Démo', at: now } })),
  ]);
  render();
  syncNow();
}

function downloadCsv(filename, rows) {
  // Texte commençant par = + - @ : préfixé pour qu'un tableur ne l'exécute pas comme formule.
  // Les nombres restent des nombres (un stock négatif n'est pas une formule).
  const cell = (v) => {
    if (typeof v === 'number') return String(v).replace('.', ',');
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const blob = new Blob(['﻿' + rows.map((r) => r.map(cell).join(';')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}

function exportCsv() {
  const st = stock();
  const cmp = costs();
  const rows = [['Article', 'Catégorie', 'Code', 'Coût moyen', 'Prix', ...depots().map((d) => d.name), 'Total']];
  for (const a of articles()) rows.push([a.name, a.category, a.code, costOf(cmp, a), a.price || 0, ...depots().map((d) => stockAt(st, a.id, d.id)), stockTotal(st, a.id)]);
  downloadCsv('stock-tahiry.csv', rows);
}

const PERIODS = { today: 'Aujourd’hui', d7: '7 derniers jours', d30: '30 derniers jours', month: 'Ce mois', all: 'Tout' };
function periodRange(key) {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  if (key === 'today') return { from: +start };
  if (key === 'd7') return { from: +start - 6 * 864e5 };
  if (key === 'd30') return { from: +start - 29 * 864e5 };
  if (key === 'month') return { from: +new Date(start.getFullYear(), start.getMonth(), 1) };
  return {};
}
const currentReport = () => salesReport(store.list('sales'), periodRange(state.reportPeriod));

function exportReportCsv() {
  const r = currentReport();
  downloadCsv(`ventes-${state.reportPeriod}.csv`, [
    ['Article', 'Quantité', 'Chiffre d’affaires', 'Marge'],
    ...r.articles.map((a) => [rawName('articles', a.articleId) === '—' ? a.name : rawName('articles', a.articleId), a.qty, a.revenue, a.margin]),
  ]);
}

function addToCart(a) {
  const line = state.cart.get(a.id);
  if (line) line.qty += 1;
  else state.cart.set(a.id, { articleId: a.id, name: a.name, price: a.price || 0, qty: 1 });
  const cart = $('#cart');
  if (cart) cart.innerHTML = cartView();
}

// --- Scan
const SCAN_ICON = 'M4 8V4h4M16 4h4v4M20 16v4h-4M8 20H4v-4M7 8v8M10 8v8M13 8v8M17 8v8';
const byCode = (code) => findByCode(store.list('articles'), code);
const unknown = (code) => ({ ok: false, message: `Code ${code} : aucun article` });

function lookupCode(code) {
  state.scanned = { code };
  if (route() !== 'scan') location.hash = '#scan';
  else render();
}

function scanPurchaseCode(code) {
  const a = byCode(code);
  if (!a) return unknown(code);
  const p = state.purchase;
  const line = p.lines.find((l) => l.articleId === a.id) ?? p.lines.find((l) => !l.articleId);
  const cost = costOf(costs(), a) || '';
  if (line) Object.assign(line, { articleId: a.id, qty: (Number(line.qty) || 0) + 1, cost: line.cost === '' ? cost : line.cost });
  else p.lines.push({ articleId: a.id, qty: 1, cost });
  renderPurchaseForm();
  return { ok: true, message: `${a.name} : ${num.format((line ?? p.lines.at(-1)).qty)} reçu(s)` };
}

const actions = {
  scanLookup: () => openScanner({ title: 'Scanner un article', onCode: (code) => { const a = byCode(code); lookupCode(code); return a ? { ok: true, message: a.name } : unknown(code); } }),
  scanPos: () => openScanner({
    title: 'Caisse — scanner les articles', continuous: true, hint: 'Chaque lecture ajoute une unité au panier.',
    onCode: (code) => {
      const a = byCode(code);
      if (!a) return unknown(code);
      addToCart(a);
      return { ok: true, message: `${a.name} — ${num.format(state.cart.get(a.id).qty)} au panier · total ${ar(saleTotals([...state.cart.values()], state.discount).total)}` };
    },
  }),
  scanInventory: () => openScanner({
    title: `Inventaire — ${rawName('depots', currentDepot())}`, continuous: true, hint: 'Chaque lecture compte une unité de plus.',
    onCode: (code) => {
      const a = byCode(code);
      if (!a) return unknown(code);
      const n = round3((Number(state.counts[a.id]) || 0) + 1);
      state.counts[a.id] = String(n);
      const input = document.querySelector(`[data-count="${CSS.escape(a.id)}"]`);
      if (input) { input.value = n; $(`#gap-${CSS.escape(a.id)}`).textContent = gapText(a.id, Number(input.dataset.theory)); }
      return { ok: true, message: `${a.name} : ${num.format(n)} compté(s)` };
    },
  }),
  scanPurchase: () => openScanner({ title: 'Réception — scanner les articles', continuous: true, hint: 'Chaque lecture ajoute une unité reçue.', onCode: scanPurchaseCode }),
  scanArticle: () => openScanner({
    title: 'Scanner un article',
    onCode: (code) => {
      const a = byCode(code);
      if (a) setTimeout(() => (isManager() ? articleForm(a) : lookupCode(code)));
      else if (isManager()) setTimeout(() => articleForm({ code }));
      else return unknown(code);
      return { ok: true, message: a ? a.name : 'Nouvel article' };
    },
  }),
  scanField: ({ field }) => openScanner({
    title: 'Scanner le code',
    onCode: (code) => {
      const input = $('#dlg form').elements[field];
      input.value = code;
      const other = byCode(code);
      return other && other.id !== $('#dlg').dataset.articleId
        ? { ok: false, message: `Attention : ce code est déjà celui de « ${other.name} »` }
        : { ok: true, message: code };
    },
  }),
  scanToCart: ({ id }) => { const a = store.get('articles', id); if (!a) return; addToCart(a); location.hash = '#pos'; },
  scanCreate: () => articleForm({ code: state.scanned.code }),
  scanAssign: () => openForm({
    title: 'Attribuer le code',
    fields: [{ name: 'articleId', label: `Article qui portera le code ${state.scanned.code}`, type: 'select', options: articleOptions() }],
    onSubmit: async ({ articleId }) => {
      const a = store.get('articles', articleId);
      const { id, ...data } = a;
      await store.save('articles', id, { ...data, code: state.scanned.code });
    },
  }),
  scanEntry: ({ id }) => actions.moveNew({ kind: 'entree', articleId: id }),
  // Modifications en attente d'une session : on redemande le PIN pour l'ouvrir.
  sync: () => {
    const user = currentUser();
    if (syncState.held > 0 && user?.id && !hasSession(user.id) && navigator.onLine) { lockNow(); lock.userId = user.id; renderLock(); return; }
    syncNow();
  },
  lock: lockNow,
  pickUser: ({ id }) => { lock.userId = id; renderLock(); },
  lockBack: () => { Object.assign(lock, { userId: null, forgot: false }); renderLock(); },
  forgotPin: () => { lock.forgot = true; renderLock(); },
  userNew: () => userForm(),
  userEdit: ({ id }) => userForm(store.get('users', id)),
  userToggle: (d) => toggleUser(d).catch((err) => alert(err.message)),
  devicesLoad: loadDevices,
  deviceRevoke: async ({ id }) => {
    const d = state.devices?.list.find((x) => x.id === id);
    const self = id === state.devices?.current;
    if (!confirm(self
      ? 'Révoquer CET appareil ? Il ne pourra plus synchroniser avant d’être réenregistré avec la clé boutique.'
      : `Révoquer « ${d?.label ?? 'cet appareil'} » ? Il perdra l’accès au serveur et toutes ses sessions.`)) return;
    try {
      await revokeDevice(id);
      if (self) await syncNow();
      await loadDevices();
    } catch (err) {
      alert(err.message);
    }
  },
  closeDlg: () => $('#dlg').close(),
  print: () => {
    const page = $('#invoice') ? Object.assign(document.createElement('style'), { textContent: '@page { margin: 14mm; }' }) : null;
    if (page) document.head.append(page);
    window.print();
    page?.remove();
  },
  demo: loadDemo,
  exportCsv,
  exportReport: exportReportCsv,
  install: async () => { await state.installEvent?.prompt(); state.installEvent = null; render(); },
  articleNew: () => articleForm(),
  articleEdit: ({ id }) => articleForm(store.get('articles', id)),
  articleDelete: async ({ id }) => { if (confirm('Supprimer cet article ? Son historique de mouvements est conservé.')) { await store.remove('articles', id); render(); } },
  partnerNew: () => partnerForm(),
  partnerEdit: ({ id }) => partnerForm(store.get('partners', id)),
  partnerDelete: async ({ id }) => { if (confirm('Supprimer ce partenaire ?')) { await store.remove('partners', id); render(); } },
  depotNew: () => depotForm(),
  depotEdit: ({ id }) => depotForm(store.get('depots', id)),
  moveNew: ({ kind, articleId = '' }) => openForm({
    title: kind === 'entree' ? 'Entrée de stock' : 'Sortie de stock',
    values: { depotId: currentDepot(), articleId },
    fields: [
      { name: 'articleId', label: 'Article', type: 'select', options: articleOptions(), required: true },
      { name: 'depotId', label: 'Dépôt', type: 'select', options: depotOptions(), required: true },
      { name: 'qty', label: 'Quantité', type: 'number', required: true },
      ...(kind === 'entree' ? [
        { name: 'cost', label: 'Coût unitaire (Ar, facultatif)', type: 'number', optional: true },
        { name: 'partnerId', label: 'Fournisseur', type: 'select', options: [{ value: '', label: '—' }, ...partners('fournisseur').map((p) => ({ value: p.id, label: p.name }))] },
      ] : []),
      { name: 'note', label: 'Motif ou référence' },
    ],
    onSubmit: (v) => {
      positive(v.qty);
      const { cost, ...rest } = v;
      return store.save('movements', newId(), {
        ...rest, ...(kind === 'entree' && cost !== null ? { cost } : {}),
        qty: kind === 'entree' ? v.qty : -v.qty, type: kind, ref: v.partnerId ? rawName('partners', v.partnerId) : '', by: seller(), at: Date.now(),
      });
    },
  }),
  transferNew: () => openForm({
    title: 'Transfert entre dépôts',
    fields: [
      { name: 'articleId', label: 'Article', type: 'select', options: articleOptions(), required: true },
      { name: 'fromDepot', label: 'Depuis', type: 'select', options: depotOptions(), required: true },
      { name: 'toDepot', label: 'Vers', type: 'select', options: depotOptions(), required: true },
      { name: 'qty', label: 'Quantité', type: 'number', required: true },
      { name: 'note', label: 'Motif' },
    ],
    onSubmit: (v) => {
      positive(v.qty);
      return store.write(buildTransfer({ id: newId(), ...v, by: seller(), at: Date.now() }).map((m) => ({ c: 'movements', ...m })));
    },
  }),
  inventorySave: async () => {
    const counts = Object.fromEntries(Object.entries(state.counts).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)]));
    if (!Object.keys(counts).length) return alert('Saisissez au moins une quantité comptée.');
    const moves = buildInventory({ id: newId(), depotId: currentDepot(), counts, stock: stock(), by: seller(), at: Date.now() });
    if (!confirm(`${moves.length} écart(s) seront enregistrés. Continuer ?`)) return undefined;
    if (moves.length) await store.write(moves.map((m) => ({ c: 'movements', ...m })));
    state.counts = {};
    render();
    return undefined;
  },
  cartAdd: ({ id }) => { const a = store.get('articles', id); if (a) addToCart(a); },
  cartRemove: ({ id }) => { state.cart.delete(id); $('#cart').innerHTML = cartView(); },
  checkout: async () => {
    const lines = [...state.cart.values()].filter((l) => l.qty > 0);
    if (!lines.length) return;
    const st = stock();
    const depotId = currentDepot();
    const short = lines.filter((l) => l.qty > stockAt(st, l.articleId, depotId));
    if (short.length && !confirm(`Stock insuffisant pour : ${short.map((l) => l.name).join(', ')}.\nVendre quand même ?`)) return;
    const id = newId();
    // Le coût est figé à la vente : les marges restent justes si le coût moyen évolue.
    const cmp = costs();
    lines.forEach((l) => { l.cost = costOf(cmp, store.get('articles', l.articleId) ?? { id: l.articleId }); });
    const { sale, movements } = buildSale({ id, number: saleNumber(), lines, discount: state.discount, payment: state.payment, depotId, partnerId: state.partnerId, by: seller(), userId: currentUser()?.id ?? null, at: Date.now() });
    const quote = state.quoteId ? store.get('quotes', state.quoteId) : null;
    const quoteChange = quote && !quote.saleId ? [{ c: 'quotes', id: quote.id, data: { ...withoutId(quote), status: 'transformé', saleId: id, saleNumber: sale.number } }] : [];
    await store.write([{ c: 'sales', id, data: { ...sale, quoteId: quote?.id ?? null } }, ...movements.map((m) => ({ c: 'movements', ...m })), ...quoteChange]);
    Object.assign(state, { cart: new Map(), discount: 0, partnerId: '', posQuery: '', quoteId: null });
    render();
    showTicket({ id, ...sale });
  },
  ticket: ({ id }) => showTicket(store.get('sales', id)),
  invoice: ({ id }) => invoiceForm(id),
  creditShow: ({ id }) => showDocument(creditOf(id)),
  creditIssue: async ({ id }) => {
    const invoice = invoiceOf(id);
    if (!invoice || creditOf(id)) return;
    const credit = creditNoteFor(invoice);
    await store.write([{ c: 'invoices', id: `${id}:av`, data: credit }]);
    showDocument(credit);
  },
  salesTab: ({ tab }) => { state.salesTab = tab; render(); },
  quoteNew: quoteForm,
  quoteShow: ({ id }) => showDocument({ ...store.get('quotes', id), kind: 'devis' }),
  quoteToSale: ({ id }) => {
    const q = store.get('quotes', id);
    if (!q) return;
    if (state.cart.size && !confirm('Remplacer le panier en cours par ce devis ?')) return;
    state.cart = new Map(q.lines.map((l) => [l.articleId, { ...l }]));
    Object.assign(state, { discount: q.discount, partnerId: q.partnerId ?? '', quoteId: id });
    $('#dlg').close();
    location.hash = '#pos';
    render();
  },
  quoteDetach: () => { state.quoteId = null; $('#cart').innerHTML = cartView(); },
  shopEdit: shopForm,
  purchaseNew: purchaseForm,
  purchaseShow: ({ id }) => showPurchase(store.get('purchases', id)),
  purchaseAddLine: () => { state.purchase.lines.push({ articleId: '', qty: '', cost: '' }); renderPurchaseForm(); },
  purchaseRemoveLine: ({ i }) => {
    state.purchase.lines.splice(Number(i), 1);
    if (!state.purchase.lines.length) state.purchase.lines.push({ articleId: '', qty: '', cost: '' });
    renderPurchaseForm();
  },
  saleCancel: async ({ id }) => {
    const { id: _ignored, ...sale } = store.get('sales', id);
    const invoice = invoiceOf(id);
    const warn = invoice ? `\nUn avoir annulera la facture ${invoice.number}.` : '';
    if (!confirm(`Annuler la vente ${sale.number} ? Le stock sera recrédité.${warn}`)) return;
    const credit = invoice && !creditOf(id) ? creditNoteFor(invoice) : null;
    await store.write([
      { c: 'sales', id, data: { ...sale, cancelled: true } },
      ...buildCancellation(id, sale, seller(), Date.now()).map((m) => ({ c: 'movements', ...m })),
      ...(credit ? [{ c: 'invoices', id: `${id}:av`, data: credit }] : []),
    ]);
    render();
    if (credit) showDocument(credit);
  },
};

// --- Événements délégués
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const act = el.dataset.act;
  if (isLocked() && !LOCKED_ACTIONS.has(act)) return;
  if (!isManager() && MANAGER_ACTIONS.has(act)) { alert('Action réservée au gérant.'); return; }
  actions[act]?.(el.dataset, el);
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.filter === 'pos') { state.posQuery = t.value; $('#pos-list').innerHTML = posList(); }
  if (t.dataset.filter === 'articles') { state.articleQuery = t.value; $('#articles-list').innerHTML = articlesTable(); }
  if (t.dataset.count) {
    state.counts[t.dataset.count] = t.value;
    $(`#gap-${CSS.escape(t.dataset.count)}`).textContent = gapText(t.dataset.count, Number(t.dataset.theory));
  }
  if (t.dataset.pf) state.purchase[t.dataset.pf] = t.value;
  if (t.dataset.pl) {
    const [i, field] = t.dataset.pl.split(':');
    const line = state.purchase.lines[Number(i)];
    line[field] = t.value;
    // Article choisi : coût proposé = coût moyen actuel, modifiable.
    if (field === 'articleId' && line.cost === '' && t.value) {
      line.cost = String(costOf(costs(), store.get('articles', t.value)));
      t.closest('tr').querySelector('[data-pl$=":cost"]').value = line.cost;
    }
    $('#purchase-total').textContent = ar(purchaseTotal());
  }
  if (t.id === 'discount') {
    state.discount = Number(t.value) || 0;
    $('#cart-total').textContent = ar(saleTotals([...state.cart.values()], state.discount).total);
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.change === 'setPeriod') { state.reportPeriod = t.value; render(); }
  if (t.dataset.change === 'setDepot' || t.dataset.change === 'setDepotInv') {
    await store.setMeta({ depotId: t.value });
    if (t.dataset.change === 'setDepotInv') state.counts = {};
    render();
  }
  if (t.dataset.cart) {
    const line = state.cart.get(t.dataset.cart);
    const qty = Number(t.value);
    if (line && qty > 0) line.qty = qty; else state.cart.delete(t.dataset.cart);
    $('#cart').innerHTML = cartView();
  }
  if (t.id === 'payment') state.payment = t.value;
  if (t.id === 'partner') state.partnerId = t.value;
});

document.addEventListener('keydown', (e) => {
  // Une douchette envoie le code puis Entrée : correspondance exacte directe.
  if (e.key !== 'Enter' || e.target.id !== 'pos-search') return;
  const code = e.target.value.trim().toLowerCase();
  const exact = findByCode(store.list('articles'), code);
  const list = exact ? [exact] : articles().filter((a) => a.name.toLowerCase().includes(code));
  if (code && list.length === 1) {
    addToCart(list[0]);
    state.posQuery = '';
    e.target.value = '';
    $('#pos-list').innerHTML = posList();
  }
});

document.addEventListener('submit', async (e) => {
  if (e.target.id === 'pin-form') { e.preventDefault(); await submitPin(e.target); return; }
  if (e.target.id === 'scan-lookup') {
    e.preventDefault();
    const code = e.target.elements.code.value.trim();
    if (code) lookupCode(code);
    return;
  }
  if (e.target.id === 'recovery-form') {
    e.preventDefault();
    const key = e.target.elements.key.value.trim();
    if (!store.meta.keyHash && !store.meta.token) {
      lockError(e.target, 'Cet appareil n’a jamais été relié à la boutique');
      return;
    }
    // Vérifiée localement (empreinte) ; la clé reste en mémoire pour synchroniser en gérant.
    if (await verifyShopKey(key)) {
      recovery = true;
      useAdminKey(key);
      lock.forgot = false;
      location.hash = 'settings';
      render();
    } else {
      lockError(e.target, 'Clé incorrecte');
    }
    return;
  }
  if (e.target.id === 'purchase-form') {
    e.preventDefault();
    const p = state.purchase;
    try {
      const id = newId();
      const lines = p.lines.map((l) => ({ articleId: l.articleId, qty: Number(l.qty) || 0, cost: l.cost === '' ? NaN : Number(l.cost) }))
        .filter((l) => l.articleId || l.qty);
      const { purchase, movements } = buildPurchase({ id, number: docNumber('A', 'purchases'), partnerId: p.partnerId, depotId: p.depotId, lines, note: p.note.trim(), by: seller(), at: Date.now() });
      await store.write([{ c: 'purchases', id, data: purchase }, ...movements.map((m) => ({ c: 'movements', ...m }))]);
      $('#dlg').close();
      render();
    } catch (err) {
      const box = e.target.querySelector('.error');
      box.textContent = err.message;
      box.hidden = false;
    }
    return;
  }
  if (e.target.id !== 'sync-form') return;
  e.preventDefault();
  const f = e.target.elements;
  const key = f.token.value.trim();
  await store.setMeta({ seller: f.seller.value.trim(), serverUrl: normalizeServerUrl(f.serverUrl.value), deviceLabel: f.deviceLabel.value.trim() });
  if (key) {
    try {
      // Avec des utilisateurs, la clé ne fait qu'enregistrer l'appareil ; sinon elle est gardée.
      if (usersEnabled()) {
        await registerDevice(key);
        // Nouvel enregistrement = nouvelles sessions : l'utilisateur connecté ressaisit son PIN.
        const user = currentUser();
        if (user?.id) { await syncNow(); lockNow(); lock.userId = user.id; renderLock(); return; }
      } else {
        await store.setMeta({ token: key });
      }
    } catch (err) {
      alert(`Enregistrement impossible : ${err.message}`);
    }
  }
  await syncNow();
  render();
});

document.addEventListener('focusout', () => setTimeout(() => { if (renderPending) safeRender(); }, 0));
$('#dlg').addEventListener('close', () => { if (renderPending) safeRender(); });
addEventListener('hashchange', render);
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvent = e; if (route() === 'settings') safeRender(); });

// --- Démarrage
await store.init();
store.author = () => currentUser()?.id ?? null;
store.subscribe(safeRender);
onSyncState(renderChip);
render();
resetIdle();
startSync();
// Demande au navigateur de ne pas purger les données locales.
navigator.storage?.persist?.();
// L'app Android embarque déjà ses fichiers : pas besoin de service worker.
if ('serviceWorker' in navigator && !isNative) navigator.serviceWorker.register('sw.js');
