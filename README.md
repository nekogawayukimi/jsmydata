# JsMyData

Administration web de bases **MySQL / MariaDB**, **PostgreSQL** et **SQLite**, avec l'expérience utilisateur de phpMyAdmin, sur une pile 100 % JavaScript : **React** côté client, **Express** (Node.js) côté serveur. Aucun PHP requis.

> État : **lots 0 et 1**. Connexion (cookie, config, http, signon, serveur libre), navigation, structures, Parcourir avec édition en ligne, Insérer / Modifier / Copier / Supprimer, Rechercher (table et base), éditeur SQL multi-instructions et console, pour les trois moteurs. Les autres onglets sont présents (parité d'interface) et signalent le lot qui les livrera.

## Démarrage rapide (sans configuration)

```bash
git clone https://github.com/nekogawayukimi/jsmydata.git
cd jsmydata
npm install
npm run build
npm start            # ou : node apps/server/dist/cli.js
```

Ouvrez <http://127.0.0.1:8080> et connectez-vous avec un compte existant du SGBD.

Sans fichier de configuration, JsMyData :

| Paramètre          | Valeur par défaut                                                                                                 |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| Écoute             | `127.0.0.1:8080` (accès local uniquement)                                                                         |
| MySQL / MariaDB    | socket détecté (`/var/run/mysqld/mysqld.sock`, `/tmp/mysql.sock`, Homebrew, MAMP, XAMPP…), sinon `127.0.0.1:3306` |
| PostgreSQL         | proposé s'il répond sur son socket ou `127.0.0.1:5432`                                                            |
| SQLite             | fichiers `.sqlite`, `.sqlite3`, `.db` du dossier de lancement                                                     |
| Authentification   | `cookie` : identifiants saisis à la connexion, chiffrés en session (AES-256-GCM)                                  |
| Clé de chiffrement | générée au premier lancement dans `~/.jsmydata/secret` (droits 600)                                               |
| Thème              | jmd-default, mode **Automatique** (clair ou sombre selon le système)                                              |

JsMyData refuse de démarrer s'il doit écouter au-delà de la machine locale sans configuration explicite.

Derrière un gestionnaire de processus (PM2, Uxsagi…), utilisez `npm run start:local` : le script installe les dépendances et recompile si nécessaire, puis lance le serveur (`node scripts/start-local.mjs --port 4820`).

## Configuration

Copiez `jsmydata.config.example.json` en `jsmydata.config.json` (ou `.yaml`). Les noms de directives reprennent ceux de phpMyAdmin (`Servers`, `auth_type`, `AllowRoot`, `AllowNoPassword`, `hide_db`, `only_db`, `LoginCookieValidity`…).

Options de la ligne de commande : `jsmydata --config fichier --host 127.0.0.1 --port 8080`.

Variables d'environnement (les alias `PMA_*` de l'image phpmyadmin sont acceptés) :

| Variable                                                           | Rôle                                        |
| ------------------------------------------------------------------ | ------------------------------------------- |
| `JSMYDATA_HOST` / `PMA_HOST`                                       | hôte du SGBD                                |
| `JSMYDATA_PORT` / `PMA_PORT`                                       | port du SGBD                                |
| `JSMYDATA_ENGINE`                                                  | `mysql` (défaut), `postgres` ou `sqlite`    |
| `JSMYDATA_USER` / `PMA_USER`, `JSMYDATA_PASSWORD` / `PMA_PASSWORD` | connexion automatique (`auth_type: config`) |
| `JSMYDATA_SECRET`                                                  | clé de chiffrement des sessions             |
| `JSMYDATA_LISTEN_HOST`, `JSMYDATA_LISTEN_PORT`                     | adresse et port d'écoute                    |
| `JSMYDATA_SQLITE_DIR`                                              | dossier autorisé pour les fichiers SQLite   |
| `JSMYDATA_COLOR_MODE`                                              | `auto`, `light` ou `dark`                   |

## Docker

```bash
docker build -f docker/Dockerfile -t jsmydata/jsmydata .
docker run -p 8080:8080 -e JSMYDATA_HOST=host.docker.internal jsmydata/jsmydata
```

## Développement

```bash
npm install
npm run dev:server   # API sur http://127.0.0.1:8080 (rechargement automatique)
npm run dev:web      # client Vite sur http://127.0.0.1:5173, /api relayé vers 8080
npm test             # tests unitaires et d'intégration
npm run lint && npm run typecheck
```

Tests sur de vrais serveurs (lancés automatiquement en CI) :

```bash
JSMYDATA_TEST_PG=postgres://postgres:mdp@127.0.0.1:5432/postgres \
JSMYDATA_TEST_MYSQL=mysql://root:mdp@127.0.0.1:3306 npm test
```

### Organisation

```
apps/web/          client React (Vite, React Router, TanStack Query, i18next)
apps/server/       API Express (sessions, CSRF, configuration, détection locale)
packages/shared/   types de l'API partagés client / serveur
packages/sql/      couche dialecte : MySQL/MariaDB (mysql2), PostgreSQL (pg), SQLite (better-sqlite3)
docker/            image de production
```

Chaque moteur implémente l'interface `Dialect` de `packages/sql` (connexion, introspection, échappement, capacités). Le client masque les onglets que le moteur ne supporte pas.

## Feuille de route

| Lot                   | Contenu                                                                                                                  | État         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------ | ------------ |
| 0. Socle              | Monorepo, CI, couche dialecte, connexion, sessions, navigation, thème clair/sombre, configuration prête à l'emploi, i18n | **en cours** |
| 1. Données            | Parcourir, édition en ligne, Insérer, Rechercher, éditeur SQL, console                                                   | à venir      |
| 2. Structure          | Création / modification de bases, tables, colonnes, index, clés, vues                                                    | à venir      |
| 3. Import / export    | Tous les formats, dumps natifs, export Tableau PHP et Tableau JS                                                         | à venir      |
| 4. Administration     | Comptes, privilèges, état, variables, réplication, processus                                                             | à venir      |
| 5. Fonctions avancées | Stockage de configuration, concepteur, suivi, colonnes centrales, 2FA…                                                   | à venir      |

## Licence

À définir en fin de projet.
