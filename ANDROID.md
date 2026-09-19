# Application Android — Espace membre AFFBC

L'APK est une **Trusted Web Activity** : une coquille Android qui affiche
`https://espace-membre.americanfullfightingbons.fr` dans Chrome, en plein écran, avec
l'icône et l'écran de démarrage du club. Conséquences :

- **Aucune modification de `app.js`, du Worker ni des CORS** des autres projets.
- **L'app se met à jour toute seule** à chaque déploiement du Worker. L'APK ne se
  reconstruit que si `android/` change (nom, icône, version).
- Les liens d'activation / réinitialisation de mot de passe envoyés par `gestion`
  s'ouvrent directement dans l'app une fois le domaine vérifié (étape 3).

## Contenu

| Fichier | Rôle |
|---|---|
| `android/` | Projet Gradle de l'app (généré avec Bubblewrap, package `fr.americanfullfightingbons.espacemembre`) |
| `.github/workflows/android-apk.yml` | Construit l'APK signé (+ l'AAB pour le Play Store) |
| `scripts/make-keystore.sh` | Crée la clé de signature, écrit `assetlinks.json`, enregistre les secrets GitHub |
| `public/.well-known/assetlinks.json` | Lie le domaine à l'app (supprime la barre d'adresse Chrome) |
| `test/assetlinks.test.mjs` | Garde-fou vitest sur ce fichier |

## Mise en route (une seule fois)

1. Copier le contenu de ce dossier **à la racine du dépôt `espace-membre`**.
2. `bash scripts/make-keystore.sh` (JDK requis). Le script crée la clé, remplit
   `public/.well-known/assetlinks.json` et enregistre les 4 secrets GitHub si `gh` est connecté
   (sinon il indique quoi copier à la main dans *Settings → Secrets and variables → Actions*).
   **Sauvegardez `android/keystore/`** (ignoré par git) : sans cette clé, plus de mises à jour possibles.
3. Commit + push sur `main` : le déploiement habituel publie `assetlinks.json`. Vérification :
   `curl https://espace-membre.americanfullfightingbons.fr/.well-known/assetlinks.json`
   doit renvoyer du JSON avec l'empreinte (et non la page d'accueil).
4. *Actions → Android APK → Run workflow*. Récupérer l'artefact `affbc-espace-membre-android`
   (`.apk` à installer, `.aab` pour le Play Store). Le résumé du job indique si `assetlinks.json`
   en ligne correspond bien à la clé.

Nouvelle version : relancer le workflow, ou `git tag android-v1.0.1 && git push origin android-v1.0.1`.
Le `versionCode` suit le numéro d'exécution du workflow (toujours croissant).

## Installer / distribuer

- **Direct** : envoyer le `.apk` sur le téléphone et autoriser l'installation depuis cette source.
- **Play Store** : envoyer le `.aab`. Avec *Play App Signing*, Google re-signe l'app : ajoutez aussi
  l'empreinte SHA-256 du certificat de signature affichée dans Play Console
  (*Intégrité de l'application*) dans `sha256_cert_fingerprints` d'`assetlinks.json`.

## À vérifier sur un vrai téléphone

1. L'app s'ouvre en plein écran, **sans barre d'adresse** (sinon : `assetlinks.json` absent ou empreinte différente).
2. Connexion, puis fermeture/réouverture : la session est conservée.
3. Téléchargement d'une facture et d'un diplôme (PDF).
4. Envoi du certificat médical (photo ou fichier).
5. **Fiche de notation** : `openPdfForPrint` utilise `window.open` sur une URL `blob:` — à tester en priorité ;
   au pire, le PDF se télécharge au lieu de s'ouvrir.
6. Les liens vers boutique / calendrier / inscription s'ouvrent dans un onglet Chrome par-dessus l'app (normal : autres domaines).

## Limites

- Nécessite Chrome (ou un navigateur compatible TWA) sur le téléphone ; sinon l'app retombe sur un onglet Chrome.
- Pas d'équivalent iOS : sur iPhone, Safari → *Partager → Sur l'écran d'accueil* (le manifest est déjà prêt).
- Les fichiers de l'APK n'ont pas été compilés dans l'environnement où ils ont été préparés (pas d'accès aux
  dépôts Android) : le premier run du workflow est le vrai test de build.
