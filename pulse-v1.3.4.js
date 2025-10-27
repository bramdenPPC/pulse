/* =========================================================================
   Pulse v1.3.4
   Unified tracking layer for anon/page_view/lead events via n8n → Fabric.
   -------------------------------------------------------------------------
   Key behaviours:
   • Consent-gated (requires window.PulseConsent === true OR "pulse:consent" event)
   • Hybrid ID storage (anon_id = localStorage + cookie mirror, sess_id = cookie)
   • Fires anon, page_view, and lead events
   • Generates new session_id when expired (used across events)
   • Always allows native form submission
   • Adds viewport/language/title/device_type context
   • DEBUG toggle + pulse:revoke listener
   • Includes version number in logs + payloads
   ========================================================================= */

(function () {

  const VERSION = '1.3.4';
  const DEBUG = true; // ← set false in production

  // ---- Logging helpers ----
  const log  = (...a)=>DEBUG&&console.log(`[Pulse v${VERSION}]`, ...a);
  const info = (...a)=>DEBUG&&console.info(`[Pulse v${VERSION}]`, ...a);
  const warn = (...a)=>DEBUG&&console.warn(`[Pulse v${VERSION}]`, ...a);

  // ---- Consent gate ----
  if (window.PulseConsent !== true) {
    info('waiting for consent...');
    window.addEventListener('pulse:consent', () => initPulse(), { once: true });
  } else initPulse();

  // ---- Revoke listener ----
  window.addEventListener('pulse:revoke', () => {
    info('revoke event → clearing identifiers');
    window.Pulse?.reset();
  });

  function initPulse() {
    info('initialising...');

    // ---- read config from script tag ----
    const S = document.currentScript || document.querySelector('script[src*="pulse.js"]');
    const CFG = {
      MODE: (S?.getAttribute('data-mode') || 'limited').toLowerCase(),
      BASE: trimSlash(S?.getAttribute('data-base') || ''),
      SITE: S?.getAttribute('data-site') || location.hostname,
      WS_ANON: S?.getAttribute('data-ws-anon') || '/pulse/anon',
      WS_PAGEVIEW: S?.getAttribute('data-ws-pageview') || '/pulse/page_view',
      WS_LEAD: S?.getAttribute('data-ws-lead') || '/pulse/lead',
      SESSION_TIMEOUT: toInt(S?.getAttribute('data-session-timeout'), 1800)
    };
    if (!CFG.BASE) warn('missing data-base');

    // ---- utility helpers ----
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
        let id = localStorage.getItem('pulse_anon');
        const cookieId = readCookie('pulse_anon');
        if (id && !cookieId) {
          writeCookie('pulse_anon', id, 365);
          return id;
        }
        if (id) return id;
        id = 'anon_' + uuidv4();
        localStorage.setItem('pulse_anon', id);
        writeCookie('pulse_anon', id, 365);
        info('new anon_id created:', id);
        return id;
      } catch (e) {
        warn('anon_id storage failed, using volatile fallback', e);
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
        info('new session_id generated:', sess);
      }
      writeCookie('pulse_sess_at', String(now), 1);
      return sess;
    }

    const anon_id = getAnonId();
    const sess_id = getSessId(CFG.SESSION_TIMEOUT);

    // ---- network helpers ----
    function sendJSON(url, payload){
      if (!CFG.BASE) return Promise.resolve();
      const body = JSON.stringify(payload);
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(url, body)) {
          info('beacon sent →', url);
          return Promise.resolve({ ok:true, beacon:true });
        }
      } catch (err) { warn('beacon failed', err); }
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
        log('fetch fallback →', url);
      } catch (err) { warn('fetch failed silently', err); }
      return Promise.resolve({ ok:true, fetch:true });
    }

    // ---- context helpers ----
    function pageMeta(){
      const u = new URL(location.href);
      const utm = {};
      ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(k=>{
        const v = u.searchParams.get(k); if (v) utm[k]=v;
      });
      return {
        domain: location.hostname,
        referrer: document.referrer || '',
        landing_page: location.pathname + location.search + location.hash,
        title: document.title || '',
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
      for (const k in map) if (p.has(k)) return { tid:p.get(k), tid_p:map[k] };
      return {};
    }

    // ---- emitters ----
    (function emitAnonAndPageView(){
      // anon event (once per browser)
      if (!readCookie('pulse_seen')) {
        writeCookie('pulse_seen','1',365);
        const anonPayload = {
          pulse_type: 'anon',
          anon_id,
          session_id: sess_id,
          created_at: iso(),
          first_seen_ts: iso(),
          user_agent: navigator.userAgent || '',
          domain: CFG.SITE,
          mode: CFG.MODE,
          pulse_version: VERSION
        };
        info('firing anon event');
        sendJSON(CFG.BASE + CFG.WS_ANON, anonPayload);
      }

      // page_view event (fires every page load)
      const meta = pageMeta();
      const tid = extractTid();
      const pvPayload = {
        pulse_type: 'page_view',
        session_id: sess_id,
        anon_id,
        first_seen_ts: iso(),
        created_at: iso(),
        ...meta, ...tid,
        mode: CFG.MODE,
        pulse_version: VERSION
      };
      info('firing page_view event');
      sendJSON(CFG.BASE + CFG.WS_PAGEVIEW, pvPayload);
    })();

    // ---- form submission tracking ----
    document.addEventListener('submit', function(ev){
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;
      ensureHidden(form, 'anon_id', anon_id);
      ensureHidden(form, 'session_id', sess_id);

      const payload = {
        pulse_type: 'lead',
        lead_id: 'lead_' + uuidv4(),
        anon_id,
        session_id: sess_id,
        created_at: iso(),
        ...pageMeta(),
        ...extractTid(),
        form_data: serializeForm(form),
        mode: CFG.MODE,
        pulse_version: VERSION
      };
      info('firing lead event');
      sendJSON(CFG.BASE + CFG.WS_LEAD, payload);
    }, true);

    // ---- helpers ----
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

    // ---- public API ----
    window.Pulse = {
      reset: function(){
        try {
          localStorage.removeItem('pulse_anon');
          ['pulse_anon','pulse_sess','pulse_sess_at','pulse_seen'].forEach(n=>{
            writeCookie(n,'',-1);
          });
          info('identifiers cleared');
        } catch(e){ warn('reset failed', e); }
      }
    };
  }
})();
