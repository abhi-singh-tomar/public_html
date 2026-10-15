/* Paribesh Bandhu — Jury Portal (vanilla JS PWA) */
(function () {
  'use strict';

  const CFG = window.APP_CONFIG;
  const DEMO = !CFG.API_URL || /PASTE_/.test(CFG.API_URL);
  const JSPDF_URL = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const app = $('#app');
  const ALL_FIELDS = CFG.SECTIONS.flatMap(s => s.fields);
  const SCORE_FIELDS = CFG.SECTIONS.filter(s => s.scoring).flatMap(s => s.fields);
  const SCORE_MAX = SCORE_FIELDS.reduce((a, f) => a + (f.max || 0), 0);
  /** Sum of the marks entered in a form's data, or null when no marks were given. */
  const scoreTotal = data => {
    const vals = SCORE_FIELDS.map(f => (data || {})[f.key]).filter(x => x !== '' && x != null && !isNaN(x));
    return vals.length ? Math.round(vals.reduce((a, x) => a + Number(x), 0) * 100) / 100 : null;
  };
  const marksText = n => n == null ? '—' : `${n} / ${SCORE_MAX}`;

  const S = { token: null, user: null, submissions: [], submission: null, files: [], imgCache: {}, adminMembers: null };

  /* ---------------- storage (safe) ---------------- */
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
    del(k) { try { localStorage.removeItem(k); } catch (e) {} }
  };

  /* ---------------- utils ---------------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = iso => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? iso : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };
  const kb = n => n >= 1024 ? (n / 1024).toFixed(1) + ' MB' : Math.round(n) + ' KB';
  const ext = n => (String(n).split('.').pop() || '').slice(0, 4).toUpperCase();
  const statusBadge = s => `<span class="badge ${s === 'Submitted' ? 'b-submitted' : s === 'Draft' ? 'b-draft' : 'b-none'}">${esc(s || 'Not started')}</span>`;

  function toast(msg, err) {
    const t = $('#toast'); t.textContent = msg; t.className = 'toast' + (err ? ' err' : ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), err ? 5000 : 2800);
  }
  function busy(on, msg) { $('#overlay').hidden = !on; $('#overlayMsg').textContent = msg || 'Please wait…'; }

  const fileToBase64 = f => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = rej; r.readAsDataURL(f); });
  const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });

  /* ---------------- API ---------------- */
  async function api(action, payload = {}) {
    const body = Object.assign({ action, token: S.token }, payload);
    let res;
    if (DEMO) res = await Mock.handle(body);
    else {
      let r;
      try {
        r = await fetch(CFG.API_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), redirect: 'follow' });
      } catch (e) { throw new Error('No internet connection. Please try again.'); }
      try { res = await r.json(); } catch (e) { throw new Error('Server error. Please try again.'); }
    }
    if (!res.ok) {
      if (res.code === 'AUTH') { logout(true); }
      throw new Error(res.error || 'Something went wrong');
    }
    return res;
  }

  /* ---------------- session ---------------- */
  function saveSession() { store.set('pbj_session', { token: S.token, user: S.user }); }
  function logout(expired) {
    S.token = null; S.user = null; S.submissions = []; S.submission = null; S.files = []; S.imgCache = {}; S.adminMembers = null; S.adminEdit = null; S.storage = null;
    store.del('pbj_session');
    $('#topbar').hidden = true;
    renderLogin();
    if (expired) toast('Session expired — please log in again', true);
  }

  async function boot() {
    $('#brandName').textContent = CFG.APP_NAME;
    $('#brandSub').textContent = CFG.APP_SUBTITLE;
    $('#demoBanner').hidden = !DEMO;
    setupMenu();
    setupInstall();
    const sess = store.get('pbj_session');
    if (sess && sess.token) {
      S.token = sess.token; S.user = sess.user;
      try { await loadMe(); route(); return; } catch (e) { /* falls through */ }
    }
    renderLogin();
  }

  async function loadMe() {
    const r = await api('me');
    S.user = r.user; S.submissions = r.submissions || []; S.storage = r.storage || null;
    saveSession();
  }

  function route() {
    $('#topbar').hidden = false;
    $('#who').textContent = S.user.name || S.user.email;
    if (S.user.role === 'admin') return renderAdmin();
    renderMember();
  }

  function setupMenu() {
    const m = $('#menu');
    $('#menuBtn').onclick = e => { e.stopPropagation(); m.hidden = !m.hidden; };
    document.addEventListener('click', () => (m.hidden = true));
    m.onclick = e => {
      const a = e.target.dataset.act;
      if (a === 'logout') logout();
      if (a === 'profile') { S.adminEdit = null; renderProfile(); }
    };
  }

  /* ================================================================
   *  MY PROFILE (jury member edits their own details)
   * ================================================================ */
  function renderProfile() {
    const u = S.user;
    app.innerHTML = `
      <div class="login-wrap"><div class="login" style="max-width:460px">
        <div class="card" style="text-align:left">
          <h1>My profile</h1>
          <p class="muted small" style="margin-top:0">New committee forms are pre-filled with these details.</p>
          <form id="profForm" novalidate>
            <div class="field"><label for="pPhone">Mobile number (login)</label><input id="pPhone" type="tel" value="${esc(u.phone || u.email)}" readonly>
              <div class="hint">To change your login number, please contact the organising team.</div></div>
            <div class="field"><label for="pName">Full name <span class="req">*</span></label><input id="pName" type="text" autocomplete="name" value="${esc(u.name || '')}"></div>
            <div class="field"><label for="pEmail">Email</label><input id="pEmail" type="email" autocomplete="email" value="${esc(u.contactEmail || '')}" placeholder="Optional"></div>
            <div class="field"><label for="pAlt">Alternate mobile</label><input id="pAlt" type="tel" inputmode="tel" value="${esc(u.altPhone || '')}" placeholder="Optional"></div>
            <div class="field"><label for="pArea">Area you will visit</label><input id="pArea" type="text" value="${esc(u.area || '')}" placeholder="e.g. Behala, Joka"></div>
            <div class="row">
              <button type="button" class="btn btn-ghost" id="pCancel">Cancel</button>
              <button class="btn btn-primary" type="submit" style="flex:1">Save profile</button>
            </div>
          </form>
        </div>
      </div></div>`;
    $('#pCancel').onclick = route;
    $('#profForm').onsubmit = async e => {
      e.preventDefault();
      const name = $('#pName').value.trim(), email = $('#pEmail').value.trim();
      if (!name) return toast('Enter your full name', true);
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return toast('Enter a valid email or leave it blank', true);
      busy(true, 'Saving…');
      try {
        const r = await api('updateProfile', { name, contactEmail: email, altPhone: $('#pAlt').value.trim(), area: $('#pArea').value.trim() });
        S.user = r.user; saveSession();
        toast('Profile updated ✓'); route();
      } catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
  }

  /* ---------------- install prompt ---------------- */
  function setupInstall() {
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
    const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (standalone || store.get('pbj_install_dismissed')) return;
    const tip = $('#installTip');
    const show = html => { tip.innerHTML = html + '<button class="btn-icon" id="tipX" aria-label="Dismiss" style="margin-left:auto">✕</button>'; tip.hidden = false; $('#tipX').onclick = () => { tip.hidden = true; store.set('pbj_install_dismissed', true); }; };
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      show('<img src="icons/icon-192.png" width="34" height="34" alt=""><span>Add the Jury Portal to your home screen</span><button class="btn btn-primary btn-sm" id="doInstall">Install</button>');
      $('#doInstall').onclick = async () => { tip.hidden = true; e.prompt(); };
    });
    const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    if (ios) setTimeout(() => show('<img src="icons/icon-192.png" width="34" height="34" alt=""><span>Install: tap <b>Share</b> <span aria-hidden="true">⎋</span> then <b>Add to Home Screen</b></span>'), 1500);
  }

  /* ================================================================
   *  LOGIN
   * ================================================================ */
  function renderLogin() {
    app.innerHTML = `
      <div class="login-wrap"><div class="login">
        <img class="logo" src="icons/logo-480.png" alt="${esc(CFG.APP_NAME)} logo">
        <h1>${esc(CFG.APP_NAME)}</h1>
        <div class="tag">${esc(CFG.APP_SUBTITLE)}</div>
        <div class="card">
          <form id="loginForm" novalidate>
            <div class="field"><label for="lPhone">Mobile number</label>
              <input id="lPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="10-digit mobile" required></div>
            <button class="btn btn-primary btn-block" type="submit">Log in</button>
          </form>
          <button type="button" class="btn btn-ghost btn-block" id="goRegister" style="margin-top:12px">New jury member? Register</button>
        </div>
        <div class="foot muted small">${CFG.ORG_URL ? `<a href="${esc(CFG.ORG_URL)}" target="_blank" rel="noopener">${esc(CFG.ORG_NAME)}</a>` : esc(CFG.ORG_NAME)}</div>
      </div></div>`;
    $('#goRegister').onclick = renderRegister;
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const phone = $('#lPhone').value.replace(/\D/g, '').slice(-10);
      if (phone.length !== 10) return toast('Enter your 10-digit mobile number', true);
      busy(true, 'Logging in…');
      try {
        const r = await api('loginByPhone', { phone });
        S.token = r.token; S.user = r.user; saveSession();
        await loadMe(); route();
      } catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
  }

  /* ================================================================
   *  SELF-REGISTRATION (admin approves)
   * ================================================================ */
  function renderRegister() {
    app.innerHTML = `
      <div class="login-wrap"><div class="login" style="max-width:460px">
        <img class="logo" src="icons/logo-480.png" alt="" style="width:110px;height:110px">
        <div class="card" style="text-align:left">
          <h1>Register as a jury member</h1>
          <p class="muted small" style="margin-top:0">The organising team will review and approve your registration. After approval, log in with your <b>mobile number</b>.</p>
          <form id="regForm" novalidate>
            <div class="field"><label for="rName">Full name <span class="req">*</span></label><input id="rName" type="text" autocomplete="name"></div>
            <div class="field"><label for="rPhone">Mobile number <span class="req">*</span></label><input id="rPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="10-digit mobile"></div>
            <div class="field"><label for="rEmail">Email</label><input id="rEmail" type="email" autocomplete="email" placeholder="Optional"></div>
            <div class="field"><label for="rArea">Area you will visit <span class="req">*</span></label><input id="rArea" type="text" placeholder="e.g. Behala, Joka"></div>
            <div class="field"><label for="rRef">Referred by</label><input id="rRef" type="text" placeholder="Optional"></div>
            <button class="btn btn-primary btn-block" type="submit">Submit registration</button>
          </form>
          <div id="regDone" hidden><div class="notice" id="regMsg"></div></div>
          <button class="btn btn-ghost btn-block" type="button" id="backLogin2" style="margin-top:10px">← Back to login</button>
        </div>
      </div></div>`;
    $('#backLogin2').onclick = renderLogin;
    $('#regForm').onsubmit = async e => {
      e.preventDefault();
      const name = $('#rName').value.trim(), phone = $('#rPhone').value.trim(), area = $('#rArea').value.trim();
      if (!name) return toast('Enter your full name', true);
      if (phone.replace(/\D/g, '').length < 10) return toast('Enter a valid 10-digit mobile number', true);
      if (!area) return toast('Enter the area you will visit', true);
      busy(true, 'Submitting…');
      try {
        const r = await api('register', { name, phone, emailAddr: $('#rEmail').value.trim(), area, reference: $('#rRef').value.trim() });
        $('#regForm').hidden = true; $('#regDone').hidden = false; $('#regMsg').textContent = r.message;
      } catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
  }

  /* ================================================================
   *  JURY MEMBER VIEW
   * ================================================================ */
  function draftKey() { return 'pbj_draft_' + S.user.email + '_' + (S.submission ? S.submission.id : 'new'); }

  /** "My committees": every committee form this jury member has started. */
  function renderMember() {
    const list = S.submissions || [];
    app.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <div><h1>Your committee reports</h1><div class="muted small">One form per committee — each committee gets its own folder for photos &amp; documents.</div></div>
        <div class="spacer"></div><button class="btn btn-primary" id="newSub">+ New committee</button>
      </div>
      ${S.storage ? `<div class="card" style="padding:12px 16px">${storageHTML(S.storage)}</div>` : ''}
      <div class="card">${list.length ? `<div class="table-wrap"><table class="responsive"><thead><tr><th>Committee</th><th>Area</th><th>Status</th><th>Marks</th><th>Files</th><th>Updated</th></tr></thead><tbody>
        ${list.map(s => `<tr class="click" data-id="${esc(s.id)}"><td data-l="Committee"><b>${esc(s.committeeName || '—')}</b></td><td data-l="Area">${esc(s.area || '—')}</td>
          <td data-l="Status">${statusBadge(s.status)}</td><td data-l="Marks">${marksText(s.marks)}</td><td data-l="Files">${s.photos} 📷 · ${s.videos || 0} 🎥 · ${s.documents} 📎</td><td data-l="Updated">${fmtDate(s.updatedAt)}</td></tr>`).join('')}
        </tbody></table></div>` : '<div class="muted">No committee forms yet. Tap <b>+ New committee</b> to start.</div>'}</div>`;
    $('#newSub').onclick = () => openSubmission(null);
    $$('tr.click', app).forEach(tr => tr.onclick = () => openSubmission(tr.dataset.id));
  }

  async function openSubmission(id) {
    if (!id) { S.submission = null; S.files = []; return renderSubmission(); }
    busy(true, 'Loading…');
    try { const r = await api('getSubmission', { id }); S.submission = r.submission; S.files = r.files || []; if (r.storage) S.storage = r.storage; renderSubmission(); }
    catch (err) { toast(err.message, true); }
    finally { busy(false); }
  }

  async function backToList() {
    busy(true, 'Loading…');
    try { await loadMe(); } catch (err) { toast(err.message, true); }
    finally { busy(false); }
    S.submission = null; S.files = [];
    renderMember();
  }

  function currentValues() {
    const saved = (S.submission && S.submission.data) || {};
    const local = store.get(draftKey()) || {};
    const v = {};
    ALL_FIELDS.forEach(f => {
      let val = local[f.key] != null ? local[f.key] : saved[f.key];
      // pre-fill from the member's profile — never when an admin is editing someone else's form
      let pre = f.prefill && !S.adminEdit ? (S.user[f.prefill] || '') : '';
      if (f.prefill === 'phone' && !pre && !S.adminEdit && !/@/.test(S.user.email)) pre = S.user.email;
      if ((val == null || val === '') && pre) val = pre;
      if (f.readonly && f.prefill && pre) val = pre;
      v[f.key] = val == null ? '' : val;
    });
    return v;
  }

  function fieldHTML(f, val) {
    const id = 'f_' + f.key;
    const req = f.required ? ' <span class="req">*</span>' : '';
    const common = `id="${id}" name="${esc(f.key)}" ${f.required ? 'required' : ''} ${f.readonly ? 'readonly' : ''}`;
    let input;
    if (f.type === 'textarea') input = `<textarea ${common} rows="${f.rows || 3}">${esc(val)}</textarea>`;
    else if (f.type === 'select') input = `<select ${common}><option value="">Select…</option>${(f.options || []).map(o => `<option ${o === val ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`;
    else if (f.type === 'number') input = `<input ${common} type="number" inputmode="decimal" min="0"${f.max != null ? ` max="${f.max}"` : ''} step="any" value="${esc(val)}" placeholder="${f.max != null ? '0 – ' + f.max : ''}">`;
    else input = `<input ${common} type="${f.type || 'text'}" value="${esc(val)}" ${f.type === 'tel' ? 'inputmode="tel" autocomplete="tel"' : ''}>`;
    const max = f.max != null ? ` <span class="muted small">(max ${f.max})</span>` : '';
    return `<div class="field"><label for="${id}">${esc(f.label)}${max}${req}</label>${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  }

  function sectionHTML(s, v) {
    return `<div class="section-title"><span class="dot"></span><h2 style="margin:0">${esc(s.title)}</h2></div>
      ${s.hint ? `<p class="muted small" style="margin:-4px 0 10px">${esc(s.hint)}</p>` : ''}
      ${s.fields.map(f => fieldHTML(f, v[f.key])).join('')}
      ${s.scoring ? `<div class="notice" style="margin-top:4px"><b>Total marks: <span id="scoreTotal">${marksText(scoreTotal(v))}</span></b></div>` : ''}`;
  }

  /** One committee form (new when S.submission is null). With S.adminEdit set, an admin is editing a jury member's form. */
  function renderSubmission() {
    const v = currentValues();
    const sub = S.submission, adm = S.adminEdit;
    const status = sub ? sub.status : 'Not started';
    app.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="backList" style="margin-bottom:12px">${adm ? '← Back to committee' : '← My committees'}</button>
      <div class="row" style="margin-bottom:12px">
        <div><h1>${sub ? esc(sub.committeeName || 'Committee') : 'New committee'}</h1><div class="muted small">${sub ? 'Last saved ' + fmtDate(sub.updatedAt) : 'Fill in the details and add photographs, videos & documents.'}${adm ? ' · Jury: ' + esc(adm.member.name || adm.email) : ''}</div></div>
        <div class="spacer"></div>${statusBadge(status)}
      </div>
      ${adm ? '<div class="notice warn">You are editing this form as <b>admin</b>. Changes to details and files are saved to the jury member\'s form and logged.</div>'
        : status === 'Submitted' ? '<div class="notice">Submitted. You can still update details or add files — changes are logged. <button type="button" class="btn btn-primary btn-sm" id="another" style="margin-left:6px">+ Start another committee</button></div>' : ''}
      <div class="grid grid-main">
        <form class="card" id="subForm" novalidate>
          ${CFG.SECTIONS.map(s => sectionHTML(s, v)).join('')}
          <div class="actions-bar sticky-m">
            ${adm ? '<button type="submit" class="btn btn-primary">Save changes</button>' : `
            <button type="button" class="btn btn-ghost" id="saveDraft">Save draft</button>
            <button type="submit" class="btn btn-primary">${status === 'Submitted' ? 'Update submission' : 'Submit'}</button>`}
          </div>
        </form>
        <div class="sticky-col">
          <div class="card">
            <div class="row"><h2 style="margin:0">Photographs</h2><div class="spacer"></div><span class="muted small" id="photoCount"></span></div>
            <p class="muted small" style="margin:4px 0 10px">Photos are compressed automatically before upload.</p>
            <div class="drop" id="photoDrop">
              <div class="row" style="justify-content:center">
                <label class="btn btn-accent btn-sm">📷 Take photo<input type="file" accept="image/*" capture="environment" id="camIn" hidden></label>
                <label class="btn btn-ghost btn-sm">🖼 Choose photos<input type="file" accept="image/*" multiple id="photoIn" hidden></label>
              </div>
              <div class="muted small" style="margin-top:6px">or drag & drop here</div>
            </div>
            <div class="progress" id="photoProg" hidden><div></div></div>
            <div class="thumbs" id="thumbs"></div>
          </div>
          <div class="card">
            <div class="row"><h2 style="margin:0">Videos</h2><div class="spacer"></div><span class="muted small" id="videoCount"></span></div>
            <p class="muted small" style="margin:4px 0 10px">Up to ${CFG.MAX_VIDEOS} videos · max ${CFG.MAX_VIDEO_MB} MB each.${canCompressVideo() ? ' Large videos are compressed on this device first, which can take a few minutes.' : ''} Keep this screen open until the upload finishes.</p>
            <div class="drop" id="videoDrop">
              <div class="row" style="justify-content:center">
                <label class="btn btn-accent btn-sm">🎥 Record video<input type="file" accept="video/*" capture="environment" id="vidCam" hidden></label>
                <label class="btn btn-ghost btn-sm">🎞 Choose videos<input type="file" accept="video/*" multiple id="vidIn" hidden></label>
              </div>
            </div>
            <div class="progress" id="videoProg" hidden><div></div></div>
            <div class="row" style="margin-top:6px"><span class="muted small" id="videoStatus" aria-live="polite"></span><div class="spacer"></div>
              <button type="button" class="btn btn-ghost btn-sm" id="videoCancel" hidden>Cancel upload</button></div>
            <div id="videoPending"></div>
            <ul class="files" id="videoList"></ul>
            <div id="storageBox" style="margin-top:10px"></div>
          </div>
          <div class="card">
            <h2>Documents</h2>
            <p class="muted small" style="margin:4px 0 10px">PDF, Word, Excel, PowerPoint or images · up to ${CFG.MAX_DOC_MB} MB each</p>
            <div class="drop" id="docDrop">
              <label class="btn btn-ghost btn-sm">📎 Add documents<input type="file" multiple id="docIn" hidden
                accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,image/*,application/pdf"></label>
            </div>
            <div class="progress" id="docProg" hidden><div></div></div>
            <ul class="files" id="docList"></ul>
          </div>
          <div class="card">
            <h2>Report</h2>
            <p class="muted small" style="margin:4px 0 10px">Download a PDF of your submitted details with photographs.</p>
            <button class="btn btn-ghost btn-block" id="pdfBtn" ${sub ? '' : 'disabled'}>⬇ Download PDF report</button>
          </div>
        </div>
      </div>`;

    $('#backList').onclick = () => {
      if (!adm) return backToList();
      S.adminEdit = null; renderAdminSubmission(adm.email, sub.id);
    };
    if ($('#another')) $('#another').onclick = () => openSubmission(null);
    const form = $('#subForm');
    form.addEventListener('input', () => {
      const d = readForm();
      store.set(draftKey(), d);
      if ($('#scoreTotal')) $('#scoreTotal').textContent = marksText(scoreTotal(d));
    });
    if ($('#saveDraft')) $('#saveDraft').onclick = () => saveSubmission('Draft');
    form.onsubmit = e => { e.preventDefault(); saveSubmission(adm ? sub.status : 'Submitted'); };

    const photoHandler = async files => uploadMany(files, 'photo');
    $('#camIn').onchange = e => { photoHandler(e.target.files); e.target.value = ''; };
    $('#photoIn').onchange = e => { photoHandler(e.target.files); e.target.value = ''; };
    $('#docIn').onchange = e => { uploadMany(e.target.files, 'document'); e.target.value = ''; };
    $('#vidCam').onchange = e => { uploadMany(e.target.files, 'video'); e.target.value = ''; };
    $('#vidIn').onchange = e => { uploadMany(e.target.files, 'video'); e.target.value = ''; };
    setupDrop($('#photoDrop'), fs => photoHandler(fs));
    setupDrop($('#videoDrop'), fs => uploadMany(fs, 'video'));
    setupDrop($('#docDrop'), fs => uploadMany(fs, 'document'));
    $('#pdfBtn').onclick = () => makePdf(adm ? adm.member : S.user, S.submission, S.files);
    $('#videoCancel').onclick = cancelVideo;
    renderFiles(); updateStorageUI(); renderPendingUploads();
    if (VUP.active) vprog.set(0, 'Upload in progress…');   // re-rendered while a video is uploading
  }

  function setupDrop(el, cb) {
    ['dragenter', 'dragover'].forEach(t => el.addEventListener(t, e => { e.preventDefault(); el.classList.add('drag'); }));
    ['dragleave', 'drop'].forEach(t => el.addEventListener(t, e => { e.preventDefault(); el.classList.remove('drag'); }));
    el.addEventListener('drop', e => cb(e.dataTransfer.files));
  }

  function readForm() {
    const d = {};
    ALL_FIELDS.forEach(f => { const el = $('#f_' + f.key); if (el) d[f.key] = el.value.trim(); });
    return d;
  }

  /** Returns '' when the form is OK, otherwise the message to show (and highlights the first bad field). */
  function validate(all) {
    let firstBad = null, msg = '';
    ALL_FIELDS.forEach(f => {
      const el = $('#f_' + f.key); if (!el) return;
      const val = el.value.trim();
      const need = all ? f.required : (f.key === 'committeeName' || f.key === 'area');
      let bad = need && !val, why = '';
      if (bad) why = all ? 'Please fill all required fields' : 'Committee name and area are needed to save';
      // input type=number reports badInput when the browser can't parse what was typed
      else if (f.type === 'number' && (el.validity && el.validity.badInput || (val && (isNaN(val) || Number(val) < 0 || (f.max != null && Number(val) > f.max))))) {
        bad = true; why = `${f.label}: marks must be between 0 and ${f.max}`;
      }
      el.classList.toggle('invalid', bad);
      if (bad && !firstBad) { firstBad = el; msg = why; }
    });
    if (firstBad) { firstBad.focus(); firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    return msg;
  }

  async function saveSubmission(status, quiet) {
    const problem = validate(status === 'Submitted');
    if (problem) { toast(problem, true); return false; }
    busy(true, status === 'Submitted' ? 'Submitting…' : 'Saving…');
    try {
      const key = draftKey();
      const r = await api('saveSubmission', { id: S.submission ? S.submission.id : '', data: readForm(), status });
      S.submission = r.submission; S.files = r.files || S.files; S.submissions = r.submissions || S.submissions;
      store.del(key);
      if (!quiet) { toast(S.adminEdit ? 'Changes saved ✓' : status === 'Submitted' ? 'Committee submitted ✓' : 'Draft saved'); renderSubmission(); }
      return true;
    } catch (err) { toast(err.message, true); return false; }
    finally { busy(false); }
  }

  /* ---------------- uploads ---------------- */
  async function uploadMany(fileList, kind) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (kind === 'video' && VUP.active) return toast('Please wait until the current video has finished uploading', true);
    if (!S.submission) {
      const ok = await saveSubmission('Draft', true);
      if (!ok) return;
      const keep = readForm(); renderSubmission(); fillForm(keep);
    }
    if (kind === 'photo') {
      const have = S.files.filter(f => f.kind === 'photo').length;
      if (have + files.length > CFG.MAX_PHOTOS) return toast(`Maximum ${CFG.MAX_PHOTOS} photos per committee`, true);
    }
    if (kind === 'video') {
      const have = S.files.filter(f => f.kind === 'video').length;
      if (have + files.length > CFG.MAX_VIDEOS) return toast(`Maximum ${CFG.MAX_VIDEOS} videos per committee`, true);
      return uploadVideos(files);
    }
    const prog = $(kind === 'photo' ? '#photoProg' : '#docProg');
    prog.hidden = false; const bar = prog.firstElementChild;
    let done = 0, failed = 0;
    window.onbeforeunload = () => 'An upload is still in progress.';
    for (const f of files) {
      bar.style.width = Math.round((done / files.length) * 100 + 5) + '%';
      try {
        let payload;
        if (kind === 'photo') {
          if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) throw new Error(f.name + ' is not an image');
          const cap = await photoCaptureTime(f);   // read before compression strips the camera data
          const blob = await compressImage(f);
          const b64 = await fileToBase64(blob);
          payload = { kind, name: f.name.replace(/\.[^.]+$/, '') + '.jpg', mimeType: 'image/jpeg', base64: b64, capturedAt: cap.at, captureSource: cap.src, originalSize: f.size };
          S._lastPhotoData = 'data:image/jpeg;base64,' + b64;
        } else {
          if (f.size > CFG.MAX_DOC_MB * 1048576) throw new Error(f.name + ' is larger than ' + CFG.MAX_DOC_MB + ' MB');
          let blob = f, mime = f.type || guessMime(f.name), name = f.name;
          if (/^image\//.test(mime)) { blob = await compressImage(f); mime = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + '.jpg'; }
          payload = { kind, name, mimeType: mime, base64: await fileToBase64(blob) };
        }
        const before = new Set(S.files.map(x => x.id));
        payload.submissionId = S.submission.id;
        const r = await api('uploadFile', payload);
        S.files = r.files; if (r.storage) S.storage = r.storage;
        if (kind === 'photo') { const nf = S.files.find(x => !before.has(x.id)); if (nf) S.imgCache[nf.id] = S._lastPhotoData; }
      } catch (err) { failed++; toast(err.message, true); }
      done++;
      bar.style.width = Math.round((done / files.length) * 100) + '%';
      renderFiles(); updateStorageUI();
    }
    window.onbeforeunload = null;
    setTimeout(() => { prog.hidden = true; bar.style.width = '0'; }, 600);
    if (done - failed > 0) toast(`${done - failed} file${done - failed > 1 ? 's' : ''} uploaded ✓`);
    S.submission && (S.submission.updatedAt = new Date().toISOString());
  }

  /* ---------------- videos: compress → upload in pieces → resume / cancel ---------------- */
  const VUP = { active: null };   // the running video job: { cancelled, conv, uploadId }
  const MB_ = 1048576;
  const fmtMB = mb => mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : (mb >= 10 ? Math.round(mb) : (Math.round(mb * 10) / 10)) + ' MB';
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const cancelErr = () => Object.assign(new Error('Upload cancelled'), { cancelled: true });

  /** Progress bar + status line + Cancel button of the Videos card (looked up each time, so re-renders are safe). */
  const vprog = {
    set(frac, text) {
      const p = $('#videoProg'); if (p) { p.hidden = false; p.firstElementChild.style.width = Math.max(2, Math.round(frac * 100)) + '%'; }
      const s = $('#videoStatus'); if (s) s.textContent = text || '';
      const c = $('#videoCancel'); if (c) c.hidden = false;
    },
    done() {
      const p = $('#videoProg'); if (p) { p.hidden = true; p.firstElementChild.style.width = '0'; }
      const s = $('#videoStatus'); if (s) s.textContent = '';
      const c = $('#videoCancel'); if (c) c.hidden = true;
    }
  };
  function cancelVideo() {
    const job = VUP.active; if (!job) return;
    if (!confirmBox('Cancel this video upload?')) return;
    job.cancelled = true;
    if (job.conv) job.conv.cancel().catch(() => {});
    const s = $('#videoStatus'); if (s) s.textContent = 'Cancelling…';
  }
  async function keepAwake(on) {   // stop the phone screen from sleeping mid-upload (where supported)
    try {
      if (on && 'wakeLock' in navigator && !S.wake) S.wake = await navigator.wakeLock.request('screen');
      if (!on && S.wake) { await S.wake.release(); S.wake = null; }
    } catch (e) { S.wake = null; }
  }

  async function uploadVideos(files) {
    window.onbeforeunload = () => 'A video upload is still in progress.';
    keepAwake(true);
    let ok = 0;
    for (let i = 0; i < files.length; i++) {
      const tag = files.length > 1 ? `Video ${i + 1} of ${files.length} · ` : '';
      try {
        const r = await uploadVideo(files[i], (p, t) => vprog.set(p, tag + t));
        S.files = r.files; if (r.storage) S.storage = r.storage; ok++;
        renderFiles(); updateStorageUI();
      } catch (e) {
        if (e.cancelled) { toast('Upload cancelled'); break; }
        toast(e.message, true);
      }
    }
    vprog.done(); renderPendingUploads();
    window.onbeforeunload = null; keepAwake(false);
    if (ok) toast(`${ok} video${ok > 1 ? 's' : ''} uploaded ✓`);
    S.submission && (S.submission.updatedAt = new Date().toISOString());
  }

  /** One video: compress when worthwhile, then send it in pieces. onProg(fraction, text). */
  async function uploadVideo(f, onProg) {
    const mime = /^video\//.test(f.type) ? f.type : guessMime(f.name);
    if (!/^video\//.test(mime)) throw new Error(f.name + ' is not a video');
    if (f.size > CFG.MAX_VIDEO_MB * MB_) throw new Error(`${f.name} is larger than ${CFG.MAX_VIDEO_MB} MB`);
    const job = VUP.active = { cancelled: false, conv: null, uploadId: null };
    try {
      const cap = await videoCaptureTime(f);   // from the original file, before compression
      let blob = f, compressed = false, name = f.name, type = mime;
      if (canCompressVideo() && f.size > CFG.VIDEO_COMPRESS.overMB * MB_) {
        onProg(0, `Preparing to compress ${f.name}…`);
        try {
          const out = await compressVideo(f, p => onProg(p * 0.5, `Compressing ${f.name} — ${Math.round(p * 100)}% (keep this screen open)`), job);
          if (job.cancelled) throw cancelErr();
          if (out && out.size < f.size * 0.9) {
            blob = out; compressed = true; type = 'video/mp4'; name = f.name.replace(/\.[^.]+$/, '') + '.mp4';
            toast(`Compressed ${fmtMB(f.size / MB_)} → ${fmtMB(out.size / MB_)}`);
          }
        } catch (e) {
          if (job.cancelled || (e && e.name === 'ConversionCanceledError')) throw cancelErr();
          console.warn('Video compression failed, uploading the original', e);
          toast('This phone could not compress the video — uploading the original instead');
        }
      }
      if (job.cancelled) throw cancelErr();
      const st = await api('uploadStart', { submissionId: S.submission.id, kind: 'video', name, mimeType: type, size: blob.size,
        originalSize: f.size, compressed, capturedAt: cap.at, captureSource: cap.src });
      job.uploadId = st.uploadId;
      const pend = { uploadId: st.uploadId, subId: S.submission.id, name, size: blob.size, offset: 0, chunkSize: st.chunkSize, compressed,
        origName: f.name, origSize: f.size, origModified: f.lastModified, savedBlob: false, at: Date.now() };
      if (compressed) { try { await idb.put(st.uploadId, blob); pend.savedBlob = true; } catch (e) { /* resume after reload won't be possible */ } }
      pendingSave(pend);
      const base = compressed ? 0.5 : 0;
      const r = await sendChunks(pend, blob, job, (p, note) => onProg(base + p * (1 - base), note || `Uploading ${name} — ${fmtMB(p * blob.size / MB_)} of ${fmtMB(blob.size / MB_)}`));
      pendingDrop(st.uploadId);
      return r;
    } catch (e) {
      if (e.cancelled && job.uploadId) { api('uploadCancel', { uploadId: job.uploadId }).catch(() => {}); pendingDrop(job.uploadId); }
      throw e;
    } finally { VUP.active = null; }
  }

  /** Sends the pieces from pend.offset. Drive reports how much it has after every piece, so a retry
   *  after a dropped connection carries on from exactly the right place. */
  async function sendChunks(pend, blob, job, onProg) {
    let off = pend.offset || 0, fails = 0;
    onProg(off / blob.size);
    for (;;) {
      if (job.cancelled) throw cancelErr();
      try {
        let r;
        if (off >= blob.size) r = await api('uploadStatus', { uploadId: pend.uploadId });
        else {
          const end = Math.min(off + pend.chunkSize, blob.size);
          r = await api('uploadChunk', { uploadId: pend.uploadId, offset: off, base64: await fileToBase64(blob.slice(off, end)) });
          if (!r.done && r.received == null) r.received = end;
        }
        if (r.done) return r;
        off = r.received; fails = 0;
      } catch (e) {
        if (job.cancelled) throw cancelErr();
        if (/expired|not found/i.test(e.message)) throw e;
        if (++fails > 5) throw new Error('Upload interrupted — check your connection, then tap Resume under Videos');
        const wait = Math.min(30, 2 ** fails);
        onProg(off / blob.size, `Connection problem — retrying in ${wait}s…`);
        await sleep(wait * 1000);
        try { const s = await api('uploadStatus', { uploadId: pend.uploadId }); if (s.done) return s; off = s.received; }
        catch (e2) { if (/expired|not found/i.test(e2.message)) throw e2; }
      }
      pend.offset = off; pendingSave(pend);
      onProg(off / blob.size);
    }
  }

  /* unfinished uploads survive a reload: details in localStorage, compressed video data in IndexedDB */
  const PEND_KEY = 'pbj_pending_uploads';
  const pendingAll = () => store.get(PEND_KEY) || {};
  function pendingSave(p) { const a = pendingAll(); a[p.uploadId] = p; store.set(PEND_KEY, a); }
  function pendingDrop(id) { const a = pendingAll(); delete a[id]; store.set(PEND_KEY, a); idb.del(id).catch(() => {}); }
  const idb = {
    open() {
      return this.p || (this.p = new Promise((res, rej) => {
        const r = indexedDB.open('pbj-uploads', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('blobs');
        r.onsuccess = () => res(r.result); r.onerror = () => { this.p = null; rej(r.error); };
      }));
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((res, rej) => { const t = db.transaction('blobs', mode), q = fn(t.objectStore('blobs')); t.oncomplete = () => res(q && q.result); t.onerror = t.onabort = () => rej(t.error); });
    },
    put(k, v) { return this.tx('readwrite', s => s.put(v, k)); },
    get(k) { return this.tx('readonly', s => s.get(k)); },
    del(k) { return this.tx('readwrite', s => s.delete(k)); }
  };

  /** "Unfinished upload" notices in the Videos card, with Resume / Discard. */
  function renderPendingUploads() {
    const box = $('#videoPending'); if (!box || !S.submission) return;
    const list = Object.values(pendingAll()).filter(p => p.subId === S.submission.id);
    box.innerHTML = list.map(p => `<div class="notice warn" style="margin:8px 0">⏸ Unfinished upload: <b>${esc(p.name)}</b> — ${Math.round((p.offset || 0) / p.size * 100)}% sent
      <div class="row" style="margin-top:6px"><button type="button" class="btn btn-primary btn-sm" data-resume="${esc(p.uploadId)}">Resume</button>
      <button type="button" class="btn btn-ghost btn-sm" data-discard="${esc(p.uploadId)}">Discard</button></div></div>`).join('');
    $$('[data-discard]', box).forEach(b => b.onclick = async () => {
      if (!confirmBox('Discard this unfinished upload?')) return;
      api('uploadCancel', { uploadId: b.dataset.discard }).catch(() => {});
      pendingDrop(b.dataset.discard); renderPendingUploads();
    });
    $$('[data-resume]', box).forEach(b => b.onclick = async () => {
      if (VUP.active) return toast('Please wait until the current video has finished uploading', true);
      const p = pendingAll()[b.dataset.resume]; if (!p) return renderPendingUploads();
      let blob = null;
      if (p.savedBlob) { try { blob = await idb.get(p.uploadId); } catch (e) {} }
      if (blob) return resumeUpload(p, blob);
      if (p.compressed) return toast('This compressed video can\'t be resumed on this device — please Discard it and upload the video again', true);
      // the original file is needed again: ask for it and make sure it's the same one
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'video/*';
      inp.onchange = () => {
        const f = inp.files[0]; if (!f) return;
        if (f.name !== p.origName || f.size !== p.origSize) return toast(`That's a different file — please choose “${p.origName}”`, true);
        resumeUpload(p, f);
      };
      toast(`Choose “${p.origName}” again to continue`); inp.click();
    });
  }

  async function resumeUpload(p, blob) {
    const job = VUP.active = { cancelled: false, conv: null, uploadId: p.uploadId };
    window.onbeforeunload = () => 'A video upload is still in progress.'; keepAwake(true);
    try {
      let r = await api('uploadStatus', { uploadId: p.uploadId });
      if (!r.done) { p.offset = r.received; pendingSave(p); r = await sendChunks(p, blob, job, (f, note) => vprog.set(f, note || `Resuming ${p.name} — ${fmtMB(f * blob.size / MB_)} of ${fmtMB(blob.size / MB_)}`)); }
      pendingDrop(p.uploadId);
      S.files = r.files; if (r.storage) S.storage = r.storage;
      renderFiles(); updateStorageUI(); toast('Video uploaded ✓');
    } catch (e) {
      if (e.cancelled) { api('uploadCancel', { uploadId: p.uploadId }).catch(() => {}); pendingDrop(p.uploadId); toast('Upload cancelled'); }
      else { if (/expired|not found/i.test(e.message)) pendingDrop(p.uploadId); toast(e.message, true); }
    } finally { VUP.active = null; vprog.done(); renderPendingUploads(); window.onbeforeunload = null; keepAwake(false); }
  }

  /* ---- browser-side compression (WebCodecs, via the Mediabunny library loaded on first use) ---- */
  let mbLib = null;
  const loadMediabunny = () => mbLib || (mbLib = import(CFG.MEDIABUNNY_URL).catch(e => { mbLib = null; throw e; }));
  const canCompressVideo = () => !!(CFG.VIDEO_COMPRESS && CFG.VIDEO_COMPRESS.enabled && window.VideoEncoder && window.VideoDecoder);

  /** Re-encodes to H.264 with the longest side ≤ maxSide at the configured bitrate; audio is copied as-is.
   *  Returns a Blob, or null when compression isn't possible / worthwhile (the caller then uploads the original). */
  async function compressVideo(file, onProg, job) {
    const C = CFG.VIDEO_COMPRESS, MB = await loadMediabunny();
    const input = new MB.Input({ source: new MB.BlobSource(file), formats: MB.ALL_FORMATS });
    try {
      const vt = await input.getPrimaryVideoTrack();
      if (!vt) return null;
      const w = vt.displayWidth, h = vt.displayHeight, scale = Math.min(1, C.maxSide / Math.max(w, h));
      const dur = await input.computeDuration();
      if (scale === 1 && dur > 0 && file.size * 8 / dur < C.bitrate * 1.4) return null;   // already small enough
      const tw = Math.round(w * scale / 2) * 2, th = Math.round(h * scale / 2) * 2;
      if (!(await MB.canEncodeVideo('avc', { width: tw, height: th, bitrate: C.bitrate }))) return null;
      const output = new MB.Output({ format: new MB.Mp4OutputFormat({ fastStart: 'in-memory' }), target: new MB.BufferTarget() });
      const conv = await MB.Conversion.init({ input, output, showWarnings: false,
        video: { width: tw, height: th, fit: 'contain', codec: 'avc', bitrate: C.bitrate, forceTranscode: true } });
      // never drop the picture or the sound: if either can't be carried over, keep the original instead
      if (!conv.isValid || conv.discardedTracks.some(d => (d.track.isVideoTrack() || d.track.isAudioTrack()) && d.reason !== 'discarded_by_user')) return null;
      job.conv = conv;
      conv.onProgress = p => onProg(p);
      await conv.execute();
      return new Blob([output.target.buffer], { type: 'video/mp4' });
    } finally { job.conv = null; try { input.dispose(); } catch (e) {} }
  }

  /* ---- capture time: camera EXIF for photos, the recording header for videos, else the file date ---- */
  const fileTime = f => f.lastModified > 0 ? { at: new Date(f.lastModified).toISOString(), src: 'file' } : { at: '', src: '' };

  async function photoCaptureTime(file) {
    try {
      const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
      if (v.getUint16(0) === 0xFFD8) {
        for (let p = 2; p + 10 < v.byteLength;) {
          const marker = v.getUint16(p), len = v.getUint16(p + 2);
          if ((marker & 0xFF00) !== 0xFF00) break;
          if (marker === 0xFFE1 && v.getUint32(p + 4) === 0x45786966) { const t = exifDate(v, p + 10); if (t) return { at: t, src: 'camera' }; break; }
          p += 2 + len;
        }
      }
    } catch (e) { /* not a readable JPEG */ }
    return fileTime(file);
  }
  function exifDate(v, tiff) {
    const le = v.getUint16(tiff) === 0x4949, u16 = o => v.getUint16(tiff + o, le), u32 = o => v.getUint32(tiff + o, le);
    const ifd = (off, want) => { const n = u16(off), out = {}; for (let i = 0; i < n; i++) { const e = off + 2 + i * 12, tag = u16(e); if (want.includes(tag)) out[tag] = { count: u32(e + 4), val: u32(e + 8) }; } return out; };
    const str = ent => { let s = ''; for (let i = 0; i < Math.min(ent.count, 32) - 1; i++) s += String.fromCharCode(v.getUint8(tiff + ent.val + i)); return s; };
    const ifd0 = ifd(u32(4), [0x8769, 0x0132]);
    let s = '';
    if (ifd0[0x8769]) { const ex = ifd(ifd0[0x8769].val, [0x9003, 0x9004]); const e = ex[0x9003] || ex[0x9004]; if (e) s = str(e); }
    if (!s && ifd0[0x0132]) s = str(ifd0[0x0132]);
    const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
    if (!m) return null;
    const d = new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]);   // camera clock = local time
    return isNaN(d) || d.getFullYear() < 1990 ? null : d.toISOString();
  }

  /** Reads creation_time from the MP4/MOV 'mvhd' header (seconds since 1904, UTC). */
  async function videoCaptureTime(file) {
    try {
      const rd = async (pos, n) => new DataView(await file.slice(pos, pos + n).arrayBuffer());
      const type = (v, o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
      const boxAt = async pos => {
        const h = await rd(pos, 16); let size = h.getUint32(0), hdr = 8;
        if (size === 1) { size = Number(h.getBigUint64(8)); hdr = 16; } else if (size === 0) size = file.size - pos;
        return { size, hdr, type: type(h, 4) };
      };
      for (let pos = 0, guard = 0; pos + 8 <= file.size && guard < 50; guard++) {
        const b = await boxAt(pos);
        if (b.size < 8) break;
        if (b.type === 'moov') {
          for (let p = pos + b.hdr, g2 = 0; p + 8 <= pos + b.size && g2 < 50; g2++) {
            const c = await boxAt(p);
            if (c.type === 'mvhd') {
              const m = await rd(p + c.hdr, 20), ver = m.getUint8(0);
              const secs = ver === 1 ? Number(m.getBigUint64(4)) : m.getUint32(4);
              const d = new Date((secs - 2082844800) * 1000);
              if (secs > 0 && d.getFullYear() > 2000 && d.getTime() < Date.now() + 864e5) return { at: d.toISOString(), src: 'video' };
              break;
            }
            if (c.size < 8) break; p += c.size;
          }
          break;
        }
        pos += b.size;
      }
    } catch (e) { /* not an MP4/MOV we can read */ }
    return fileTime(file);
  }

  function fillForm(d) { Object.keys(d).forEach(k => { const el = $('#f_' + k); if (el && !el.readOnly) el.value = d[k]; }); }

  function guessMime(n) {
    const e = n.split('.').pop().toLowerCase();
    return ({ pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
      mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', '3gp': 'video/3gpp', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo' })[e] || 'application/octet-stream';
  }

  /** Resize + JPEG-compress a photo. Honours EXIF orientation. */
  async function compressImage(file) {
    let src, w, h;
    try {
      src = await createImageBitmap(file, { imageOrientation: 'from-image' });
      w = src.width; h = src.height;
    } catch (e) {
      src = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('Could not read image ' + file.name)); i.src = URL.createObjectURL(file); });
      w = src.naturalWidth; h = src.naturalHeight;
    }
    let max = CFG.PHOTO_MAX_SIDE, q = CFG.PHOTO_QUALITY, blob;
    for (let attempt = 0; attempt < 5; attempt++) {
      const scale = Math.min(1, max / Math.max(w, h));
      const cw = Math.round(w * scale), ch = Math.round(h * scale);
      const c = document.createElement('canvas'); c.width = cw; c.height = ch;
      const ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(src, 0, 0, cw, ch);
      blob = await new Promise(r => c.toBlob(r, 'image/jpeg', q));
      if (blob.size / 1024 <= CFG.PHOTO_TARGET_KB) break;
      q = Math.max(0.5, q - 0.08); max = Math.round(max * 0.88);
    }
    if (src.close) src.close();
    return blob;
  }

  /* ---------------- file lists ---------------- */
  const srcLabel = { camera: 'camera time', video: 'recording time', file: 'file date' };
  /** Plain-text version of a file's caption / sections / capture time (for the PDF). */
  const evidenceText = f => [f.caption, f.sections ? 'Sections: ' + f.sections.replace(/,/g, ', ') : '',
    f.capturedAt ? 'Taken ' + fmtDate(f.capturedAt) : '', f.lat != null ? `Location ${f.lat.toFixed(5)}, ${f.lng.toFixed(5)}` : ''].filter(Boolean).join(' · ');
  /** Small "📅 time · A C · caption" line under a photo/video (all optional details). */
  function evidenceLine(f) {
    const bits = [];
    if (f.capturedAt) bits.push(`<span title="Taken (${esc(srcLabel[f.captureSource] || 'file date')})">📅 ${fmtDate(f.capturedAt)}</span>`);
    if (f.sections) bits.push(f.sections.split(',').map(k => `<span class="sec-tag" title="${esc((SCORE_FIELDS.find(s => s.key === 'score_' + k) || {}).label || k)}">${esc(k)}</span>`).join(''));
    if (f.lat != null) bits.push(`<a href="https://maps.google.com/?q=${f.lat},${f.lng}" target="_blank" rel="noopener" title="Location">📍</a>`);
    return bits.join(' ');
  }

  function renderFiles(container = document, files = S.files, canEdit = true) {
    const photos = files.filter(f => f.kind === 'photo'), videos = files.filter(f => f.kind === 'video');
    const docs = files.filter(f => f.kind !== 'photo' && f.kind !== 'video');
    const thumbs = $('#thumbs', container), list = $('#docList', container), vlist = $('#videoList', container);
    if ($('#photoCount', container)) $('#photoCount', container).textContent = photos.length ? `${photos.length} / ${CFG.MAX_PHOTOS}` : '';
    if ($('#videoCount', container)) $('#videoCount', container).textContent = videos.length ? `${videos.length} / ${CFG.MAX_VIDEOS}` : '';
    if (vlist) {
      // videos are too big to preview in the app; admins get a Drive link
      vlist.innerHTML = videos.length ? videos.map(v => `<li><span class="ficon">🎥</span><span class="nm" title="${esc(v.name)}">${esc(v.name)}
          <br><span class="muted small">${kb(v.sizeKB)}${v.compressed ? ` (compressed from ${kb(v.originalSizeKB)})` : ''} · uploaded ${fmtDate(v.uploadedAt)}</span>
          ${v.caption ? `<br><span class="small">${esc(v.caption)}</span>` : ''}${evidenceLine(v) ? `<br><span class="muted small">${evidenceLine(v)}</span>` : ''}</span>
          ${canEdit ? `<button class="btn btn-ghost btn-sm" data-meta="${esc(v.id)}" title="Caption, sections, location">✎ Details</button>` : ''}
          ${v.url ? `<a class="btn btn-ghost btn-sm" href="${esc(v.url)}" target="_blank" rel="noopener">Open</a>` : ''}${canEdit ? `<button class="btn btn-danger btn-sm" data-del="${esc(v.id)}" aria-label="Delete">✕</button>` : ''}</li>`).join('')
        : '<li class="muted small">No videos yet.</li>';
    }
    if (thumbs) {
      thumbs.innerHTML = photos.length ? photos.map(p => `<div class="thumb-wrap"><div class="thumb" data-id="${esc(p.id)}">${S.imgCache[p.id] ? `<img src="${S.imgCache[p.id]}" alt="${esc(p.caption || p.name)}">` : '<div class="ph">Loading…</div>'}
          ${canEdit ? `<button class="x" data-del="${esc(p.id)}" aria-label="Delete photo">×</button><button class="ed" data-meta="${esc(p.id)}" aria-label="Photo details" title="Caption, sections, location">✎</button>` : ''}</div>
          ${p.caption || evidenceLine(p) ? `<div class="thumb-cap small">${p.caption ? esc(p.caption) + ' ' : ''}<span class="muted">${evidenceLine(p)}</span></div>` : ''}</div>`).join('')
        : '<div class="muted small" style="grid-column:1/-1">No photos yet.</div>';
      photos.filter(p => !S.imgCache[p.id]).forEach(p => loadThumb(p.id, thumbs));
    }
    if (list) {
      list.innerHTML = docs.length ? docs.map(d => `<li><span class="ficon">${esc(ext(d.name))}</span><span class="nm" title="${esc(d.name)}">${esc(d.name)}<br><span class="muted small">${kb(d.sizeKB)} · ${fmtDate(d.uploadedAt)}</span></span>
          <button class="btn btn-ghost btn-sm" data-open="${esc(d.id)}">View</button>${canEdit ? `<button class="btn btn-danger btn-sm" data-del="${esc(d.id)}" aria-label="Delete">✕</button>` : ''}</li>`).join('')
        : '<li class="muted small">No documents yet.</li>';
    }
    $$('[data-del]', container).forEach(b => b.onclick = () => deleteFile(b.dataset.del));
    $$('[data-meta]', container).forEach(b => b.onclick = () => metaDialog(files.find(f => f.id === b.dataset.meta)));
    $$('[data-open]', container).forEach(b => b.onclick = () => openFile(b.dataset.open, files));
    $$('.thumb img', container).forEach(img => img.onclick = () => lightbox(img.src, (files.find(f => f.id === img.closest('.thumb').dataset.id) || {}).caption));
  }

  /** Optional caption, A–L checklist and location for one photo/video. */
  function metaDialog(f) {
    if (!f) return;
    const chosen = new Set(String(f.sections || '').split(',').filter(Boolean));
    let loc = f.lat != null ? { lat: f.lat, lng: f.lng } : null, clearLoc = false;
    const d = document.createElement('div'); d.className = 'modal';
    d.innerHTML = `<div class="card modal-card" role="dialog" aria-modal="true" aria-labelledby="mdT">
      <h2 id="mdT" style="margin-top:0">${f.kind === 'video' ? 'Video' : 'Photo'} details <span class="muted small">(all optional)</span></h2>
      <div class="muted small" style="margin:-4px 0 12px">${esc(f.name)}${f.capturedAt ? `<br>Taken ${fmtDate(f.capturedAt)} <span title="where this time came from">(${esc(srcLabel[f.captureSource] || 'file date')})</span>` : ''}</div>
      <div class="field"><label for="mdCap">Caption</label><textarea id="mdCap" rows="2" maxlength="300" placeholder="What does this show?">${esc(f.caption || '')}</textarea></div>
      <div class="field"><label>Evidence for sections</label>
        <div class="chips">${SCORE_FIELDS.map(s => { const k = s.key.replace('score_', ''); return `<label class="chip" title="${esc(s.label)}"><input type="checkbox" value="${k}" ${chosen.has(k) ? 'checked' : ''}><span>${k}</span></label>`; }).join('')}</div>
        <div class="hint" id="mdSecHint"></div></div>
      <div class="field"><label>Location</label>
        <div class="row"><span id="mdLoc" class="muted small"></span><div class="spacer"></div>
          <button type="button" class="btn btn-ghost btn-sm" id="mdLocAdd">📍 Use my current location</button>
          <button type="button" class="btn btn-ghost btn-sm" id="mdLocDel">Remove</button></div></div>
      <div class="row"><button type="button" class="btn btn-ghost" id="mdCancel">Cancel</button><button type="button" class="btn btn-primary" id="mdSave" style="flex:1">Save details</button></div>
    </div>`;
    document.body.appendChild(d);
    const close = () => { d.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    d.onclick = e => { if (e.target === d) close(); };
    const drawLoc = () => {
      $('#mdLoc', d).textContent = loc ? `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)}` : 'Not added';
      $('#mdLocDel', d).hidden = !loc;
    };
    const drawHint = () => {
      const picked = $$('.chips input:checked', d).map(i => (SCORE_FIELDS.find(s => s.key === 'score_' + i.value) || {}).label).filter(Boolean);
      $('#mdSecHint', d).textContent = picked.length ? picked.join(' · ') : 'Tick the A–L sections this is evidence for.';
    };
    drawLoc(); drawHint();
    $$('.chips input', d).forEach(i => i.onchange = drawHint);
    $('#mdCancel', d).onclick = close;
    $('#mdLocDel', d).onclick = () => { loc = null; clearLoc = true; drawLoc(); };
    $('#mdLocAdd', d).onclick = () => {
      if (!navigator.geolocation) return toast('Location is not available on this device', true);
      $('#mdLoc', d).textContent = 'Finding location…';
      navigator.geolocation.getCurrentPosition(
        pos => { loc = { lat: pos.coords.latitude, lng: pos.coords.longitude }; clearLoc = false; drawLoc(); },
        err => { drawLoc(); toast('Could not get location: ' + err.message, true); },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
    };
    $('#mdSave', d).onclick = async () => {
      busy(true, 'Saving…');
      try {
        const r = await api('updateFileMeta', { fileId: f.id, caption: $('#mdCap', d).value.trim(),
          sections: $$('.chips input:checked', d).map(i => i.value).join(','),
          lat: loc ? loc.lat : '', lng: loc ? loc.lng : '', clearLocation: clearLoc && !loc });
        S.files = r.files; renderFiles(); close(); toast('Details saved ✓');
      } catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
    $('#mdCap', d).focus();
  }

  /** "1.2 GB of 4 GB used" bar, with a warning when the member is running low. */
  function storageHTML(st) {
    if (!st) return '';
    const pct = Math.min(100, Math.round(st.usedMB / st.quotaMB * 100));
    return `<div class="storage${st.warn ? ' warn' : ''}"><div class="row small"><b>Storage</b><div class="spacer"></div><span>${fmtMB(st.usedMB)} of ${fmtMB(st.quotaMB)} used</span></div>
      <div class="progress"><div style="width:${Math.max(pct, 1)}%"></div></div>
      ${st.warn ? `<div class="small" style="margin-top:4px">⚠️ Running low — ${fmtMB(st.leftMB)} left. Delete videos you don't need, or contact the organisers.</div>` : ''}</div>`;
  }
  function updateStorageUI() { const b = $('#storageBox'); if (b) b.innerHTML = storageHTML(S.storage); }

  async function loadThumb(id, root) {
    try {
      const r = await api('getFile', { fileId: id });
      S.imgCache[id] = `data:${r.mimeType};base64,${r.base64}`;
      const t = root.querySelector(`.thumb[data-id="${CSS.escape(id)}"]`);
      if (t) { const ph = t.querySelector('.ph'); if (ph) { const img = new Image(); img.src = S.imgCache[id]; img.alt = ''; img.onclick = () => lightbox(img.src); ph.replaceWith(img); } }
    } catch (e) { /* ignore */ }
  }

  async function deleteFile(id) {
    const f = S.files.find(x => x.id === id);
    if (!f || !confirmBox(`Delete “${f.name}”?`)) return;
    busy(true, 'Deleting…');
    try { const r = await api('deleteFile', { fileId: id }); S.files = r.files; delete S.imgCache[id]; renderFiles(); toast('Deleted'); }
    catch (err) { toast(err.message, true); }
    finally { busy(false); }
  }
  function confirmBox(msg) { return window.confirm(msg); }

  async function openFile(id, files) {
    const f = files.find(x => x.id === id);
    const w = window.open('', '_blank');
    busy(true, 'Opening…');
    try {
      const r = await api('getFile', { fileId: id });
      const bin = atob(r.base64); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([arr], { type: r.mimeType }));
      if (w && /pdf|image|text/.test(r.mimeType)) w.location = url;
      else { if (w) w.close(); const a = document.createElement('a'); a.href = url; a.download = f ? f.name : 'file'; a.click(); }
    } catch (err) { if (w) w.close(); toast(err.message, true); }
    finally { busy(false); }
  }

  function lightbox(src, caption) {
    const d = document.createElement('div'); d.className = 'lightbox';
    d.innerHTML = `<img src="${src}" alt="${esc(caption || '')}">${caption ? `<div class="lb-cap">${esc(caption)}</div>` : ''}`;
    d.onclick = () => d.remove(); document.body.appendChild(d);
  }

  /* ================================================================
   *  PDF REPORT
   * ================================================================ */
  let jsPdfReady;
  function loadJsPdf() {
    if (window.jspdf) return Promise.resolve();
    return jsPdfReady || (jsPdfReady = new Promise((res, rej) => {
      const s = document.createElement('script'); s.src = JSPDF_URL; s.onload = res;
      s.onerror = () => { jsPdfReady = null; rej(new Error('Could not load PDF tool — check your connection')); };
      document.head.appendChild(s);
    }));
  }

  async function makePdf(user, sub, files) {
    if (!sub) return toast('Save your details first', true);
    busy(true, 'Preparing PDF…');
    try {
      await loadJsPdf();
      const { jsPDF } = window.jspdf;
      const doc = new jsPDF({ unit: 'mm', format: 'a4' });
      const W = 210, M = 15, green = [75, 95, 42], terra = [160, 97, 58];
      let y = M;
      const logo = await fetch('icons/logo-480.png').then(r => r.blob()).then(blobToDataURL).catch(() => null);
      if (logo) doc.addImage(logo, 'PNG', M, y, 24, 24);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(17); doc.setTextColor(...green);
      doc.text(CFG.APP_NAME, M + 30, y + 9);
      doc.setFontSize(10); doc.setTextColor(...terra); doc.text('JURY SUBMISSION REPORT', M + 30, y + 15);
      doc.setFont('helvetica', 'normal'); doc.setTextColor(110); doc.setFontSize(9);
      doc.text(`Status: ${sub.status}   ·   Last updated: ${fmtDate(sub.updatedAt)}   ·   Generated: ${fmtDate(new Date().toISOString())}`, M + 30, y + 21);
      y += 30; doc.setDrawColor(...green); doc.setLineWidth(0.8); doc.line(M, y, W - M, y); y += 7;

      const ensure = need => { if (y + need > 282) { doc.addPage(); y = M; } };
      const data = sub.data || {};
      CFG.SECTIONS.forEach(sec => {
        ensure(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...green); doc.text(sec.title, M, y); y += 6;
        if (sec.scoring) {
          // marks table: section name on the left, "marks / max" on the right
          doc.setFontSize(9.5);
          const row = (label, val, bold) => {
            const lines = doc.splitTextToSize(label, W - 2 * M - 34);
            ensure(lines.length * 5 + 3);
            doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setTextColor(bold ? 40 : 90); doc.text(lines, M, y);
            doc.setFont('helvetica', 'bold'); doc.setTextColor(40); doc.text(val, W - M, y, { align: 'right' });
            y += lines.length * 5 + 1.5;
          };
          sec.fields.forEach(f => row(f.label, `${data[f.key] !== '' && data[f.key] != null ? data[f.key] : '—'} / ${f.max}`));
          doc.setDrawColor(200); doc.setLineWidth(0.3); doc.line(M, y - 3, W - M, y - 3); y += 1.5;
          row('Total marks', marksText(scoreTotal(data)), true);
          y += 3;
          return;
        }
        sec.fields.forEach(f => {
          const val = String(data[f.key] || (f.prefill ? user[f.prefill] : '') || '—');
          const lines = doc.splitTextToSize(val, W - 2 * M - 52);
          ensure(lines.length * 5 + 3);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(9.5); doc.setTextColor(120); doc.text(f.label, M, y);
          doc.setFont('helvetica', 'normal'); doc.setTextColor(40); doc.text(lines, M + 52, y);
          y += lines.length * 5 + 2.5;
        });
        y += 3;
      });

      const listing = (title, items) => {
        if (!items.length) return;
        ensure(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...green); doc.text(`${title} (${items.length})`, M, y); y += 6;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(40);
        items.forEach((d, i) => {
          ensure(6); doc.setTextColor(40); doc.text(doc.splitTextToSize(`${i + 1}. ${d.name}  (${kb(d.sizeKB)})`, W - 2 * M)[0], M, y); y += 5.5;
          const note = evidenceText(d);
          if (note) { const ls = doc.splitTextToSize(note, W - 2 * M - 5); ensure(ls.length * 4.5); doc.setTextColor(110); doc.text(ls, M + 5, y); y += ls.length * 4.5 + 1; }
        });
        doc.setTextColor(40);
        y += 3;
      };
      listing('Documents', files.filter(f => f.kind !== 'photo' && f.kind !== 'video'));
      listing('Videos', files.filter(f => f.kind === 'video'));

      const photos = files.filter(f => f.kind === 'photo');
      if (photos.length) {
        ensure(20);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...green); doc.text(`Photographs (${photos.length})`, M, y); y += 5;
        const colW = (W - 2 * M - 6) / 2;
        let col = 0, rowH = 0;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
        for (let i = 0; i < photos.length; i++) {
          busy(true, `Adding photo ${i + 1} of ${photos.length}…`);
          let src = S.imgCache[photos[i].id];
          if (!src) { const r = await api('getFile', { fileId: photos[i].id }); src = S.imgCache[photos[i].id] = `data:${r.mimeType};base64,${r.base64}`; }
          const dim = await new Promise(res => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res([4, 3]); im.src = src; });
          let w = colW, h = colW * dim[1] / dim[0];
          if (h > 95) { h = 95; w = h * dim[0] / dim[1]; }
          // caption / sections / time under the photo, up to 3 lines
          const capLines = doc.splitTextToSize(evidenceText(photos[i]), colW).slice(0, 3).filter(Boolean);
          const cellH = h + (capLines.length ? capLines.length * 3.8 + 1.5 : 0);
          if (col === 0) ensure(cellH + 4);
          const x = M + col * (colW + 6) + (colW - w) / 2;
          doc.addImage(src, 'JPEG', x, y, w, h, undefined, 'FAST');
          if (capLines.length) { doc.setTextColor(90); doc.text(capLines, M + col * (colW + 6), y + h + 4); }
          rowH = Math.max(rowH, cellH);
          col++;
          if (col === 2) { col = 0; y += rowH + 5; rowH = 0; }
        }
        if (col) y += rowH + 5;
      }

      const pages = doc.getNumberOfPages();
      for (let p = 1; p <= pages; p++) {
        doc.setPage(p); doc.setFontSize(8); doc.setTextColor(150);
        doc.text(`${CFG.APP_NAME} · ${CFG.ORG_NAME}`, M, 292);
        doc.text(`Page ${p} of ${pages}`, W - M, 292, { align: 'right' });
      }
      const nm = `${CFG.APP_NAME}_${data.committeeName || data.memberName || user.name || 'jury'}_${data.area || ''}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
      doc.save(nm + '.pdf');
      toast('PDF downloaded');
    } catch (err) { toast(err.message, true); }
    finally { busy(false); }
  }

  /* ================================================================
   *  ADMIN VIEW
   * ================================================================ */
  let adminTab = 'members', adminFilter = { q: '', status: '' }, comFilter = { q: '', status: '', media: '' };

  /** Stores an adminList / adminApprove / adminSetRole response. */
  function setAdminData(r) { S.adminMembers = r.members || []; S.adminCommittees = r.committees || []; S.adminDrive = r.drive || null; }

  /** One line about the Drive account's space and the upload reserve. */
  function driveNotice(dr) {
    if (!dr) return '';
    const space = dr.limitMB ? `${fmtMB(dr.usedMB)} used of ${fmtMB(dr.limitMB)} — <b>${fmtMB(dr.freeMB)} free</b>` : `${fmtMB(dr.usedMB)} used (no limit reported)`;
    return `<div class="notice${dr.low ? ' warn' : ''}" style="margin-bottom:14px">💾 Drive storage: ${space}.
      ${dr.paused ? '<b>Uploads are paused</b> because free space is below the reserve.' : dr.low ? '<b>Running low.</b>' : ''}
      Uploads stop when free space would fall below ${fmtMB(dr.reserveMB)}; each jury member can use up to ${fmtMB(dr.quotaMB)}.
      <span class="muted small">Deleted files stay in the Drive trash (and use space) until it is emptied.</span></div>`;
  }

  /** Switches the dashboard to a tab with the given filters (used by the stat tiles). */
  function showAdmin(tab, filters) {
    adminTab = tab;
    if (tab === 'members') adminFilter = Object.assign({ q: '', status: '' }, filters);
    if (tab === 'committees') comFilter = Object.assign({ q: '', status: '', media: '' }, filters);
    renderAdmin(false, true);
  }

  async function renderAdmin(force, scrollToList) {
    app.innerHTML = `
      <div class="row" style="margin-bottom:12px"><h1>Admin dashboard</h1><div class="spacer"></div><span class="badge b-admin">ADMIN</span></div>
      <div class="stats" id="stats"></div>
      <div id="driveBox"></div>
      <div id="pendingBox"></div>
      <div class="tabs" id="adminTabs">${[['members', 'Jury members'], ['committees', 'Committees'], ['log', 'Activity log']].map(([k, l]) =>
        `<button class="tab ${adminTab === k ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}
        <div class="spacer"></div><button class="btn btn-ghost btn-sm" id="refresh">↻ Refresh</button></div>
      <div id="adminBody" class="card"><div class="muted">Loading…</div></div>`;
    $$('.tab').forEach(t => t.onclick = () => { adminTab = t.dataset.tab; renderAdmin(); });
    $('#refresh').onclick = () => { S.adminMembers = null; renderAdmin(true); };
    try {
      if (!S.adminMembers || force) setAdminData(await api('adminList'));
      const pend = S.adminMembers.filter(x => x.pending);
      const m = S.adminMembers.filter(x => x.role !== 'admin' && !x.pending && !x.rejected);
      const coms = S.adminCommittees || [];
      const sum = k => coms.reduce((a, c) => a + (c[k] || 0), 0);
      const sub = coms.filter(c => c.status === 'Submitted').length;
      // each tile: [count, label, tab, filters] — clicking opens that list with those filters
      const tiles = [
        [m.length, 'Jury members', 'members', { status: '' }],
        [coms.length, 'Committees', 'committees', {}],
        [sub, 'Submitted', 'committees', { status: 'Submitted' }],
        [coms.length - sub, 'Drafts', 'committees', { status: 'Draft' }],
        [m.filter(x => !x.committees).length, 'Members not started', 'members', { status: 'Not started' }],
        [sum('photos'), 'Photos', 'committees', { media: 'photo' }],
        [sum('videos'), 'Videos', 'committees', { media: 'video' }],
        [sum('documents'), 'Documents', 'committees', { media: 'document' }]
      ];
      if (pend.length) tiles.push([pend.length, 'Pending approvals', 'pending', {}]);
      const isOn = (tab, f) => tab === adminTab && (
        tab === 'members' ? (f.status || '') === adminFilter.status && !adminFilter.q :
        tab === 'committees' ? (f.status || '') === comFilter.status && (f.media || '') === comFilter.media && !comFilter.q : false);
      $('#stats').innerHTML = tiles.map(([n, l, tab, f], i) =>
        `<button type="button" class="stat stat-btn ${isOn(tab, f) ? 'on' : ''}${tab === 'pending' ? ' warn' : ''}" data-i="${i}" title="Show ${esc(l.toLowerCase())}"><div class="n">${n}</div><div class="l">${l}</div></button>`).join('');
      $$('#stats .stat-btn').forEach(b => b.onclick = () => {
        const [, , tab, f] = tiles[+b.dataset.i];
        if (tab === 'pending') return $('#pendingBox').scrollIntoView({ behavior: 'smooth', block: 'start' });
        showAdmin(tab, f);
      });
      renderPending(pend);
      $('#driveBox').innerHTML = driveNotice(S.adminDrive);
      if (adminTab === 'members') renderMembersTable(m);
      else if (adminTab === 'committees') renderCommitteesTable(coms);
      else await renderLog();
      if (scrollToList) $('#adminTabs').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) { $('#adminBody').innerHTML = `<div class="notice warn">${esc(err.message)}</div>`; }
  }

  function downloadCsv(rows, cols, filename) {
    const csv = [cols.join(',')].concat(rows.map(x => cols.map(c => `"${String(x[c] == null ? '' : x[c]).replace(/"/g, '""')}"`).join(','))).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = filename; a.click();
  }

  function renderPending(list) {
    const box = $('#pendingBox');
    if (!list.length) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="card" style="border-left:4px solid var(--gold)">
      <h2>Pending registrations (${list.length})</h2>
      <div class="table-wrap"><table class="responsive"><thead><tr><th>Name</th><th>Area</th><th>Referred by</th><th>Registered</th><th></th></tr></thead><tbody>
      ${list.map(x => `<tr><td data-l="Name"><b>${esc(x.name)}</b><br><span class="muted small">${esc(x.email)}${x.altEmail ? ' · ' + esc(x.altEmail) : ''}</span></td>
        <td data-l="Area">${esc(x.assignedArea || '—')}</td><td data-l="Referred by">${esc(x.reference || '—')}</td>
        <td data-l="Registered">${esc(String(x.source || '').replace('Self-registered ', ''))}</td>
        <td data-l=""><div class="row"><button class="btn btn-primary btn-sm" data-appr="${esc(x.email)}">Approve as jury</button><button class="btn btn-ghost btn-sm" data-appradm="${esc(x.email)}">Approve as admin</button><button class="btn btn-danger btn-sm" data-rej="${esc(x.email)}">Reject</button></div></td></tr>`).join('')}
      </tbody></table></div></div>`;
    const act = async (email, approve, role) => {
      if (!approve && !confirmBox('Reject this registration?')) return;
      if (role === 'admin' && !confirmBox('Approve as ADMIN? Admins can see every member\'s data and approve others.')) return;
      busy(true, approve ? 'Approving…' : 'Rejecting…');
      try { setAdminData(await api('adminApprove', { email, approve, role: role || 'jury' })); toast(approve ? 'Approved as ' + (role || 'jury') + ' ✓' : 'Rejected'); renderAdmin(); }
      catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
    $$('[data-appr]', box).forEach(b => b.onclick = () => act(b.dataset.appr, true, 'jury'));
    $$('[data-appradm]', box).forEach(b => b.onclick = () => act(b.dataset.appradm, true, 'admin'));
    $$('[data-rej]', box).forEach(b => b.onclick = () => act(b.dataset.rej, false));
  }

  function renderMembersTable(all) {
    const body = $('#adminBody');
    body.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <input id="aq" placeholder="Search name, email, area…" value="${esc(adminFilter.q)}" style="flex:1;min-width:180px">
        <select id="as" style="width:auto"><option value="">All statuses</option>${['Submitted', 'Draft', 'Not started'].map(s => `<option ${adminFilter.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="btn btn-ghost btn-sm" id="csv">Export CSV</button>
      </div>
      <div class="table-wrap"><table class="responsive"><thead><tr><th>Member</th><th>Areas</th><th>Status</th><th>Committees</th><th>Files</th><th>Storage</th><th>Updated</th><th>Last login</th></tr></thead><tbody id="mt"></tbody></table></div>`;
    const draw = () => {
      const q = adminFilter.q.toLowerCase();
      const rows = all.filter(x => (!adminFilter.status || x.status === adminFilter.status) &&
        (!q || [x.name, x.memberName, x.email, x.location, x.phone].join(' ').toLowerCase().includes(q)));
      $('#mt').innerHTML = rows.length ? rows.map(x => `<tr class="click" data-email="${esc(x.email)}">
          <td data-l="Member"><b>${esc(x.memberName || x.name || '—')}</b><br><span class="muted small">${esc(x.email)}${x.phone ? ' · ' + esc(x.phone) : ''}</span></td>
          <td data-l="Areas">${esc(x.location || x.assignedArea || '—')}</td><td data-l="Status">${statusBadge(x.status)}</td>
          <td data-l="Committees">${x.committees || 0}${x.committees ? ` <span class="muted small">(${x.submitted || 0} submitted)</span>` : ''}</td>
          <td data-l="Files">${x.photos} 📷 · ${x.videos || 0} 🎥 · ${x.documents} 📎</td>
          <td data-l="Storage">${fmtMB(x.storageMB || 0)}${x.storageWarn ? ' <span title="Over ' + 80 + '% of the allowance">⚠️</span>' : ''}</td>
          <td data-l="Updated">${fmtDate(x.updatedAt)}</td><td data-l="Last login">${fmtDate(x.lastLogin)}</td></tr>`).join('')
        : '<tr><td colspan="8" class="muted">No matching members.</td></tr>';
      $$('#mt tr.click').forEach(tr => tr.onclick = () => renderAdminDetail(tr.dataset.email));
    };
    $('#aq').oninput = e => { adminFilter.q = e.target.value; draw(); };
    $('#as').onchange = e => { adminFilter.status = e.target.value; renderAdmin(); };
    $('#csv').onclick = () => downloadCsv(all,
      ['memberName', 'email', 'phone', 'location', 'status', 'committees', 'submitted', 'photos', 'videos', 'documents', 'storageMB', 'updatedAt', 'lastLogin'], 'paribesh-jury-members.csv');
    draw();
  }

  /** Every committee form across all jury members, with status / files filters. */
  function renderCommitteesTable(all) {
    const body = $('#adminBody');
    const media = [['', 'Any files'], ['photo', 'With photos'], ['video', 'With videos'], ['document', 'With documents'], ['none', 'No photos yet']];
    body.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <input id="cq" placeholder="Search committee, area, jury member…" value="${esc(comFilter.q)}" style="flex:1;min-width:180px">
        <select id="cs" style="width:auto"><option value="">All statuses</option>${['Submitted', 'Draft'].map(s => `<option ${comFilter.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <select id="cm" style="width:auto">${media.map(([v, l]) => `<option value="${v}" ${comFilter.media === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
        <button class="btn btn-ghost btn-sm" id="ccsv">Export CSV</button>
      </div>
      <div class="muted small" id="ccount" style="margin-bottom:8px"></div>
      <div class="table-wrap"><table class="responsive"><thead><tr><th>Committee</th><th>Area</th><th>Jury member</th><th>Status</th><th>Marks</th><th>Files</th><th>Updated</th></tr></thead><tbody id="ct"></tbody></table></div>`;
    let rows = [];
    const draw = () => {
      const q = comFilter.q.toLowerCase();
      rows = all.filter(c => (!comFilter.status || c.status === comFilter.status) &&
        (!comFilter.media || (comFilter.media === 'none' ? !c.photos : (c[comFilter.media === 'photo' ? 'photos' : comFilter.media === 'video' ? 'videos' : 'documents'] || 0) > 0)) &&
        (!q || [c.committeeName, c.area, c.memberName, c.email].join(' ').toLowerCase().includes(q)));
      $('#ccount').textContent = `${rows.length} of ${all.length} committees`;
      $('#ct').innerHTML = rows.length ? rows.map(c => `<tr class="click" data-email="${esc(c.email)}" data-id="${esc(c.id)}">
          <td data-l="Committee"><b>${esc(c.committeeName || '—')}</b></td><td data-l="Area">${esc(c.area || '—')}</td>
          <td data-l="Jury member">${esc(c.memberName || '—')}<br><span class="muted small">${esc(c.email)}</span></td>
          <td data-l="Status">${statusBadge(c.status)}</td><td data-l="Marks">${marksText(c.marks)}</td>
          <td data-l="Files">${c.photos} 📷 · ${c.videos || 0} 🎥 · ${c.documents} 📎</td><td data-l="Updated">${fmtDate(c.updatedAt)}</td></tr>`).join('')
        : '<tr><td colspan="7" class="muted">No matching committees.</td></tr>';
      $$('#ct tr.click').forEach(tr => tr.onclick = () => renderAdminSubmission(tr.dataset.email, tr.dataset.id));
    };
    $('#cq').oninput = e => { comFilter.q = e.target.value; draw(); };
    $('#cs').onchange = e => { comFilter.status = e.target.value; renderAdmin(); };
    $('#cm').onchange = e => { comFilter.media = e.target.value; renderAdmin(); };
    $('#ccsv').onclick = () => downloadCsv(rows,
      ['committeeName', 'area', 'memberName', 'email', 'status', 'marks', 'photos', 'videos', 'documents', 'createdAt', 'updatedAt', 'folderUrl'], 'paribesh-committees.csv');
    draw();
  }

  async function renderLog() {
    const r = await api('adminLog', { limit: 300 });
    $('#adminBody').innerHTML = `<div class="table-wrap"><table class="responsive"><thead><tr><th>Time</th><th>Member</th><th>Action</th><th>Details</th></tr></thead><tbody>
      ${r.log.length ? r.log.map(l => `<tr><td data-l="Time">${fmtDate(l.time)}</td><td data-l="Member">${esc(l.name || '')}<br><span class="muted small">${esc(l.email)}</span></td><td data-l="Action"><b>${esc(l.action)}</b></td><td data-l="Details">${esc(l.details)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</tbody></table></div>`;
  }

  /** Admin: one jury member and the list of their committee forms. */
  async function renderAdminDetail(email) {
    busy(true, 'Loading…');
    let r;
    try { r = await api('adminGet', { email }); } catch (err) { busy(false); return toast(err.message, true); }
    busy(false);
    const meta = (S.adminMembers || []).find(x => x.email === email) || {};
    const list = r.submissions || [];
    app.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="back" style="margin-bottom:12px">← All members</button>
      <div class="row" style="margin-bottom:12px"><div><h1>${esc(r.user.name || email)}</h1><div class="muted small">${esc(email)}${r.user.phone ? ' · ' + esc(r.user.phone) : ''} · Last login ${fmtDate(meta.lastLogin)}</div></div><div class="spacer"></div>${statusBadge(meta.status)}</div>
      <div class="grid grid-main">
        <div class="card"><h2>Committees (${list.length})</h2>
          ${list.length ? `<div class="table-wrap"><table class="responsive"><thead><tr><th>Committee</th><th>Area</th><th>Status</th><th>Marks</th><th>Files</th><th>Updated</th></tr></thead><tbody>
            ${list.map(s => `<tr class="click" data-id="${esc(s.id)}"><td data-l="Committee"><b>${esc(s.committeeName || '—')}</b></td><td data-l="Area">${esc(s.area || '—')}</td>
              <td data-l="Status">${statusBadge(s.status)}</td><td data-l="Marks">${marksText(s.marks)}</td><td data-l="Files">${s.photos} 📷 · ${s.videos || 0} 🎥 · ${s.documents} 📎</td><td data-l="Updated">${fmtDate(s.updatedAt)}</td></tr>`).join('')}
            </tbody></table></div>` : '<div class="muted">This member has not started any committee form.</div>'}
        </div>
        <div>
          <div class="card"><h2>Actions</h2><div class="actions-bar">
            <button class="btn btn-ghost btn-sm" id="aRole">${meta.role === 'admin' ? 'Change to jury' : 'Make admin'}</button></div>
            <p class="muted small" style="margin:8px 0 0">Role: <b>${esc(meta.role || 'jury')}</b></p></div>
        </div>
      </div>`;
    $('#back').onclick = () => renderAdmin();
    $$('tr.click', app).forEach(tr => tr.onclick = () => renderAdminSubmission(email, tr.dataset.id));
    $('#aRole').onclick = async () => {
      const role = meta.role === 'admin' ? 'jury' : 'admin';
      if (!confirmBox(role === 'admin' ? `Make ${email} an ADMIN? They will see all members' data.` : `Change ${email} to jury (remove admin access)?`)) return;
      busy(true, 'Updating role…');
      try { setAdminData(await api('adminSetRole', { email, role })); toast('Role set to ' + role + ' ✓'); renderAdminDetail(email); }
      catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
  }

  /** Admin: one committee form with its details, photos and documents. */
  async function renderAdminSubmission(email, id) {
    busy(true, 'Loading…');
    let r;
    try { r = await api('getSubmission', { id }); } catch (err) { busy(false); return toast(err.message, true); }
    busy(false);
    const sub = r.submission, data = sub.data || {};
    const member = (S.adminMembers || []).find(x => x.email === email) || { email, name: sub.memberName };
    app.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="back" style="margin-bottom:12px">← ${esc(member.name || email)}</button>
      <div class="row" style="margin-bottom:12px"><div><h1>${esc(sub.committeeName || 'Committee')}</h1><div class="muted small">${esc(sub.location || '')} · Jury: ${esc(sub.memberName || member.name || email)}</div></div><div class="spacer"></div>${statusBadge(sub.status)}</div>
      <div class="grid grid-main">
        <div class="card">
          ${CFG.SECTIONS.map(s => `<div class="section-title"><span class="dot"></span><h2 style="margin:0">${esc(s.title)}</h2></div>
            <dl class="kv">${s.fields.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(data[f.key] || '—')}${f.max != null && data[f.key] ? ` <span class="muted small">/ ${f.max}</span>` : ''}</dd>`).join('')}
            ${s.scoring ? `<dt><b>Total marks</b></dt><dd><b>${marksText(scoreTotal(data))}</b></dd>` : ''}</dl>`).join('<div style="height:10px"></div>')}
          <p class="muted small" style="margin-top:14px">Created ${fmtDate(sub.createdAt)} · Updated ${fmtDate(sub.updatedAt)}</p>
        </div>
        <div>
          <div class="card"><h2>Actions</h2><div class="actions-bar">
            <button class="btn btn-primary btn-sm" id="aEdit">✏️ Edit form &amp; files</button>
            ${sub.folderUrl ? `<a class="btn btn-ghost btn-sm" href="${esc(sub.folderUrl)}" target="_blank" rel="noopener">📁 Open Drive folder</a>` : ''}
            <button class="btn btn-ghost btn-sm" id="aPdf">⬇ PDF report</button></div></div>
          <div class="card"><h2>Photographs (${r.files.filter(f => f.kind === 'photo').length})</h2><div class="thumbs" id="thumbs"></div></div>
          <div class="card"><h2>Videos (${r.files.filter(f => f.kind === 'video').length})</h2><ul class="files" id="videoList"></ul></div>
          <div class="card"><h2>Documents</h2><ul class="files" id="docList"></ul></div>
        </div>
      </div>`;
    $('#back').onclick = () => renderAdminDetail(email);
    renderFiles(app, r.files, false);
    $('#aPdf').onclick = () => makePdf(member, sub, r.files);
    $('#aEdit').onclick = () => {
      S.adminEdit = { email, member };
      S.submission = sub; S.files = r.files; S.storage = r.storage || null;
      renderSubmission();
    };
  }

  /* ================================================================
   *  DEMO BACKEND (only used when API_URL is not set)
   * ================================================================ */
  const Mock = {
    key: 'pbj_demo_db2',
    files: {},
    db() {
      let d = store.get(this.key);
      if (!d) {
        d = { users: {
          '9800000000': { email: '9800000000', name: 'Demo Jury Member', phone: '9800000000', role: 'jury' },
          '9822222222': { email: '9822222222', name: 'Demo Admin', phone: '9822222222', role: 'admin' }
        }, subs: {}, files: [], log: [] };
        store.set(this.key, d);
      }
      return d;
    },
    save(d) { store.set(this.key, d); },
    pub(u) { return { email: u.email, name: u.name, phone: u.phone, role: u.role, mustChange: false, contactEmail: u.altEmail || '', altPhone: u.alternate || '', area: u.assignedArea || '' }; },
    uploads: {},
    log(d, u, a, det) { d.log.push({ time: new Date().toISOString(), email: u.email, name: u.name, action: a, details: det || '' }); },
    subFiles(d, id) {
      return d.files.filter(f => f.sub === id && !f.deleted).map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, kind: f.kind, sizeKB: f.sizeKB, uploadedAt: f.uploadedAt,
        caption: f.caption || '', sections: f.sections || '', capturedAt: f.capturedAt || '', captureSource: f.captureSource || '',
        lat: f.lat == null || f.lat === '' ? null : f.lat, lng: f.lng == null || f.lng === '' ? null : f.lng, originalSizeKB: f.originalSizeKB || f.sizeKB, compressed: !!f.compressed }));
    },
    storage(d, email) {
      const used = d.files.filter(f => f.email === email && !f.deleted).reduce((a, f) => a + f.sizeKB, 0) / 1024, q = CFG.MEMBER_QUOTA_MB;
      return { usedMB: Math.round(used * 10) / 10, quotaMB: q, leftMB: Math.max(0, Math.round((q - used) * 10) / 10), warn: used >= q * 0.8 };
    },
    quotaError(d, email, bytes) {
      const st = this.storage(d, email);
      return st.usedMB + bytes / 1048576 > st.quotaMB ? `Storage limit reached: only ${Math.floor(st.leftMB)} MB of the ${st.quotaMB} MB allowance is left.` : '';
    },
    meta(b) {   // same rules as cleanMeta_ in Code.gs, simplified
      const lat = Number(b.lat), lng = Number(b.lng), loc = b.lat !== '' && b.lat != null && isFinite(lat) && isFinite(lng);
      return { caption: String(b.caption || '').trim().slice(0, 300), sections: String(b.sections || '').toUpperCase().split(/[^A-L]+/).filter(Boolean).sort().join(','),
        capturedAt: b.capturedAt || '', captureSource: b.capturedAt ? b.captureSource || '' : '', lat: loc ? lat : '', lng: loc ? lng : '' };
    },
    summaries(d, email, withFolder) {
      return Object.values(d.subs).filter(s => email == null || s.email === email).map(s => {
        const fs = this.subFiles(d, s.id);
        return { id: s.id, email: s.email, memberName: (d.users[s.email] || {}).name || s.memberName, committeeName: s.committeeName, area: s.location, status: s.status, createdAt: s.createdAt, updatedAt: s.updatedAt,
          marks: scoreTotal(s.data), photos: fs.filter(f => f.kind === 'photo').length, videos: fs.filter(f => f.kind === 'video').length, documents: fs.filter(f => f.kind !== 'photo' && f.kind !== 'video').length,
          folderUrl: withFolder ? 'https://drive.google.com/' : undefined };
      }).sort((a, b) => a.updatedAt < b.updatedAt ? 1 : -1);
    },
    async handle(b) {
      await new Promise(r => setTimeout(r, 150));
      const d = this.db();
      d.uploads = d.uploads || {};
      if (b.action === 'loginByPhone') {
        const ph = String(b.phone).replace(/\D/g, '').slice(-10);
        const u = Object.values(d.users).find(x => String(x.phone || '').replace(/\D/g, '').slice(-10) === ph);
        if (!u) return { ok: false, error: 'This mobile number is not registered' };
        if (u.pending) return { ok: false, error: 'Your registration is awaiting approval' };
        if (u.rejected) return { ok: false, error: 'Your registration was not approved' };
        u.lastLogin = new Date().toISOString(); this.log(d, u, 'LOGIN'); this.save(d);
        return { ok: true, token: 'demo:' + u.email, user: this.pub(u) };
      }
      if (b.action === 'register') {
        const ph = String(b.phone).replace(/\D/g, '').slice(-10);
        if (d.users[ph]) return { ok: false, error: 'Already registered' };
        d.users[ph] = { email: ph, name: b.name, phone: ph, role: 'jury', pending: true, assignedArea: b.area, reference: b.reference, altEmail: b.emailAddr, source: new Date().toLocaleString() };
        this.save(d); return { ok: true, message: 'Registration received. You will be able to log in once the organisers approve it.' };
      }
      const u = b.token && d.users[String(b.token).replace('demo:', '')];
      if (!u) return { ok: false, error: 'Session expired', code: 'AUTH' };
      const now = new Date().toISOString();
      switch (b.action) {
        case 'logout': return { ok: true };
        case 'me': return { ok: true, user: this.pub(u), submissions: this.summaries(d, u.email), storage: this.storage(d, u.email) };
        case 'updateProfile': {
          if (!String(b.name || '').trim()) return { ok: false, error: 'Enter your full name' };
          u.name = b.name.trim(); u.altEmail = b.contactEmail; u.alternate = b.altPhone; u.assignedArea = b.area;
          this.log(d, u, 'PROFILE_UPDATED'); this.save(d); return { ok: true, user: this.pub(u) };
        }
        case 'uploadStart': {
          const s = d.subs[b.submissionId];
          if (!s || (s.email !== u.email && u.role !== 'admin')) return { ok: false, error: 'Please save the committee details before uploading files' };
          if (this.subFiles(d, s.id).filter(f => f.kind === 'video').length >= CFG.MAX_VIDEOS) return { ok: false, error: `Maximum ${CFG.MAX_VIDEOS} videos per committee` };
          if (b.size > CFG.MAX_VIDEO_MB * 1048576) return { ok: false, error: `Video is larger than ${CFG.MAX_VIDEO_MB} MB` };
          const qe = this.quotaError(d, s.email, b.size); if (qe) return { ok: false, error: qe };
          const uploadId = 'U' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          d.uploads[uploadId] = { sub: s.id, name: b.name, mime: b.mimeType, size: b.size, got: 0, meta: this.meta(b), compressed: !!b.compressed, originalSize: b.originalSize || b.size };
          this.save(d);
          return { ok: true, uploadId, chunkSize: 5 * 1024 * 1024, received: 0 };
        }
        case 'uploadChunk': case 'uploadStatus': {
          const up = d.uploads[b.uploadId];
          if (!up) return { ok: false, error: 'Video upload expired — please upload it again' };
          if (up.done) return { ok: true, done: true, files: this.subFiles(d, up.sub), storage: this.storage(d, d.subs[up.sub].email) };
          if (b.action === 'uploadChunk') {
            if (this.failNext) { this.failNext--; return { ok: false, error: 'No internet connection. Please try again.' }; }   // used by the UI test
            if (b.offset !== up.got) return { ok: false, error: 'Video upload failed (400). Please try again.' };
            up.got += Math.round(b.base64.length * 0.75) - (b.base64.endsWith('==') ? 2 : b.base64.endsWith('=') ? 1 : 0);
          }
          if (up.got < up.size) { this.save(d); return { ok: true, done: false, received: up.got }; }
          up.done = true;
          const s = d.subs[up.sub];
          d.files.push({ id: 'f' + Date.now() + Math.random().toString(36).slice(2, 6), sub: s.id, email: s.email, name: up.name, mimeType: up.mime, kind: 'video', sizeKB: Math.round(up.size / 1024), uploadedAt: now,
            ...up.meta, compressed: up.compressed, originalSizeKB: Math.round(up.originalSize / 1024) });
          this.log(d, u, 'UPLOAD', `${s.committeeName} — video: ${up.name}`); this.save(d);
          return { ok: true, done: true, files: this.subFiles(d, s.id), storage: this.storage(d, s.email) };
        }
        case 'uploadCancel': { delete d.uploads[b.uploadId]; this.save(d); return { ok: true }; }
        case 'updateFileMeta': {
          const f = d.files.find(x => x.id === b.fileId && !x.deleted && (x.email === u.email || u.role === 'admin'));
          if (!f) return { ok: false, error: 'File not found' };
          const m = this.meta(b); f.caption = m.caption; f.sections = m.sections;
          if (b.clearLocation) { f.lat = ''; f.lng = ''; } else if (m.lat !== '') { f.lat = m.lat; f.lng = m.lng; }
          this.save(d); return { ok: true, files: this.subFiles(d, f.sub) };
        }
        case 'getSubmission': {
          const s = d.subs[b.id];
          if (!s || (s.email !== u.email && u.role !== 'admin')) return { ok: false, error: 'Committee form not found' };
          const files = this.subFiles(d, s.id).map(f => u.role === 'admin' ? Object.assign({ url: 'https://drive.google.com/' }, f) : f);
          return { ok: true, submission: Object.assign({}, s, { folderUrl: u.role === 'admin' ? 'https://drive.google.com/' : undefined }), files, storage: this.storage(d, s.email) };
        }
        case 'saveSubmission': {
          if (!b.data.committeeName || !b.data.area) return { ok: false, error: 'Committee name and area are needed to save' };
          const s = b.id ? d.subs[b.id] : null;
          if (b.id && (!s || (s.email !== u.email && u.role !== 'admin'))) return { ok: false, error: 'Committee form not found' };
          const id = s ? s.id : 'S' + Date.now().toString(36);
          const st = s && s.status === 'Submitted' ? 'Submitted' : b.status;
          d.subs[id] = { id, email: s ? s.email : u.email, data: b.data, status: st, committeeName: b.data.committeeName, memberName: b.data.memberName, location: b.data.area, createdAt: s ? s.createdAt : now, updatedAt: now };
          this.log(d, u, s ? (b.status === 'Submitted' ? 'SUBMITTED' : 'SUBMISSION_UPDATED') : 'SUBMISSION_CREATED', `${b.data.committeeName} - ${b.data.area}`);
          this.save(d);
          return { ok: true, submission: d.subs[id], files: this.subFiles(d, id), submissions: this.summaries(d, d.subs[id].email) };
        }
        case 'uploadFile': {
          const s = d.subs[b.submissionId];
          if (!s || (s.email !== u.email && u.role !== 'admin')) return { ok: false, error: 'Please save the committee details before uploading files' };
          if (b.kind === 'photo' && this.subFiles(d, s.id).filter(f => f.kind === 'photo').length >= CFG.MAX_PHOTOS) return { ok: false, error: `Maximum ${CFG.MAX_PHOTOS} photos per committee` };
          const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 6);
          const sizeKB = Math.round(b.base64.length * 0.75 / 1024);
          const qe = this.quotaError(d, s.email, sizeKB * 1024); if (qe) return { ok: false, error: qe };
          d.files.push({ id, sub: s.id, email: s.email, name: b.name, mimeType: b.mimeType, kind: b.kind, sizeKB, uploadedAt: now, ...(b.kind === 'photo' ? this.meta(b) : {}) });
          this.files[id] = b; this.log(d, u, 'UPLOAD', `${s.committeeName} — ${b.kind}: ${b.name} (${sizeKB} KB)`); this.save(d);
          return { ok: true, files: this.subFiles(d, s.id), storage: this.storage(d, s.email) };
        }
        case 'deleteFile': { const f = d.files.find(x => x.id === b.fileId && (x.email === u.email || u.role === 'admin')); if (f) { f.deleted = true; this.log(d, u, 'FILE_DELETED', f.name); } this.save(d); return { ok: true, files: f ? this.subFiles(d, f.sub) : [], storage: f ? this.storage(d, f.email) : null }; }
        case 'getFile': { const f = this.files[b.fileId]; if (!f) return { ok: false, error: 'Demo files are kept only until the page is reloaded' }; return { ok: true, mimeType: f.mimeType, base64: f.base64 }; }
      }
      if (u.role !== 'admin') return { ok: false, error: 'Not permitted' };
      switch (b.action) {
        case 'adminSetRole': { d.users[b.email].role = b.role === 'admin' ? 'admin' : 'jury'; this.save(d); return this.handle({ action: 'adminList', token: b.token }); }
        case 'adminApprove': { const x = d.users[b.email]; if (b.approve === false) x.rejected = true; else x.role = b.role === 'admin' ? 'admin' : 'jury'; x.pending = false; this.save(d); return this.handle({ action: 'adminList', token: b.token }); }
        case 'adminList': return { ok: true, members: Object.values(d.users).map(x => {
          const subs = this.summaries(d, x.email), submitted = subs.filter(s => s.status === 'Submitted').length;
          return { pending: !!x.pending, rejected: !!x.rejected, assignedArea: x.assignedArea, reference: x.reference, altEmail: x.altEmail, source: x.source, email: x.email, name: x.name, phone: x.phone, role: x.role, lastLogin: x.lastLogin || '',
            committees: subs.length, submitted, status: !subs.length ? 'Not started' : (submitted ? 'Submitted' : 'Draft'), location: subs.map(s => s.area).filter(Boolean).join(', '), memberName: x.name,
            updatedAt: subs.length ? subs[0].updatedAt : '', photos: subs.reduce((a, s) => a + s.photos, 0), videos: subs.reduce((a, s) => a + s.videos, 0), documents: subs.reduce((a, s) => a + s.documents, 0),
            storageMB: this.storage(d, x.email).usedMB, storageWarn: this.storage(d, x.email).warn }; }), committees: this.summaries(d, null, true),
          drive: { usedMB: 1200, limitMB: 102400, freeMB: 101200, reserveMB: 2048, quotaMB: CFG.MEMBER_QUOTA_MB, low: false, paused: false } };
        case 'adminGet': { const x = d.users[b.email]; return { ok: true, user: x ? this.pub(x) : { email: b.email }, submissions: this.summaries(d, b.email, true) }; }
        case 'adminLog': return { ok: true, log: d.log.slice(-300).reverse() };
      }
      return { ok: false, error: 'Unknown action' };
    }
  };

  if (DEMO) window.__pbjDemo = Mock;   // demo mode only: lets automated tests simulate a flaky connection
  boot();
})();
