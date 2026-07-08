# Espace membre — AFFBC

Front statique (Cloudflare Workers + Assets) pour `espace-membre.americanfullfightingbons.fr`.

Ce Worker ne fait que servir les fichiers de `public/` avec des en-têtes de
sécurité cohérents avec le reste de l'écosystème AFFBC. **Il n'a pas de base
de données à lui** : toute la logique (authentification, profil, cotisation,
documents, commandes, inscriptions) vit déjà dans les trois autres projets et
est consommée ici en cross-origin, via un jeton signé émis par `gestion`.

## Comment ça s'articule avec le reste

```
                     ┌──────────────────────────────────────────┐
                     │  espace-membre.americanfullfightingbons.fr │
                     │  (ce projet — front seul, pas de DB)       │
                     └───────────────┬────────────────────────────┘
                                      │ Authorization: Bearer <jeton>
              ┌───────────────────────┼───────────────────────┐
              ▼                       ▼                       ▼
   gestion.americanfullfightingbons.fr   boutique.…fr    calendrier.…fr
   /api/member/login, /me,               /api/member/    /api/member/
   /activation/*, /password/*,           orders          registrations
   /documents/certificat
```

Le jeton est émis uniquement par `gestion` (source de vérité de l'identité
adhérent) et vérifié indépendamment par `boutique` et `calendrier` grâce à un
`SESSION_SECRET` **partagé** entre les quatre Workers — voir la section
Configuration ci-dessous.

## Pourquoi localStorage plutôt qu'un cookie HttpOnly

Le staff (`gestion`) utilise un cookie HttpOnly pour sa propre session — la
bonne pratique habituelle. Ce n'était pas possible ici : un cookie posé par
`gestion` n'est jamais envoyé par le navigateur vers `boutique` ou
`calendrier`, qui sont des sous-domaines distincts. Le jeton doit donc être
lisible par le JavaScript de ce front pour être rejoué en `Authorization:
Bearer` vers les trois APIs. La contrepartie de sécurité : une CSP stricte
(`script-src 'self'`, aucun script tiers) dans `src/index.ts`, et aucune
donnée venant des API n'est jamais insérée en HTML brut côté client
(`app.js` construit le DOM élément par élément, jamais via `innerHTML` avec
des données externes).

## Configuration nécessaire avant déploiement

1. **`SESSION_SECRET`** doit être défini sur `gestion`, `boutique` et
   `calendrier` avec **exactement la même valeur** (`wrangler secret put
   SESSION_SECRET` sur chacun). C'est ce secret partagé qui permet à
   `boutique`/`calendrier` de faire confiance à un jeton émis par `gestion`
   sans jamais se reparler entre eux.
2. **`MEMBER_PORTAL_URL`** sur `gestion`, à définir sur
   `https://espace-membre.americanfullfightingbons.fr` (utilisé dans les
   emails d'activation et de réinitialisation de mot de passe).
3. Domaine personnalisé `espace-membre.americanfullfightingbons.fr` à
   rattacher à ce Worker (déjà déclaré dans `wrangler.json`, à valider côté
   dashboard Cloudflare / DNS).
4. Un lien vers cet espace est à ajouter dans la navigation du site
   principal (`site-americanfullfightingbons`) — non fait automatiquement.

## Développement local

```bash
npm install
npm run dev
```

## Vérifications avant déploiement

```bash
npm run typecheck   # tsc --noEmit
npm run check       # + wrangler deploy --dry-run
```
