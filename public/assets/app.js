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
const TOKEN_KEY = 'affbc_membre_token';
const TOKEN_EXP_KEY = 'affbc_membre_token_exp';

// ── Session ─────────────────────────────────────────────────────────────
function getToken() {
  const token = localStorage.getItem(TOKEN_KEY);
  const exp = Number(localStorage.getItem(TOKEN_EXP_KEY) || 0);
  if (!token || !exp || Date.now() >= exp) return null;
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

// ── Client API ──────────────────────────────────────────────────────────
async function apiCall(base, path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (!token) { goTo('/connexion'); throw new Error('Session absente'); }
    headers.Authorization = `Bearer ${token}`;
  }
  let response;
  try {
    response = await fetch(base + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Connexion impossible. Vérifiez votre connexion internet et réessayez.');
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
function renderTopbar({ showLogout }) {
  const bar = el('div', { class: 'topbar' }, [
    el('a', { class: 'brand', href: SITE_URL }, [
      el('img', { src: '/assets/logo.png', alt: '' }),
      el('span', { class: 'brand-text' }, [
        el('b', {}, 'AFFBC'),
        el('span', {}, 'Espace membre'),
      ]),
    ]),
    showLogout
      ? el('div', { class: 'topbar-actions' }, [
          el('button', { class: 'btn-logout', type: 'button', onclick: handleLogout }, 'Se déconnecter'),
        ])
      : null,
  ]);
  return bar;
}

function alertBox(type, message) {
  return el('div', { class: `alert alert-${type}` }, [
    el('span', {}, type === 'error' ? '⚠️' : '✓'),
    el('span', {}, message),
  ]);
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
          el('div', { class: 'field' }, [
            el('label', { for: 'password' }, 'Mot de passe'),
            el('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
          ]),
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
      setToken(res.data.token, res.data.expiresAt);
      goTo('/');
    } catch (e) {
      alertSlot.appendChild(alertBox('error', e.message));
      setBusy(btn, false, 'Se connecter');
    }
  });
}

function setBusy(btn, busy, label) {
  btn.disabled = busy;
  btn.innerHTML = '';
  if (busy) btn.appendChild(el('span', { class: 'spinner' }));
  btn.appendChild(document.createTextNode(label));
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
      alertSlot.appendChild(alertBox('error', e.message));
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
          el('div', { class: 'field' }, [
            el('label', { for: 'password' }, 'Nouveau mot de passe'),
            el('input', { id: 'password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: '8' }),
            el('div', { class: 'field-hint' }, '8 caractères minimum.'),
          ]),
          el('div', { class: 'field' }, [
            el('label', { for: 'password2' }, 'Confirmez le mot de passe'),
            el('input', { id: 'password2', name: 'password2', type: 'password', autocomplete: 'new-password', required: true, minlength: '8' }),
          ]),
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
      if (res?.data?.token) {
        setToken(res.data.token, res.data.expiresAt);
        goTo('/');
        return;
      }
      form.replaceWith(el('div', {}, [
        alertBox('ok', successMessage || 'Fait.'),
        el('a', { class: 'btn btn-primary btn-block', href: '/connexion', style: 'margin-top:1rem' }, 'Se connecter'),
      ]));
    } catch (e) {
      alertSlot.appendChild(alertBox('error', e.message));
      setBusy(btn, false, 'Valider');
    }
  });
}

// ── Vue : tableau de bord ───────────────────────────────────────────────
async function renderDashboard(root) {
  if (!getToken()) return goTo('/connexion');

  root.appendChild(renderTopbar({ showLogout: true }));
  const main = el('main');
  root.appendChild(main);

  main.appendChild(el('div', { class: 'member-card' }, [el('div', { class: 'skeleton' })]));
  main.appendChild(el('div', { class: 'skeleton', style: 'height:8rem;margin-bottom:1rem' }));
  main.appendChild(el('div', { class: 'skeleton', style: 'height:8rem' }));

  const [meRes, regRes, orderRes] = await Promise.allSettled([
    gestionApi('/api/member/me'),
    calendrierApi('/api/member/registrations'),
    boutiqueApi('/api/member/orders'),
  ]);

  main.innerHTML = '';

  if (meRes.status === 'rejected') {
    main.appendChild(alertBox('error', "Impossible de charger votre profil : " + meRes.reason.message));
    return;
  }
  const me = meRes.value.data;

  main.appendChild(renderMemberCard(me));
  main.appendChild(renderCertificatSection(me));
  main.appendChild(renderRegistrationsSection(regRes));
  main.appendChild(renderOrdersSection(orderRes));

  root.appendChild(el('footer', { class: 'app-footer' }, [
    'Une question sur votre dossier ? Écrivez à ',
    el('a', { href: 'mailto:fullfightingbons@gmail.com' }, 'fullfightingbons@gmail.com'),
  ]));
}

function renderMemberCard(me) {
  const cotisationOk = String(me.paiement || '').toLowerCase().includes('pay') || String(me.paiement || '').toLowerCase().includes('sold');
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
    el('div', { class: `stamp ${cotisationOk ? 'stamp-ok' : 'stamp-warn'}` }, [
      el('span', { class: 'stamp-dot' }),
      cotisationOk ? 'Cotisation à jour' : `Cotisation : ${me.paiement || 'à régulariser'}`,
    ]),
  ]);
}

function renderCertificatSection(me) {
  const hasValidCert = Number(me.certificat) === 1;
  const section = el('div', { class: 'section fade-rise fade-rise-1' }, [
    el('div', { class: 'section-head' }, [
      el('div', { class: 'section-title' }, 'Certificat médical'),
    ]),
    el('div', { class: 'row', style: 'margin-bottom:.85rem' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, hasValidCert ? 'Certificat enregistré' : 'Aucun certificat à jour enregistré'),
        el('div', { class: 'row-sub' }, me.certificat_date ? `Daté du ${formatDate(me.certificat_date)}` : "Déposez un certificat pour valider votre pratique."),
      ]),
      el('span', { class: `badge ${hasValidCert ? 'badge-ok' : 'badge-warn'}` }, hasValidCert ? 'À jour' : 'À déposer'),
    ]),
    renderCertificatUpload(),
  ]);
  return section;
}

function renderCertificatUpload() {
  const box = el('div', { class: 'upload-box' }, [
    el('div', { class: 'upload-row' }, [
      el('label', { class: 'file-input-label', for: 'cert-file' }, [
        '📎 ', el('span', { id: 'cert-file-label' }, 'Choisir un fichier (PDF, JPG, PNG)'),
      ]),
      el('input', { type: 'file', id: 'cert-file', accept: '.pdf,.jpg,.jpeg,.png' }),
      el('input', { type: 'date', id: 'cert-date', 'aria-label': 'Date du certificat' }),
    ]),
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
  const statusLabels = { paye: ['Payé', 'badge-ok'], en_attente: ['En attente', 'badge-muted'], annule: ['Annulé', 'badge-warn'] };
  for (const r of items) {
    const [label, cls] = statusLabels[r.paiement_status] || [r.paiement_status || '—', 'badge-muted'];
    list.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, r.title || 'Événement'),
        el('div', { class: 'row-sub' }, `${formatDate(r.date_start)}${r.lieu ? ' · ' + r.lieu : ''}`),
      ]),
      el('span', { class: `badge ${cls}` }, label),
    ]));
  }
  section.appendChild(list);
  return section;
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
    list.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'row-main' }, [
        el('div', { class: 'row-title' }, `Commande n°${o.id}`),
        el('div', { class: 'row-sub' }, `${formatDate(o.created_at)} · ${formatMoney(o.total)}`),
      ]),
      el('div', { class: 'row-actions' }, [
        el('span', { class: `badge ${cls}` }, label),
        o.status === 'confirmed' ? el('button', {
          class: 'btn btn-ghost btn-sm', type: 'button',
          onclick: () => downloadInvoice(o.id),
        }, 'Facture') : null,
      ]),
    ]));
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
    alert(e.message); // eslint-disable-line no-alert -- action ponctuelle hors formulaire, pas de zone d'erreur dédiée ici
  }
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

render();
