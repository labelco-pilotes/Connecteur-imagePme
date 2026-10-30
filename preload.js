// Preload injecté dans la page www.imagepme.fr, AVANT ses propres scripts.
// Rôle (identique à content-main.js de l'extension) : intercepter l'appel que
// l'appli fait DÉJÀ à /data/requeteur et lire l'URL node9 (secHASH) qu'elle renvoie.
// On ne reconstruit AUCUN jeton : on lit le résultat légitime de la session du membre.
//
// Prérequis côté main.js : contextIsolation:false + sandbox:false, pour que ce preload
// partage le `window` de la page et puisse envelopper son XHR/fetch.
const { ipcRenderer } = require('electron');

(function () {
  const REQUETEUR_RE = /\/data\/requeteur/;
  const DASH_RE = /_dash-update-component/;

  // Les 2 dropdowns du requêteur arrivent pré-sélectionnés sur la dernière période TVA dispo.
  // On lit leur `value` dans les réponses Dash et on la remonte à main.js (TVA_PERIODE_PART).
  function extrairePeriode(url, body) {
    if (!DASH_RE.test(url || '')) {
      return;
    }
    let resp;
    try {
      const data = JSON.parse(body);
      resp = data && data.response;
    } catch (_) {
      return;
    }
    if (!resp) {
      return;
    }
    if (resp.tva_periode_year && resp.tva_periode_year.value != null) {
      ipcRenderer.send('TVA_PERIODE_PART', { champ: 'year', valeur: String(resp.tva_periode_year.value) });
    }
    if (resp.tva_periode_month && resp.tva_periode_month.value != null) {
      ipcRenderer.send('TVA_PERIODE_PART', { champ: 'month', valeur: String(resp.tva_periode_month.value) });
    }
  }

  function emit(url) {
    if (url) {
      ipcRenderer.send('NODE9_URL', url);
    }
  }

  // L'appli utilise axios (XHR) : on enveloppe open/send pour lire la réponse du requêteur.
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__ipmeUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', () => {
      try {
        if (this.__ipmeUrl && REQUETEUR_RE.test(this.__ipmeUrl)) {
          const data = JSON.parse(this.responseText);
          if (data && data.url) {
            emit(data.url);
          }
        }
      } catch (_) {
        /* réponse non-JSON : on ignore */
      }
      extrairePeriode(this.__ipmeUrl, this.responseText);
      capterDash(this.__ipmeUrl, this.responseText);
    });
    return origSend.apply(this, args);
  };

  // --- Capture diagnostique (gardée par --poc-capture-dash) pour APPRENDRE où ImagePME expose
  // la dernière période TVA : réponses Dash _dash-update-component + candidats du DOM. ---
  const CAPTURE = typeof process !== 'undefined'
    && Array.isArray(process.argv)
    && process.argv.includes('--poc-capture-dash');

  function capterDash(url, body) {
    if (!CAPTURE || !DASH_RE.test(url || '')) {
      return;
    }
    try {
      ipcRenderer.send('DASH_CAPTURE', { url: String(url), body: String(body).slice(0, 200000) });
    } catch (_) {
      /* ignore */
    }
  }

  function scanDom() {
    try {
      const periodeRe = /20\d\d[-/ ]?(0?[1-9]|1[0-2]|7\d|8\d)\b/;
      const selects = Array.from(
        document.querySelectorAll('select, [class*="Select"], [class*="dropdown"], [id*="periode"], [id*="date"], [id*="mois"]'),
      ).map((el) => el.outerHTML.slice(0, 2000));
      const textes = Array.from(document.querySelectorAll('*'))
        .filter((el) => el.childElementCount === 0)
        .map((el) => el.textContent.trim())
        .filter((t) => t && periodeRe.test(t));
      const uniques = Array.from(new Set(textes)).slice(0, 60);
      let origine = '';
      try {
        origine = location.href.slice(0, 120);
      } catch (_) {
        origine = '(origine inconnue)';
      }
      ipcRenderer.send('DOM_CANDIDATES', { origine, selects, textes: uniques });
    } catch (_) {
      /* ignore */
    }
  }

  if (CAPTURE) {
    window.addEventListener('load', () => {
      setTimeout(scanDom, 6000); // laisse le requêteur Dash se peupler
      setTimeout(scanDom, 15000);
      setTimeout(scanDom, 23000);
    });
  }

  // Filet de sécurité si une partie de l'appli passe par fetch().
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function (...args) {
      const response = await origFetch.apply(this, args);
      try {
        const u = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        if (REQUETEUR_RE.test(u)) {
          response
            .clone()
            .json()
            .then((d) => {
              if (d && d.url) emit(d.url);
            })
            .catch(() => {});
        }
        if (DASH_RE.test(u)) {
          response.clone().text().then((t) => {
            extrairePeriode(u, t);
            if (CAPTURE) {
              capterDash(u, t);
            }
          }).catch(() => {});
        }
      } catch (_) {
        /* ignore */
      }
      return response;
    };
  }

  console.log('[POC] preload chargé — en écoute de /data/requeteur');
})();
