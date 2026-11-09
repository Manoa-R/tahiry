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

- Tableau de bord : ventes du jour, valeur du stock, alertes
- Caisse : recherche, douchette, remise, Espèces / MVola / Orange Money / Airtel Money, ticket imprimable
- Articles, catégories, seuils, export CSV
- Mouvements : entrées, sorties, transferts multi-dépôts
- Inventaire avec écarts, annulation de vente, clients et fournisseurs

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

- Une seule clé partagée par installation : ni comptes utilisateurs, ni rôles, ni multi-entreprise.
- Données locales non chiffrées sur l'appareil.
- Une horloge d'appareil très en avance peut gagner les conflits de « dernière écriture ».
- Tout est chargé en mémoire : adapté à une boutique, pas à des millions de mouvements.
- Pas encore d'app native sur les stores ; `/api` accepte déjà le CORS pour un empaquetage Capacitor.
- Pas de facturation PDF, comptabilité, paie ni commandes fournisseurs.
