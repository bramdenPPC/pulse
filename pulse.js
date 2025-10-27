/* =========================================================================
   Pulse v1.3.10
   Unified tracking layer for anon/session_start/page_view/lead events.
   -------------------------------------------------------------------------
   • Consent gated
   • Hybrid ID storage (anon_id + session_id)
   • Derives full device/browser context once per session
   • Slimmer page_view events (no UTM/device duplication)
   • Links lead → last pageview via sessionStorage
   • No first_seen_ts
   • Uses page_path / page_referrer / page_title naming
   ========================================================================= */

(function () {
  const VERSION = '1.3.10';
  const DEBUG = true;

  const log  = (...a)=>DEBUG&&console.log(`[Pulse v${VERSION}]`, ...a);
  const info = (...a)=>DEBUG&&console.info(`[Pulse v${VERSION}]`, ...a);
  const warn = (...a)=>DEBUG&&console.warn(`[Pulse v${VERSION}]`, ...a);

  if (window.PulseConsent !== true) {
    info('waiting for consent...');
    window.addEventListener('pulse:consent', () => initPulse(), { once: true });
  } else initPulse();

  window.addEventListener('pulse:revoke', () => {
    info('revoke event → clearing identifiers');
    window.Pulse?.reset();
  });

  function initPulse() {
    info('initialising...');
    const S = document.currentScript || document.querySelector('script[src*="pulse.js"]');
    const CFG = {
      MODE: (S?.getAttribute('data-mode') || 'limited').toLowerCase(),
      BASE: trimSlash(S?.getAttribute('data-base') || ''),
      SITE: S?.getAttribute('data-site') || location.hostname,
      WS_ANON: S?.getAttribute('data-ws-anon') || '/pulse/anon',
      WS_SESS_START: S?.getAttribute('data-ws-sess-start') || '/pulse/session_start',
      WS_PAGEVIEW: S?.getAttribute('data-ws-pageview') || '/pulse/page_view',
      WS_LEAD: S?.getAttribute('data-ws-lead') || '/pulse/lead',
      SESSION_TIMEOUT: toInt(S?.getAttribute('data-session-timeout'), 1800)
    };
    if (!CFG.BASE) warn('missing data-base');

    function trimSlash(s){ return s ? s.replace(/\/+$/,'') : s; }
    function toInt(v,d){ v=parseInt(v,10); return isNaN(v)?d:v; }
    function iso(){ return new Date().toISOString(); }
    function uuidv4(){
      if (crypto.randomUUID) return crypto.randomUUID();
      const a = new Uint8Array(16); crypto.getRandomValues(a);
      a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
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

    function parseUA(ua){
      ua = ua.toLowerCase();
      return {
        device_os:
          /android/.test(ua) ? 'Android' :
          /iphone|ipad|ipod/.test(ua) ? 'iOS' :
          /windows/.test(ua) ? 'Windows' :
          /mac os/.test(ua) ? 'MacOS' :
          /linux/.test(ua) ? 'Linux' : 'Other',
        browser_name:
          /chrome|crios/.test(ua) ? 'Chrome' :
          /safari/.test(ua) && !/chrome|crios/.test(ua) ? 'Safari' :
          /firefox/.test(ua) ? 'Firefox' :
          /edg/.test(ua) ? 'Edge' :
          /opera|opr/.test(ua) ? 'Opera' : 'Other'
      };
    }

    function getAnonId() {
      try {
        let id = localStorage.getItem('pulse_anon');
        const cookieId = readCookie('pulse_anon');
        if (id && !cookieId) { writeCookie('pulse_anon', id, 365); return id; }
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
        writeCookie('pulse_sess_seen', '', -1);
        info('new session_id generated:', sess);
      }
      writeCookie('pulse_sess_at', String(now), 1);
      return sess;
    }

    const anon_id = getAnonId();
    const sess_id = getSessId(CFG.SESSION_TIMEOUT);
    if (!readCookie('pulse_sess_seen')) {
      emitSessionStart(sess_id);
      writeCookie('pulse_sess_seen', '1', 1);
    }

    function sendJSON(url, payload){
      if (!CFG.BASE) return Promise.resolve();
      const body = JSON.stringify(payload);
      info('sending →', url, payload);
      try {
        if (navigator.sendBeacon && navigator.sendBeacon(url, body)) return Promise.resolve({ ok:true });
      } catch {}
      try { fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body,keepalive:true,mode:'no-cors'}); } catch {}
      return Promise.resolve({ ok:true });
    }

    function pageMeta(){
      const u = new URL(location.href);
      const utm = {};
      ['utm_source','utm_medium','utm_campaign','utm_term','utm_content'].forEach(k=>{
        const v = u.searchParams.get(k); if (v) utm[k]=v;
      });
      const ua = navigator.userAgent || '';
      const parsed = parseUA(ua);
      return {
        domain: location.hostname,
        page_referrer: document.referrer || '',
        page_path: location.pathname + location.search + location.hash,
        page_title: document.title || '',
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        language: navigator.language || '',
        device_type: /Mobi|Android/i.test(ua) ? 'mobile' : 'desktop',
        device_os: parsed.device_os,
        browser_name: parsed.browser_name,
        ...utm
      };
    }

    function extractTid(){
      const p = new URLSearchParams(location.search);
      const known = ['gclid','gbraid','wbraid','fbclid','ttclid','li_fat_id','msclkid','snap_clickid','ad_id'];
      for (const key of known){
        if (p.has(key)) return { tid: p.get(key), tid_p: key };
      }
      return {};
    }

    function emitSessionStart(sess){
      const meta = pageMeta();
      const tid = extractTid();
      const payload = {
        pulse_type: 'session_start',
        created_at: iso(),
        pulse_version: VERSION,
        anon_id, session_id: sess,
        user_agent: navigator.userAgent || '',
        ...meta, ...tid,
        mode: CFG.MODE
      };
      sendJSON(CFG.BASE + CFG.WS_SESS_START, payload);
    }

    (function emitAnonAndPageView(){
      const meta = pageMeta();
      const tid = extractTid();

      if (!readCookie('pulse_seen')) {
        writeCookie('pulse_seen','1',365);
        const anonPayload = {
          pulse_type: 'anon',
          created_at: iso(),
          pulse_version: VERSION,
          anon_id, session_id: sess_id,
          user_agent: navigator.userAgent || '',
          ...meta, ...tid,
          mode: CFG.MODE
        };
        sendJSON(CFG.BASE + CFG.WS_ANON, anonPayload);
      }

      const pageview_id = 'pv_' + uuidv4();
      sessionStorage.setItem('pulse_last_pv', pageview_id);
      const pvPayload = {
        pulse_type: 'page_view',
        created_at: iso(),
        pulse_version: VERSION,
        anon_id, session_id: sess_id, pageview_id,
        page_title: document.title || '',
        page_referrer: document.referrer || '',
        page_path: location.pathname + location.search + location.hash,
        viewport: `${window.innerWidth}x${window.innerHeight}`,
        domain: location.hostname,
        mode: CFG.MODE
      };
      sendJSON(CFG.BASE + CFG.WS_PAGEVIEW, pvPayload);
    })();

    document.addEventListener('submit', function(ev){
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;
      ensureHidden(form, 'anon_id', anon_id);
      ensureHidden(form, 'session_id', sess_id);
      const lastPV = sessionStorage.getItem('pulse_last_pv') || null;
      const payload = {
        pulse_type: 'lead',
        created_at: iso(),
        pulse_version: VERSION,
        anon_id, session_id: sess_id, pageview_id: lastPV,
        lead_id: 'lead_' + uuidv4(),
        user_agent: navigator.userAgent || '',
        ...pageMeta(), ...extractTid(),
        form_data: serializeForm(form),
        mode: CFG.MODE
      };
      sendJSON(CFG.BASE + CFG.WS_LEAD, payload);
    }, true);

    function serializeForm(form){
      const fd = new FormData(form);
      const out = {};
      for (const [k,v] of fd.entries()){
        if (k in out) Array.isArray(out[k]) ? out[k].push(v) : out[k] = [out[k],v];
        else out[k] = v;
      }
      ['anon_id','session_id','utm_source','utm_medium','utm_campaign','utm_term','utm_content','tid','tid_p','tidp','user_agent']
        .forEach(k => delete out[k]);
      const t = form.getAttribute('data-form-type');
      if (t && !out.type) out.type = t;
      return out;
    }

    function ensureHidden(form, name, value){
      let el = form.querySelector(`input[name="${name}"]`);
      if (!el){ el = document.createElement('input'); el.type='hidden'; el.name=name; form.appendChild(el); }
      el.value = value;
    }

    window.Pulse = {
      reset: function(){
        try {
          localStorage.removeItem('pulse_anon');
          ['pulse_anon','pulse_sess','pulse_sess_at','pulse_seen','pulse_sess_seen'].forEach(n=>writeCookie(n,'',-1));
          info('identifiers cleared');
        } catch(e){ warn('reset failed', e); }
      }
    };
  }
})();
