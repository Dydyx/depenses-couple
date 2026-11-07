# Dépenses du couple

Petite appli web (HTML/CSS/JS, sans dépendance) pour gérer les dépenses de Dyd, de Meg et du couple.
Hébergée gratuitement sur GitHub Pages, données stockées dans une base Supabase (gratuite).

## Fonctionnement

- Page d'accueil blanche : mot de passe + « Valider ». Rien ne s'affiche si le mot de passe est faux.
- 3 onglets : **Dépenses Dyd**, **Dépenses Meg**, **Dépenses du couple**.
- Ajout (Motif, Montant, Le ... du mois), modification ✏️ et suppression 🗑 en un clic (avec « Annuler »).
- Tri par colonne (clic sur l'en-tête), recherche/filtre sur chaque champ.
- Totaux en bas de chaque tableau ; les onglets personnels reprennent la part du couple.
- Curseur « Répartition des parts » (pas de 0,5 %) dans l'onglet du couple.
- Import / export `.json` par onglet.

## Base de données en ligne (Supabase) : mise en place

Sans configuration, l'appli fonctionne en **mode local** : les données restent dans le navigateur
de l'appareil utilisé (pastille grise « Données sur cet appareil »).
Pour partager les données entre vos téléphones / ordinateurs :

1. Créer un compte gratuit sur <https://supabase.com> puis un nouveau projet (région Europe).
2. Dans le projet : **SQL Editor** → **New query** → coller le contenu de [`supabase.sql`](supabase.sql) → **Run**.
3. Dans **Project Settings → API Keys** (ou **Connect**), récupérer :
   - l'**URL du projet** (`https://xxxx.supabase.co`) ;
   - la **clé publique** (`sb_publishable_…` ou l'ancienne clé `anon`). **Jamais** la clé `secret` / `service_role`.
4. Les renseigner dans [`config.js`](config.js), puis committer / pousser.

La pastille passe au vert « Synchronisé ». La clé publique peut être visible dans le code :
les tables sont fermées, et seules deux fonctions sont accessibles, qui vérifient le mot de passe
côté serveur (stocké haché en bcrypt).

### Changer le mot de passe

Dans le SQL Editor de Supabase :

```sql
update public.app_secret
  set pwd_hash = extensions.crypt('NOUVEAU_MOT_DE_PASSE', extensions.gen_salt('bf'))
  where id = 1;
```

(En mode local, le mot de passe est vérifié via son empreinte SHA-256 dans `app.js`.)

## Développement local

Servir le dossier avec n'importe quel serveur statique, par ex. :

```bash
npx http-server -p 8080 -c-1
```
