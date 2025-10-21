/* =========================================================================
   Pulse v1.1
   Unified tracking layer for anon/session/lead events via n8n → Fabric.
   -------------------------------------------------------------------------
   Key behaviours:
   • Consent-gated (requires window.PulseConsent === true OR "pulse:consent" event)
   • Hybrid ID storage (anon_id = localStorage + cookie mirror, sess_id = cookie)
   • Fires anon, session, and lead events
   • Always allows native form submission
   ========================================================================= */

(function () {
  // Wait for consent --------------------------------------------------------
  if (window.PulseConsent !== true) {
    console.info('[Pulse] waiting for consent...');
    window.addEventListener('pulse:consent', () => initPulse(), { once: true });
  } else {
    initPulse();
  }

  function initPulse() {
    console.info('[Pulse] initialising...');

    // ---- read config from script tag ----
    const S = document.currentScript || document.querySelector('script[src*="pulse.js"]');
    const CFG = {
      MODE: (S?.getAttribute('data-mode') || 'limited').toLowerCase(),
      BASE: trimSlash(S?.getAttribute('data-base') || ''),
      SITE: S?.getAttribute('data-site') || location.hostname,
      WS_ANON: S?.getAttribute('data-ws-anon') || '/pulse/anon',
      WS_SESS: S?.getAttribute('data-ws-sess') || '/pulse/session',
      WS_LEAD: S?.getAttribute('data-ws-lead') || '/pulse/lead',
      SESSION_TIMEOUT: toInt(S?.getAttribute('data-session-timeout'), 1800)
    };
    if (!CFG.BASE) console.warn('[Pulse] missing data-base');

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

    // ---- ID management (hybrid model) ----
    function getAnonId() {
      try {
        let id = localStorage.getItem('pulse_anon');
        const cookieId = readCookie('pulse_anon');

        // Restore cookie from localStorage if missing
        if (id && !cookieId) {
          writeCookie('pulse_anon', id, 365);
          return id;
        }
        // If both exist, trust localStorage
        if (id) return id;

        // None exist → generate new
        id = 'anon_' + uuidv4();
        localStorage.setItem('pulse_anon', id);
        writeCookie('pulse_anon', id, 365);
        return id;
      } catch (e) {
        console.warn('[Pulse] anon_id storage failed, using volatile fallback', e);
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
        if (navigator.sendBeacon) {
          const ok = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
          if (ok) return Promise.resolve({ ok:true, beacon:true });
        }
      } catch {}
      return fetch(url, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body, keepalive:true, credentials:'omit', cache:'no-store'
      }).catch(()=>({ok:false}));
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
      for (const k in map) if (p.has(k)) return { tid:p.get(k), tidp:map[k] };
      return {};
    }

    // ---- emitters ----
    (function emitAnonAndSession(){
      // Only emit anon on very first presence
      if (!readCookie('pulse_seen')) {
        writeCookie('pulse_seen','1',365);
        const anonPayload = {
          anon_id,
          created_at: iso(),
          first_seen_ts: iso(),
          user_agent: navigator.userAgent || '',
          domain: CFG.SITE,
          mode: CFG.MODE
        };
        sendJSON(CFG.BASE + CFG.WS_ANON, anonPayload);
      }
      // Always emit session when new or expired
      const meta = pageMeta();
      const tid = extractTid();
      const sessPayload = {
        session_id: sess_id,
        anon_id,
        first_seen_ts: iso(),
        created_at: iso(),
        ...meta, ...tid,
        mode: CFG.MODE
      };
      sendJSON(CFG.BASE + CFG.WS_SESS, sessPayload);
    })();

    // ---- form submission tracking ----
    document.addEventListener('submit', function(ev){
      const form = ev.target;
      if (!(form instanceof HTMLFormElement)) return;

      // attach hidden IDs for backend visibility
      ensureHidden(form, 'anon_id', anon_id);
      ensureHidden(form, 'session_id', sess_id);

      const payload = {
        lead_id: 'lead_' + uuidv4(),
        anon_id, session_id: sess_id,
        created_at: iso(),
        ...pageMeta(),
        ...extractTid(),
        form_data: serializeForm(form),
        mode: CFG.MODE
      };
      sendJSON(CFG.BASE + CFG.WS_LEAD, payload);
      // do not block native submit (thank-you pages work)
    }, true);

    function serializeForm(form){
      const fd = new FormData(form);
      const out = {};
      for (const [k,v] of fd.entries()){
        if (k in out) Array.isArray(out[k]) ? out[k].push(v) : out[k] = [out[k],v];
        else out[k] = v;
      }
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
          console.info('[Pulse] identifiers cleared');
        } catch(e){ console.warn('[Pulse] reset failed', e); }
      }
    };
  }
})();