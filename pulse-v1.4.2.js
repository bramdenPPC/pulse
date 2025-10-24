/* =========================================================================
   Pulse v1.4.2
   Unified tracking layer for anon/page_view/lead events via n8n → Fabric.
   -------------------------------------------------------------------------
   Key behaviours:
   • Consent-gated (requires window.PulseConsent === true OR "pulse:consent")
   • Hybrid ID storage (anon_id = localStorage + cookie mirror, sess_id = cookie)
   • Fires anon, session_start, page_view, and lead events
   • Responds to "pulse:revoke" to clear identifiers
   • Consistent payload fields across all events
   • DEBUG flag for logging control
   ========================================================================= */

(function () {

  // ---- Toggle console logging ----
  const DEBUG = true; // ← set false in production
  const log  = (...a) => DEBUG && console.log(...a);
  const info = (...a) => DEBUG && console.info(...a);
  const warn = (...a) => DEBUG && console.warn(...a);

  // ---- Consent gate ----
  if (window.PulseConsent !== true) {
    info('[Pulse] waiting for consent...');
    window.addEventListener('pulse:consent', () => initPulse(), { once: true });
  } else initPulse();

  // ---- Revoke listener ----
  window.addEventListener('pulse:revoke', () => {
    if (window.Pulse) {
      info('[Pulse] revoke event received → clearing identifiers');
      window.Pulse.reset();
    }
  });

  function initPulse() {
    info('[Pulse] initialising...');

    // ---- Config ----
    const S = document.currentScript || document.querySelector('script[src*="pulse.js"]');
    const CFG = {
      MODE: (S?.getAttribute('data-mode') || 'limited').toLowerCase(),
      BASE: trimSlash(S?.getAttribute('data-base') || ''),
      SITE: S?.getAttribute('data-site') || location.hostname,
      WS_ANON: S?.getAttribute('data-ws-anon') || '/pulse/anon',
      WS_PAGEVIEW: S?.getAttribute('data-ws-pageview') || '/pulse/page_view',
      WS_SESS_START: S?.getAttribute('data-ws-session-start') || '/pulse/session_start',
      WS_LEAD: S?.getAttribute('data-ws-lead') || '/pulse/lead',
      SESSION_TIMEOUT: toInt(S?.getAttribute('data-session-timeout'), 1800)
    };
    if (!CFG.BASE) warn('[Pulse] missing data-base attribute');

    // ---- Helpers ----
    function trimSlash(s){ return s ? s.replace(/\/+$/,'') : s; }
    function toInt(v,d){ v=parseInt(v,10); return isNaN(v)?d:v; }
    function iso(){ return new Date().toISOString(); }
    function uuidv4(){
      if (crypto.randomUUID) return crypto.randomUUID();
      const a = new Uint8Array(16);
      crypto.getRandomValues(a);
      a[6] = (a[6] & 0x0f) | 0x40;
      a[8] = (a[8] & 0x3f) | 0x80;
      const h = [...a].map(b=>b.toString(16).padStart(2,'0'));
      return `${h.slice(0,4).join('')}-${h.slice(4,6).join('')}-${h.slice(6,8).join('')}-${h.slice(8,10).join('')}-${h.slice(10).join('')}`;
    }
    function readCookie(name){
      const m = document.cookie.match(new RegExp('(?:^|; )'+name+'=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    }
    function writeCookie(name,value,days){
      const exp = new Date(Date.now()+days*864e5).toUTCString();
      document.cookie = `${name}=${encodeURIComponent(value)}; expires=${exp}; path=/; SameSite=Lax; Secure`;
    }

    // ---- ID management ----
    function getAnonId() {
      try {
        const cookieId = readCookie('pulse_anon');
        if (cookieId) {
          log('[Pulse] existing anon_id:', cookieId);
          return cookieId;
        }
        const id = 'anon_' + uuidv4();
        localStorage.setItem('pulse_anon', id);
        writeCookie('pulse_anon', id, 365);
        info('[Pulse] new anon_id created:', id);
        return id;
      } catch (e) {
        warn('[Pulse] anon_id storage failed, using volatile fallback', e);
        return 'anon_' + uuidv4();
      }
    }

    function getSessId(timeoutSec) {
      const last = parseInt(readCookie('pulse_sess_at') || '0', 10) || 0;
      const now = Date.now();
      let sess = readCookie('pulse_sess');
      const expired = !sess || (now - last) > timeoutSec * 1000;
      if (expired) {
        sess = 'sess_' + uuidv4();
        writeCookie('pulse_sess', sess, 1);
        info('[Pulse] new session started:', sess);
        sendSessionStart(sess);
      } else log('[Pulse] existing session_id:', sess);
      writeCookie('pulse_sess_at', String(now), 1);
      return sess;
    }

    const anon_id = getAnonId();
    const sess_id = getSessId(CFG.SESSION_TIMEOUT);

    // ---- Network helper ----
    function sendJSON(endpoint, payload){
      if (!CFG.BASE) return Promise.resolve();
      const url = CFG.BASE + endpoint;
      const body = JSON.stringify(payload, null, DEBUG ? 2 : 0);
      log('[Pulse] sending →', url, payload);
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(url, body)) {
          info('[Pulse] beacon sent →', url);
          return Promise.resolve({ ok:true, beacon:true });
        }
      } catch (err) { warn('[Pulse] beacon failed', err); }
      try {
        fetch(url, {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body,
          keepalive:true,
          credentials:'omit',
          cache:'no-store',
          mode:'no-cors'
        });
        log('[Pulse] fetch fallback →', url);
      } catch (err) { warn('[Pulse] fetch failed', err); }
      return Promise.resolve({ ok:true, fetch:true });
    }

    // ---- Context helpers ----
    function pageMeta(){
      const u = new URL(location.href);
      const utm = {};
      ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(k=>{
        const v = u.searchParams.get(k); if (v) utm[k]=v;
      });
      return {
        domain: location.hostname,
        referrer: document.referrer || '',
        title: document.title || '',
        landing_page: location.pathname + location.search + location.hash,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        language: navigator.language || '',
        device_type: /Mobi|Android/i.test(navigator.userAgent) ? 'mobile' : 'desktop',
        ...utm
      };
    }

    function extractTid(){
      const p = new URLSearchParams(location.search);
      const map = {
        gclid:'google_ads', gbraid:'google_ads', wbraid:'google_ads',
        fbclid:'meta_ads', ttclid:'tiktok_ads', li_fat_id:'linkedin_ads',
        msclkid:'microsoft_ads', snap_clickid:'snap_ads', ad_id:'generic'
      };
      for (const k in map) if (p.has(k)) {
        log('[Pulse] found tracking id →', k, p.get(k));
        return { tid:p.get(k), tid_p:map[k] };
      }
      return {};
    }

    // ---- Event emitters ----
    function sendAnonEvent() {
      const payload = {
        pulse_type: 'anon',
        anon_id,
        session_id: sess_id,
        created_at: iso(),
        first_seen_ts: iso(),
        user_agent: navigator.userAgent || '',
        domain: CFG.SITE,
        mode: CFG.MODE,
        pulse_version: '1.4.2'
      };
      info('[Pulse] firing anon event');
      sendJSON(CFG.WS_ANON, payload);
    }

    function sendSessionStart(sess_id){
      const payload = {
        pulse_type: 'session_start',
        anon_id,
        session_id: sess_id,
        created_at: iso(),
        first_seen_ts: iso(),
        user_agent: navigator.userAgent || '',
        domain: CFG.SITE,
        mode: CFG.MODE,
        pulse_version: '1.4.2'
      };
      info('[Pulse] firing session_start event');
      sendJSON(CFG.WS_SESS_START, payload);
    }

    (function emitPageView(){
      const meta = pageMeta();
      const tid = extractTid();
      const payload = {
        pulse_type: 'page_view',
        pageview_id: 'pv_' + uuidv4(),
        anon_id,
        session_id: sess_id,
        created_at: iso(),
        first_seen_ts: iso(),
        user_agent: navigator.userAgent || '',
        ...meta, ...tid,
        mode: CFG.MODE,
        pulse_version: '1.4.2'
      };
      info('[Pulse] firing page_view event');
      sendJSON(CFG.WS_PAGEVIEW, payload);
    })();

    // ---- Fire anon once per new anon_id ----
    if (!readCookie('pulse_anon')) sendAnonEvent();

    // ---- Form submission tracking ----
    document.addEventListener('submit', ev => {
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;
      ensureHidden(form, 'anon_id', anon_id);
      ensureHidden(form, 'session_id', sess_id);

      const payload = {
        pulse_type: 'lead',
        lead_id: 'lead_' + uuidv4(),
        anon_id,
        session_id: sess_id,
        pageview_id: 'pv_' + uuidv4(),
        created_at: iso(),
        first_seen_ts: iso(),
        user_agent: navigator.userAgent || '',
        ...pageMeta(),
        ...extractTid(),
        form_data: serializeForm(form),
        mode: CFG.MODE,
        pulse_version: '1.4.2'
      };
      info('[Pulse] lead form submission detected → firing lead event');
      sendJSON(CFG.WS_LEAD, payload);
    }, true);

    // ---- Form helpers ----
    function serializeForm(form){
      const fd = new FormData(form);
      const out = {};
      for (const [k,v] of fd.entries()){
        if (k in out) Array.isArray(out[k]) ? out[k].push(v) : out[k] = [out[k],v];
        else out[k] = v;
      }
      ['anon_id','session_id','utm_source','utm_medium','utm_campaign','utm_term','utm_content','tid','tid_p','tidp']
        .forEach(k => delete out[k]);
      const t = form.getAttribute('data-form-type');
      if (t && !out.type) out.type = t;
      return out;
    }

    function ensureHidden(form, name, value){
      let el = form.querySelector(`input[name="${name}"]`);
      if (!el){
        el = document.createElement('input');
        el.type = 'hidden'; el.name = name;
        form.appendChild(el);
      }
      el.value = value;
    }

    // ---- Public API ----
    window.Pulse = {
      reset: function(){
        try {
          localStorage.removeItem('pulse_anon');
          ['pulse_anon','pulse_sess','pulse_sess_at'].forEach(n=>{
            writeCookie(n,'',-1);
          });
          info('[Pulse] identifiers cleared');
        } catch(e){ warn('[Pulse] reset failed', e); }
      }
    };
  }
})();