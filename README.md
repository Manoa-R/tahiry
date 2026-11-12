# Tahiry

Premier jet d'un logiciel de gestion de stock et de caisse **offline-first**, pour navigateur et mobile (PWA installable). Fonctions inspirées des ERP de commerce comme Async ; code et marque sont indépendants.

## Démarrer

Node.js 22.13 ou plus récent, aucune dépendance à installer.

```bash
npm start
```

Ouvrir <http://localhost:8787>. La clé boutique est créée dans `data/token.txt` : la saisir dans **Réglages** pour relier chaque appareil.

```bash
npm test
```

## Fonctions

- Tableau de bord : ventes du jour, valeur du stock au coût moyen, alertes
- Scanner : codes-barres à la caméra (téléphone, tablette, webcam) ou à la douchette, hors ligne
- Caisse : recherche, douchette, remise, Espèces / MVola / Orange Money / Airtel Money, ticket imprimable
- Factures A4 depuis une vente : en-tête boutique (NIF, STAT, RCS), client, TVA 20 % en option, montant en lettres, impression ou PDF
- Articles, catégories, seuils, export CSV
- Achats : réceptions fournisseurs multi-lignes, coût moyen pondéré (CUMP)
- Mouvements : entrées valorisées, sorties, transferts multi-dépôts
- Inventaire avec écarts, annulation de vente, clients et fournisseurs
- Rapports : chiffre d'affaires, marge, panier moyen, paiements, vendeurs, articles, par période, export CSV
- Utilisateurs : rôles gérant / vendeur, code PIN, verrouillage après 15 min d'inactivité

## Scanner

La caméra lit les codes EAN-13, EAN-8, UPC, Code 128, Code 39, ITF, Codabar, QR et Data Matrix. Le lecteur est embarqué dans l'application : il fonctionne hors ligne, y compris sur PC.

| Où | Ce que fait une lecture |
| --- | --- |
| **Scanner** (menu) | Fiche de l'article : prix, stock par dépôt, coût moyen ; si le code est inconnu, le gérant crée l'article ou attribue le code à un article existant |
| **Caisse → Scanner** | Ajoute une unité au panier, en continu |
| **Inventaire → Compter au scanner** | Compte une unité de plus, en continu |
| **Réception fournisseur → Scanner** | Ajoute une unité reçue, au coût moyen actuel |
| **Articles → Scanner**, fiche article | Ouvre l'article ou en crée un avec ce code ; remplit le champ code-barres |

Tant qu'un code reste devant la caméra, il ne compte qu'une fois : écarter l'article une seconde pour compter le suivant. Un bip aigu confirme, un bip grave signale un code inconnu. Un même produit lu en UPC-A ou en EAN-13 est reconnu. Sans caméra, saisir le code ou utiliser une douchette dans le même écran.

La caméra demande l'app Android, HTTPS ou `localhost` ; dans un navigateur ouvert en `http://192.168…`, seule la saisie manuelle est disponible.

## Factures

1. **Réglages → Fiche boutique** (gérant) : raison sociale, adresse, NIF, STAT, RCS, TVA et mention de bas de page.
2. **Ventes → Facture** (ou le bouton **Facture** du ticket) : choisir un client enregistré ou saisir son nom, puis émettre.
3. **Imprimer / PDF** : choisir l’imprimante, ou « Enregistrer au format PDF ».

La facture est figée à l’émission : modifier ensuite un prix, un client ou la fiche boutique ne la change pas. Une vente ne donne qu’une facture, et une vente annulée n’en donne pas ; annuler une vente déjà facturée laisse la facture consultable, signalée « à annuler par un avoir ». Numérotation continue par appareil et par année (`FA26-7A36-0001`), car les appareils facturent hors ligne. Avec la TVA, les prix de vente sont considérés TTC et la facture en déduit le HT. Le vendeur peut facturer ses propres ventes ; le serveur refuse une facture dont les montants diffèrent de la vente.

## Utilisateurs et rôles

Sans utilisateur, l'application est ouverte à tous. Dans **Réglages → Utilisateurs**, créer le premier gérant active l'écran de connexion sur tous les appareils synchronisés.

- **Gérant** : tout.
- **Vendeur** : tableau de bord, caisse, scanner, ventes et articles en lecture ; pas d'annulation, d'achat, d'inventaire ni de réglages.
- **PIN oublié** : saisir la clé boutique ouvre une session gérant de récupération.

Le PIN est haché (PBKDF2-SHA256, sel aléatoire) et synchronisé, pour se connecter hors ligne sur n'importe quel appareil.

### Droits vérifiés par le serveur

| Identifiant | Obtenu | Droits |
| --- | --- | --- |
| Clé boutique (`data/token.txt`) | Créée au premier démarrage | Tous ; conservée sur l'appareil seulement tant qu'aucun utilisateur n'existe |
| Jeton d'appareil | Échangé contre la clé boutique dès qu'il y a des utilisateurs | Lecture ; la clé boutique est alors effacée de l'appareil (seule son empreinte reste, pour la récupération) |
| Session utilisateur (90 jours) | Saisie du PIN en ligne (`POST /api/login`, blocage après 5 erreurs) | Écriture selon le rôle, relu à chaque synchro |

Une session n'est valable que depuis l'appareil qui l'a ouverte : un jeton copié ne sert pas ailleurs.

**Appareil perdu ou volé** : dans **Réglages → Appareils**, le gérant connecté voit chaque appareil (nom, date d'enregistrement, dernière activité) et peut le révoquer. L'appareil révoqué perd immédiatement l'accès au serveur, ainsi que toutes les sessions ouvertes depuis lui ; ses données locales restent sur place mais ne se synchronisent plus. Pour le réutiliser, ressaisir la clé boutique.

Chaque changement porte son auteur. Le serveur refuse au vendeur tout ce qui n'est pas **sa** vente et les sorties de stock qui correspondent exactement à ses lignes (même article, quantité et dépôt). Un changement refusé est annulé sur l'appareil avec la version du serveur. Un changement fait hors ligne par un utilisateur sans session n'est pas perdu : il attend, et la pastille « Reconnexion requise » redemande le PIN.

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

Le plus simple : l'[app Android](#app-android), qui fonctionne avec un serveur local en `http`. Dans le navigateur du téléphone, les service workers exigent **HTTPS** (ou `localhost`) : en ouvrant `http://192.168.x.x`, on a la synchro mais pas le démarrage hors ligne. Placer le serveur derrière un proxy HTTPS, avec `HOST=0.0.0.0`. Variables : `PORT`, `HOST`, `TAHIRY_TOKEN`, `TAHIRY_DATA`.

## App Android

Le dossier `mobile/` empaquette l'application web avec [Capacitor](https://capacitorjs.com). Les fichiers sont embarqués dans l'APK : l'app démarre sans réseau, sans HTTPS ni service worker.

- **Obtenir l'APK** : chaque changement poussé sur `main` le construit dans GitHub Actions (onglet *Actions* → *Android* → artefact `tahiry-apk`). Une étiquette `v*` (`git tag v0.2.0 && git push --tags`) publie l'APK dans les *Releases*.
- **Installer** : copier `tahiry.apk` sur le téléphone et l'ouvrir (autoriser « sources inconnues »).
- **Relier** : dans Réglages, saisir l'adresse du serveur de la boutique, par exemple `http://192.168.1.10:8787` (démarrer le serveur avec `HOST=0.0.0.0`), puis la clé boutique.
- **Construire en local** (JDK 21 et SDK Android requis) : `cd mobile && npm ci && npm run apk`.
- **Icônes** : `node scripts/make-icons.mjs` régénère celles du web et d'Android.

L'APK est une version de débogage, à installer à la main ; une publication sur le Play Store demandera une clé de signature.

## Limites de ce premier jet

- La clé boutique donne tous les droits : la garder hors des appareils des vendeurs. Changer la clé boutique ne révoque pas les appareils déjà enregistrés : les révoquer dans Réglages → Appareils. Pas de multi-entreprise.
- Le vendeur lit toutes les données synchronisées (coûts compris).
- Un utilisateur désactivé alors qu'il avait des ventes hors ligne non envoyées : ces ventes restent bloquées sur l'appareil.
- Le PIN est un contrôle d'accès entre collègues : un PIN de 4 chiffres reste devinable par quelqu'un qui copie les données de l'appareil.
- Données locales non chiffrées sur l'appareil.
- Une horloge d'appareil très en avance peut gagner les conflits de « dernière écriture ».
- Tout est chargé en mémoire : adapté à une boutique, pas à des millions de mouvements.
- App Android hors Play Store (APK de débogage) ; pas encore d'app iOS.
- Pas d’avoirs, de devis, de comptabilité, de paie, ni de bons de commande fournisseurs (seulement les réceptions).
- Deux appareils qui facturent la même vente hors ligne : une seule facture est gardée après synchro (facturer depuis un seul poste).
- Un appareil plus récent que le serveur garde en attente les données que le serveur ne connaît pas encore (factures, réglages…), jusqu’à la mise à jour du serveur.
- Les ventes enregistrées avant l'ajout du coût figé ont une marge surestimée (signalé dans les rapports).
