# Tahiry

Premier jet d'un logiciel de gestion de stock et de caisse **offline-first**, pour navigateur et mobile (PWA installable). Fonctions inspirées des ERP de commerce comme Async ; code et marque sont indépendants.

## Démarrer

Node.js 22.13 ou plus récent, aucune dépendance à installer.

```bash
npm start
```

Ouvrir <http://localhost:8787>. La clé de synchronisation est créée dans `data/token.txt` : la coller dans **Réglages** sur chaque appareil.

```bash
npm test
```

## Fonctions

- Tableau de bord : ventes du jour, valeur du stock au coût moyen, alertes
- Caisse : recherche, douchette, remise, Espèces / MVola / Orange Money / Airtel Money, ticket imprimable
- Articles, catégories, seuils, export CSV
- Achats : réceptions fournisseurs multi-lignes, coût moyen pondéré (CUMP)
- Mouvements : entrées valorisées, sorties, transferts multi-dépôts
- Inventaire avec écarts, annulation de vente, clients et fournisseurs
- Rapports : chiffre d'affaires, marge, panier moyen, paiements, vendeurs, articles, par période, export CSV
- Utilisateurs : rôles gérant / vendeur, code PIN, verrouillage après 15 min d'inactivité

## Utilisateurs et rôles

Sans utilisateur, l'application est ouverte à tous. Dans **Réglages → Utilisateurs**, créer le premier gérant active l'écran de connexion sur tous les appareils synchronisés.

- **Gérant** : tout.
- **Vendeur** : tableau de bord, caisse, ventes et articles en lecture ; pas d'annulation, d'achat, d'inventaire ni de réglages.
- **PIN oublié** : la clé de synchronisation enregistrée sur l'appareil ouvre une session gérant de récupération.

Le PIN est haché (PBKDF2-SHA256, sel aléatoire) et synchronisé, pour se connecter hors ligne sur n'importe quel appareil.

## Comment marche le hors ligne

1. L'interface lit et écrit uniquement dans IndexedDB ; le service worker sert l'application sans réseau.
2. Chaque écriture rejoint, dans la même transaction, une file d'envoi.
3. La synchro (`POST /api/sync`) envoie la file puis récupère les nouveautés grâce à un curseur.

Résolution des conflits :

| Donnée | Règle |
| --- | --- |
| Stock | Jamais stocké : somme de mouvements immuables, donc les ventes de deux appareils s'additionnent |
| Articles, partenaires, dépôts, ventes | Dernière écriture gagnante, selon une horloge logique hybride |
| Annulation concurrente | Identifiants déterministes : le stock n'est recrédité qu'une fois |
| Survente hors ligne | Autorisée, puis signalée dans « Écarts à vérifier » |

## Déployer pour les téléphones

Les service workers exigent **HTTPS** (ou `localhost`). Un téléphone qui ouvre `http://192.168.x.x` aura la synchro mais pas le démarrage hors ligne. Placer le serveur derrière un proxy HTTPS, avec `HOST=0.0.0.0`. Variables : `PORT`, `HOST`, `TAHIRY_TOKEN`, `TAHIRY_DATA`.

## Limites de ce premier jet

- Les rôles sont appliqués par l'application, pas par le serveur : toute personne qui détient la clé de synchronisation peut écrire n'importe quelle donnée. Pas de multi-entreprise.
- Le PIN est un contrôle d'accès entre collègues : un PIN de 4 chiffres reste devinable par quelqu'un qui copie les données de l'appareil.
- Données locales non chiffrées sur l'appareil.
- Une horloge d'appareil très en avance peut gagner les conflits de « dernière écriture ».
- Tout est chargé en mémoire : adapté à une boutique, pas à des millions de mouvements.
- Pas encore d'app native sur les stores ; `/api` accepte déjà le CORS pour un empaquetage Capacitor.
- Pas de facturation PDF, comptabilité, paie, ni bons de commande fournisseurs (seulement les réceptions).
- Les ventes enregistrées avant l'ajout du coût figé ont une marge surestimée (signalé dans les rapports).
