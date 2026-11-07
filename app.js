(() => {
  'use strict';

  /* =========================================================
   * Configuration
   * ========================================================= */
  const CFG = window.APP_CONFIG || {};
  const REMOTE = Boolean(CFG.supabaseUrl && CFG.supabaseKey);
  // SHA-256 du mot de passe, utilisé uniquement en mode local (sans base en ligne).
  const LOCAL_PASSWORD_SHA256 = '110812f67fa1e1f0117f6f3d70241c1a42a7b07711a93c2477cc516d9042f9db';
  const LS_DATA = 'depenses-couple:data:v1';
  const LS_TAB = 'depenses-couple:tab';
  const SS_PWD = 'depenses-couple:session';
  const LISTS = ['dyd', 'meg', 'couple'];
  const WHO = { dyd: 'Dyd', meg: 'Meg' };
  const TAB_LABEL = { dyd: 'Dépenses Dyd', meg: 'Dépenses Meg', couple: 'Dépenses du couple' };
  const JOUR_LABEL = 'Le ... du mois';

  /* =========================================================
   * État
   * ========================================================= */
  const state = { dyd: [], meg: [], couple: [], settings: { partDyd: 50 } };
  const ui = {};
  LISTS.forEach((k) => {
    ui[k] = { sortBy: '', sortDir: 1, f: { motif: '', mOp: 'eq', m: '', jOp: 'eq', j: '' }, editing: null };
  });
  let password = null;
  let activeTab = 'dyd';

  /* =========================================================
   * Utilitaires
   * ========================================================= */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const nf = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const euro = (cents) => nf.format(cents / 100) + ' €';
  const pct = (p) => String(p).replace('.', ',') + '%';
  const shareText = (p) => pct(p) + '/' + pct(100 - p);
  const partOf = (cents, p) => Math.round((cents * p) / 100);
  const sum = (list) => list.reduce((s, e) => s + e.cents, 0);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const centsToInput = (c) => (c / 100).toFixed(2).replace('.', ',').replace(/,00$/, '');

  // Saisie autorisée (au fil de la frappe)
  const RE_MONTANT = /^\d{0,9}([.,]\d{0,2})?$/;
  const RE_JOUR = /^([1-9]|[12]\d|3[01])?$/;

  function parseMontant(str) {
    const s = String(str).trim().replace(',', '.');
    if (!/^\d{0,9}(\.\d{0,2})?$/.test(s) || s === '' || s === '.') return null;
    const [i, d = ''] = s.split('.');
    const cents = Number(i || '0') * 100 + Number((d + '00').slice(0, 2));
    return cents > 0 ? cents : null;
  }
  function parseJour(str) {
    const s = String(str).trim();
    if (s === '') return { ok: true, value: null };
    if (!/^\d{1,2}$/.test(s)) return { ok: false };
    const n = Number(s);
    return n >= 1 && n <= 31 ? { ok: true, value: n } : { ok: false };
  }
  const validPart = (p) => {
    const n = Number(p);
    if (!Number.isFinite(n) || n < 0 || n > 100) return null;
    return Math.round(n * 2) / 2;
  };

  // Nettoie / valide une dépense (données importées ou chargées)
  function cleanEntry(e, keepId) {
    if (!e || typeof e !== 'object') return null;
    const motif = typeof e.motif === 'string' ? e.motif.trim().slice(0, 100) : '';
    if (!motif) return null;
    let cents = null;
    if (Number.isInteger(e.cents) && e.cents > 0) cents = e.cents;
    else if (typeof e.montant === 'number' && Number.isFinite(e.montant)) {
      const c = e.montant * 100;
      if (Math.abs(c - Math.round(c)) < 1e-6 && c > 0) cents = Math.round(c);
    } else if (typeof e.montant === 'string') cents = parseMontant(e.montant);
    if (!cents) return null;
    let jour = null;
    if (e.jour !== null && e.jour !== undefined && e.jour !== '') {
      const j = parseJour(String(e.jour));
      if (!j.ok) return null;
      jour = j.value;
    }
    const id = keepId && typeof e.id === 'string' && e.id ? e.id : uid();
    return { id, motif, cents, jour };
  }

  function applyData(data) {
    const d = data && typeof data === 'object' ? data : {};
    LISTS.forEach((k) => {
      state[k] = Array.isArray(d[k]) ? d[k].map((e) => cleanEntry(e, true)).filter(Boolean) : [];
    });
    const p = validPart(d.settings && d.settings.partDyd);
    state.settings = { partDyd: p === null ? 50 : p };
  }

  async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  // Restreint la saisie d'un champ à une expression régulière
  function restrict(input, re) {
    input.dataset.last = input.value;
    input.addEventListener('input', () => {
      let v = input.value;
      if (!re.test(v)) {
        const cleaned = v.replace(/[\s  €]/g, '');
        if (re.test(cleaned)) v = cleaned;
      }
      if (re.test(v)) {
        input.value = v;
        input.dataset.last = v;
        return;
      }
      const last = input.dataset.last || '';
      const pos = Math.max(0, (input.selectionStart ?? v.length) - (v.length - last.length));
      input.value = last;
      try { input.setSelectionRange(pos, pos); } catch (_) { /* type non supporté */ }
    });
  }
  function setVal(input, v) { input.value = v; input.dataset.last = v; }

  /* =========================================================
   * Stockage (Supabase en ligne, ou navigateur en local)
   * ========================================================= */
  const Store = {
    pending: new Set(),
    timer: null,
    retryTimer: null,
    flushing: false,

    async rpc(fn, body) {
      const headers = { 'Content-Type': 'application/json', apikey: CFG.supabaseKey };
      if (!String(CFG.supabaseKey).startsWith('sb_')) headers.Authorization = 'Bearer ' + CFG.supabaseKey;
      const res = await fetch(String(CFG.supabaseUrl).replace(/\/+$/, '') + '/rest/v1/rpc/' + fn, {
        method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store'
      });
      if (!res.ok) {
        const err = new Error('HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      const txt = await res.text();
      return txt ? JSON.parse(txt) : null;
    },

    async login(pwd) {
      if (REMOTE) {
        const data = await this.rpc('app_load', { pwd });
        applyData(data);
        return true;
      }
      if (!window.crypto || !crypto.subtle) return false;
      if ((await sha256(pwd)) !== LOCAL_PASSWORD_SHA256) return false;
      let data = null;
      try { data = JSON.parse(localStorage.getItem(LS_DATA) || 'null'); } catch (_) { /* vide */ }
      applyData(data);
      return true;
    },

    save(key) {
      if (!REMOTE) {
        try {
          localStorage.setItem(LS_DATA, JSON.stringify(state));
          setSync('local');
        } catch (_) { setSync('error'); }
        return;
      }
      this.pending.add(key);
      setSync('saving');
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.flush(), 400);
    },

    async flush() {
      if (this.flushing || !this.pending.size) return;
      this.flushing = true;
      clearTimeout(this.retryTimer);
      try {
        while (this.pending.size) {
          const key = this.pending.values().next().value;
          this.pending.delete(key);
          try {
            await this.rpc('app_save', { pwd: password, k: key, v: key === 'settings' ? state.settings : state[key] });
          } catch (e) {
            this.pending.add(key);
            throw e;
          }
        }
        setSync('ok');
      } catch (e) {
        console.warn('Enregistrement impossible, nouvel essai dans 8 s', e);
        setSync('error');
        this.retryTimer = setTimeout(() => this.flush(), 8000);
      } finally {
        this.flushing = false;
      }
    },

    async refresh() {
      if (!REMOTE || !password || this.pending.size || this.flushing) return;
      try {
        const data = await this.rpc('app_load', { pwd: password });
        if (this.pending.size || this.flushing) return;
        const before = JSON.stringify(state);
        const sliding = document.activeElement && document.activeElement.id === 'share-range';
        const keepPart = state.settings.partDyd;
        applyData(data);
        if (sliding) state.settings.partDyd = keepPart;
        if (JSON.stringify(state) !== before) renderAll();
        setSync('ok');
      } catch (e) {
        console.warn('Actualisation impossible', e);
      }
    }
  };

  function setSync(s) {
    const el = $('#sync');
    const text = { local: 'Données sur cet appareil', ok: 'Synchronisé', saving: 'Enregistrement…', error: 'Hors ligne · nouvel essai' }[s];
    el.dataset.state = s;
    $('.sync-text', el).textContent = text;
    el.title = s === 'local' ? 'Base en ligne non configurée : les données restent dans ce navigateur.' : text;
  }

  /* =========================================================
   * Gabarits
   * ========================================================= */
  const ICON_EDIT = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
  const ICON_DEL = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/></svg>';

  function panelHTML(k) {
    const couple = k === 'couple';
    const opSelect = (name, label) => `<select data-f="${name}" aria-label="${label}"><option value="eq">=</option><option value="gte">≥</option><option value="lte">≤</option></select>`;
    const share = couple ? `
      <aside class="card share">
        <h2>Répartition des parts</h2>
        <div class="share-slider">
          <output class="share-bubble" id="share-out" for="share-range">50%/50%</output>
          <input type="range" id="share-range" min="0" max="100" step="0.5" value="50" aria-label="Répartition des parts : part de Dyd">
          <div class="share-ends"><span class="dyd">Dyd</span><span class="mid">50%/50%</span><span class="meg">Meg</span></div>
        </div>
        <div class="share-detail">
          <div class="dyd">Dyd<b id="share-dyd">50%</b></div>
          <div class="meg">Meg<b id="share-meg">50%</b></div>
        </div>
        <button type="button" class="link" id="share-reset">Remettre à 50%/50%</button>
      </aside>` : '';

    return `
      <section class="panel" id="panel-${k}" role="tabpanel" aria-label="${TAB_LABEL[k]}" hidden>
        <div class="layout${couple ? ' has-side' : ''}">
          ${share}
          <div class="main-col">
            <form class="card entry" novalidate autocomplete="off">
              <h2 class="entry-title">Nouvelle dépense</h2>
              <div class="fields">
                <label class="field f-motif"><span>Motif <i>*</i></span>
                  <input name="motif" maxlength="100" required enterkeyhint="next">
                  <small class="motif-count">0/100</small>
                </label>
                <label class="field"><span>Montant <i>*</i></span>
                  <span class="suffix"><input name="montant" inputmode="decimal" required placeholder="0,00" enterkeyhint="next"><em>€</em></span>
                </label>
                <label class="field"><span>${JOUR_LABEL}</span>
                  <input name="jour" inputmode="numeric" placeholder="1 à 31" enterkeyhint="done">
                </label>
              </div>
              <p class="form-msg" role="alert"></p>
              <div class="form-actions">
                <button type="submit" class="btn primary">Valider</button>
                <button type="button" class="btn cancel-edit" hidden>Annuler</button>
              </div>
            </form>

            <section class="card list">
              <div class="list-head">
                <h2>Dépenses<span class="count-badge"></span></h2>
                <div class="io">
                  <button type="button" class="btn small" data-io="export">Exporter .json</button>
                  <button type="button" class="btn small" data-io="import">Importer .json</button>
                  <input type="file" class="file" accept=".json,application/json" hidden>
                </div>
              </div>

              <details class="tools">
                <summary>Rechercher et trier <span class="active-dot" hidden></span></summary>
                <div class="tools-grid">
                  <label class="field f-search"><span>Motif</span>
                    <input type="search" data-f="motif" maxlength="100" placeholder="Rechercher…">
                  </label>
                  <div class="field"><span>Montant</span>
                    <div class="op-input">${opSelect('mOp', 'Comparaison du montant')}<input data-f="m" inputmode="decimal" placeholder="0,00" aria-label="Montant recherché"></div>
                  </div>
                  <div class="field"><span>${JOUR_LABEL}</span>
                    <div class="op-input">${opSelect('jOp', 'Comparaison du jour')}<input data-f="j" inputmode="numeric" placeholder="1 à 31" aria-label="Jour recherché"></div>
                  </div>
                  <div class="field"><span>Trier par</span>
                    <div class="op-input">
                      <select data-sort-by aria-label="Trier par" style="flex:1;text-align:left;padding:0 10px">
                        <option value="">Ordre d'ajout</option>
                        <option value="motif">Motif</option>
                        <option value="montant">Montant</option>
                        <option value="jour">${JOUR_LABEL}</option>
                      </select>
                      <button type="button" class="btn" data-sort-dir aria-label="Inverser l'ordre de tri" title="Inverser l'ordre de tri">↑</button>
                    </div>
                  </div>
                </div>
                <div class="tools-foot"><button type="button" class="link reset-filters" hidden>Effacer les filtres</button></div>
              </details>

              <div class="table-wrap">
                <table class="expenses">
                  <thead><tr>
                    <th><button type="button" class="th-sort" data-col="motif">Motif<span class="arrow"></span></button></th>
                    <th class="num"><button type="button" class="th-sort" data-col="montant">Montant<span class="arrow"></span></button></th>
                    <th class="num"><button type="button" class="th-sort" data-col="jour">${JOUR_LABEL}<span class="arrow"></span></button></th>
                    ${couple ? '<th class="num">Part Dyd</th><th class="num">Part Meg</th>' : ''}
                    <th class="act"><span class="sr">Actions</span></th>
                  </tr></thead>
                  <tbody></tbody>
                </table>
              </div>
              <p class="filtered-total" hidden></p>
              <dl class="totals"></dl>
            </section>
          </div>
        </div>
      </section>`;
  }

  /* =========================================================
   * Calculs
   * ========================================================= */
  function coupleTotals() {
    const p = state.settings.partDyd;
    let total = 0;
    let dyd = 0;
    state.couple.forEach((e) => { total += e.cents; dyd += partOf(e.cents, p); });
    return { total, dyd, meg: total - dyd };
  }

  const cmp = (op, a, b) => (op === 'gte' ? a >= b : op === 'lte' ? a <= b : a === b);

  function filtersActive(k) {
    const f = ui[k].f;
    return Boolean(f.motif.trim() || parseMontant(f.m) || f.j !== '');
  }

  function visibleEntries(k) {
    const { f, sortBy, sortDir } = ui[k];
    let list = state[k].slice();
    const q = norm(f.motif.trim());
    if (q) list = list.filter((e) => norm(e.motif).includes(q));
    const m = parseMontant(f.m);
    if (m) list = list.filter((e) => cmp(f.mOp, e.cents, m));
    const j = parseJour(f.j);
    if (j.ok && j.value !== null) list = list.filter((e) => e.jour !== null && cmp(f.jOp, e.jour, j.value));
    if (sortBy) {
      list.sort((a, b) => {
        if (sortBy === 'motif') return a.motif.localeCompare(b.motif, 'fr', { sensitivity: 'base', numeric: true }) * sortDir;
        if (sortBy === 'montant') return (a.cents - b.cents) * sortDir;
        if (a.jour === null && b.jour === null) return 0;
        if (a.jour === null) return 1; // sans jour : toujours en fin de liste
        if (b.jour === null) return -1;
        return (a.jour - b.jour) * sortDir;
      });
    }
    return list;
  }

  /* =========================================================
   * Rendu
   * ========================================================= */
  function renderList(k) {
    const panel = $('#panel-' + k);
    const couple = k === 'couple';
    const p = state.settings.partDyd;
    const list = visibleEntries(k);
    const all = state[k].length;
    const cols = couple ? 6 : 4;
    const editing = ui[k].editing;

    $('tbody', panel).innerHTML = list.length
      ? list.map((e) => {
        const dyd = partOf(e.cents, p);
        return `<tr data-id="${esc(e.id)}"${e.id === editing ? ' class="is-editing"' : ''}>
          <td class="motif" data-label="Motif">${esc(e.motif)}</td>
          <td class="num" data-label="Montant">${euro(e.cents)}</td>
          <td class="num" data-label="${JOUR_LABEL}">${e.jour === null ? '—' : e.jour}</td>
          ${couple ? `<td class="num dyd" data-label="Part Dyd">${euro(dyd)}</td><td class="num meg" data-label="Part Meg">${euro(e.cents - dyd)}</td>` : ''}
          <td class="act">
            <button type="button" class="icon-btn" data-act="edit" aria-label="Modifier « ${esc(e.motif)} »" title="Modifier">${ICON_EDIT}</button>
            <button type="button" class="icon-btn del" data-act="del" aria-label="Supprimer « ${esc(e.motif)} »" title="Supprimer">${ICON_DEL}</button>
          </td>
        </tr>`;
      }).join('')
      : `<tr><td class="empty" colspan="${cols}">${all ? 'Aucune dépense ne correspond à la recherche.' : 'Aucune dépense pour le moment.'}</td></tr>`;

    const active = filtersActive(k);
    $('.count-badge', panel).textContent = all ? (active ? ` · ${list.length} sur ${all}` : ` · ${all}`) : '';
    $('.active-dot', panel).hidden = !active;
    $('.reset-filters', panel).hidden = !active;
    const ft = $('.filtered-total', panel);
    ft.hidden = !active;
    if (active) ft.textContent = 'Total des dépenses affichées : ' + euro(sum(list));

    // Indicateurs de tri
    const { sortBy, sortDir } = ui[k];
    $$('.th-sort', panel).forEach((b) => {
      const on = b.dataset.col === sortBy;
      b.classList.toggle('on', on);
      $('.arrow', b).textContent = on ? (sortDir === 1 ? '▲' : '▼') : '';
      b.closest('th').setAttribute('aria-sort', on ? (sortDir === 1 ? 'ascending' : 'descending') : 'none');
    });
    $('[data-sort-by]', panel).value = sortBy;
    const dirBtn = $('[data-sort-dir]', panel);
    dirBtn.textContent = sortDir === 1 ? '↑' : '↓';
    dirBtn.disabled = !sortBy;

    renderTotals(k);
  }

  function renderTotals(k) {
    const row = (label, cents, cls = '') => `<div class="t-row ${cls}"><dt>${label}</dt><dd>${euro(cents)}</dd></div>`;
    let html;
    if (k === 'couple') {
      const t = coupleTotals();
      html = row('Total des dépenses mensuelles du couple', t.total, 'grand')
        + row('Dyd - Total des dépenses mensuelles dans le couple', t.dyd, 'dyd')
        + row('Meg - Total des dépenses mensuelles dans le couple', t.meg, 'meg');
    } else {
      const perso = sum(state[k]);
      const inCouple = coupleTotals()[k];
      html = row('Total des dépenses mensuelles personnelles', perso)
        + row('Total des dépenses mensuelles dans le couple', inCouple)
        + row('Total des dépenses mensuelles ' + WHO[k], perso + inCouple, 'grand');
    }
    $('#panel-' + k + ' .totals').innerHTML = html;
  }

  function renderShare() {
    const p = state.settings.partDyd;
    const range = $('#share-range');
    if (!range) return;
    if (Number(range.value) !== p) range.value = String(p);
    $('.share-slider').style.setProperty('--p', p);
    range.style.setProperty('--p', p);
    $('#share-out').textContent = shareText(p);
    $('#share-dyd').textContent = pct(p);
    $('#share-meg').textContent = pct(100 - p);
    range.setAttribute('aria-valuetext', `Dyd ${pct(p)}, Meg ${pct(100 - p)}`);
  }

  function renderAll() {
    LISTS.forEach(renderList);
    renderShare();
  }

  function showTab(k) {
    activeTab = k;
    $$('.tab').forEach((t) => {
      const on = t.dataset.tab === k;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
    });
    LISTS.forEach((x) => { $('#panel-' + x).hidden = x !== k; });
    try { localStorage.setItem(LS_TAB, k); } catch (_) { /* indisponible */ }
  }

  /* =========================================================
   * Toast (annulation de suppression)
   * ========================================================= */
  let toastTimer = null;
  function toast(msg, actionLabel, action) {
    const el = $('#toast');
    el.innerHTML = `<span>${esc(msg)}</span>` + (actionLabel ? `<button type="button">${esc(actionLabel)}</button>` : '');
    el.hidden = false;
    if (actionLabel) {
      $('button', el).onclick = () => { action(); el.hidden = true; clearTimeout(toastTimer); };
    }
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
  }

  /* =========================================================
   * Actions sur les dépenses
   * ========================================================= */
  function storageKey(k) { return k; }

  function exitEdit(k) {
    const panel = $('#panel-' + k);
    const form = $('form.entry', panel);
    ui[k].editing = null;
    form.reset();
    $$('input', form).forEach((i) => { i.dataset.last = ''; i.removeAttribute('aria-invalid'); });
    $('.motif-count', form).textContent = '0/100';
    $('.form-msg', form).textContent = '';
    $('.entry-title', form).textContent = 'Nouvelle dépense';
    $('.cancel-edit', form).hidden = true;
    form.classList.remove('editing');
  }

  function startEdit(k, id) {
    const e = state[k].find((x) => x.id === id);
    if (!e) return;
    const form = $('#panel-' + k + ' form.entry');
    ui[k].editing = id;
    setVal(form.motif, e.motif);
    setVal(form.montant, centsToInput(e.cents));
    setVal(form.jour, e.jour === null ? '' : String(e.jour));
    $('.motif-count', form).textContent = e.motif.length + '/100';
    $('.form-msg', form).textContent = '';
    $$('input', form).forEach((i) => i.removeAttribute('aria-invalid'));
    $('.entry-title', form).textContent = 'Modifier la dépense';
    $('.cancel-edit', form).hidden = false;
    form.classList.add('editing');
    renderList(k);
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    form.motif.focus({ preventScroll: true });
  }

  function submitEntry(k, form) {
    const motif = form.motif.value.trim();
    const cents = parseMontant(form.montant.value);
    const jour = parseJour(form.jour.value);
    const errors = [];
    form.motif.setAttribute('aria-invalid', String(!motif));
    form.montant.setAttribute('aria-invalid', String(!cents));
    form.jour.setAttribute('aria-invalid', String(!jour.ok));
    if (!motif) errors.push('Le motif est obligatoire.');
    if (!cents) errors.push('Le montant doit être un nombre positif (2 décimales maximum).');
    if (!jour.ok) errors.push('Le jour du mois doit être un entier de 1 à 31.');
    if (errors.length) {
      $('.form-msg', form).textContent = errors.join(' ');
      (!motif ? form.motif : !cents ? form.montant : form.jour).focus();
      return;
    }
    const entry = { motif: motif.slice(0, 100), cents, jour: jour.value };
    const editing = ui[k].editing;
    const idx = editing ? state[k].findIndex((x) => x.id === editing) : -1;
    if (idx >= 0) state[k][idx] = { id: editing, ...entry };
    else state[k].push({ id: uid(), ...entry });
    exitEdit(k);
    Store.save(storageKey(k));
    renderAll();
    form.motif.focus();
  }

  function deleteEntry(k, id) {
    const idx = state[k].findIndex((x) => x.id === id);
    if (idx < 0) return;
    const [removed] = state[k].splice(idx, 1);
    if (ui[k].editing === id) exitEdit(k);
    Store.save(storageKey(k));
    renderAll();
    toast(`« ${removed.motif.length > 30 ? removed.motif.slice(0, 30) + '…' : removed.motif} » supprimée`, 'Annuler', () => {
      state[k].splice(Math.min(idx, state[k].length), 0, removed);
      Store.save(storageKey(k));
      renderAll();
    });
  }

  /* =========================================================
   * Import / export JSON
   * ========================================================= */
  function exportTab(k) {
    const payload = {
      application: 'depenses-couple',
      version: 1,
      onglet: k,
      nomOnglet: TAB_LABEL[k],
      exporteLe: new Date().toISOString(),
      ...(k === 'couple' ? { partDyd: state.settings.partDyd, partMeg: 100 - state.settings.partDyd } : {}),
      depenses: state[k].map((e) => ({ motif: e.motif, montant: e.cents / 100, jour: e.jour }))
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `depenses-${k}-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function importTab(k, file) {
    let json;
    try {
      json = JSON.parse(await file.text());
    } catch (_) {
      alert('Ce fichier n\'est pas un fichier .json valide.');
      return;
    }
    const raw = Array.isArray(json) ? json : json && Array.isArray(json.depenses) ? json.depenses : null;
    if (!raw) {
      alert('Aucune liste de dépenses trouvée dans ce fichier.');
      return;
    }
    if (json && json.onglet && LISTS.includes(json.onglet) && json.onglet !== k
      && !confirm(`Ce fichier provient de l'onglet « ${TAB_LABEL[json.onglet]} ». L'importer quand même dans « ${TAB_LABEL[k]} » ?`)) return;

    const entries = raw.map((e) => cleanEntry(e, false)).filter(Boolean);
    const skipped = raw.length - entries.length;
    if (state[k].length && !confirm(`Remplacer les ${state[k].length} dépense(s) actuelles de « ${TAB_LABEL[k]} » par les ${entries.length} dépense(s) du fichier ?`)) return;

    state[k] = entries;
    exitEdit(k);
    Store.save(storageKey(k));
    if (k === 'couple' && json && !Array.isArray(json)) {
      const p = validPart(json.partDyd);
      if (p !== null) { state.settings.partDyd = p; Store.save('settings'); }
    }
    renderAll();
    toast(`${entries.length} dépense(s) importée(s)` + (skipped ? ` · ${skipped} ligne(s) invalide(s) ignorée(s)` : ''));
  }

  /* =========================================================
   * Construction de l'interface & événements
   * ========================================================= */
  function buildPanels() {
    $('#panels').innerHTML = LISTS.map(panelHTML).join('');

    LISTS.forEach((k) => {
      const panel = $('#panel-' + k);
      const form = $('form.entry', panel);

      restrict(form.montant, RE_MONTANT);
      restrict(form.jour, RE_JOUR);
      restrict($('[data-f="m"]', panel), RE_MONTANT);
      restrict($('[data-f="j"]', panel), RE_JOUR);

      form.addEventListener('submit', (ev) => { ev.preventDefault(); submitEntry(k, form); });
      form.motif.addEventListener('input', () => { $('.motif-count', form).textContent = form.motif.value.length + '/100'; });
      $$('input', form).forEach((i) => i.addEventListener('input', () => i.removeAttribute('aria-invalid')));
      $('.cancel-edit', form).addEventListener('click', () => { exitEdit(k); renderList(k); });
      form.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && ui[k].editing) { exitEdit(k); renderList(k); } });

      // Clic sur modifier / supprimer
      $('tbody', panel).addEventListener('click', (ev) => {
        const btn = ev.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.closest('tr').dataset.id;
        if (btn.dataset.act === 'edit') startEdit(k, id);
        else deleteEntry(k, id);
      });

      // Filtres
      $$('[data-f]', panel).forEach((el) => {
        el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
          ui[k].f[el.dataset.f] = el.value;
          renderList(k);
        });
      });
      $('.reset-filters', panel).addEventListener('click', () => {
        ui[k].f = { motif: '', mOp: 'eq', m: '', jOp: 'eq', j: '' };
        $$('[data-f]', panel).forEach((el) => setVal(el, ui[k].f[el.dataset.f]));
        renderList(k);
      });

      // Tri
      $$('.th-sort', panel).forEach((b) => b.addEventListener('click', () => {
        const col = b.dataset.col;
        const u = ui[k];
        if (u.sortBy !== col) { u.sortBy = col; u.sortDir = 1; }
        else if (u.sortDir === 1) u.sortDir = -1;
        else { u.sortBy = ''; u.sortDir = 1; }
        renderList(k);
      }));
      $('[data-sort-by]', panel).addEventListener('change', (ev) => { ui[k].sortBy = ev.target.value; ui[k].sortDir = 1; renderList(k); });
      $('[data-sort-dir]', panel).addEventListener('click', () => { ui[k].sortDir *= -1; renderList(k); });

      // Import / export
      const fileInput = $('.file', panel);
      $('[data-io="export"]', panel).addEventListener('click', () => exportTab(k));
      $('[data-io="import"]', panel).addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const f = fileInput.files && fileInput.files[0];
        fileInput.value = '';
        if (f) importTab(k, f);
      });

      // Outils de recherche ouverts par défaut sur grand écran
      if (window.matchMedia('(min-width: 641px)').matches) $('details.tools', panel).open = true;
    });

    // Curseur de répartition
    const range = $('#share-range');
    range.addEventListener('input', () => {
      state.settings.partDyd = validPart(range.value) ?? 50;
      renderShare();
      LISTS.forEach(renderList);
      Store.save('settings');
    });
    $('#share-reset').addEventListener('click', () => {
      state.settings.partDyd = 50;
      renderAll();
      Store.save('settings');
    });

    // Onglets (clic + flèches du clavier)
    $$('.tab').forEach((t) => {
      t.addEventListener('click', () => showTab(t.dataset.tab));
      t.addEventListener('keydown', (ev) => {
        if (ev.key !== 'ArrowRight' && ev.key !== 'ArrowLeft') return;
        const i = LISTS.indexOf(activeTab);
        const next = LISTS[(i + (ev.key === 'ArrowRight' ? 1 : LISTS.length - 1)) % LISTS.length];
        showTab(next);
        $(`.tab[data-tab="${next}"]`).focus();
      });
    });
  }

  function enterApp() {
    document.title = 'Dépenses du couple';
    $('#login').hidden = true;
    $('#app').hidden = false;
    buildPanels();
    let tab = 'dyd';
    try { tab = localStorage.getItem(LS_TAB) || 'dyd'; } catch (_) { /* indisponible */ }
    showTab(LISTS.includes(tab) ? tab : 'dyd');
    renderAll();
    setSync(REMOTE ? 'ok' : 'local');

    if (REMOTE) {
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') Store.refresh(); });
      setInterval(() => { if (document.visibilityState === 'visible') Store.refresh(); }, 30000);
      window.addEventListener('online', () => Store.flush());
    }
    window.addEventListener('beforeunload', (ev) => {
      if (Store.pending.size) { Store.flush(); ev.preventDefault(); ev.returnValue = ''; }
    });
  }

  async function tryLogin(pwd) {
    try {
      if (await Store.login(pwd)) {
        password = pwd;
        try { sessionStorage.setItem(SS_PWD, pwd); } catch (_) { /* indisponible */ }
        enterApp();
        return true;
      }
    } catch (e) {
      console.warn('Connexion refusée', e && e.status ? e.status : e);
    }
    return false;
  }

  /* =========================================================
   * Démarrage
   * ========================================================= */
  const loginForm = $('#login-form');
  const pwdInput = $('#pwd');
  let busy = false;
  loginForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    if (busy) return;
    busy = true;
    await tryLogin(pwdInput.value);
    busy = false;
  });

  $('#logout').addEventListener('click', async () => {
    if (Store.pending.size) await Store.flush();
    try { sessionStorage.removeItem(SS_PWD); } catch (_) { /* indisponible */ }
    location.reload();
  });

  (async () => {
    let saved = null;
    try { saved = sessionStorage.getItem(SS_PWD); } catch (_) { /* indisponible */ }
    if (saved) {
      $('#login').style.visibility = 'hidden';
      const ok = await tryLogin(saved);
      if (!ok) { try { sessionStorage.removeItem(SS_PWD); } catch (_) { /* */ } }
      $('#login').style.visibility = '';
    }
    if ($('#app').hidden) pwdInput.focus();
  })();
})();
