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

  const S = { token: null, user: null, submission: null, files: [], imgCache: {}, adminMembers: null };

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
    S.token = null; S.user = null; S.submission = null; S.files = []; S.imgCache = {}; S.adminMembers = null;
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
    S.user = r.user; S.submission = r.submission; S.files = r.files || [];
    saveSession();
  }

  function route() {
    $('#topbar').hidden = false;
    $('#who').textContent = S.user.name || S.user.email;
    if (S.user.mustChange) return renderChangePw(true);
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
      if (a === 'change-pw') renderChangePw(false);
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
            <div class="field"><label for="lEmail">Mobile number or email</label>
              <input id="lEmail" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="10-digit mobile or email" required></div>
            <div class="field"><label for="lPw">Password</label>
              <input id="lPw" type="password" autocomplete="current-password" required></div>
            <button class="btn btn-primary btn-block" type="submit">Log in</button>
          </form>
          <button type="button" class="btn btn-ghost btn-block" id="getCode" style="margin-top:12px">First time / forgot password? Get a code</button>
          <button type="button" class="btn btn-ghost btn-block" id="goRegister" style="margin-top:8px">New jury member? Register</button>
        </div>
        <div class="foot muted small">${CFG.ORG_URL ? `<a href="${esc(CFG.ORG_URL)}" target="_blank" rel="noopener">${esc(CFG.ORG_NAME)}</a>` : esc(CFG.ORG_NAME)}</div>
      </div></div>`;
    $('#getCode').onclick = () => renderCodeFlow($('#lEmail').value.trim());
    $('#goRegister').onclick = renderRegister;
    $('#loginForm').onsubmit = async e => {
      e.preventDefault();
      const email = $('#lEmail').value.trim(), password = $('#lPw').value;
      if (!email || !password) return toast('Enter your mobile number / email and password', true);
      busy(true, 'Logging in…');
      try {
        const r = await api('login', { email, password });
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
          <p class="muted small" style="margin-top:0">The organising team will review and approve your registration. After approval, log in with <b>Get a code</b>.</p>
          <form id="regForm" novalidate>
            <div class="field"><label for="rName">Full name <span class="req">*</span></label><input id="rName" type="text" autocomplete="name"></div>
            <div class="field"><label for="rPhone">Mobile number (WhatsApp) <span class="req">*</span></label><input id="rPhone" type="tel" inputmode="tel" autocomplete="tel" placeholder="10-digit mobile"></div>
            <div class="field"><label for="rEmail">Email</label><input id="rEmail" type="email" autocomplete="email" placeholder="Optional — codes can also come by email"></div>
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
   *  ONE-TIME CODE (first login / forgot password)
   * ================================================================ */
  function renderCodeFlow(prefill) {
    app.innerHTML = `
      <div class="login-wrap"><div class="login" style="max-width:440px">
        <img class="logo" src="icons/logo-480.png" alt="" style="width:110px;height:110px">
        <div class="card" style="text-align:left">
          <h1>Get a login code</h1>
          <p class="muted small" style="margin-top:0">Enter the mobile number or email registered with the organisers.<br><b>Mobile:</b> tap <i>Get code on WhatsApp</i>, press <b>send</b> in WhatsApp, and the code arrives as a reply.<br><b>Email:</b> tap <i>Send code by email</i>.</p>
          <form id="reqForm" novalidate>
            <div class="field"><label for="cId">Mobile number or email</label>
              <input id="cId" type="text" autocomplete="username" autocapitalize="off" spellcheck="false" value="${esc(prefill || '')}" placeholder="10-digit mobile or email"></div>
            <button class="btn btn-primary btn-block" type="button" id="waBtn">
              <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8s-.4-.1-.6.1-.7.8-.8 1-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.3-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.4.8 3.2.7a2.8 2.8 0 0 0 1.8-1.3 2.3 2.3 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>
              Get code on WhatsApp</button>
            <button class="btn btn-ghost btn-block" type="submit" id="sendBtn" style="margin-top:8px">Send code by email</button>
          </form>
          <form id="verForm" novalidate hidden style="margin-top:16px">
            <div class="notice" id="sentMsg"></div>
            <div class="field"><label for="cCode">6-digit code</label>
              <input id="cCode" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••"></div>
            <div class="field"><label for="cPw">New password</label><input id="cPw" type="password" autocomplete="new-password"><div class="hint">At least 8 characters</div></div>
            <div class="field"><label for="cPw2">Confirm new password</label><input id="cPw2" type="password" autocomplete="new-password"></div>
            <button class="btn btn-primary btn-block" type="submit">Set password &amp; log in</button>
            <button class="btn btn-ghost btn-block" type="button" id="resend" style="margin-top:8px">Resend code</button>
          </form>
          <button class="btn btn-ghost btn-block" type="button" id="backLogin" style="margin-top:10px">← Back to login</button>
        </div>
      </div></div>`;
    $('#backLogin').onclick = renderLogin;
    const send = async () => {
      const id = $('#cId').value.trim();
      if (!id) return toast('Enter your mobile number or email', true);
      busy(true, 'Sending code…');
      try {
        const r = await api('requestCode', { email: id });
        $('#sentMsg').textContent = r.message || 'Code sent.';
        $('#verForm').hidden = false; $('#resend').hidden = false; $('#sendBtn').textContent = 'Send again';
        $('#cCode').focus();
      } catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
    $('#reqForm').onsubmit = e => { e.preventDefault(); send(); };
    $('#waBtn').onclick = () => {
      const id = $('#cId').value.trim(), digits = id.replace(/\D/g, '').slice(-10);
      if (digits.length !== 10 || /@/.test(id)) return toast('Enter your 10-digit mobile number first', true);
      const text = encodeURIComponent('LOGIN ' + digits + ' — please send my Paribesh Bandhu Jury Portal code');
      const a = document.createElement('a');
      a.href = 'https://wa.me/' + (CFG.WHATSAPP_NUMBER || '') + '?text=' + text; a.target = '_blank'; a.rel = 'noopener';
      document.body.appendChild(a); a.click(); a.remove();
      $('#sentMsg').innerHTML = 'WhatsApp opened — <b>press send</b> there. The 6-digit code will come back as a reply in a few seconds. Then enter it below.<br><span class="small">Send it from the same mobile number (' + esc(digits) + ').</span>';
      $('#verForm').hidden = false; $('#resend').hidden = true;
      setTimeout(() => $('#cCode').focus(), 300);
    };
    $('#resend').onclick = send;
    $('#verForm').onsubmit = async e => {
      e.preventDefault();
      const code = $('#cCode').value.trim(), n = $('#cPw').value, n2 = $('#cPw2').value;
      if (!/^\d{6}$/.test(code)) return toast('Enter the 6-digit code', true);
      if (n.length < 8) return toast('Password must be at least 8 characters', true);
      if (n !== n2) return toast('Passwords do not match', true);
      busy(true, 'Verifying…');
      try {
        const r = await api('verifyCode', { email: $('#cId').value.trim(), code, newPassword: n });
        S.token = r.token; S.user = r.user; saveSession();
        toast('Password set ✓'); await loadMe(); route();
      } catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
  }

  /* ================================================================
   *  CHANGE PASSWORD
   * ================================================================ */
  function renderChangePw(forced) {
    app.innerHTML = `
      <div class="login-wrap"><div class="login" style="max-width:440px">
        <div class="card" style="text-align:left">
          <h1>${forced ? 'Set your password' : 'Change password'}</h1>
          ${forced ? '<div class="notice">Welcome! Please replace the temporary password you were given with one of your own.</div>' : ''}
          <form id="pwForm" novalidate>
            <div class="field"><label for="pOld">${forced ? 'Temporary password' : 'Current password'}</label><input id="pOld" type="password" autocomplete="current-password"></div>
            <div class="field"><label for="pNew">New password</label><input id="pNew" type="password" autocomplete="new-password" minlength="8"><div class="hint">At least 8 characters</div></div>
            <div class="field"><label for="pNew2">Confirm new password</label><input id="pNew2" type="password" autocomplete="new-password"></div>
            <div class="row">
              ${forced ? '' : '<button type="button" class="btn btn-ghost" id="pCancel">Cancel</button>'}
              <button class="btn btn-primary" type="submit" style="flex:1">Save password</button>
            </div>
          </form>
        </div>
      </div></div>`;
    if (!forced) $('#pCancel').onclick = route;
    $('#pwForm').onsubmit = async e => {
      e.preventDefault();
      const o = $('#pOld').value, n = $('#pNew').value, n2 = $('#pNew2').value;
      if (n.length < 8) return toast('New password must be at least 8 characters', true);
      if (n !== n2) return toast('Passwords do not match', true);
      busy(true, 'Saving…');
      try {
        const r = await api('changePassword', { oldPassword: o, newPassword: n });
        S.token = r.token; S.user = r.user; saveSession();
        toast('Password updated'); route();
      } catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
  }

  /* ================================================================
   *  JURY MEMBER VIEW
   * ================================================================ */
  function draftKey() { return 'pbj_draft_' + S.user.email; }

  function currentValues() {
    const saved = (S.submission && S.submission.data) || {};
    const local = store.get(draftKey()) || {};
    const v = {};
    ALL_FIELDS.forEach(f => {
      let val = local[f.key] != null ? local[f.key] : saved[f.key];
      let pre = f.prefill ? (S.user[f.prefill] || '') : '';
      const loginIsEmail = /@/.test(S.user.email);
      if (f.prefill === 'email' && !loginIsEmail) pre = '';                      // logged in with mobile no.
      if (f.prefill === 'phone' && !pre && !loginIsEmail) pre = S.user.email;    // mobile login fills phone
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
    else input = `<input ${common} type="${f.type || 'text'}" value="${esc(val)}" ${f.type === 'tel' ? 'inputmode="tel" autocomplete="tel"' : ''}>`;
    return `<div class="field"><label for="${id}">${esc(f.label)}${req}</label>${input}${f.hint ? `<div class="hint">${esc(f.hint)}</div>` : ''}</div>`;
  }

  function renderMember() {
    const v = currentValues();
    const sub = S.submission;
    const status = sub ? sub.status : 'Not started';
    app.innerHTML = `
      <div class="row" style="margin-bottom:12px">
        <div><h1>Your submission</h1><div class="muted small">${sub ? 'Last saved ' + fmtDate(sub.updatedAt) : 'Fill in the details and add photographs & documents.'}</div></div>
        <div class="spacer"></div>${statusBadge(status)}
      </div>
      ${status === 'Submitted' ? '<div class="notice">Submitted. You can still update details or add files — changes are logged.</div>' : ''}
      <div class="grid grid-main">
        <form class="card" id="subForm" novalidate>
          ${CFG.SECTIONS.map(s => `<div class="section-title"><span class="dot"></span><h2 style="margin:0">${esc(s.title)}</h2></div>${s.fields.map(f => fieldHTML(f, v[f.key])).join('')}`).join('')}
          <div class="actions-bar sticky-m">
            <button type="button" class="btn btn-ghost" id="saveDraft">Save draft</button>
            <button type="submit" class="btn btn-primary">${status === 'Submitted' ? 'Update submission' : 'Submit'}</button>
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

    const form = $('#subForm');
    form.addEventListener('input', () => store.set(draftKey(), readForm()));
    $('#saveDraft').onclick = () => saveSubmission('Draft');
    form.onsubmit = e => { e.preventDefault(); saveSubmission('Submitted'); };

    const photoHandler = async files => uploadMany(files, 'photo');
    $('#camIn').onchange = e => { photoHandler(e.target.files); e.target.value = ''; };
    $('#photoIn').onchange = e => { photoHandler(e.target.files); e.target.value = ''; };
    $('#docIn').onchange = e => { uploadMany(e.target.files, 'document'); e.target.value = ''; };
    setupDrop($('#photoDrop'), fs => photoHandler(fs));
    setupDrop($('#docDrop'), fs => uploadMany(fs, 'document'));
    $('#pdfBtn').onclick = () => makePdf(S.user, S.submission, S.files);
    renderFiles();
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

  function validate(all) {
    let firstBad = null;
    ALL_FIELDS.forEach(f => {
      const el = $('#f_' + f.key); if (!el) return;
      const need = all ? f.required : (f.key === 'memberName' || f.key === 'area');
      const bad = need && !el.value.trim();
      el.classList.toggle('invalid', bad);
      if (bad && !firstBad) firstBad = el;
    });
    if (firstBad) { firstBad.focus(); firstBad.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    return !firstBad;
  }

  async function saveSubmission(status, quiet) {
    if (!validate(status === 'Submitted')) {
      toast(status === 'Submitted' ? 'Please fill all required fields' : 'Name and area are needed to save', true);
      return false;
    }
    busy(true, status === 'Submitted' ? 'Submitting…' : 'Saving…');
    try {
      const r = await api('saveSubmission', { data: readForm(), status });
      S.submission = r.submission; S.files = r.files || S.files;
      store.del(draftKey());
      if (!quiet) { toast(status === 'Submitted' ? 'Submission saved ✓' : 'Draft saved'); renderMember(); }
      return true;
    } catch (err) { toast(err.message, true); return false; }
    finally { busy(false); }
  }

  /* ---------------- uploads ---------------- */
  async function uploadMany(fileList, kind) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    if (!S.submission) {
      const ok = await saveSubmission('Draft', true);
      if (!ok) return;
      const keep = readForm(); renderMember(); fillForm(keep);
    }
    if (kind === 'photo') {
      const have = S.files.filter(f => f.kind === 'photo').length;
      if (have + files.length > CFG.MAX_PHOTOS) return toast(`Maximum ${CFG.MAX_PHOTOS} photos`, true);
    }
    const prog = $(kind === 'photo' ? '#photoProg' : '#docProg');
    prog.hidden = false; const bar = prog.firstElementChild;
    let done = 0, failed = 0;
    for (const f of files) {
      bar.style.width = Math.round((done / files.length) * 100 + 5) + '%';
      try {
        let payload;
        if (kind === 'photo') {
          if (!/^image\//.test(f.type) && !/\.(jpe?g|png|heic|heif|webp)$/i.test(f.name)) throw new Error(f.name + ' is not an image');
          const blob = await compressImage(f);
          const b64 = await fileToBase64(blob);
          payload = { kind, name: f.name.replace(/\.[^.]+$/, '') + '.jpg', mimeType: 'image/jpeg', base64: b64 };
          S._lastPhotoData = 'data:image/jpeg;base64,' + b64;
        } else {
          if (f.size > CFG.MAX_DOC_MB * 1048576) throw new Error(f.name + ' is larger than ' + CFG.MAX_DOC_MB + ' MB');
          let blob = f, mime = f.type || guessMime(f.name), name = f.name;
          if (/^image\//.test(mime)) { blob = await compressImage(f); mime = 'image/jpeg'; name = name.replace(/\.[^.]+$/, '') + '.jpg'; }
          payload = { kind, name, mimeType: mime, base64: await fileToBase64(blob) };
        }
        const before = new Set(S.files.map(x => x.id));
        const r = await api('uploadFile', payload);
        S.files = r.files;
        if (kind === 'photo') { const nf = S.files.find(x => !before.has(x.id)); if (nf) S.imgCache[nf.id] = S._lastPhotoData; }
      } catch (err) { failed++; toast(err.message, true); }
      done++;
      bar.style.width = Math.round((done / files.length) * 100) + '%';
      renderFiles();
    }
    setTimeout(() => { prog.hidden = true; bar.style.width = '0'; }, 600);
    if (done - failed > 0) toast(`${done - failed} file${done - failed > 1 ? 's' : ''} uploaded ✓`);
    S.submission && (S.submission.updatedAt = new Date().toISOString());
  }

  function fillForm(d) { Object.keys(d).forEach(k => { const el = $('#f_' + k); if (el && !el.readOnly) el.value = d[k]; }); }

  function guessMime(n) {
    const e = n.split('.').pop().toLowerCase();
    return ({ pdf: 'application/pdf', doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', txt: 'text/plain',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' })[e] || 'application/octet-stream';
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
  function renderFiles(container = document, files = S.files, canDelete = true) {
    const photos = files.filter(f => f.kind === 'photo'), docs = files.filter(f => f.kind !== 'photo');
    const thumbs = $('#thumbs', container), list = $('#docList', container);
    if ($('#photoCount', container)) $('#photoCount', container).textContent = photos.length ? `${photos.length} / ${CFG.MAX_PHOTOS}` : '';
    if (thumbs) {
      thumbs.innerHTML = photos.length ? photos.map(p => `<div class="thumb" data-id="${esc(p.id)}">${S.imgCache[p.id] ? `<img src="${S.imgCache[p.id]}" alt="${esc(p.name)}">` : '<div class="ph">Loading…</div>'}${canDelete ? `<button class="x" data-del="${esc(p.id)}" aria-label="Delete photo">×</button>` : ''}</div>`).join('')
        : '<div class="muted small" style="grid-column:1/-1">No photos yet.</div>';
      photos.filter(p => !S.imgCache[p.id]).forEach(p => loadThumb(p.id, thumbs));
    }
    if (list) {
      list.innerHTML = docs.length ? docs.map(d => `<li><span class="ficon">${esc(ext(d.name))}</span><span class="nm" title="${esc(d.name)}">${esc(d.name)}<br><span class="muted small">${kb(d.sizeKB)} · ${fmtDate(d.uploadedAt)}</span></span>
          <button class="btn btn-ghost btn-sm" data-open="${esc(d.id)}">View</button>${canDelete ? `<button class="btn btn-danger btn-sm" data-del="${esc(d.id)}" aria-label="Delete">✕</button>` : ''}</li>`).join('')
        : '<li class="muted small">No documents yet.</li>';
    }
    $$('[data-del]', container).forEach(b => b.onclick = () => deleteFile(b.dataset.del));
    $$('[data-open]', container).forEach(b => b.onclick = () => openFile(b.dataset.open, files));
    $$('.thumb img', container).forEach(img => img.onclick = () => lightbox(img.src));
  }

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

  function lightbox(src) {
    const d = document.createElement('div'); d.className = 'lightbox'; d.innerHTML = `<img src="${src}" alt="">`;
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

      const docs = files.filter(f => f.kind !== 'photo');
      if (docs.length) {
        ensure(14);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...green); doc.text(`Documents (${docs.length})`, M, y); y += 6;
        doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.setTextColor(40);
        docs.forEach((d, i) => { ensure(6); doc.text(doc.splitTextToSize(`${i + 1}. ${d.name}  (${kb(d.sizeKB)})`, W - 2 * M)[0], M, y); y += 5.5; });
        y += 3;
      }

      const photos = files.filter(f => f.kind === 'photo');
      if (photos.length) {
        ensure(20);
        doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...green); doc.text(`Photographs (${photos.length})`, M, y); y += 5;
        const colW = (W - 2 * M - 6) / 2;
        let col = 0, rowH = 0;
        for (let i = 0; i < photos.length; i++) {
          busy(true, `Adding photo ${i + 1} of ${photos.length}…`);
          let src = S.imgCache[photos[i].id];
          if (!src) { const r = await api('getFile', { fileId: photos[i].id }); src = S.imgCache[photos[i].id] = `data:${r.mimeType};base64,${r.base64}`; }
          const dim = await new Promise(res => { const im = new Image(); im.onload = () => res([im.naturalWidth, im.naturalHeight]); im.onerror = () => res([4, 3]); im.src = src; });
          let w = colW, h = colW * dim[1] / dim[0];
          if (h > 95) { h = 95; w = h * dim[0] / dim[1]; }
          if (col === 0) ensure(h + 4);
          const x = M + col * (colW + 6) + (colW - w) / 2;
          doc.addImage(src, 'JPEG', x, y, w, h, undefined, 'FAST');
          rowH = Math.max(rowH, h);
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
      const nm = `${CFG.APP_NAME}_${data.memberName || user.name || 'jury'}_${data.area || ''}`.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_');
      doc.save(nm + '.pdf');
      toast('PDF downloaded');
    } catch (err) { toast(err.message, true); }
    finally { busy(false); }
  }

  /* ================================================================
   *  ADMIN VIEW
   * ================================================================ */
  let adminTab = 'members', adminFilter = { q: '', status: '' };

  async function renderAdmin(force) {
    app.innerHTML = `
      <div class="row" style="margin-bottom:12px"><h1>Admin dashboard</h1><div class="spacer"></div><span class="badge b-admin">ADMIN</span></div>
      <div class="stats" id="stats"></div>
      <div id="pendingBox"></div>
      <div class="tabs"><button class="tab ${adminTab === 'members' ? 'on' : ''}" data-tab="members">Jury members</button><button class="tab ${adminTab === 'log' ? 'on' : ''}" data-tab="log">Activity log</button>
        <div class="spacer"></div><button class="btn btn-ghost btn-sm" id="refresh">↻ Refresh</button></div>
      <div id="adminBody" class="card"><div class="muted">Loading…</div></div>`;
    $$('.tab').forEach(t => t.onclick = () => { adminTab = t.dataset.tab; renderAdmin(); });
    $('#refresh').onclick = () => { S.adminMembers = null; renderAdmin(true); };
    try {
      if (!S.adminMembers || force) S.adminMembers = (await api('adminList')).members;
      const pend = S.adminMembers.filter(x => x.pending);
      const m = S.adminMembers.filter(x => x.role !== 'admin' && !x.pending && !x.rejected);
      const sub = m.filter(x => x.status === 'Submitted').length, dr = m.filter(x => x.status === 'Draft').length;
      $('#stats').innerHTML = [
        [m.length, 'Jury members'], [sub, 'Submitted'], [dr, 'Drafts'], [m.length - sub - dr, 'Not started'],
        [m.reduce((a, x) => a + x.photos, 0), 'Photos'], [m.reduce((a, x) => a + x.documents, 0), 'Documents']
      ].map(([n, l]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('');
      renderPending(pend);
      if (adminTab === 'members') renderMembersTable(m); else await renderLog();
    } catch (err) { $('#adminBody').innerHTML = `<div class="notice warn">${esc(err.message)}</div>`; }
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
      try { S.adminMembers = (await api('adminApprove', { email, approve, role: role || 'jury' })).members; toast(approve ? 'Approved as ' + (role || 'jury') + ' ✓' : 'Rejected'); renderAdmin(); }
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
      <div class="table-wrap"><table class="responsive"><thead><tr><th>Member</th><th>Area</th><th>Status</th><th>Files</th><th>Updated</th><th>Last login</th></tr></thead><tbody id="mt"></tbody></table></div>`;
    const draw = () => {
      const q = adminFilter.q.toLowerCase();
      const rows = all.filter(x => (!adminFilter.status || x.status === adminFilter.status) &&
        (!q || [x.name, x.memberName, x.email, x.location, x.phone].join(' ').toLowerCase().includes(q)));
      $('#mt').innerHTML = rows.length ? rows.map(x => `<tr class="click" data-email="${esc(x.email)}">
          <td data-l="Member"><b>${esc(x.memberName || x.name || '—')}</b><br><span class="muted small">${esc(x.email)}${x.phone ? ' · ' + esc(x.phone) : ''}</span></td>
          <td data-l="Area">${esc(x.location || '—')}</td><td data-l="Status">${statusBadge(x.status)}</td>
          <td data-l="Files">${x.photos} 📷 · ${x.documents} 📎</td><td data-l="Updated">${fmtDate(x.updatedAt)}</td><td data-l="Last login">${fmtDate(x.lastLogin)}</td></tr>`).join('')
        : '<tr><td colspan="6" class="muted">No matching members.</td></tr>';
      $$('#mt tr.click').forEach(tr => tr.onclick = () => renderAdminDetail(tr.dataset.email));
    };
    $('#aq').oninput = e => { adminFilter.q = e.target.value; draw(); };
    $('#as').onchange = e => { adminFilter.status = e.target.value; draw(); };
    $('#csv').onclick = () => {
      const cols = ['memberName', 'email', 'phone', 'location', 'status', 'photos', 'documents', 'updatedAt', 'lastLogin', 'folderUrl'];
      const csv = [cols.join(',')].concat(all.map(x => cols.map(c => `"${String(x[c] == null ? '' : x[c]).replace(/"/g, '""')}"`).join(','))).join('\n');
      const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
      a.download = 'paribesh-jury-members.csv'; a.click();
    };
    draw();
  }

  async function renderLog() {
    const r = await api('adminLog', { limit: 300 });
    $('#adminBody').innerHTML = `<div class="table-wrap"><table class="responsive"><thead><tr><th>Time</th><th>Member</th><th>Action</th><th>Details</th></tr></thead><tbody>
      ${r.log.length ? r.log.map(l => `<tr><td data-l="Time">${fmtDate(l.time)}</td><td data-l="Member">${esc(l.name || '')}<br><span class="muted small">${esc(l.email)}</span></td><td data-l="Action"><b>${esc(l.action)}</b></td><td data-l="Details">${esc(l.details)}</td></tr>`).join('')
      : '<tr><td colspan="4" class="muted">No activity yet.</td></tr>'}</tbody></table></div>`;
  }

  async function renderAdminDetail(email) {
    busy(true, 'Loading…');
    let r;
    try { r = await api('adminGet', { email }); } catch (err) { busy(false); return toast(err.message, true); }
    busy(false);
    const meta = (S.adminMembers || []).find(x => x.email === email) || {};
    const sub = r.submission, data = (sub && sub.data) || {};
    app.innerHTML = `
      <button class="btn btn-ghost btn-sm" id="back" style="margin-bottom:12px">← All members</button>
      <div class="row" style="margin-bottom:12px"><div><h1>${esc(data.memberName || r.user.name || email)}</h1><div class="muted small">${esc(email)} · Last login ${fmtDate(meta.lastLogin)}</div></div><div class="spacer"></div>${statusBadge(sub ? sub.status : '')}</div>
      <div class="grid grid-main">
        <div class="card">
          ${sub ? CFG.SECTIONS.map(s => `<div class="section-title"><span class="dot"></span><h2 style="margin:0">${esc(s.title)}</h2></div>
            <dl class="kv">${s.fields.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(data[f.key] || '—')}</dd>`).join('')}</dl>`).join('<div style="height:10px"></div>')
            : '<div class="muted">This member has not started their submission.</div>'}
          ${sub ? `<p class="muted small" style="margin-top:14px">Created ${fmtDate(sub.createdAt)} · Updated ${fmtDate(sub.updatedAt)}</p>` : ''}
        </div>
        <div>
          <div class="card"><h2>Actions</h2><div class="actions-bar">
            ${meta.folderUrl ? `<a class="btn btn-ghost btn-sm" href="${esc(meta.folderUrl)}" target="_blank" rel="noopener">📁 Open Drive folder</a>` : ''}
            <button class="btn btn-ghost btn-sm" id="aPdf" ${sub ? '' : 'disabled'}>⬇ PDF report</button>
            <button class="btn btn-ghost btn-sm" id="aRole">${meta.role === 'admin' ? 'Change to jury' : 'Make admin'}</button>
            <button class="btn btn-danger btn-sm" id="aReset">Reset password</button></div>
            <p class="muted small" style="margin:8px 0 0">Role: <b>${esc(meta.role || 'jury')}</b></p>
            <div id="resetOut"></div></div>
          <div class="card"><h2>Photographs (${r.files.filter(f => f.kind === 'photo').length})</h2><div class="thumbs" id="thumbs"></div></div>
          <div class="card"><h2>Documents</h2><ul class="files" id="docList"></ul></div>
        </div>
      </div>`;
    $('#back').onclick = () => renderAdmin();
    renderFiles(app, r.files, false);
    $('#aPdf').onclick = () => makePdf(r.user, sub, r.files);
    $('#aRole').onclick = async () => {
      const role = meta.role === 'admin' ? 'jury' : 'admin';
      if (!confirmBox(role === 'admin' ? `Make ${email} an ADMIN? They will see all members' data.` : `Change ${email} to jury (remove admin access)?`)) return;
      busy(true, 'Updating role…');
      try { S.adminMembers = (await api('adminSetRole', { email, role })).members; toast('Role set to ' + role + ' ✓'); renderAdminDetail(email); }
      catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
    $('#aReset').onclick = async () => {
      if (!confirmBox(`Reset the password for ${email}? They will need the new temporary password to log in.`)) return;
      busy(true, 'Resetting…');
      try {
        const x = await api('adminResetPassword', { email });
        $('#resetOut').innerHTML = `<div class="notice" style="margin-top:12px">Temporary password for <b>${esc(x.email)}</b>:<br><code style="font-size:1.1rem">${esc(x.tempPassword)}</code><br><span class="small">Share it privately. They will be asked to change it on login.</span></div>`;
      } catch (err) { toast(err.message, true); }
      finally { busy(false); }
    };
  }

  /* ================================================================
   *  DEMO BACKEND (only used when API_URL is not set)
   * ================================================================ */
  const Mock = {
    key: 'pbj_demo_db',
    files: {},
    db() {
      let d = store.get(this.key);
      if (!d) {
        d = { users: {
          'jury@demo.in': { email: 'jury@demo.in', name: 'Demo Jury Member', phone: '9800000000', role: 'jury', pw: 'demo1234', mustChange: false },
          'admin@demo.in': { email: 'admin@demo.in', name: 'Demo Admin', phone: '', role: 'admin', pw: 'admin1234', mustChange: false },
          'new@demo.in': { email: 'new@demo.in', name: 'New Member', phone: '9811111111', role: 'jury', pw: 'temp1234', mustChange: true }
        }, subs: {}, files: [], log: [] };
        store.set(this.key, d);
      }
      return d;
    },
    save(d) { store.set(this.key, d); },
    pub(u) { return { email: u.email, name: u.name, phone: u.phone, role: u.role, mustChange: u.mustChange }; },
    log(d, u, a, det) { d.log.push({ time: new Date().toISOString(), email: u.email, name: u.name, action: a, details: det || '' }); },
    myFiles(d, e) { return d.files.filter(f => f.email === e && !f.deleted).map(({ id, name, mimeType, kind, sizeKB, uploadedAt }) => ({ id, name, mimeType, kind, sizeKB, uploadedAt })); },
    async handle(b) {
      await new Promise(r => setTimeout(r, 150));
      const d = this.db();
      if (b.action === 'login') {
        const u = d.users[String(b.email).toLowerCase()];
        if (!u || u.pw !== b.password) return { ok: false, error: 'Incorrect email or password' };
        u.lastLogin = new Date().toISOString(); this.log(d, u, 'LOGIN'); this.save(d);
        return { ok: true, token: 'demo:' + u.email, user: this.pub(u) };
      }
      if (b.action === 'register') {
        const ph = String(b.phone).replace(/\D/g, '').slice(-10);
        if (d.users[ph]) return { ok: false, error: 'Already registered' };
        d.users[ph] = { email: ph, name: b.name, phone: ph, role: 'jury', pw: '', pending: true, assignedArea: b.area, reference: b.reference, altEmail: b.emailAddr, source: new Date().toLocaleString() };
        this.save(d); return { ok: true, message: 'Registration received. You will be able to log in once the organisers approve it.' };
      }
      if (b.action === 'requestCode') { this.otp = { id: String(b.email).toLowerCase(), code: '123456' }; return { ok: true, message: 'Demo: your code is 123456' }; }
      if (b.action === 'verifyCode') {
        const x = d.users[String(b.email).toLowerCase()];
        if (!x || b.code !== '123456') return { ok: false, error: 'Incorrect code' };
        x.pw = b.newPassword; x.mustChange = false; this.save(d);
        return { ok: true, token: 'demo:' + x.email, user: this.pub(x) };
      }
      const u = b.token && d.users[String(b.token).replace('demo:', '')];
      if (!u) return { ok: false, error: 'Session expired', code: 'AUTH' };
      const now = new Date().toISOString();
      switch (b.action) {
        case 'logout': return { ok: true };
        case 'me': return { ok: true, user: this.pub(u), submission: d.subs[u.email] || null, files: this.myFiles(d, u.email) };
        case 'changePassword':
          if (b.oldPassword !== u.pw) return { ok: false, error: 'Current password is incorrect' };
          u.pw = b.newPassword; u.mustChange = false; this.log(d, u, 'PASSWORD_CHANGED'); this.save(d);
          return { ok: true, token: b.token, user: this.pub(u) };
        case 'saveSubmission': {
          const s = d.subs[u.email];
          const st = s && s.status === 'Submitted' ? 'Submitted' : b.status;
          d.subs[u.email] = { data: b.data, status: st, memberName: b.data.memberName, location: b.data.area, createdAt: s ? s.createdAt : now, updatedAt: now };
          this.log(d, u, s ? (b.status === 'Submitted' ? 'SUBMITTED' : 'SUBMISSION_UPDATED') : 'SUBMISSION_CREATED', `${b.data.memberName} - ${b.data.area}`);
          this.save(d);
          return { ok: true, user: this.pub(u), submission: d.subs[u.email], files: this.myFiles(d, u.email) };
        }
        case 'uploadFile': {
          const id = 'f' + Date.now() + Math.random().toString(36).slice(2, 6);
          const sizeKB = Math.round(b.base64.length * 0.75 / 1024);
          d.files.push({ id, email: u.email, name: b.name, mimeType: b.mimeType, kind: b.kind, sizeKB, uploadedAt: now });
          this.files[id] = b; this.log(d, u, 'UPLOAD', `${b.kind}: ${b.name} (${sizeKB} KB)`); this.save(d);
          return { ok: true, files: this.myFiles(d, u.email) };
        }
        case 'deleteFile': { const f = d.files.find(x => x.id === b.fileId && x.email === u.email); if (f) { f.deleted = true; this.log(d, u, 'FILE_DELETED', f.name); } this.save(d); return { ok: true, files: this.myFiles(d, u.email) }; }
        case 'getFile': { const f = this.files[b.fileId]; if (!f) return { ok: false, error: 'Demo files are kept only until the page is reloaded' }; return { ok: true, mimeType: f.mimeType, base64: f.base64 }; }
      }
      if (u.role !== 'admin') return { ok: false, error: 'Not permitted' };
      switch (b.action) {
        case 'adminSetRole': { d.users[b.email].role = b.role === 'admin' ? 'admin' : 'jury'; this.save(d); return this.handle({ action: 'adminList', token: b.token }); }
        case 'adminApprove': { const x = d.users[b.email]; if (b.approve === false) x.rejected = true; else x.role = b.role === 'admin' ? 'admin' : 'jury'; x.pending = false; this.save(d); return this.handle({ action: 'adminList', token: b.token }); }
        case 'adminList': return { ok: true, members: Object.values(d.users).map(x => { const s = d.subs[x.email]; const fs = this.myFiles(d, x.email);
          return { pending: !!x.pending, rejected: !!x.rejected, assignedArea: x.assignedArea, reference: x.reference, altEmail: x.altEmail, source: x.source, email: x.email, name: x.name, phone: x.phone, role: x.role, lastLogin: x.lastLogin || '', status: s ? s.status : 'Not started', location: s ? s.location : '', memberName: s ? s.memberName : x.name,
            folderUrl: s ? 'https://drive.google.com/' : '', updatedAt: s ? s.updatedAt : '', photos: fs.filter(f => f.kind === 'photo').length, documents: fs.filter(f => f.kind !== 'photo').length }; }) };
        case 'adminGet': { const x = d.users[b.email]; return { ok: true, user: x ? this.pub(x) : { email: b.email }, submission: d.subs[b.email] || null, files: this.myFiles(d, b.email) }; }
        case 'adminLog': return { ok: true, log: d.log.slice(-300).reverse() };
        case 'adminResetPassword': { const x = d.users[b.email]; x.pw = 'Temp' + Math.floor(1000 + Math.random() * 9000); x.mustChange = true; this.log(d, u, 'ADMIN_PASSWORD_RESET', x.email); this.save(d); return { ok: true, email: x.email, tempPassword: x.pw }; }
      }
      return { ok: false, error: 'Unknown action' };
    }
  };

  boot();
})();
