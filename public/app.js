/* KinBubble — interactive family tree app (vanilla JS + D3) */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const state = {
    user: null, trees: [], tree: null, persons: [], rels: [],
    selectedId: null, layout: 'bubble', hiddenFamilies: new Set(), matchIds: new Set(),
    shareToken: new URLSearchParams(location.search).get('share') || '',
  };
  const PALETTE = ['#14b8a6', '#6366f1', '#f59e0b', '#ec4899', '#22c55e', '#0ea5e9', '#a855f7', '#ef4444', '#84cc16', '#f97316', '#06b6d4', '#8b5cf6'];
  const familyOf = p => (p.last_name || '').trim() || 'Unknown family';
  const colorFor = (() => { const map = new Map(); return fam => { if (!map.has(fam)) map.set(fam, PALETTE[map.size % PALETTE.length]); return map.get(fam); }; })();
  const fullName = p => [p.first_name, p.last_name].filter(Boolean).join(' ');
  const initials = p => ((p.first_name || '')[0] || '') + ((p.last_name || '')[0] || '');
  const years = p => { const b = (p.birth_date || '').slice(0, 4), d = (p.death_date || '').slice(0, 4); return b || d ? `${b || '?'}–${d || (p.death_date ? '?' : '')}`.replace(/–$/, '') : ''; };

  // ---------- API ----------
  async function api(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (state.shareToken) headers['X-Share-Token'] = state.shareToken;
    const r = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(data.error || r.statusText); e.status = r.status; throw e; }
    return data;
  }
  const get = url => api('GET', url), post = (u, b) => api('POST', u, b), patch = (u, b) => api('PATCH', u, b), del = u => api('DELETE', u);

  // ---------- UI utils ----------
  let toastTimer;
  function toast(msg, isErr) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' error' : ''); t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.hidden = true, 2600);
  }
  function modal(html, onMount) {
    const root = $('#modal-root');
    root.innerHTML = `<div class="modal-bg"><div class="modal" role="dialog" aria-modal="true">${html}</div></div>`;
    const bg = $('.modal-bg', root);
    const close = () => { root.innerHTML = ''; document.removeEventListener('keydown', esc); };
    const esc = e => { if (e.key === 'Escape') close(); };
    bg.addEventListener('click', e => { if (e.target === bg) close(); });
    document.addEventListener('keydown', esc);
    $$('[data-close]', root).forEach(b => b.addEventListener('click', close));
    onMount && onMount($('.modal', root), close);
    return close;
  }
  function confirmModal(title, body, okLabel = 'Delete') {
    return new Promise(res => modal(`<h2>${esc(title)}</h2><p class="muted">${esc(body)}</p>
      <div class="close-row"><button class="btn" data-close>Cancel</button><button class="btn danger" id="ok">${esc(okLabel)}</button></div>`,
      (m, close) => { $('#ok', m).onclick = () => { res(true); close(); }; $('[data-close]', m).addEventListener('click', () => res(false)); }));
  }
  function navigate(path) { history.pushState({}, '', path); route(); }
  document.addEventListener('click', e => {
    const a = e.target.closest('a[data-link]'); if (!a) return;
    e.preventDefault(); navigate(a.getAttribute('href'));
  });
  window.addEventListener('popstate', route);

  // ---------- Top bar ----------
  function renderTopbar() {
    const u = state.user;
    $('#user-menu').hidden = !u; $('#btn-login-top').hidden = !!u;
    if (u) { $('#user-btn').textContent = (u.name[0] || '?').toUpperCase(); $('#menu-name').textContent = u.name; $('#menu-email').textContent = u.email; }
    const t = state.tree;
    $('#tree-title').hidden = !t; $('#search-wrap').hidden = !t && !u;
    $('#btn-share').hidden = !t || t.access !== 'owner';
    if (t) $('#tree-title').innerHTML = `${esc(t.name)} <span class="badge ${t.access}">${t.access}</span>`;
  }
  $('#user-btn').onclick = e => { e.stopPropagation(); $('#user-dropdown').hidden = !$('#user-dropdown').hidden; };
  document.addEventListener('click', () => { $('#user-dropdown').hidden = true; $('#search-results').hidden = true; });
  $('#btn-logout').onclick = async () => { await post('/api/auth/logout'); state.user = null; state.tree = null; navigate('/'); };
  $('#btn-login-top').onclick = () => { const next = location.pathname + location.search; navigate('/?next=' + encodeURIComponent(next)); };
  $('#btn-share').onclick = openShare;
  $('#btn-account').onclick = () => modal(`<h2>Account</h2>
    <form class="form" id="acct">
      <label>Name<input name="name" type="text" value="${esc(state.user.name)}" required maxlength="80"></label>
      <div class="section-title">Change password (optional)</div>
      <label>Current password<input name="current_password" type="password" autocomplete="current-password"></label>
      <label>New password<input name="new_password" type="password" minlength="8" autocomplete="new-password"></label>
      <div class="close-row"><button class="btn" type="button" data-close>Cancel</button><button class="btn primary" type="submit">Save</button></div>
    </form>`, (m, close) => {
    $('#acct', m).onsubmit = async e => {
      e.preventDefault();
      try { const d = await patch('/api/auth/me', Object.fromEntries(new FormData(e.target))); state.user = d.user; renderTopbar(); toast('Saved'); close(); }
      catch (err) { toast(err.message, true); }
    };
  });

  // ---------- Search (top bar, global or current tree) ----------
  let searchTimer, searchIdx = -1;
  const searchInput = $('#search'), searchBox = $('#search-results');
  searchInput.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 180); });
  $('#search-field').addEventListener('change', runSearch);
  searchInput.addEventListener('focus', () => { if (searchBox.innerHTML) searchBox.hidden = false; });
  searchInput.addEventListener('click', e => e.stopPropagation());
  searchBox.addEventListener('click', e => e.stopPropagation());
  searchInput.addEventListener('keydown', e => {
    const items = $$('.res', searchBox);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); searchIdx = (searchIdx + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      items.forEach((el, i) => el.classList.toggle('active', i === searchIdx)); items[searchIdx]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') { (items[searchIdx] || items[0])?.click(); }
    else if (e.key === 'Escape') { searchInput.value = ''; searchBox.hidden = true; setMatches([]); }
  });
  async function runSearch() {
    const q = searchInput.value.trim(); searchIdx = -1;
    if (!q) { searchBox.hidden = true; searchBox.innerHTML = ''; setMatches([]); return; }
    const field = $('#search-field').value;
    const params = new URLSearchParams({ q, field });
    if (state.tree) params.set('tree', state.tree.slug);
    if (state.shareToken) params.set('share', state.shareToken);
    try {
      const { results } = await get('/api/search?' + params);
      if (state.tree) setMatches(results.filter(r => r.tree_slug === state.tree.slug).map(r => r.id));
      const hi = s => esc(s).replace(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig'), '<mark>$1</mark>');
      searchBox.innerHTML = results.length ? results.map(r => `
        <div class="res" data-id="${r.id}" data-tree="${esc(r.tree_slug)}">
          <span class="dot" style="background:${colorFor(familyOf(r))}">${esc(initials(r)) || '?'}</span>
          <span class="who"><b>${hi(fullName(r))}${r.nickname ? ` <small>“${hi(r.nickname)}”</small>` : ''}</b>
          <small>${[years(r), hi(r.birth_place), hi(r.occupation), state.tree ? '' : r.tree_name].filter(Boolean).join(' · ')}</small></span>
        </div>`).join('') : `<div class="none">No one matches “${esc(q)}”</div>`;
      searchBox.hidden = false;
      $$('.res', searchBox).forEach(el => el.onclick = () => {
        const id = +el.dataset.id, slug = el.dataset.tree;
        searchBox.hidden = true;
        if (state.tree && state.tree.slug === slug) { selectPerson(id); focusNode(id); }
        else navigate(`/t/${slug}?focus=${id}`);
      });
    } catch (err) { toast(err.message, true); }
  }
  function setMatches(ids) { state.matchIds = new Set(ids); graph && graph.refreshClasses(); }

  // ---------- Router ----------
  async function route() {
    const m = location.pathname.match(/^\/t\/([^/]+)/);
    state.shareToken = new URLSearchParams(location.search).get('share') || '';
    if (m) return showTree(m[1]);
    state.tree = null; graph && graph.destroy(); graph = null;
    if (!state.user) return showAuth();
    showDashboard();
  }

  // ---------- Auth screen ----------
  function showAuth() {
    renderTopbar();
    const v = $('#view'); v.innerHTML = ''; v.append($('#tpl-auth').content.cloneNode(true));
    const err = $('#auth-error');
    $$('.tab', v).forEach(t => t.onclick = () => {
      $$('.tab', v).forEach(x => x.classList.toggle('active', x === t));
      $('#form-login').hidden = t.dataset.tab !== 'login'; $('#form-register').hidden = t.dataset.tab !== 'register'; err.hidden = true;
    });
    const handle = url => async e => {
      e.preventDefault(); err.hidden = true;
      const btn = $('button[type=submit]', e.target); btn.disabled = true;
      try {
        const d = await post(url, Object.fromEntries(new FormData(e.target)));
        state.user = d.user;
        const next = new URLSearchParams(location.search).get('next');
        navigate(next && next.startsWith('/') ? next : '/');
      } catch (ex) { err.textContent = ex.message; err.hidden = false; }
      btn.disabled = false;
    };
    $('#form-login').onsubmit = handle('/api/auth/login');
    $('#form-register').onsubmit = handle('/api/auth/register');
  }

  // ---------- Dashboard ----------
  async function showDashboard() {
    renderTopbar();
    const v = $('#view'); v.innerHTML = ''; v.append($('#tpl-dashboard').content.cloneNode(true));
    $('#btn-new-tree').onclick = newTreeModal;
    try { state.trees = (await get('/api/trees')).trees; } catch (e) { toast(e.message, true); return; }
    const list = $('#tree-list');
    if (!state.trees.length) { list.innerHTML = `<div class="empty-trees"><h3>No trees yet</h3><p>Create your first family tree to get started.</p><button class="btn primary" id="btn-first-tree">+ New tree</button></div>`; $('#btn-first-tree').onclick = newTreeModal; return; }
    list.innerHTML = state.trees.map((t, i) => `
      <a class="tree-card" href="/t/${esc(t.slug)}" data-link>
        <div class="bubbles"><i style="background:${PALETTE[i % PALETTE.length]}"></i><i style="background:${PALETTE[(i + 3) % PALETTE.length]}"></i><i style="background:${PALETTE[(i + 6) % PALETTE.length]}"></i></div>
        <h3>${esc(t.name)}</h3><p>${esc(t.description) || '<span class="muted">No description</span>'}</p>
        <div class="meta"><span class="badge ${t.access}">${t.access}</span><span>${t.person_count} ${t.person_count === 1 ? 'person' : 'people'}</span>${t.access !== 'owner' ? `<span>· by ${esc(t.owner_name)}</span>` : ''}</div>
      </a>`).join('');
  }
  function newTreeModal() {
    modal(`<h2>New family tree</h2><form class="form" id="f">
      <label>Tree name<input name="name" type="text" required maxlength="80" placeholder="e.g. The Soemawilaga family"></label>
      <label>Description <small>(optional)</small><textarea name="description" maxlength="1000" placeholder="Where this family comes from, what you know so far…"></textarea></label>
      <div class="close-row"><button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">Create</button></div></form>`,
      (m, close) => { $('input', m).focus(); $('#f', m).onsubmit = async e => { e.preventDefault(); try { const d = await post('/api/trees', Object.fromEntries(new FormData(e.target))); close(); navigate('/t/' + d.tree.slug); } catch (err) { toast(err.message, true); } }; });
  }

  // ---------- Tree view ----------
  let graph = null;
  async function showTree(slug) {
    const v = $('#view');
    let data;
    try { data = await get(`/api/trees/${slug}${state.shareToken ? '?share=' + encodeURIComponent(state.shareToken) : ''}`); }
    catch (e) {
      if (e.status === 401) { return navigate('/?next=' + encodeURIComponent(location.pathname + location.search)); }
      renderTopbar(); v.innerHTML = `<div class="dashboard"><h1>${esc(e.message)}</h1><p class="muted">Ask the tree owner for a share link or an invite.</p><a class="btn" href="/" data-link>Back to my trees</a></div>`; return;
    }
    state.tree = data.tree; state.persons = data.persons; state.rels = data.relationships; state.selectedId = null; state.hiddenFamilies.clear(); state.matchIds.clear();
    renderTopbar();
    document.title = `${state.tree.name} — KinBubble`;
    v.innerHTML = ''; v.append($('#tpl-tree').content.cloneNode(true));
    const editable = canEdit();
    $('#btn-add-person').hidden = !editable;
    $('#btn-add-person').onclick = () => personForm();
    $('#btn-add-first').onclick = () => personForm();
    $('#btn-fit').onclick = () => graph.fit();
    $$('.seg [data-layout]').forEach(b => b.onclick = () => { $$('.seg [data-layout]').forEach(x => x.classList.toggle('active', x === b)); state.layout = b.dataset.layout; graph.update(); });
    graph = createGraph($('#canvas'));
    graph.update();
    refreshEmpty(); renderLegend();
    const focus = new URLSearchParams(location.search).get('focus');
    if (focus && state.persons.some(p => p.id === +focus)) { selectPerson(+focus); setTimeout(() => focusNode(+focus), 600); }
    else setTimeout(() => graph.fit(), 700);
  }
  const canEdit = () => state.tree && (state.tree.access === 'owner' || state.tree.access === 'editor');
  const treeUrl = path => `/api/trees/${state.tree.slug}${path}${state.shareToken ? (path.includes('?') ? '&' : '?') + 'share=' + encodeURIComponent(state.shareToken) : ''}`;
  function refreshEmpty() { const e = $('#empty-state'); if (e) { e.hidden = state.persons.length > 0; if (!e.hidden) $('#btn-add-first').hidden = !canEdit(); } }
  function renderLegend() {
    const counts = new Map();
    state.persons.forEach(p => counts.set(familyOf(p), (counts.get(familyOf(p)) || 0) + 1));
    const fams = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    $('#legend').innerHTML = fams.map(([f, n]) => `<span class="chip ${state.hiddenFamilies.has(f) ? 'dim' : ''}" data-fam="${esc(f)}"><i style="background:${colorFor(f)}"></i>${esc(f)} <small>${n}</small></span>`).join('');
    $$('#legend .chip').forEach(c => c.onclick = () => {
      const f = c.dataset.fam;
      if (state.hiddenFamilies.has(f)) state.hiddenFamilies.delete(f); else state.hiddenFamilies.add(f);
      renderLegend(); graph.refreshClasses();
    });
  }

  // relationships helpers
  const personById = id => state.persons.find(p => p.id === id);
  const parentsOf = id => state.rels.filter(r => r.type === 'parent' && r.to_id === id).map(r => ({ rel: r, p: personById(r.from_id) }));
  const childrenOf = id => state.rels.filter(r => r.type === 'parent' && r.from_id === id).map(r => ({ rel: r, p: personById(r.to_id) }));
  const spousesOf = id => state.rels.filter(r => r.type === 'spouse' && (r.from_id === id || r.to_id === id)).map(r => ({ rel: r, p: personById(r.from_id === id ? r.to_id : r.from_id) }));
  const siblingsOf = id => { const ps = new Set(parentsOf(id).map(x => x.p?.id)); const s = new Map(); ps.forEach(pid => childrenOf(pid).forEach(c => { if (c.p && c.p.id !== id) s.set(c.p.id, c.p); })); return [...s.values()]; };

  // ---------- Side panel ----------
  function selectPerson(id) {
    state.selectedId = id; graph && graph.refreshClasses();
    const p = personById(id); const side = $('#side'); if (!p) { side.hidden = true; return; }
    side.hidden = false;
    const editable = canEdit();
    const fam = familyOf(p), col = colorFor(fam);
    const fact = (label, val) => val ? `<div><small>${label}</small>${esc(val)}</div>` : '';
    const relRow = (label, x) => x.p ? `<div class="rel-row"><span class="lbl">${label}</span><span class="dot" style="background:${colorFor(familyOf(x.p))}">${esc(initials(x.p)) || '?'}</span><a data-go="${x.p.id}">${esc(fullName(x.p))}</a>${editable && x.rel ? `<button class="x" title="Remove link" data-unlink="${x.rel.id}">×</button>` : ''}</div>` : '';
    side.innerHTML = `
      <div class="side-head">
        <div class="big-dot" style="background:${col}${p.photo_url ? `;background-image:url('${esc(p.photo_url)}')` : ''}">${p.photo_url ? '' : esc(initials(p)) || '?'}</div>
        <div><h2>${esc(fullName(p))}</h2><div class="sub">${[p.nickname && `“${esc(p.nickname)}”`, years(p), p.gender && p.gender[0].toUpperCase() + p.gender.slice(1)].filter(Boolean).join(' · ')}</div></div>
        <button class="side-close" title="Close" id="side-close">×</button>
      </div>
      <div class="facts">
        ${fact('Family', fam)}${fact('Maiden name', p.maiden_name)}${fact('Born', p.birth_date)}${fact('Died', p.death_date)}
        ${fact('Birthplace', p.birth_place)}${fact('Lives in', p.location)}${fact('Occupation', p.occupation)}
      </div>
      ${p.tags ? `<div class="chips">${p.tags.split(',').map(t => t.trim()).filter(Boolean).map(t => `<span class="badge">${esc(t)}</span>`).join('')}</div>` : ''}
      ${p.bio ? `<div class="bio">${esc(p.bio)}</div>` : ''}
      ${editable ? `<div class="actions">
        <button class="btn" data-add="parent">+ Parent</button><button class="btn" data-add="spouse">+ Partner</button>
        <button class="btn" data-add="child">+ Child</button><button class="btn" data-add="sibling">+ Sibling</button>
        <button class="btn" id="btn-link">🔗 Link existing</button><button class="btn" id="btn-edit">✎ Edit</button>
      </div>` : ''}
      <div class="section-title">Relationships</div>
      <div class="rel-list">
        ${parentsOf(id).map(x => relRow('Parent', x)).join('')}
        ${spousesOf(id).map(x => relRow('Partner', x)).join('')}
        ${siblingsOf(id).map(s => relRow('Sibling', { p: s })).join('')}
        ${childrenOf(id).map(x => relRow('Child', x)).join('')}
        ${!state.rels.some(r => r.from_id === id || r.to_id === id) ? '<div class="muted" style="font-size:13px">No relationships yet.</div>' : ''}
      </div>
      ${editable ? `<div style="margin-top:auto"><button class="btn danger sm" id="btn-del">Delete person</button></div>` : ''}`;
    $('#side-close').onclick = () => { state.selectedId = null; side.hidden = true; graph.refreshClasses(); };
    $$('[data-go]', side).forEach(a => a.onclick = () => { selectPerson(+a.dataset.go); focusNode(+a.dataset.go); });
    $$('[data-add]', side).forEach(b => b.onclick = () => personForm(null, { type: b.dataset.add, person_id: id }));
    $$('[data-unlink]', side).forEach(b => b.onclick = async () => {
      try { await del(treeUrl('/relationships/' + b.dataset.unlink)); state.rels = state.rels.filter(r => r.id !== +b.dataset.unlink); graph.update(); selectPerson(id); }
      catch (e) { toast(e.message, true); }
    });
    if (editable) {
      $('#btn-edit').onclick = () => personForm(p);
      $('#btn-link').onclick = () => linkModal(p);
      $('#btn-del').onclick = async () => {
        if (!await confirmModal(`Delete ${fullName(p)}?`, 'Their relationships will be removed too. This cannot be undone.')) return;
        try { await del(treeUrl('/persons/' + id)); state.persons = state.persons.filter(x => x.id !== id); state.rels = state.rels.filter(r => r.from_id !== id && r.to_id !== id); state.selectedId = null; side.hidden = true; graph.update(); renderLegend(); refreshEmpty(); toast('Deleted'); }
        catch (e) { toast(e.message, true); }
      };
    }
  }

  // ---------- Person form (add / edit) ----------
  function personForm(p, link) {
    const isEdit = !!p; p = p || {};
    const rel = link ? personById(link.person_id) : null;
    const defaultLast = rel && link.type !== 'spouse' ? rel.last_name : (rel ? '' : '');
    const title = isEdit ? `Edit ${fullName(p)}` : rel ? `Add ${link.type === 'spouse' ? 'partner' : link.type} of ${fullName(rel)}` : 'Add person';
    modal(`<h2>${esc(title)}</h2><form class="form" id="pf">
      <div class="row"><label>First name*<input name="first_name" type="text" required maxlength="200" value="${esc(p.first_name)}"></label>
      <label>Family name<input name="last_name" type="text" maxlength="200" value="${esc(p.last_name ?? defaultLast)}" placeholder="groups the bubble"></label></div>
      <div class="row"><label>Nickname<input name="nickname" type="text" maxlength="200" value="${esc(p.nickname)}"></label>
      <label>Maiden name<input name="maiden_name" type="text" maxlength="200" value="${esc(p.maiden_name)}"></label></div>
      <div class="row"><label>Gender<select name="gender" class="input">${['', 'female', 'male', 'other'].map(g => `<option value="${g}" ${p.gender === g ? 'selected' : ''}>${g ? g[0].toUpperCase() + g.slice(1) : '—'}</option>`).join('')}</select></label>
      <label>Occupation<input name="occupation" type="text" maxlength="200" value="${esc(p.occupation)}"></label></div>
      <div class="row"><label>Born <small>(YYYY or YYYY-MM-DD)</small><input name="birth_date" type="text" maxlength="20" value="${esc(p.birth_date)}" placeholder="1950-04-12"></label>
      <label>Died<input name="death_date" type="text" maxlength="20" value="${esc(p.death_date)}"></label></div>
      <div class="row"><label>Birthplace<input name="birth_place" type="text" maxlength="200" value="${esc(p.birth_place)}"></label>
      <label>Lives in<input name="location" type="text" maxlength="200" value="${esc(p.location)}"></label></div>
      <label>Tags <small>(comma separated)</small><input name="tags" type="text" maxlength="200" value="${esc(p.tags)}" placeholder="doctor, Bandung, twins"></label>
      <label>Photo URL<input name="photo_url" type="url" maxlength="2000" value="${esc(p.photo_url)}" placeholder="https://…"></label>
      <label>Notes / story<textarea name="bio" maxlength="4000">${esc(p.bio)}</textarea></label>
      <div class="close-row">${isEdit ? '' : ''}<button type="button" class="btn" data-close>Cancel</button><button class="btn primary" type="submit">${isEdit ? 'Save' : 'Add'}</button></div></form>`,
      (m, close) => {
        $('input', m).focus();
        $('#pf', m).onsubmit = async e => {
          e.preventDefault();
          const body = Object.fromEntries(new FormData(e.target));
          try {
            if (isEdit) {
              const d = await patch(treeUrl('/persons/' + p.id), body);
              Object.assign(personById(p.id), d.person);
            } else {
              if (link) body.link = link;
              const d = await post(treeUrl('/persons'), body);
              state.persons.push(d.person); state.rels.push(...d.relationships);
              state.selectedId = d.person.id;
            }
            close(); graph.update(); renderLegend(); refreshEmpty();
            selectPerson(state.selectedId); if (!isEdit) setTimeout(() => focusNode(state.selectedId), 400);
            toast(isEdit ? 'Saved' : 'Added');
          } catch (err) { toast(err.message, true); }
        };
      });
  }

  // ---------- Link existing people ----------
  function linkModal(p) {
    const others = state.persons.filter(x => x.id !== p.id);
    const render = q => others.filter(x => !q || fullName(x).toLowerCase().includes(q) || (x.nickname || '').toLowerCase().includes(q))
      .map(x => `<div class="res" data-id="${x.id}"><span class="dot" style="background:${colorFor(familyOf(x))}">${esc(initials(x)) || '?'}</span><span>${esc(fullName(x))} <small>${years(x)}</small></span></div>`).join('') || '<div class="none muted" style="padding:10px">No one found</div>';
    modal(`<h2>Link ${esc(fullName(p))} to…</h2>
      <label class="form" style="display:block"><input id="lq" type="search" placeholder="Type a name"></label>
      <div class="pick-list" id="pl">${render('')}</div>
      <div class="section-title" style="margin-top:12px">Relationship</div>
      <select id="ltype" class="input">
        <option value="parent-of">${esc(p.first_name)} is the parent of the selected person</option>
        <option value="child-of">${esc(p.first_name)} is the child of the selected person</option>
        <option value="spouse">${esc(p.first_name)} is the partner / spouse of the selected person</option>
      </select>
      <div class="close-row"><button class="btn" data-close>Cancel</button><button class="btn primary" id="lok" disabled>Link</button></div>`,
      (m, close) => {
        let picked = null;
        const pl = $('#pl', m);
        const bind = () => $$('.res', pl).forEach(r => r.onclick = () => { picked = +r.dataset.id; $$('.res', pl).forEach(x => x.classList.toggle('active', x === r)); $('#lok', m).disabled = false; });
        bind();
        $('#lq', m).oninput = e => { pl.innerHTML = render(e.target.value.trim().toLowerCase()); picked = null; $('#lok', m).disabled = true; bind(); };
        $('#lok', m).onclick = async () => {
          const t = $('#ltype', m).value;
          const body = t === 'spouse' ? { type: 'spouse', from_id: p.id, to_id: picked } : t === 'parent-of' ? { type: 'parent', from_id: p.id, to_id: picked } : { type: 'parent', from_id: picked, to_id: p.id };
          try { const d = await post(treeUrl('/relationships'), body); if (!state.rels.some(r => r.id === d.relationship.id)) state.rels.push(d.relationship); close(); graph.update(); selectPerson(p.id); toast('Linked'); }
          catch (err) { toast(err.message, true); }
        };
      });
  }

  // ---------- Share modal ----------
  async function openShare() {
    const t = state.tree;
    const link = mode => `${location.origin}/t/${t.slug}${mode === 'private' ? '' : '?share=' + t.share_token}`;
    modal(`<h2>Share “${esc(t.name)}”</h2>
      <div class="section-title">Link access</div>
      <select id="smode" class="input">
        <option value="private" ${t.share_mode === 'private' ? 'selected' : ''}>Private — only invited people</option>
        <option value="link-view" ${t.share_mode === 'link-view' ? 'selected' : ''}>Anyone with the link can view</option>
        <option value="link-edit" ${t.share_mode === 'link-edit' ? 'selected' : ''}>Anyone with the link can edit</option>
      </select>
      <div class="share-link" style="margin-top:8px"><input id="slink" type="text" readonly value="${esc(link(t.share_mode))}"><button class="btn" id="scopy">Copy</button></div>
      <p class="muted" style="font-size:13px;margin:6px 0 0">${t.share_mode === 'private' ? 'Switch to a link mode to let people open the tree without an invite.' : 'People with this link do not need an account. '}<button class="btn sm ghost" id="srotate">Reset link</button></p>
      <div class="section-title" style="margin-top:16px">Invite by email</div>
      <form id="sinv" class="share-link"><input name="email" type="email" required placeholder="relative@example.com"><select name="role" class="input" style="width:auto"><option value="viewer">Viewer</option><option value="editor">Editor</option></select><button class="btn primary" type="submit">Invite</button></form>
      <p class="muted" style="font-size:13px;margin:6px 0">They will see the tree under “My trees” after logging in with that email.</p>
      <div id="smembers"></div>
      <div class="section-title" style="margin-top:16px">Tree settings</div>
      <form id="sset" class="form">
        <label>Name<input name="name" type="text" value="${esc(t.name)}" required maxlength="80"></label>
        <label>Description<textarea name="description" maxlength="1000">${esc(t.description)}</textarea></label>
        <div class="close-row"><button class="btn danger" type="button" id="sdel">Delete tree</button><button class="btn" type="button" data-close>Close</button><button class="btn primary" type="submit">Save</button></div>
      </form>`,
      (m, close) => {
        const apply = d => { state.tree = d.tree; renderTopbar(); };
        const members = () => {
          $('#smembers', m).innerHTML = (state.tree.members || []).map(x => `<div class="member-row"><span>${esc(x.email)}</span><span class="badge ${x.role}">${x.role}</span><button class="x" data-rm="${esc(x.email)}" title="Remove">×</button></div>`).join('') || '<p class="muted" style="font-size:13px">No one invited yet.</p>';
          $$('[data-rm]', m).forEach(b => b.onclick = async () => { try { apply(await del(treeUrl('/members/' + encodeURIComponent(b.dataset.rm)))); members(); } catch (e) { toast(e.message, true); } });
        };
        members();
        $('#smode', m).onchange = async e => { try { apply(await patch(treeUrl(''), { share_mode: e.target.value })); $('#slink', m).value = link(state.tree.share_mode); toast('Sharing updated'); } catch (err) { toast(err.message, true); } };
        $('#scopy', m).onclick = () => { navigator.clipboard?.writeText($('#slink', m).value).then(() => toast('Link copied')).catch(() => { $('#slink', m).select(); document.execCommand('copy'); toast('Link copied'); }); };
        $('#srotate', m).onclick = async () => { try { apply(await post(treeUrl('/share/rotate'))); $('#slink', m).value = link(state.tree.share_mode); toast('Old links no longer work'); } catch (e) { toast(e.message, true); } };
        $('#sinv', m).onsubmit = async e => { e.preventDefault(); try { apply(await post(treeUrl('/members'), Object.fromEntries(new FormData(e.target)))); e.target.reset(); members(); toast('Invited'); } catch (err) { toast(err.message, true); } };
        $('#sset', m).onsubmit = async e => { e.preventDefault(); try { apply(await patch(treeUrl(''), Object.fromEntries(new FormData(e.target)))); toast('Saved'); } catch (err) { toast(err.message, true); } };
        $('#sdel', m).onclick = async () => { if (!await confirmModal('Delete this tree?', 'Every person and relationship in it will be permanently removed.')) return; try { await del(treeUrl('')); close(); navigate('/'); } catch (err) { toast(err.message, true); } };
      });
  }

  // ---------- Graph (D3) ----------
  function focusNode(id) { graph && graph.focus(id); }
  function createGraph(svgEl) {
    const svg = d3.select(svgEl);
    const root = svg.append('g');
    const gHull = root.append('g').attr('class', 'hulls');
    const gLink = root.append('g').attr('class', 'links');
    const gNode = root.append('g').attr('class', 'nodes');
    const tooltip = $('#tooltip');
    let nodes = [], links = [], nodeSel, linkSel, hullSel, labelSel;
    const zoom = d3.zoom().scaleExtent([0.15, 4]).on('zoom', e => root.attr('transform', e.transform));
    svg.call(zoom).on('dblclick.zoom', null);
    svg.on('click', () => { if (state.selectedId != null) { state.selectedId = null; $('#side').hidden = true; refreshClasses(); } });
    const size = () => svgEl.getBoundingClientRect();
    const radius = n => 22 + Math.min(10, 2 * (parentsOf(n.id).length + childrenOf(n.id).length + spousesOf(n.id).length));

    const sim = d3.forceSimulation().alphaDecay(0.03).velocityDecay(0.35)
      .force('charge', d3.forceManyBody().strength(-320))
      .force('collide', d3.forceCollide(n => radius(n) + 14).strength(0.9))
      .on('tick', tick);

    function generations() {
      // longest-path depth from roots; partners share a level
      const gen = new Map(); const ids = nodes.map(n => n.id);
      ids.forEach(id => gen.set(id, 0));
      for (let i = 0; i < ids.length + 2; i++) {
        let changed = false;
        for (const r of state.rels) {
          if (r.type === 'parent' && gen.has(r.from_id) && gen.has(r.to_id)) { const g = gen.get(r.from_id) + 1; if (g > gen.get(r.to_id) && g < 60) { gen.set(r.to_id, g); changed = true; } }
          if (r.type === 'spouse' && gen.has(r.from_id) && gen.has(r.to_id)) { const g = Math.max(gen.get(r.from_id), gen.get(r.to_id)); if (gen.get(r.from_id) !== g || gen.get(r.to_id) !== g) { gen.set(r.from_id, g); gen.set(r.to_id, g); changed = true; } }
        }
        if (!changed) break;
      }
      return gen;
    }

    function update() {
      const old = new Map(nodes.map(n => [n.id, n]));
      const { width, height } = size();
      nodes = state.persons.map(p => {
        const n = old.get(p.id) || { id: p.id, x: width / 2 + (Math.random() - .5) * 200, y: height / 2 + (Math.random() - .5) * 200 };
        n.p = p; n.fam = familyOf(p); return n;
      });
      const byId = new Map(nodes.map(n => [n.id, n]));
      links = state.rels.filter(r => byId.has(r.from_id) && byId.has(r.to_id)).map(r => ({ id: r.id, type: r.type, source: byId.get(r.from_id), target: byId.get(r.to_id) }));

      // family centroids for clustering
      const fams = [...new Set(nodes.map(n => n.fam))];
      const famCenter = new Map(); const R = Math.min(width, height) * 0.36;
      fams.forEach((f, i) => famCenter.set(f, { x: width / 2 + (fams.length > 1 ? R * Math.cos(i / fams.length * 2 * Math.PI) : 0), y: height / 2 + (fams.length > 1 ? R * Math.sin(i / fams.length * 2 * Math.PI) : 0) }));

      sim.nodes(nodes);
      sim.force('link', d3.forceLink(links).id(n => n.id).distance(l => l.type === 'spouse' ? 70 : 120).strength(l => l.type === 'spouse' ? 1 : 0.5));
      if (state.layout === 'generations') {
        const gen = generations();
        sim.force('y', d3.forceY(n => 90 + gen.get(n.id) * 150).strength(1));
        sim.force('x', d3.forceX(n => famCenter.get(n.fam).x).strength(0.05));
        sim.force('cluster', null); sim.force('center', null);
      } else {
        sim.force('y', null);
        sim.force('x', null);
        sim.force('cluster', alpha => { for (const n of nodes) { const c = famCenter.get(n.fam); n.vx += (c.x - n.x) * alpha * 0.12; n.vy += (c.y - n.y) * alpha * 0.12; } });
        sim.force('center', d3.forceCenter(width / 2, height / 2).strength(0.05));
      }

      linkSel = gLink.selectAll('line').data(links, l => l.id).join('line').attr('class', l => `link ${l.type}`);

      nodeSel = gNode.selectAll('g.node').data(nodes, n => n.id).join(enter => {
        const g = enter.append('g').attr('class', 'node');
        g.append('circle').attr('class', 'ring');
        g.append('circle').attr('class', 'body');
        g.append('image');
        g.append('text').attr('class', 'init');
        g.append('text').attr('class', 'name');
        g.call(d3.drag().on('start', (e, n) => { if (!e.active) sim.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; })
          .on('drag', (e, n) => { n.fx = e.x; n.fy = e.y; })
          .on('end', (e, n) => { if (!e.active) sim.alphaTarget(0); n.fx = null; n.fy = null; }));
        g.on('click', (e, n) => { e.stopPropagation(); selectPerson(n.id); })
          .on('dblclick', (e, n) => { e.stopPropagation(); if (canEdit()) personForm(n.p); })
          .on('mouseenter', (e, n) => { tooltip.innerHTML = `${esc(fullName(n.p))}<small>${[years(n.p), n.p.occupation].filter(Boolean).join(' · ') || n.fam}</small>`; tooltip.hidden = false; })
          .on('mousemove', e => { const r = svgEl.getBoundingClientRect(); tooltip.style.left = (e.clientX - r.left) + 'px'; tooltip.style.top = (e.clientY - r.top) + 'px'; })
          .on('mouseleave', () => tooltip.hidden = true);
        return g;
      });
      nodeSel.select('circle.body').attr('r', radius).attr('fill', n => colorFor(n.fam));
      nodeSel.select('circle.ring').attr('r', n => radius(n) + 5).style('display', n => n.p.gender === 'female' ? null : 'none');
      nodeSel.select('image').attr('href', n => n.p.photo_url || null).attr('x', n => -radius(n)).attr('y', n => -radius(n)).attr('width', n => radius(n) * 2).attr('height', n => radius(n) * 2).style('display', n => n.p.photo_url ? null : 'none');
      nodeSel.select('text.init').text(n => n.p.photo_url ? '' : initials(n.p).toUpperCase() || '?').attr('font-size', n => radius(n) * 0.7);
      nodeSel.select('text.name').text(n => fullName(n.p)).attr('y', n => radius(n) + 14);

      const famList = fams.map(f => ({ fam: f }));
      hullSel = gHull.selectAll('path').data(famList, d => d.fam).join('path').attr('class', 'family-hull').attr('fill', d => colorFor(d.fam)).attr('stroke', d => colorFor(d.fam));
      labelSel = gHull.selectAll('text').data(famList, d => d.fam).join('text').attr('class', 'family-label').attr('fill', d => colorFor(d.fam)).text(d => d.fam);

      gHull.classed('gen', state.layout === 'generations');
      refreshClasses();
      sim.alpha(0.9).restart();
    }

    function hullPath(pts) {
      // pad each node with a ring of points so single/dual-member families still get a rounded bubble
      const pad = 34; const cloud = [];
      for (const n of pts) for (let a = 0; a < 8; a++) cloud.push([n.x + (radius(n) + pad) * Math.cos(a / 8 * 2 * Math.PI), n.y + (radius(n) + pad) * Math.sin(a / 8 * 2 * Math.PI)]);
      const hull = d3.polygonHull(cloud); if (!hull) return '';
      return d3.line().curve(d3.curveCatmullRomClosed.alpha(0.6))(hull);
    }
    function tick() {
      linkSel.attr('x1', l => l.source.x).attr('y1', l => l.source.y).attr('x2', l => l.target.x).attr('y2', l => l.target.y);
      nodeSel.attr('transform', n => `translate(${n.x},${n.y})`);
      const groups = d3.group(nodes, n => n.fam);
      hullSel.attr('d', d => hullPath(groups.get(d.fam) || []));
      labelSel.attr('x', d => d3.mean(groups.get(d.fam) || [], n => n.x)).attr('y', d => d3.min(groups.get(d.fam) || [], n => n.y - radius(n)) - 46);
    }
    function refreshClasses() {
      if (!nodeSel) return;
      const hidden = state.hiddenFamilies, match = state.matchIds, sel = state.selectedId;
      const neigh = new Set(); if (sel != null) { neigh.add(sel); links.forEach(l => { if (l.source.id === sel) neigh.add(l.target.id); if (l.target.id === sel) neigh.add(l.source.id); }); }
      nodeSel.classed('selected', n => n.id === sel)
        .classed('match', n => match.has(n.id))
        .classed('deceased', n => !!n.p.death_date)
        .classed('dim', n => hidden.has(n.fam) || (match.size > 0 && !match.has(n.id)) || (sel != null && match.size === 0 && !neigh.has(n.id)));
      linkSel.classed('dim', l => hidden.has(l.source.fam) || hidden.has(l.target.fam) || (sel != null && !(l.source.id === sel || l.target.id === sel)) || (match.size > 0));
      hullSel.classed('dim', d => hidden.has(d.fam));
    }
    function fit() {
      if (!nodes.length) return;
      const { width, height } = size();
      const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
      const x0 = Math.min(...xs) - 90, x1 = Math.max(...xs) + 90, y0 = Math.min(...ys) - 90, y1 = Math.max(...ys) + 90;
      const k = Math.max(0.15, Math.min(1.6, 0.92 / Math.max((x1 - x0) / width, (y1 - y0) / height)));
      svg.transition().duration(500).call(zoom.transform, d3.zoomIdentity.translate(width / 2 - k * (x0 + x1) / 2, height / 2 - k * (y0 + y1) / 2).scale(k));
    }
    function focus(id) {
      const n = nodes.find(x => x.id === id); if (!n) return;
      const { width, height } = size(); const k = 1.3;
      svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity.translate(width / 2 - k * n.x, height / 2 - k * n.y).scale(k));
    }
    const onResize = () => { sim.alpha(0.3).restart(); };
    window.addEventListener('resize', onResize);
    return { update, refreshClasses, fit, focus, destroy() { sim.stop(); window.removeEventListener('resize', onResize); } };
  }

  // ---------- boot ----------
  (async () => {
    try { state.user = (await get('/api/auth/me')).user; } catch { state.user = null; }
    route();
  })();
})();
