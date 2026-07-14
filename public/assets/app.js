// ─────────────────────────────────────────────────────────────────────────
// Espace membre AFFBC — application cliente.
//
// Ce Worker ne fait que servir ces fichiers statiques : toute la logique
// tourne ici, dans le navigateur, et parle en cross-origin à trois APIs
// existantes (gestion / boutique / calendrier) via un jeton signé émis par
// gestion. Le jeton est stocké en localStorage : c'est un compromis assumé,
// pas un oubli — un cookie HttpOnly (l'approche déjà utilisée côté staff
// dans gestion) ne peut pas être partagé entre trois sous-domaines
// différents, alors qu'un jeton en Authorization: Bearer le peut. La CSP de
// ce Worker (script-src 'self', aucun script tiers) est la vraie ligne de
// défense contre le XSS qui rendrait ce compromis dangereux ; toute donnée
// venant des API est insérée en texte (textContent), jamais en HTML brut.
// ─────────────────────────────────────────────────────────────────────────

const API = {
  gestion: 'https://gestion.americanfullfightingbons.fr',
  boutique: 'https://boutique.americanfullfightingbons.fr',
  calendrier: 'https://calendrier.americanfullfightingbons.fr',
};
const SITE_URL = 'https://americanfullfightingbons.fr';
// Lien vers lequel rediriger un·e adhérent·e dont la cotisation n'est pas à
// jour : le formulaire de ré-inscription en ligne du club.
const RENEWAL_URL = 'https://inscription.americanfullfightingbons.fr/';

// Encode les infos déjà connues du membre dans le lien de réinscription,
// pour que le formulaire (inscription.js, fonction applyDraft) les
// préremplisse. Non signé volontairement : ces champs sont déjà visibles
// par le membre dans son propre espace, et le formulaire de réinscription
// revérifie indépendamment l'éligibilité (nom/prénom/naissance/email) côté
// serveur avant d'accorder quoi que ce soit (tarif bureau, etc.) — un lien
// modifié ne ferait donc que préremplir des champs que le membre pourrait
// de toute façon saisir lui-même à la main.
function buildRenewalUrl(me) {
  const prefill = {
    lastName: me.nom || undefined,
    firstName: me.prenom || undefined,
    birthDate: me.naissance || undefined,
    address1: me.adresse || undefined,
    postalCode: me.code_postal || undefined,
    city: me.ville || undefined,
    phonePrimary: me.telephone || undefined,
    email: me.email || undefined,
    typeInscription: 'renouvellement',
  };
  try {
    const json = JSON.stringify(prefill);
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    bytes.forEach((b) => { binary += String.fromCharCode(b); });
    const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    return `${RENEWAL_URL}?prefill=${token}`;
  } catch (e) {
    return RENEWAL_URL;
  }
}
const TOKEN_KEY = 'affbc_membre_token';
const TOKEN_EXP_KEY = 'affbc_membre_token_exp';
const REQUEST_TIMEOUT_MS = 15000;

// ── Session ─────────────────────────────────────────────────────────────
// localStorage.setItem coerce silencieusement undefined/null en la chaîne
// "undefined"/"null" : si la réponse de connexion n'a pas la forme attendue
// (res.data.token manquant), on stockerait sinon un jeton bidon sans jamais
// lever d'erreur, avec un aller-retour confus vers "session expirée" au
// premier appel authentifié. On se protège explicitement de ce cas.
function isPlausibleToken(token) {
  return typeof token === 'string' && token.length > 0 && token !== 'undefined' && token !== 'null';
}
function getToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const exp = Number(localStorage.getItem(TOKEN_EXP_KEY) || 0);
  if (!isPlausibleToken(token) || !exp || Date.now() >= exp) return null;
  return token;
}
function setToken(token, expiresAt) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(TOKEN_EXP_KEY, String(expiresAt || Date.now() + 30 * 24 * 3600 * 1000));
}
function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(TOKEN_EXP_KEY);
}

// ── Thème clair/sombre ──────────────────────────────────────────────────
// Appliqué très tôt (voir le script inline dans index.html, qui pose déjà
// l'attribut avant le premier paint pour éviter un flash) ; les fonctions
// ci-dessous ne font que garder le bouton et le storage synchronisés après
// coup, quand l'adhérent bascule manuellement.
const THEME_KEY = 'affbc_theme';
function getTheme() {
  const stored = localStorage.getItem(THEME_KEY);
  if (stored === 'dark' || stored === 'light') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
}
function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark';
  localStorage.setItem(THEME_KEY, next);
  applyTheme(next);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = next === 'dark' ? '☀️' : '🌙';
}

// ── Client API ──────────────────────────────────────────────────────────
async function apiCall(base, path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (!token) { goTo('/connexion'); throw new Error('Session absente'); }
    headers.Authorization = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    if (err?.name === 'AbortError') {
      throw new Error('Le serveur met trop de temps à répondre. Réessayez dans un instant.');
    }
    throw new Error('Connexion impossible. Vérifiez votre connexion internet et réessayez.');
  } finally {
    clearTimeout(timeoutId);
  }
  if (response.status === 401 && auth) {
    clearToken();
    goTo('/connexion?expire=1');
    throw new Error('Session expirée');
  }
  const isJson = (response.headers.get('Content-Type') || '').includes('application/json');
  const payload = isJson ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    const message =
      (payload && (payload.error?.message || payload.error)) ||
      `Une erreur est survenue (${response.status}).`;
    throw new Error(typeof message === 'string' ? message : 'Une erreur est survenue.');
  }
  return payload;
}

const gestionApi = (path, opts) => apiCall(API.gestion, path, opts);
const boutiqueApi = (path, opts) => apiCall(API.boutique, path, opts);
const calendrierApi = (path, opts) => apiCall(API.calendrier, path, opts);
const siteApi = (path, opts) => apiCall(SITE_URL, path, opts);

// Convertit une promesse en résultat de forme Promise.allSettled ({status,
// value} ou {status, reason}), pour réutiliser telles quelles les fonctions
// de rendu déjà écrites contre cette forme (renderNextEvent,
// renderRegistrationsSection, renderOrdersSection, renderNewsSection...)
// avec des appels indépendants qui ne se bloquent plus les uns les autres.
function settled(promise) {
  return promise.then(
    (value) => ({ status: 'fulfilled', value }),
    (reason) => ({ status: 'rejected', reason })
  );
}

// ── Aides d'affichage ───────────────────────────────────────────────────
function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
}
function formatMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' });
}
// Identique à esc() dans le back-office gestion (public/assets/app.js) :
// nécessaire uniquement pour buildCotisationReceiptHTML, seul endroit de ce
// fichier qui construit du HTML par concaténation de chaînes plutôt que via
// el() (qui échappe déjà tout via textContent/setAttribute).
function escapeHtml(value) {
  return (value ?? '').toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value; // uniquement pour du HTML statique connu, jamais des données API
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined) node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === null || child === undefined || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}
function goTo(path) {
  window.location.href = path;
}

// ── Éléments partagés ───────────────────────────────────────────────────
function renderCrossNav() {
  const links = [
    ['Club', SITE_URL],
    ['Inscription', 'https://inscription.americanfullfightingbons.fr/'],
    ['Calendrier', API.calendrier],
    ['Boutique', API.boutique],
    ['Espace membre', 'https://espace-membre.americanfullfightingbons.fr/'],
  ];
  return el('nav', { class: 'crossnav', 'aria-label': 'Navigation entre les services AFFBC' },
    links.map(([label, href]) =>
      el('a', { href, ...(label === 'Espace membre' ? { 'aria-current': 'page' } : {}) }, label)
    )
  );
}

function renderTopbar({ showLogout }) {
  const wrap = el('div', { class: 'nav-wrap' }, [
    renderCrossNav(),
    el('div', { class: 'topbar' }, [
      el('a', { class: 'brand', href: SITE_URL }, [
        el('img', { src: '/assets/logo.png', alt: '' }),
        el('span', { class: 'brand-text' }, [
          el('b', {}, 'AFFBC'),
          el('span', {}, 'Espace membre'),
        ]),
      ]),
      el('div', { class: 'topbar-actions' }, [
        el('button', {
          class: 'btn-theme', type: 'button', id: 'theme-toggle',
          'aria-label': 'Changer de thème (clair/sombre)', title: 'Changer de thème',
          onclick: toggleTheme,
        }, getTheme() === 'dark' ? '☀️' : '🌙'),
        showLogout
          ? el('button', { class: 'btn-logout', type: 'button', onclick: handleLogout }, 'Se déconnecter')
          : null,
      ]),
    ]),
  ]);
  return wrap;
}

function alertBox(type, message) {
  return el('div', { class: `alert alert-${type}`, role: 'alert', 'aria-live': type === 'error' ? 'assertive' : 'polite' }, [
    el('span', { 'aria-hidden': 'true' }, type === 'error' ? '⚠️' : '✓'),
    el('span', {}, message),
  ]);
}
// Affiche une alerte dans `slot` et y déplace le focus (utile en clavier/lecteur
// d'écran : sans ça, un échec de soumission passe facilement inaperçu).
function showAlert(slot, type, message) {
  slot.innerHTML = '';
  const box = alertBox(type, message);
  slot.appendChild(box);
  box.setAttribute('tabindex', '-1');
  box.focus();
  return box;
}
// Petite notification transitoire hors formulaire (ex : téléchargement de
// facture), en remplacement d'un alert() natif bloquant et hors charte.
function showToast(message, type = 'error') {
  let root = document.getElementById('toast-root');
  if (!root) {
    root = el('div', { id: 'toast-root', class: 'toast-root' });
    document.body.appendChild(root);
  }
  const toast = alertBox(type, message);
  toast.classList.add('toast');
  root.appendChild(toast);
  setTimeout(() => toast.remove(), 6000);
}

async function handleLogout() {
  const token = getToken();
  clearToken();
  if (token) {
    try {
      await fetch(API.gestion + '/api/member/logout', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* déconnexion locale déjà faite, tant pis pour l'appel réseau */ }
  }
  goTo('/connexion');
}

// ── Vue : connexion ─────────────────────────────────────────────────────
function renderConnexion(root) {
  const params = new URLSearchParams(location.search);
  const wrap = el('div', { class: 'auth-shell' }, [
    el('div', { class: 'auth-wrap' }, [
      el('div', { class: 'auth-card fade-rise' }, [
        el('img', { class: 'auth-logo', src: '/assets/logo.png', alt: 'AFFBC' }),
        el('div', { class: 'auth-kicker' }, 'Espace membre'),
        el('h1', { class: 'auth-title' }, 'Connexion'),
        el('p', { class: 'auth-sub' }, 'Accédez à votre cotisation, vos documents et vos commandes.'),
        el('div', { id: 'alert-slot' }),
        el('form', { id: 'login-form' }, [
          el('div', { class: 'field' }, [
            el('label', { for: 'email' }, 'Adresse e-mail'),
            el('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'email', required: true }),
          ]),
          passwordField({ id: 'password', label: 'Mot de passe', autocomplete: 'current-password' }),
          el('button', { class: 'btn btn-primary btn-block', type: 'submit', id: 'submit-btn' }, 'Se connecter'),
        ]),
        el('div', { class: 'auth-links' }, [
          el('a', { class: 'link-quiet', href: '/mot-de-passe-oublie' }, 'Mot de passe oublié'),
          el('a', { class: 'link-quiet', href: '/activer' }, 'Activer mon compte'),
        ]),
      ]),
    ]),
    el('footer', { class: 'app-footer' }, [
      'Un souci pour vous connecter ? Écrivez à ',
      el('a', { href: 'mailto:fullfightingbons@gmail.com' }, 'fullfightingbons@gmail.com'),
    ]),
  ]);
  root.appendChild(wrap);

  const alertSlot = wrap.querySelector('#alert-slot');
  if (params.get('expire')) alertSlot.appendChild(alertBox('error', 'Votre session a expiré, reconnectez-vous.'));

  wrap.querySelector('#login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    alertSlot.innerHTML = '';
    const btn = wrap.querySelector('#submit-btn');
    const email = wrap.querySelector('#email').value.trim();
    const password = wrap.querySelector('#password').value;
    setBusy(btn, true, 'Connexion…');
    try {
      const res = await gestionApi('/api/member/login', { method: 'POST', body: { email, password }, auth: false });
      if (!isPlausibleToken(res?.data?.token)) {
        throw new Error('Connexion impossible : réponse inattendue du serveur. Réessayez, ou contactez le club si le problème persiste.');
      }
      setToken(res.data.token, res.data.expiresAt);
      goTo('/');
    } catch (e) {
      showAlert(alertSlot, 'error', e.message);
      setBusy(btn, false, 'Se connecter');
    }
  });
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.setAttribute('aria-busy', String(busy));
  btn.innerHTML = '';
  if (busy) btn.appendChild(el('span', { class: 'spinner', 'aria-hidden': 'true' }));
  btn.appendChild(document.createTextNode(label));
}
// Champ mot de passe avec bouton afficher/masquer (utile sur mobile, et pour
// les adhérents moins à l'aise avec un gestionnaire de mots de passe).
function passwordField({ id, label, autocomplete, minlength, hint }) {
  const input = el('input', {
    id, name: id, type: 'password', autocomplete, required: true,
    ...(minlength ? { minlength: String(minlength) } : {}),
  });
  const toggle = el('button', {
    type: 'button',
    class: 'field-toggle',
    'aria-label': 'Afficher le mot de passe',
    'aria-pressed': 'false',
    onclick: () => {
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      toggle.setAttribute('aria-pressed', String(show));
      toggle.setAttribute('aria-label', show ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
      toggle.textContent = show ? '🙈' : '👁️';
    },
  }, '👁️');
  const children = [
    el('label', { for: id }, label),
    el('div', { class: 'field-input-wrap' }, [input, toggle]),
  ];
  if (hint) children.push(el('div', { class: 'field-hint' }, hint));
  return el('div', { class: 'field' }, children);
}

// ── Vue : activation ────────────────────────────────────────────────────
function renderActivation(root) {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (!token) return renderRequestForm(root, {
    kicker: 'Première connexion',
    title: 'Activer mon compte',
    sub: "Indiquez l'e-mail utilisé lors de votre inscription au club : nous vous envoyons un lien pour choisir votre mot de passe.",
    endpoint: '/api/member/activation/request',
    backTo: '/connexion',
  });
  return renderSetPasswordForm(root, {
    title: 'Choisissez votre mot de passe',
    endpoint: '/api/member/activation/confirm',
    token,
    successMessage: null, // connecte directement
  });
}

// ── Vue : mot de passe oublié ───────────────────────────────────────────
function renderMotDePasseOublie(root) {
  const params = new URLSearchParams(location.search);
  const token = params.get('token');
  if (!token) return renderRequestForm(root, {
    kicker: 'Mot de passe oublié',
    title: 'Réinitialiser mon mot de passe',
    sub: 'Indiquez votre e-mail : si un compte existe, vous recevrez un lien de réinitialisation.',
    endpoint: '/api/member/password/forgot',
    backTo: '/connexion',
  });
  return renderSetPasswordForm(root, {
    title: 'Choisissez un nouveau mot de passe',
    endpoint: '/api/member/password/reset',
    token,
    successMessage: 'Mot de passe mis à jour. Vous pouvez maintenant vous connecter.',
  });
}

// Formulaire générique « entrez votre email » (activation ou mot de passe oublié)
function renderRequestForm(root, { kicker, title, sub, endpoint, backTo }) {
  const wrap = el('div', { class: 'auth-shell' }, [
    el('div', { class: 'auth-wrap' }, [
      el('div', { class: 'auth-card fade-rise' }, [
        el('img', { class: 'auth-logo', src: '/assets/logo.png', alt: 'AFFBC' }),
        el('div', { class: 'auth-kicker' }, kicker),
        el('h1', { class: 'auth-title' }, title),
        el('p', { class: 'auth-sub' }, sub),
        el('div', { id: 'alert-slot' }),
        el('form', { id: 'request-form' }, [
          el('div', { class: 'field' }, [
            el('label', { for: 'email' }, 'Adresse e-mail'),
            el('input', { id: 'email', name: 'email', type: 'email', autocomplete: 'email', required: true }),
          ]),
          el('button', { class: 'btn btn-primary btn-block', type: 'submit', id: 'submit-btn' }, 'Envoyer le lien'),
        ]),
        el('div', { class: 'auth-footer' }, [
          el('a', { class: 'link-quiet', href: backTo }, '← Retour à la connexion'),
        ]),
      ]),
    ]),
  ]);
  root.appendChild(wrap);
  const alertSlot = wrap.querySelector('#alert-slot');
  const form = wrap.querySelector('#request-form');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertSlot.innerHTML = '';
    const btn = wrap.querySelector('#submit-btn');
    const email = wrap.querySelector('#email').value.trim();
    setBusy(btn, true, 'Envoi…');
    try {
      const res = await gestionApi(endpoint, { method: 'POST', body: { email }, auth: false });
      form.replaceWith(alertBox('ok', res.data.message || 'E-mail envoyé si un compte correspond.'));
    } catch (e) {
      showAlert(alertSlot, 'error', e.message);
      setBusy(btn, false, 'Envoyer le lien');
    }
  });
}

// Formulaire générique « choisissez un mot de passe » (activation-confirm ou reset)
function renderSetPasswordForm(root, { title, endpoint, token, successMessage }) {
  const wrap = el('div', { class: 'auth-shell' }, [
    el('div', { class: 'auth-wrap' }, [
      el('div', { class: 'auth-card fade-rise' }, [
        el('img', { class: 'auth-logo', src: '/assets/logo.png', alt: 'AFFBC' }),
        el('div', { class: 'auth-kicker' }, 'Espace membre'),
        el('h1', { class: 'auth-title' }, title),
        el('div', { id: 'alert-slot' }),
        el('form', { id: 'pwd-form' }, [
          passwordField({ id: 'password', label: 'Nouveau mot de passe', autocomplete: 'new-password', minlength: 8, hint: '8 caractères minimum.' }),
          passwordField({ id: 'password2', label: 'Confirmez le mot de passe', autocomplete: 'new-password', minlength: 8 }),
          el('button', { class: 'btn btn-primary btn-block', type: 'submit', id: 'submit-btn' }, 'Valider'),
        ]),
      ]),
    ]),
  ]);
  root.appendChild(wrap);
  const alertSlot = wrap.querySelector('#alert-slot');
  const form = wrap.querySelector('#pwd-form');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    alertSlot.innerHTML = '';
    const btn = wrap.querySelector('#submit-btn');
    const password = wrap.querySelector('#password').value;
    const password2 = wrap.querySelector('#password2').value;
    if (password !== password2) {
      alertSlot.appendChild(alertBox('error', 'Les deux mots de passe ne correspondent pas.'));
      return;
    }
    setBusy(btn, true, 'Validation…');
    try {
      const res = await gestionApi(endpoint, { method: 'POST', body: { token, password }, auth: false });
      if (isPlausibleToken(res?.data?.token)) {
        setToken(res.data.token, res.data.expiresAt);
        goTo('/');
        return;
      }
      form.replaceWith(el('div', {}, [
        alertBox('ok', successMessage || 'Fait.'),
        el('a', { class: 'btn btn-primary btn-block', href: '/connexion', style: 'margin-top:1rem' }, 'Se connecter'),
      ]));
    } catch (e) {
      showAlert(alertSlot, 'error', e.message);
      setBusy(btn, false, 'Valider');
    }
  });
}

// ── Vue : tableau de bord ───────────────────────────────────────────────
// Chargement en deux temps :
// 1) /api/member/dashboard (gestion) est le SEUL appel bloquant : il
//    regroupe en une authentification et un aller-retour uniques ce qui
//    passait avant par trois appels distincts (/me, /diplomes, /annuaire —
//    cf. gestion/src/index.ts, memberProfilePayload). Sans cette donnée, la
//    page n'a de toute façon aucun sens.
// 2) Stages (calendrier), commandes (boutique) et actualités (site) sont
//    des origines indépendantes : chacune s'affiche dans son propre
//    emplacement dès qu'elle répond, sans attendre ni bloquer les autres —
//    contrairement à l'ancien Promise.allSettled global qui gardait
//    l'écran entier en squelette jusqu'à la plus lente des 4 origines.
async function renderDashboard(root) {
  if (!getToken()) return goTo('/connexion');

  root.appendChild(renderTopbar({ showLogout: true }));
  const main = el('main');
  root.appendChild(main);

  main.appendChild(el('div', { class: 'member-card' }, [el('div', { class: 'skeleton' })]));
  main.appendChild(el('div', { class: 'skeleton', style: 'height:8rem;margin-bottom:1rem' }));
  main.appendChild(el('div', { class: 'skeleton', style: 'height:8rem' }));

  let dashboardRes;
  let profilesRes;
  try {
    [dashboardRes, profilesRes] = await Promise.all([
      gestionApi('/api/member/dashboard'),
      // Tolérant à l'échec (settled) : le sélecteur de profils est un
      // complément au tableau de bord, pas un prérequis — un souci réseau ne
      // doit jamais empêcher l'affichage du reste.
      settled(gestionApi('/api/member/profiles')),
    ]);
  } catch (e) {
    main.innerHTML = '';
    main.appendChild(alertBox('error', "Impossible de charger votre profil : " + e.message));
    return;
  }
  const me = dashboardRes.data.me;
  const diplomeRes = { status: 'fulfilled', value: { data: dashboardRes.data.diplomes } };
  const annuaireRes = { status: 'fulfilled', value: { data: dashboardRes.data.annuaire } };
  const cotisations = dashboardRes.data.cotisations || [];
  const feedback = dashboardRes.data.feedback || null;

  main.innerHTML = '';
  const switcher = renderProfileSwitcher(profilesRes);
  if (switcher) main.appendChild(switcher);
  main.appendChild(renderMemberCard(me));

  const alertsBanner = renderAlertsBanner(me);
  if (alertsBanner) main.appendChild(alertsBanner);

  const feedbackBanner = renderFeedbackBanner(feedback);
  if (feedbackBanner) main.appendChild(feedbackBanner);

  // Emplacements réservés dans l'ordre d'affichage habituel, remplacés en
  // place dès que leur requête répond — l'ordre visuel final est identique
  // à avant, seul le moment d'apparition de chaque section change.
  const nextEventSlot = el('div');
  main.appendChild(nextEventSlot);
  const newsSlot = el('div');
  main.appendChild(newsSlot);

  main.appendChild(renderCertificatSection(me));

  const bulletinSection = renderBulletinSection(me);
  if (bulletinSection) main.appendChild(bulletinSection);

  const gradeSection = renderGradeSection(me);
  if (gradeSection) main.appendChild(gradeSection);

  const parcoursSection = renderParcoursSection(me, diplomeRes, cotisations);
  if (parcoursSection) main.appendChild(parcoursSection);

  const registrationsSlot = el('div', { class: 'skeleton', style: 'height:8rem;margin-bottom:1rem' });
  main.appendChild(registrationsSlot);
  const ordersSlot = el('div', { class: 'skeleton', style: 'height:8rem;margin-bottom:1rem' });
  main.appendChild(ordersSlot);

  main.appendChild(renderAccountSection(me));

  const annuaireSection = renderAnnuaireSection(annuaireRes);
  if (annuaireSection) main.appendChild(annuaireSection);

  main.appendChild(renderContactSection());

  root.appendChild(el('footer', { class: 'app-footer' }, [
    'Une question sur votre dossier ? Écrivez à ',
    el('a', { href: 'mailto:fullfightingbons@gmail.com' }, 'fullfightingbons@gmail.com'),
  ]));

  // Stages/inscriptions (calendrier) : alimente à la fois le prochain
  // rendez-vous en haut de page et la liste complète plus bas.
  settled(calendrierApi('/api/member/registrations')).then((regRes) => {
    const nextEvent = renderNextEvent(regRes);
    if (nextEvent) nextEventSlot.replaceWith(nextEvent); else nextEventSlot.remove();
    registrationsSlot.replaceWith(renderRegistrationsSection(regRes));
  });

  // Commandes boutique.
  settled(boutiqueApi('/api/member/orders')).then((orderRes) => {
    ordersSlot.replaceWith(renderOrdersSection(orderRes));
  });

  // Actualités du club : lecture publique sur le site vitrine, tolérante à
  // l'échec (cf. renderNewsSection) — ne doit jamais retarder le reste.
  settled(siteApi('/api/bootstrap', { auth: false })).then((newsRes) => {
    const newsSection = renderNewsSection(newsRes);
    if (newsSection) newsSlot.replaceWith(newsSection); else newsSlot.remove();
  });
}

// Bandeau "enquête de satisfaction en attente" : réutilise la page publique
// existante (gestion/public/feedback.html) via le token déjà généré côté
// feedback_recipients — pas de nouveau formulaire à maintenir ici.
function renderFeedbackBanner(feedback) {
  if (!feedback || !feedback.token) return null;
  return el('div', { class: 'section fade-rise' }, [
    el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, feedback.titre || 'Enquête de satisfaction'),
        el('div', { class: 'row-sub' }, feedback.description || 'Le club aimerait avoir votre avis.'),
      ]),
      el('a', {
        class: 'btn btn-primary btn-sm',
        href: `${API.gestion}/feedback.html?token=${encodeURIComponent(feedback.token)}`,
        target: '_blank', rel: 'noopener',
      }, 'Répondre →'),
    ]),
  ]);
}

// Partagé entre la carte de membre et le sélecteur de profils (vue famille) :
// une seule règle de calcul pour ne pas les laisser diverger silencieusement,
// comme MEMBER_ADHERENT_FIELDS avait divergé entre ses deux requêtes côté gestion.
function isCotisationOk(paiement) {
  return String(paiement || '').toLowerCase().includes('pay') || String(paiement || '').toLowerCase().includes('sold');
}

function certificatDaysLeft(certificatExpireLe) {
  if (!certificatExpireLe) return null;
  const d = new Date(certificatExpireLe);
  if (isNaN(d.getTime())) return null;
  return Math.ceil((d.getTime() - Date.now()) / 86400000);
}
function certificatWarningLevel(certificatExpireLe) {
  const days = certificatDaysLeft(certificatExpireLe);
  if (days === null) return null;
  if (days < 0) return 'expired';
  if (days <= 30) return 'soon';
  return null;
}

// Bandeau d'alertes en haut de tableau de bord (certificat + cotisation du
// profil actuellement affiché). Complète les badges ⚠️/⛔/⏳ du sélecteur de
// profils (renderProfileSwitcher), qui ne renseignent que sur les *autres*
// membres du foyer sans jamais détailler le profil actif — et n'existent
// pas du tout pour un compte sans profil famille, qui n'avait sinon aucun
// résumé avant de scroller jusqu'aux sections Certificat/Cotisation.
// Ne s'affiche que s'il y a au moins une chose à signaler : pas de bruit
// visuel pour un dossier à jour.
function renderAlertsBanner(me) {
  const items = [];

  if (!isCotisationOk(me.paiement)) {
    items.push({
      level: 'warn',
      text: "Votre cotisation n'est pas à jour.",
      action: { label: 'Renouveler →', href: buildRenewalUrl(me), external: true },
    });
  }

  const hasValidCert = Number(me.certificat) === 1;
  const certLevel = certificatWarningLevel(me.certificat_expire_le);
  if (!hasValidCert) {
    items.push({
      level: 'warn',
      text: 'Aucun certificat médical à jour enregistré.',
      action: { label: 'Déposer →', href: '#certificat-medical' },
    });
  } else if (certLevel === 'expired') {
    items.push({
      level: 'error',
      text: `Votre certificat médical a expiré le ${formatDate(me.certificat_expire_le)}.`,
      action: { label: 'Renouveler →', href: '#certificat-medical' },
    });
  } else if (certLevel === 'soon') {
    const daysLeft = certificatDaysLeft(me.certificat_expire_le);
    items.push({
      level: 'warn',
      text: `Votre certificat médical expire dans ${daysLeft} jour${daysLeft > 1 ? 's' : ''} (le ${formatDate(me.certificat_expire_le)}).`,
      action: { label: 'Renouveler →', href: '#certificat-medical' },
    });
  }

  if (!items.length) return null;

  return el('div', { class: 'alerts-banner fade-rise', role: 'status' },
    items.map((item) => el('div', { class: `alerts-banner-item alerts-banner-${item.level}` }, [
      el('span', { 'aria-hidden': 'true' }, item.level === 'error' ? '⛔' : '⚠️'),
      el('span', { class: 'alerts-banner-text' }, item.text),
      item.action
        ? el('a', {
            class: 'alerts-banner-action', href: item.action.href,
            ...(item.action.external ? { target: '_blank', rel: 'noopener' } : {}),
          }, item.action.label)
        : null,
    ]))
  );
}

// Auto-déclaré depuis "Mon rôle dans le foyer" (préférences) — purement
// cosmétique, remplace juste l'icône générique dans le sélecteur de profils.
function familyRoleIcon(familyRole) {
  if (familyRole === 'pere') return '👨';
  if (familyRole === 'mere') return '👩';
  return '👤';
}

function renderMemberCard(me) {
  const cotisationOk = isCotisationOk(me.paiement);
  return el('div', { class: 'member-card fade-rise' }, [
    el('div', { class: 'member-card-top' }, [
      el('div', {}, [
        el('div', { class: 'member-card-eyebrow' }, 'Carte de membre'),
        el('div', { class: 'member-card-name' }, `${me.prenom || ''} ${me.nom || ''}`.trim() || 'Adhérent·e'),
        el('div', { class: 'member-card-meta' }, [
          el('span', {}, ['Membre depuis ', el('b', {}, formatDate(me.date_inscription))]),
        ]),
      ]),
      el('div', { class: 'seal' }, [el('img', { src: '/assets/logo.png', alt: '' })]),
    ]),
    el('div', { class: 'member-card-bottom' }, [
      el('div', { class: `stamp ${cotisationOk ? 'stamp-ok' : 'stamp-warn'}` }, [
        el('span', { class: 'stamp-dot' }),
        cotisationOk ? 'Cotisation à jour' : `Cotisation : ${me.paiement || 'à régulariser'}`,
      ]),
      // Toujours vers le site d'inscription (jamais un lien HelloAsso
      // direct) : c'est ce formulaire qui permet de mettre à jour les
      // coordonnées et, le cas échéant, de repasser commande de vêtements —
      // un lien de paiement direct court-circuiterait cette étape.
      cotisationOk
        ? el('div', { class: 'no-print', style: 'display:flex;gap:.5rem' }, [
            el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => window.print() }, '🖶 Imprimer / PDF'),
            el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: printAttestationCotisation }, '📄 Attestation'),
          ])
        : el('a', { class: 'btn btn-primary btn-sm no-print', href: buildRenewalUrl(me), target: '_blank', rel: 'noopener' }, 'Renouveler mon adhésion →'),
    ]),
  ]);
}

// ── Multi-comptes / parent-enfant ──────────────────────────────────────────
// Sélecteur de profils : n'apparaît que si le compte connecté a accès à plus
// d'un profil (le sien + au moins un enfant sous tutelle, cf.
// GET /api/member/profiles côté gestion). Basculer rappelle
// POST /api/member/profiles/switch, qui réémet un jeton portant le nouveau
// profil actif — même mécanisme que le changement de mot de passe
// (renderAccountSection) : un nouveau jeton signé plutôt qu'une session
// modifiable côté serveur.
function renderProfileSwitcher(profilesRes) {
  if (profilesRes.status !== 'fulfilled') return null;
  const { profiles, activeAdherentId } = profilesRes.value.data || {};
  if (!Array.isArray(profiles) || profiles.length < 2) return null;

  const wrap = el('div', { class: 'profile-switcher fade-rise', role: 'group', 'aria-label': 'Basculer entre les profils du foyer' });
  for (const p of profiles) {
    const isActive = String(p.id) === String(activeAdherentId);
    const attrs = {
      class: `profile-pill${isActive ? ' profile-pill-active' : ''}`,
      type: 'button',
      onclick: () => switchProfile(p.id),
    };
    if (isActive) attrs.disabled = true; // cf. checkboxField : n'ajouter la clé que si vrai

    // Vue famille : badges cotisation/certificat, pour voir d'un coup d'œil
    // qui a besoin de quoi sans avoir à basculer sur chaque profil.
    const badges = [];
    if (!isCotisationOk(p.paiement)) {
      badges.push(el('span', { class: 'profile-pill-badge', title: 'Cotisation à renouveler', 'aria-label': 'Cotisation à renouveler' }, '⚠️'));
    }
    const certWarn = certificatWarningLevel(p.certificat_expire_le);
    if (certWarn === 'expired') {
      badges.push(el('span', { class: 'profile-pill-badge', title: 'Certificat médical expiré', 'aria-label': 'Certificat médical expiré' }, '⛔'));
    } else if (certWarn === 'soon') {
      badges.push(el('span', { class: 'profile-pill-badge', title: 'Certificat médical à renouveler bientôt', 'aria-label': 'Certificat médical à renouveler bientôt' }, '⏳'));
    }

    wrap.appendChild(el('button', attrs, [
      el('span', { 'aria-hidden': 'true' }, p.isSelf ? familyRoleIcon(p.family_role) : '🧒'),
      ` ${p.prenom || ''} ${p.nom || ''}`.trim(),
      ...badges,
    ]));
  }
  return wrap;
}

async function switchProfile(adherentId) {
  try {
    const res = await gestionApi('/api/member/profiles/switch', { method: 'POST', body: { adherentId } });
    if (isPlausibleToken(res?.data?.token)) setToken(res.data.token, res.data.expiresAt);
    window.location.reload();
  } catch (e) {
    showToast(e.message || 'Impossible de changer de profil.', 'error');
  }
}

// N'affiche rien tant que /api/member/registrations ne retourne aucune
// inscription à venir — comportement inchangé si l'adhérent n'a rien de prévu.
function renderNextEvent(regRes) {
  if (regRes.status !== 'fulfilled') return null;
  const items = regRes.value.data || [];
  const now = Date.now();
  const upcoming = items
    .filter((r) => r.date_start && new Date(r.date_start).getTime() >= now && r.paiement_status !== 'annule')
    .sort((a, b) => new Date(a.date_start) - new Date(b.date_start))[0];
  if (!upcoming) return null;
  return el('div', { class: 'next-event fade-rise' }, [
    el('div', { class: 'next-event-label' }, 'Prochain rendez-vous'),
    el('div', { class: 'next-event-title' }, upcoming.title || 'Événement'),
    el('div', { class: 'next-event-meta' }, `${formatDate(upcoming.date_start)}${upcoming.lieu ? ' · ' + upcoming.lieu : ''}`),
  ]);
}

// Fil d'actualités du club, en lecture publique depuis le site vitrine
// (/api/bootstrap → data.news, table news_items). Tolérant à l'échec : si le
// site est indisponible ou l'appel cross-origin échoue, on n'affiche rien
// plutôt que de casser le reste du dashboard (contrairement à meRes, qui est
// bloquant). Même filtrage/tri que côté site (enabled=1, display_order) pour
// rester cohérent avec ce que voient les visiteurs non-connectés.
function renderNewsSection(newsRes) {
  if (newsRes.status !== 'fulfilled') return null;
  const items = (newsRes.value?.data?.news || [])
    .filter((item) => Number(item.enabled ?? 1) === 1)
    .sort((a, b) => Number(a.display_order) - Number(b.display_order))
    .slice(0, 3);
  if (!items.length) return null;

  const section = el('div', { class: 'section fade-rise' }, [
    el('div', { class: 'section-head' }, [
      el('div', { class: 'section-title' }, 'Actualités du club'),
      el('a', { class: 'link-quiet', href: `${SITE_URL}/#actualites`, target: '_blank', rel: 'noopener' }, 'Voir tout →'),
    ]),
  ]);
  const list = el('div', { class: 'row-list' });
  for (const item of items) {
    list.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, item.title || 'Actualité'),
        el('div', { class: 'row-sub' }, item.badge || item.date_label || ''),
      ]),
      item.cta_href
        ? el('a', { class: 'btn btn-ghost btn-sm', href: item.cta_href, target: '_blank', rel: 'noopener' }, item.cta_label || 'Lire →')
        : null,
    ]));
  }
  section.appendChild(list);
  return section;
}

// Annuaire des membres : liste (nom + prénom uniquement) des adhérents
// ayant activé "annuaire_visible" dans leur profil (cf.
// renderAccountSection). Tolérant à l'échec comme renderNewsSection : un
// annuaire vide (personne n'a encore opté) ou une erreur réseau n'empêche
// jamais le reste du dashboard de s'afficher — la section disparaît
// simplement, plutôt que d'afficher un état vide qui inviterait à croire
// que la fonctionnalité est cassée.
function renderAnnuaireSection(annuaireRes) {
  if (annuaireRes.status !== 'fulfilled') return null;
  const members = annuaireRes.value?.data || [];
  if (!members.length) return null;

  const section = el('div', { class: 'section fade-rise' }, [
    el('div', { class: 'section-head' }, [
      el('div', { class: 'section-title' }, 'Annuaire des membres'),
      el('div', { class: 'section-note' }, `${members.length} membre${members.length > 1 ? 's' : ''}`),
    ]),
  ]);
  // Recherche 100% côté client : `members` est déjà la liste complète
  // (l'API /dashboard ne pagine pas l'annuaire), donc filtrer ici évite un
  // aller-retour réseau à chaque frappe pour une liste de cette taille.
  const search = el('input', {
    class: 'annuaire-search', type: 'search', placeholder: 'Rechercher un membre…',
    'aria-label': 'Rechercher dans l\'annuaire',
  });
  const chips = el('div', { class: 'chip-list' });
  const emptyState = el('div', { class: 'empty', hidden: true }, 'Aucun membre ne correspond à cette recherche.');

  function renderChips(filter) {
    const needle = filter.trim().toLowerCase();
    chips.innerHTML = '';
    const filtered = !needle
      ? members
      : members.filter((m) => `${m.prenom || ''} ${m.nom || ''}`.toLowerCase().includes(needle));
    for (const m of filtered) {
      chips.appendChild(el('span', { class: 'badge badge-muted' }, `${m.prenom || ''} ${m.nom || ''}`.trim()));
    }
    emptyState.hidden = filtered.length > 0;
  }
  search.addEventListener('input', () => renderChips(search.value));
  renderChips('');

  section.appendChild(search);
  section.appendChild(chips);
  section.appendChild(emptyState);
  return section;
}

// Section "Mon grade" : ceinture + licence viennent de /api/member/me
// (member.couleur_ceinture / member.numero_licence côté gestion), les
// diplômes de /api/member/diplomes. N'affiche rien si l'adhérent n'a ni
// ceinture enregistrée ni diplôme — comportement inchangé pour les fiches
// pas encore renseignées côté staff.
// Bulletin d'inscription / reçu de paiement, généré automatiquement à la
// confirmation HelloAsso (ou inscription gratuite) par le worker
// inscription-americanfullfightingbons. Ne s'affiche que si ce document
// existe déjà (bulletin_disponible) : un adhérent créé manuellement par le
// bureau sans passer par le formulaire d'inscription n'en aura pas.
function renderBulletinSection(me) {
  if (!me.bulletin_disponible) return null;
  return el('div', { class: 'section fade-rise' }, [
    el('div', { class: 'section-head' }, [el('div', { class: 'section-title' }, 'Mon inscription')]),
    el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, "Bulletin d'inscription"),
        el('div', { class: 'row-sub' }, "Formulaire rempli à l'adhésion"),
      ]),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => printBulletin() }, 'Imprimer'),
    ]),
  ]);
}

async function printBulletin() {
  await openPdfForPrint('/api/member/documents/bulletin', "Bulletin d'inscription indisponible.");
}

// Convention de saison sportive du club (démarre au 1er juillet) — reprise
// telle quelle de seasonFromDate()/currentSeasonLabel() dans le back-office
// gestion (public/assets/app.js), pour que le libellé affiché au membre soit
// cohérent avec celui que voit le bureau.
function seasonFromDateFr(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  if (Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const start = m >= 7 ? y : y - 1;
  return `${start}-${start + 1}`;
}

// Reçu de cotisation généré entièrement côté client (pas de PDF stocké sur
// R2, contrairement au bulletin et à la fiche de notation) : même principe
// que buildFacHTML()/pwPrint() dans le back-office gestion pour les ventes
// et les reçus de don, appliqué ici à la cotisation d'adhésion.
//
// Hypothèses à vérifier côté club avant diffusion large :
// - `cotisation` est supposé être le montant net réellement encaissé. Si ce
//   n'est pas le cas (ex. montant brut avant réduction Pass Région), le
//   reçu affichera un montant inexact — la réduction Pass Région
//   (adherents.montant_pass_region) n'est volontairement pas soustraite ici
//   faute de certitude sur ce point.
// - `date_inscription` est utilisée comme date du reçu, faute de colonne
//   dédiée à la date de paiement sur `adherents` (contrairement aux ventes
//   manuelles côté gestion, qui ont date_paiement). Sur un renouvellement,
//   vérifier que cette date est bien mise à jour par le worker inscription.
//
// Volontairement affiché comme un simple "reçu" (pas une "facture") et sans
// aucune mention de déduction fiscale : une cotisation d'adhésion n'ouvre
// pas droit à réduction d'impôt en France, contrairement à un don — ne pas
// copier le bloc "66 % déductible" de buildFacHTML côté gestion ici.
function buildCotisationReceiptHTML(me, clubRes) {
  const club = clubRes && clubRes.status === 'fulfilled' ? (clubRes.value.data?.clubInfo || {}) : {};
  const clubName = club.nom || 'AFFBC';
  const montant = Number(me.cotisation) || 0;
  const season = seasonFromDateFr(me.date_inscription);
  const numero = `COT-${season.slice(0, 4)}-${String(me.numero_licence || '').replace(/[^A-Za-z0-9]/g, '') || 'ADH'}`;
  const adresseMembre = [me.adresse, [me.code_postal, me.ville].filter(Boolean).join(' ')].filter(Boolean).join('<br>');

  return `<div style="background:#fff;border:.5px solid #ddd;border-radius:10px;overflow:hidden;font-family:sans-serif;font-size:12px;color:#222">
  <div style="background:#111;padding:16px 20px;display:flex;justify-content:space-between;align-items:center">
  <div style="display:flex;align-items:center;gap:10px">
  <div style="width:44px;height:44px;border-radius:50%;overflow:hidden;border:2px solid #D4AC0D;background:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0">${club.logo ? `<img src="${escapeHtml(club.logo)}" style="width:100%;height:100%;object-fit:contain">` : '<span style="font-size:22px">🥊</span>'}</div>
  <div><div style="color:#fff;font-size:12px;font-weight:500">${escapeHtml(clubName)}</div><div style="color:#aaa;font-size:10px;line-height:1.6">${escapeHtml(club.adresse || '')}<br>${escapeHtml(club.email || '')}</div></div>
  </div>
  <div style="text-align:right">
  <div style="color:#D4AC0D;font-size:15px;font-weight:500">REÇU DE COTISATION</div>
  <div style="color:#fff;font-size:11px;margin-top:2px">${escapeHtml(numero)}</div>
  <div style="color:#888;font-size:10px">${formatDate(me.date_inscription)}</div>
  </div>
  </div>
  <div style="padding:16px 20px">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
  <div><div style="font-size:9px;font-weight:500;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Émetteur</div>
  <p style="font-size:11px;line-height:1.6">${escapeHtml(clubName)}<br>${escapeHtml(club.adresse || '')}${club.siret ? `<br>SIRET : ${escapeHtml(club.siret)}` : ''}</p></div>
  <div><div style="font-size:9px;font-weight:500;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:4px">Adhérent</div>
  <p style="font-size:11px;line-height:1.6">${escapeHtml(`${me.prenom || ''} ${me.nom || ''}`.trim())}<br>${adresseMembre}</p></div>
  </div>
  <table style="width:100%;border-collapse:collapse;font-size:11px;margin-bottom:10px">
  <thead><tr style="background:#111;color:#fff">
  <th style="padding:5px 8px;text-align:left;font-weight:500">Désignation</th>
  <th style="padding:5px 8px;text-align:right;font-weight:500">Montant</th>
  </tr></thead>
  <tbody><tr>
  <td style="padding:5px 8px;border-bottom:.5px solid #eee">Cotisation adhésion — saison ${escapeHtml(season)}</td>
  <td style="padding:5px 8px;border-bottom:.5px solid #eee;text-align:right;font-weight:500">${montant.toFixed(2)} €</td>
  </tr></tbody>
  </table>
  <div style="display:flex;justify-content:flex-end">
  <div style="min-width:200px">
  <div style="display:flex;justify-content:space-between;padding:6px 10px;font-size:13px;font-weight:500;background:#111;color:#fff;border-radius:4px;margin-top:4px"><span>Total réglé</span><span>${montant.toFixed(2)} €</span></div>
  </div>
  </div>
  <p style="font-size:10px;color:#888;margin-top:10px;padding-top:8px;border-top:.5px solid #eee">Statut : ${escapeHtml(me.paiement || '—')}. Ce document tient lieu de reçu de cotisation ; il n'ouvre pas droit à réduction d'impôt (à la différence d'un don).</p>
  </div>
  <div style="background:#111;padding:7px 20px;font-size:9px;color:#888;text-align:center">${escapeHtml(clubName)}${club.siret ? ` — SIRET ${escapeHtml(club.siret)}` : ''} — Association loi 1901 — TVA non applicable, art. 261-7-1°b CGI</div>
  </div>`;
}

// Les informations du club (nom, adresse, SIRET, logo) affichées en en-tête
// du reçu ne sont chargées qu'à cet instant, au clic sur « Imprimer » — pas
// au chargement du dashboard — car la plupart des membres n'impriment
// jamais ce reçu dans une session donnée : ce serait sinon un aller-retour
// réseau systématique pour une fonctionnalité rarement utilisée.
// /api/bootstrap sur gestion accepte les appels non authentifiés et ne
// renvoie alors que PUBLIC_CLUB_INFO_KEYS (nom, adresse, siret, etc.).
async function printCotisationReceipt(btn, me) {
  const originalLabel = btn.textContent;
  setBusy(btn, true, 'Préparation…');
  try {
    const clubRes = await settled(gestionApi('/api/bootstrap', { auth: false }));
    printHtmlDocument(buildCotisationReceiptHTML(me, clubRes), `Reçu de cotisation`);
  } finally {
    setBusy(btn, false, originalLabel);
  }
}

// Équivalent de pwPrint() dans le back-office gestion : ouvre un nouvel
// onglet, y écrit un document HTML autonome, déclenche l'impression.
function printHtmlDocument(html, title) {
  const w = window.open('', '_blank');
  if (!w) { showToast("Impossible d'ouvrir la fenêtre d'impression (bloqueur de popup ?)."); return; }
  w.document.write(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${title}</title><style>body{margin:20px;font-family:sans-serif}@media print{body{margin:0}}</style></head><body>${html}<script>setTimeout(()=>window.print(),300);</script></body></html>`);
  w.document.close();
}

function renderGradeSection(me) {
  const grade = me.ceinture;
  if (!grade && !me.notation_disponible) return null;

  const section = el('div', { class: 'section fade-rise' }, [
    el('div', { class: 'section-head' }, [el('div', { class: 'section-title' }, 'Mon grade')]),
  ]);
  if (grade) {
    section.appendChild(el('div', { class: 'row', style: me.notation_disponible ? 'margin-bottom:.6rem' : '' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, `Ceinture ${grade}`),
        me.numero_licence ? el('div', { class: 'row-sub' }, `Licence FFK n° ${me.numero_licence}`) : null,
      ]),
    ]));
  }
  if (me.notation_disponible) {
    section.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, 'Fiche de notation'),
        el('div', { class: 'row-sub' }, 'Évaluation technique établie par un coach'),
      ]),
      el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => printNotation() }, 'Imprimer'),
    ]));
  }
  return section;
}

// "Mon parcours" : fusionne les diplômes (ex-liste dans renderGradeSection)
// et l'historique de cotisation par saison (ex-liste dans
// renderBulletinSection) en une seule frise chronologique, plutôt que deux
// sections séparées à parcourir indépendamment pour reconstituer le même
// fil du temps. renderGradeSection garde le statut courant (ceinture,
// fiche de notation) ; renderBulletinSection garde le bulletin
// d'inscription — ce sont des accès rapides à un document, pas un
// historique, donc ils restent séparés de la frise.
function renderParcoursSection(me, diplomeRes, cotisations) {
  const diplomes = diplomeRes && diplomeRes.status === 'fulfilled' ? (diplomeRes.value.data || []) : [];

  // Même repli que l'ancien renderBulletinSection : si `cotisations` est
  // absent/vide (déploiement gestion pas encore fait, ou jeton en cache
  // pointant vers une version antérieure de l'API), on retombe sur `me`
  // seul pour au moins montrer la saison en cours.
  const hasReceipt = Number(me.cotisation) > 0;
  const seasons = (Array.isArray(cotisations) && cotisations.length)
    ? cotisations.filter((c) => Number(c.cotisation) > 0)
    : (hasReceipt ? [{ cotisation: me.cotisation, paiement: me.paiement, date_inscription: me.date_inscription }] : []);

  const items = [
    ...diplomes.map((d) => ({
      date: d.date_emission,
      node: el('div', { class: 'row' }, [
        el('div', { class: 'row-main' }, [
          el('div', { class: 'row-title' }, `🥋 ${d.titre || 'Diplôme'}`),
          el('div', { class: 'row-sub' }, [
            formatDate(d.date_emission),
            d.saison ? ` · Saison ${d.saison}` : '',
            d.delivre_par ? ` · Délivré par ${d.delivre_par}` : '',
          ].join('')),
        ]),
        el('button', { class: 'btn btn-ghost btn-sm', type: 'button', onclick: () => downloadDiplome(d.id, d.titre) }, 'Télécharger'),
      ]),
    })),
    ...seasons.map((s) => {
      const season = s.saison || seasonFromDateFr(s.date_inscription);
      return {
        date: s.date_inscription,
        node: el('div', { class: 'row' }, [
          el('div', { class: 'row-main' }, [
            el('div', { class: 'row-title' }, `📋 Inscription — saison ${season}`),
            el('div', { class: 'row-sub' }, formatMoney(s.cotisation)),
          ]),
          el('button', {
            class: 'btn btn-ghost btn-sm', type: 'button',
            onclick: (event) => printCotisationReceipt(event.currentTarget, { ...me, ...s }),
          }, 'Imprimer'),
        ]),
      };
    }),
  ];

  if (!items.length) return null;
  items.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  return el('div', { class: 'section fade-rise' }, [
    el('div', { class: 'section-head' }, [el('div', { class: 'section-title' }, 'Mon parcours')]),
    el('div', { class: 'row-list' }, items.map((it) => it.node)),
  ]);
}

// Ouvre un PDF authentifié dans un nouvel onglet plutôt que de forcer un
// téléchargement (contrairement à downloadDiplome ci-dessous) : la fiche de
// notation est consultée pour impression immédiate, pas pour être archivée
// localement — le lecteur PDF natif de l'onglet expose déjà un bouton
// imprimer. L'URL blob est révoquée après un délai (et non immédiatement au
// clic comme pour downloadDiplome) le temps que le nouvel onglet la charge.
async function openPdfForPrint(path, errorFallback) {
  try {
    const token = getToken();
    const response = await fetch(API.gestion + path, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || errorFallback);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (e) {
    showToast(e.message);
  }
}

async function printNotation() {
  await openPdfForPrint('/api/member/documents/notation', 'Fiche de notation indisponible.');
}

async function printAttestationCotisation() {
  await openPdfForPrint('/api/member/documents/attestation-cotisation', 'Attestation indisponible.');
}

async function downloadDiplome(id, titre) {
  try {
    const token = getToken();
    const response = await fetch(API.gestion + `/api/member/documents/diplome/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || 'Téléchargement impossible.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${String(titre || 'diplome').replace(/[^A-Za-z0-9 _-]/g, '') || 'diplome'}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast(e.message);
  }
}

function renderCertificatSection(me) {
  const hasValidCert = Number(me.certificat) === 1;
  let expiryBadge = null;
  if (hasValidCert && me.certificat_expire_le) {
    const level = certificatWarningLevel(me.certificat_expire_le);
    if (level === 'expired') expiryBadge = el('span', { class: 'badge badge-warn' }, 'Expiré');
    else if (level === 'soon') expiryBadge = el('span', { class: 'badge badge-warn' }, `Expire dans ${certificatDaysLeft(me.certificat_expire_le)} j`);
  }
  const section = el('div', { class: 'section fade-rise fade-rise-1', id: 'certificat-medical' }, [
    el('div', { class: 'section-head' }, [
      el('div', { class: 'section-title' }, 'Certificat médical'),
    ]),
    el('div', { class: 'row', style: 'margin-bottom:.85rem' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, hasValidCert ? 'Certificat enregistré' : 'Aucun certificat à jour enregistré'),
        el('div', { class: 'row-sub' }, me.certificat_date
          ? `Daté du ${formatDate(me.certificat_date)}${me.certificat_expire_le ? ' · valable jusqu\'au ' + formatDate(me.certificat_expire_le) : ''}`
          : "Déposez un certificat pour valider votre pratique."),
      ]),
      expiryBadge || el('span', { class: `badge ${hasValidCert ? 'badge-ok' : 'badge-warn'}` }, hasValidCert ? 'À jour' : 'À déposer'),
    ]),
    renderCertificatUpload(),
  ]);
  return section;
}

const MAX_CERT_SIZE = 8 * 1024 * 1024; // 8 Mo

function renderCertificatUpload() {
  const box = el('div', { class: 'upload-box' }, [
    el('div', { class: 'upload-row' }, [
      el('label', { class: 'file-input-label', for: 'cert-file' }, [
        '📎 ', el('span', { id: 'cert-file-label' }, 'Choisir un fichier (PDF, JPG, PNG)'),
      ]),
      el('input', { type: 'file', id: 'cert-file', accept: '.pdf,.jpg,.jpeg,.png' }),
      el('input', { type: 'date', id: 'cert-date', 'aria-label': 'Date du certificat' }),
    ]),
    el('div', { class: 'field-hint' }, 'Formats acceptés : PDF, JPG, PNG — 8 Mo maximum.'),
    el('div', { id: 'cert-status' }),
    el('button', { class: 'btn btn-primary btn-sm', type: 'button', id: 'cert-submit' }, 'Envoyer mon certificat'),
  ]);

  const fileInput = box.querySelector('#cert-file');
  const fileLabel = box.querySelector('#cert-file-label');
  fileInput.addEventListener('change', () => {
    fileLabel.textContent = fileInput.files[0]?.name || 'Choisir un fichier (PDF, JPG, PNG)';
  });

  box.querySelector('#cert-submit').addEventListener('click', async () => {
    const status = box.querySelector('#cert-status');
    const btn = box.querySelector('#cert-submit');
    status.innerHTML = '';
    const file = fileInput.files[0];
    if (!file) { status.appendChild(alertBox('error', 'Choisissez un fichier avant d\'envoyer.')); return; }
    if (file.size > MAX_CERT_SIZE) {
      status.appendChild(alertBox('error', `Fichier trop volumineux (${(file.size / 1024 / 1024).toFixed(1)} Mo) : 8 Mo maximum.`));
      return;
    }
    const form = new FormData();
    form.append('file', file);
    const dateVal = box.querySelector('#cert-date').value;
    if (dateVal) form.append('date', dateVal);

    const originalLabel = btn.textContent;
    setBusy(btn, true, 'Envoi…');
    try {
      const token = getToken();
      const response = await fetch(API.gestion + '/api/member/documents/certificat', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new Error(payload?.error || 'Envoi impossible.');
      status.appendChild(alertBox('ok', 'Certificat bien reçu. Merci !'));
      setBusy(btn, false, originalLabel);
      setTimeout(() => window.location.reload(), 1200);
    } catch (e) {
      status.appendChild(alertBox('error', e.message));
      setBusy(btn, false, originalLabel);
    }
  });

  return box;
}

// Statuts pour lesquels l'adhérent·e peut annuler elle/lui-même son
// inscription depuis l'espace membre. Reflète exactement la règle
// appliquée côté API (canMemberCancelRegistration dans calendrier/worker.js) :
// une inscription déjà payée en ligne (HelloAsso) doit passer par un
// remboursement géré par le bureau, jamais une simple bascule côté membre.
// Dupliquer la règle ici n'est qu'un raccourci d'affichage (masquer un
// bouton qui échouerait de toute façon) — l'API revalide tout côté serveur.
const MEMBER_CANCELLABLE_STATUSES = ['en_attente', 'gratuit'];

function isRegistrationCancellable(r) {
  if (!MEMBER_CANCELLABLE_STATUSES.includes(r.paiement_status)) return false;
  const startsAt = new Date(r.date_start).getTime();
  return Number.isFinite(startsAt) && startsAt >= Date.now();
}

function renderRegistrationsSection(regRes) {
  const section = el('div', { class: 'section fade-rise fade-rise-2' }, [
    el('div', { class: 'section-head' }, [
      el('div', { class: 'section-title' }, 'Mes inscriptions aux stages'),
      el('a', { class: 'link-quiet', href: API.calendrier, target: '_blank', rel: 'noopener' }, "S'inscrire à un stage →"),
    ]),
  ]);

  if (regRes.status === 'rejected') {
    section.appendChild(alertBox('error', 'Inscriptions indisponibles pour le moment : ' + regRes.reason.message));
    return section;
  }
  const items = regRes.value.data || [];
  if (!items.length) {
    section.appendChild(el('div', { class: 'empty' }, [
      el('b', {}, 'Aucune inscription pour le moment'),
      'Les stages et événements à venir sont sur le calendrier du club.',
    ]));
    return section;
  }
  const list = el('div', { class: 'row-list' });
  const statusLabels = {
    paye: ['Payé', 'badge-ok'],
    gratuit: ['Gratuit', 'badge-ok'],
    en_attente: ['En attente', 'badge-muted'],
    annule: ['Annulé', 'badge-warn'],
  };
  for (const r of items) {
    const [label, cls] = statusLabels[r.paiement_status] || [r.paiement_status || '—', 'badge-muted'];
    const cancelSlot = el('div', { class: 'cancel-slot' });
    const cancelBtn = isRegistrationCancellable(r)
      ? el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onclick: () => renderCancelConfirm(cancelSlot, r),
        }, 'Annuler')
      : null;

    list.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, r.title || 'Événement'),
        el('div', { class: 'row-sub' }, `${formatDate(r.date_start)}${r.lieu ? ' · ' + r.lieu : ''}`),
      ]),
      el('div', { class: 'row-actions' }, [
        el('span', { class: `badge ${cls}` }, label),
        cancelBtn,
      ]),
    ]));
    list.appendChild(cancelSlot);
  }
  section.appendChild(list);
  return section;
}

// Confirmation en deux temps avant annulation : pas de window.confirm()
// natif (hors charte visuelle du reste de l'app, cf. showToast plus haut),
// un petit panneau inline à la place, sur le même principe que order-items.
function renderCancelConfirm(slot, r) {
  slot.innerHTML = '';
  slot.appendChild(el('div', { class: 'cancel-confirm' }, [
    el('p', {}, `Annuler votre inscription à « ${r.title || 'cet événement'} » ?`),
    el('div', { class: 'cancel-confirm-actions' }, [
      el('button', {
        class: 'btn btn-primary btn-sm', type: 'button',
        onclick: (event) => confirmCancelRegistration(event.currentTarget, slot, r),
      }, 'Oui, annuler'),
      el('button', {
        class: 'btn btn-ghost btn-sm', type: 'button',
        onclick: () => { slot.innerHTML = ''; },
      }, 'Non, garder mon inscription'),
    ]),
  ]));
}

async function confirmCancelRegistration(btn, slot, r) {
  setBusy(btn, true, 'Annulation…');
  try {
    await calendrierApi(`/api/member/registrations/${r.id}`, { method: 'DELETE' });
    showToast('Inscription annulée.', 'ok');
    render();
  } catch (e) {
    slot.innerHTML = '';
    slot.appendChild(alertBox('error', e.message));
  }
}

function renderOrdersSection(orderRes) {
  const section = el('div', { class: 'section fade-rise fade-rise-3' }, [
    el('div', { class: 'section-head' }, [
      el('div', { class: 'section-title' }, 'Mes commandes boutique'),
      el('a', { class: 'link-quiet', href: API.boutique, target: '_blank', rel: 'noopener' }, 'Voir la boutique →'),
    ]),
  ]);

  if (orderRes.status === 'rejected') {
    section.appendChild(alertBox('error', 'Commandes indisponibles pour le moment : ' + orderRes.reason.message));
    return section;
  }
  const items = orderRes.value.data || [];
  if (!items.length) {
    section.appendChild(el('div', { class: 'empty' }, [
      el('b', {}, 'Aucune commande pour le moment'),
      'Vos achats à la boutique du club apparaîtront ici.',
    ]));
    return section;
  }
  const statusLabels = { confirmed: ['Confirmée', 'badge-ok'], pending_payment: ['Paiement en attente', 'badge-muted'], payment_failed: ['Paiement échoué', 'badge-warn'] };
  const list = el('div', { class: 'row-list' });
  for (const o of items) {
    const [label, cls] = statusLabels[o.status] || [o.status || '—', 'badge-muted'];
    const hasItems = Array.isArray(o.items) && o.items.length > 0;
    const itemsWrap = el('div', { class: 'order-items', style: 'display:none' },
      hasItems ? o.items.map((it) => el('div', { class: 'order-item-line' }, `${it.quantity} × ${it.product_name} — ${formatMoney(it.unit_price)}`)) : []);
    list.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, `Commande n°${o.id}`),
        el('div', { class: 'row-sub' }, `${formatDate(o.created_at)} · ${formatMoney(o.total)}`),
      ]),
      el('div', { class: 'row-actions' }, [
        el('span', { class: `badge ${cls}` }, label),
        hasItems ? el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button', 'aria-expanded': 'false',
          onclick: (event) => {
            const open = itemsWrap.style.display !== 'none';
            itemsWrap.style.display = open ? 'none' : 'block';
            event.currentTarget.setAttribute('aria-expanded', String(!open));
            event.currentTarget.textContent = open ? 'Détail' : 'Masquer';
          },
        }, 'Détail') : null,
        o.status === 'confirmed' ? el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onclick: () => downloadInvoice(o.id),
        }, 'Facture') : null,
      ]),
    ]));
    list.appendChild(itemsWrap);
  }
  section.appendChild(list);
  return section;
}

async function downloadInvoice(orderId) {
  try {
    const token = getToken();
    const response = await fetch(API.boutique + `/api/member/orders/${orderId}/invoice`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new Error(payload?.error || 'Téléchargement impossible.');
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `facture-affb-${String(orderId).padStart(6, '0')}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (e) {
    showToast(e.message);
  }
}

function textField(id, label, value, type = 'text') {
  return el('div', { class: 'field' }, [
    el('label', { for: id }, label),
    el('input', { id, name: id, type, value: value || '' }),
  ]);
}

function selectField(id, label, options, selectedValue) {
  return el('div', { class: 'field' }, [
    el('label', { for: id }, label),
    el('select', { id, name: id }, options.map(([value, text]) => {
      const attrs = { value };
      if (value === (selectedValue || '')) attrs.selected = true;
      return el('option', attrs, text);
    })),
  ]);
}

// Attention : el() fait un setAttribute générique, donc passer `checked:
// false` poserait quand même l'attribut (et cocherait la case). On
// n'inclut la clé que lorsque la case doit être cochée.
function checkboxField(id, label, checked, hint) {
  const inputAttrs = { id, name: id, type: 'checkbox' };
  if (checked) inputAttrs.checked = true;
  return el('div', { class: 'field-checkbox' }, [
    el('input', inputAttrs),
    el('div', {}, [
      el('label', { for: id }, label),
      hint ? el('div', { class: 'field-hint' }, hint) : null,
    ]),
  ]);
}

// Section "Mon compte" : l'adhérent modifie lui-même ses coordonnées et son
// contact d'urgence (PATCH /api/member/me), et peut changer son mot de passe
// sans repasser par le flux "mot de passe oublié" (POST
// /api/member/password/change). Nom, prénom, email, statut, cotisation
// restent en lecture seule ici : ce sont des informations administratives,
// modifiables uniquement par le bureau depuis l'interface staff.
function renderAccountSection(me) {
  const section = el('div', { class: 'section fade-rise' }, [
    el('div', { class: 'section-head' }, [el('div', { class: 'section-title' }, 'Mon compte')]),
  ]);

  const profileAlert = el('div');
  const profileForm = el('form', { id: 'profile-form' }, [
    el('div', { class: 'field-grid' }, [
      textField('telephone', 'Téléphone', me.telephone, 'tel'),
      textField('adresse', 'Adresse', me.adresse),
      textField('code_postal', 'Code postal', me.code_postal),
      textField('ville', 'Ville', me.ville),
      textField('urgence_nom', "Contact d'urgence — nom", me.urgence_nom),
      textField('urgence_telephone', "Contact d'urgence — téléphone", me.urgence_telephone, 'tel'),
    ]),
    checkboxField(
      'annuaire_visible',
      "Apparaître dans l'annuaire des membres",
      me.annuaire_visible,
      "Seuls votre nom et prénom seront visibles des autres adhérents connectés — indépendant du droit à l'image."
    ),
    profileAlert,
    el('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Enregistrer mes coordonnées'),
  ]);
  profileForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = profileForm.querySelector('button[type="submit"]');
    const payload = {};
    for (const id of ['telephone', 'adresse', 'code_postal', 'ville', 'urgence_nom', 'urgence_telephone']) {
      payload[id] = profileForm.querySelector('#' + id).value.trim();
    }
    payload.annuaire_visible = profileForm.querySelector('#annuaire_visible').checked;
    setBusy(btn, true, 'Enregistrement…');
    try {
      await gestionApi('/api/member/me', { method: 'PATCH', body: payload });
      showAlert(profileAlert, 'ok', 'Coordonnées mises à jour.');
    } catch (e) {
      showAlert(profileAlert, 'error', e.message);
    } finally {
      setBusy(btn, false, 'Enregistrer mes coordonnées');
    }
  });

  const pwdAlert = el('div');
  const pwdForm = el('form', { id: 'account-password-form', style: 'margin-top:1.5rem' }, [
    passwordField({ id: 'current-password', label: 'Mot de passe actuel', autocomplete: 'current-password' }),
    passwordField({ id: 'next-password', label: 'Nouveau mot de passe', autocomplete: 'new-password', minlength: 8, hint: '8 caractères minimum.' }),
    pwdAlert,
    el('button', { class: 'btn btn-ghost btn-sm', type: 'submit' }, 'Changer mon mot de passe'),
  ]);
  pwdForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = pwdForm.querySelector('button[type="submit"]');
    const currentPassword = pwdForm.querySelector('#current-password').value;
    const nextPassword = pwdForm.querySelector('#next-password').value;
    setBusy(btn, true, 'Changement…');
    try {
      const res = await gestionApi('/api/member/password/change', { method: 'POST', body: { currentPassword, nextPassword } });
      if (isPlausibleToken(res?.data?.token)) setToken(res.data.token, res.data.expiresAt);
      showAlert(pwdAlert, 'ok', 'Mot de passe modifié.');
      pwdForm.reset();
    } catch (e) {
      showAlert(pwdAlert, 'error', e.message);
    } finally {
      setBusy(btn, false, 'Changer mon mot de passe');
    }
  });

  const prefAlert = el('div');
  // `me.pref_email_feedback` peut être absent si gestion n'a pas encore ce
  // champ déployé (cf. migration 0020) : dans ce cas on affiche coché par
  // défaut (comportement historique — ces emails étaient déjà envoyés à
  // tout le monde), plutôt que de décocher silencieusement une préférence
  // qui n'existe pas encore côté serveur.
  const prefForm = el('form', { id: 'preferences-form', style: 'margin-top:1.5rem' }, [
    checkboxField(
      'pref_email_feedback',
      'Recevoir les sondages de fin de saison par email',
      me.pref_email_feedback !== false,
      "Invitation à donner ton avis à la clôture de chaque saison, et une éventuelle relance si tu n'as pas répondu."
    ),
    selectField('family_role', 'Mon rôle dans le foyer', [
      ['', 'Non précisé'],
      ['pere', 'Père'],
      ['mere', 'Mère'],
    ], me.family_role),
    prefAlert,
    el('button', { class: 'btn btn-ghost btn-sm', type: 'submit' }, 'Enregistrer mes préférences'),
  ]);
  prefForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = prefForm.querySelector('button[type="submit"]');
    const pref_email_feedback = prefForm.querySelector('#pref_email_feedback').checked;
    const family_role = prefForm.querySelector('#family_role').value || null;
    setBusy(btn, true, 'Enregistrement…');
    try {
      await gestionApi('/api/member/preferences', { method: 'PUT', body: { pref_email_feedback, family_role } });
      showAlert(prefAlert, 'ok', 'Préférences mises à jour.');
    } catch (e) {
      showAlert(prefAlert, 'error', e.message);
    } finally {
      setBusy(btn, false, 'Enregistrer mes préférences');
    }
  });

  section.appendChild(profileForm);
  section.appendChild(el('hr', { class: 'divider' }));
  section.appendChild(prefForm);
  section.appendChild(el('hr', { class: 'divider' }));
  section.appendChild(pwdForm);
  section.appendChild(el('hr', { class: 'divider' }));

  // Chargé à part (comme les commandes boutique / inscriptions événements) :
  // pas besoin de retarder l'affichage du reste de "Mon compte" pour une
  // information consultée occasionnellement.
  const rgpdSlot = el('div', { class: 'skeleton', style: 'height:3rem' });
  section.appendChild(rgpdSlot);
  settled(gestionApi('/api/member/deletion-request')).then((res) => {
    rgpdSlot.replaceWith(renderDeletionRequestBlock(res));
  });

  return section;
}

// Droit à l'effacement (RGPD, art. 17) : la demande est enregistrée
// immédiatement, mais l'anonymisation réelle n'a lieu qu'une fois le délai
// de conservation légal écoulé (5 ans après la fin de la dernière adhésion
// active, calculé côté gestion) — jamais automatiquement, un staff doit
// déclencher l'exécution depuis l'admin une fois la date passée.
function renderDeletionRequestBlock(res) {
  const wrap = el('div');
  wrap.appendChild(el('div', { class: 'row-title', style: 'margin-bottom:.4rem' }, 'Suppression de mes données'));

  if (res.status === 'rejected') {
    wrap.appendChild(el('div', { class: 'row-sub' }, 'Statut de la demande indisponible pour le moment.'));
    return wrap;
  }

  const existing = res.value.data;
  const alertBox2 = el('div');

  if (!existing || existing.statut === 'cancelled' || existing.statut === 'rejected') {
    if (existing && existing.statut === 'rejected') {
      wrap.appendChild(el('div', { class: 'row-sub', style: 'margin-bottom:.4rem' }, 'Une précédente demande a été refusée par le bureau.'));
    }
    wrap.appendChild(el('div', { class: 'row-sub', style: 'margin-bottom:.6rem' },
      "Vous pouvez demander la suppression de vos données personnelles. Pour des raisons légales (obligations comptables), vos données sont conservées au minimum 5 ans après la fin de votre dernière adhésion active avant que la suppression ne soit effective ; l'historique de cotisation (montant, date) est conservé indéfiniment à titre comptable, sans vos coordonnées."
    ));
    wrap.appendChild(alertBox2);
    const btn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Demander la suppression de mes données');
    btn.addEventListener('click', async () => {
      if (!confirm('Confirmer la demande de suppression de vos données ?')) return;
      setBusy(btn, true, 'Envoi…');
      try {
        const created = await gestionApi('/api/member/deletion-request', { method: 'POST' });
        wrap.replaceWith(renderDeletionRequestBlock({ status: 'fulfilled', value: created }));
      } catch (e) {
        showAlert(alertBox2, 'error', e.message);
        setBusy(btn, false, 'Demander la suppression de mes données');
      }
    });
    wrap.appendChild(btn);
    return wrap;
  }

  if (existing.statut === 'pending') {
    const eligibleDate = formatDate(existing.eligible_at);
    wrap.appendChild(el('div', { class: 'row-sub', style: 'margin-bottom:.6rem' },
      `Demande enregistrée le ${formatDate(existing.requested_at)}. Vos données seront anonymisées à partir du ${eligibleDate} (délai légal de conservation).`
    ));
    wrap.appendChild(alertBox2);
    const cancelBtn = el('button', { class: 'btn btn-ghost btn-sm', type: 'button' }, 'Annuler ma demande');
    cancelBtn.addEventListener('click', async () => {
      if (!confirm('Annuler votre demande de suppression ?')) return;
      setBusy(cancelBtn, true, 'Annulation…');
      try {
        await gestionApi('/api/member/deletion-request', { method: 'DELETE' });
        wrap.replaceWith(renderDeletionRequestBlock({ status: 'fulfilled', value: { data: null } }));
      } catch (e) {
        showAlert(alertBox2, 'error', e.message);
        setBusy(cancelBtn, false, 'Annuler ma demande');
      }
    });
    wrap.appendChild(cancelBtn);
    return wrap;
  }

  // statut === 'done' : ne devrait normalement plus être consultable (le
  // compte est supprimé), gardé par sécurité si jamais affiché quand même.
  wrap.appendChild(el('div', { class: 'row-sub' }, 'Vos données ont été anonymisées.'));
  return wrap;
}

// Messagerie / contact rapide avec le bureau (POST /api/member/contact,
// gestion) : envoie un email via Brevo à l'adresse du club sans jamais
// l'exposer côté client — contrairement au lien mailto: du pied de page
// (renderDashboard), qui reste affiché tel quel pour qui préfère sa propre
// messagerie.
function renderContactSection() {
  const alert = el('div');
  const form = el('form', { id: 'contact-form' }, [
    textField('contact-subject', 'Objet', ''),
    el('div', { class: 'field' }, [
      el('label', { for: 'contact-message' }, 'Message'),
      el('textarea', { id: 'contact-message', name: 'contact-message', rows: '5', required: true }),
    ]),
    alert,
    el('button', { class: 'btn btn-primary btn-sm', type: 'submit' }, 'Envoyer au bureau'),
  ]);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const btn = form.querySelector('button[type="submit"]');
    const subject = form.querySelector('#contact-subject').value.trim();
    const message = form.querySelector('#contact-message').value.trim();
    if (!subject || !message) {
      showAlert(alert, 'error', 'Merci de renseigner un objet et un message.');
      return;
    }
    setBusy(btn, true, 'Envoi…');
    try {
      await gestionApi('/api/member/contact', { method: 'POST', body: { subject, message } });
      showAlert(alert, 'ok', 'Message envoyé — le bureau vous répondra directement par email.');
      form.reset();
    } catch (e) {
      showAlert(alert, 'error', e.message);
    } finally {
      setBusy(btn, false, 'Envoyer au bureau');
    }
  });

  return el('div', { class: 'section fade-rise' }, [
    el('div', { class: 'section-head' }, [el('div', { class: 'section-title' }, 'Contacter le bureau')]),
    el('div', { class: 'section-note' }, "Votre message part par email sans révéler d'adresse en clair ; le bureau pourra vous répondre directement."),
    form,
  ]);
}

// ── Routeur ─────────────────────────────────────────────────────────────
function render() {
  const root = document.getElementById('app');
  root.innerHTML = '';
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const authed = !!getToken();

  if (path === '/connexion') return renderConnexion(root);
  if (path === '/activer') return renderActivation(root);
  if (path === '/mot-de-passe-oublie') return renderMotDePasseOublie(root);
  if (path === '/reinitialiser') return renderMotDePasseOublie(root); // même vue : détecte ?token
  if (path === '/') {
    if (!authed) return goTo('/connexion');
    return renderDashboard(root);
  }
  // Chemin inconnu : on ramène vers le tableau de bord (ou la connexion, selon la session)
  return goTo(authed ? '/' : '/connexion');
}

applyTheme(getTheme());
render();
