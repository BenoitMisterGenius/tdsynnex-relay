# Relais TD SYNNEX Europe

Petit relais HTTP protege pour les consultations catalogue, prix et stock.
Le site Mister Genius transmet ses requetes a ce service avec une cle partagee.
Le service appelle exclusivement `https://api.tdsynnex.com/eu`.
Il ne stocke aucun identifiant, jeton ou catalogue sur disque.

## Installation manuelle sur Render

1. Creer un depot GitHub prive nomme `tdsynnex-relay`.
2. Extraire le ZIP et deposer son contenu a la racine du depot (pas le ZIP lui-meme).
3. Sur Render, creer un **Web Service** depuis ce depot.
4. Parametres :
   - Name : `tdsynnex-relay`
   - Language : `Node`
   - Region : `Frankfurt`
   - Branch : `main`
   - Root Directory : laisser vide
   - Build Command : `npm install --omit=dev`
   - Start Command : `npm start`
   - Instance Type : **Free**
   - Health Check Path : `/health` (dans Advanced si disponible)
5. Dans Environment Variables, ajouter `RELAY_KEY` : generer dans 1Password
   un mot de passe aleatoire de 64 caracteres alphanumeriques. Le conserver
   pour la configuration du site. Ne pas le mettre dans GitHub ou une capture.
6. Deployer. L'URL `https://NOM.onrender.com/health` doit retourner
   `{"ok":true,"service":"tdsynnex-relay","version":"1.0.0"}`.
7. Dans la fiche du service Render, ouvrir **Connect > Outbound**.
   Ajouter TOUTES les plages CIDR affichees a la whitelist TD SYNNEX.
   Ces plages sont partagees avec d'autres services Render ; le Bearer TD
   reste requis. Ne pas utiliser l'IP DNS du nom onrender.com.
8. Il reste ensuite a adapter le site existant pour utiliser l'URL du relais
   et la cle `RELAY_KEY`, conservee chiffree cote serveur. Deployer ce relais
   seul ne modifie pas encore les appels du site.

`render.yaml` sert a une installation via Blueprint. Dans le formulaire manuel
Web Service, il faut bien saisir les parametres et la cle ci-dessus.

## Contrat d'integration

- `GET /health` : reveil et verification de fonctionnement, sans secret.
- Les trois routes POST autorisees sont :
  - `/auth/token` (formulaire client_credentials)
  - `/resellers/v2/products/catalogue` (JSON + Bearer TD)
  - `/resellers/v1/products/latest-stock-price` (JSON + Bearer TD)
- Pour chaque POST, ajouter `X-TD-Relay-Key: <RELAY_KEY>`.
- Conserver les Content-Type et corps attendus par TD SYNNEX.
- Ne pas ajouter `/eu` a l'URL du relais : il ajoute lui-meme le prefixe TD.
- Les statuts fournisseur, dont 400/401/403/429, sont conserves.
- Aucun proxy generique, suivi de redirection, cookie ou acces CORS navigateur.
- Protection : 60 appels/minute, 8 simultanes, corps 64 Kio maximum,
  reponse 8 Mio maximum, delai fournisseur 25 secondes.
- Les identifiants TD restent geres par le site. Ils transitent via le relais
  en HTTPS pour obtenir le jeton ; ce relais doit donc rester sous ton controle.

### Essai catalogue

POST `https://NOM.onrender.com/resellers/v2/products/catalogue`

En-tetes : Content-Type application/json, Authorization Bearer du jeton TD
recent, X-TD-Relay-Key contenant la cle privee du relais.

```json
{"manufacturer":"Lenovo","page":1,"pageSize":1,"includeStock":true,"includePrice":true}
```

Le test reel TD doit etre effectue apres ajout des plages IP. Les tests fournis
utilisent un faux fournisseur et ne valident ni les identifiants ni la whitelist.

## Offre gratuite et reveil

Render Free se met en veille apres 15 minutes sans trafic et peut prendre
environ une minute a redemarrer. Le site devra reveiller `/health` a la demande
et afficher une attente, puis appeler l'API une fois le relais disponible.
Pas de ping permanent pour contourner la mise en veille.
L'offre gratuite a des quotas et n'est pas recommandee par Render pour une
production critique. Sans moyen de paiement, les depassements concernes
entrainent une suspension plutot qu'une facturation supplementaire.

Documentation verifiee le 27 octobre 2026 :
- https://render.com/docs/deploy-node-express-app
- https://render.com/docs/free
- https://render.com/docs/outbound-ip-addresses

## Developpement

Node.js 24, sans dependance externe. `npm test` execute les tests locaux.
`npm start` exige la variable `RELAY_KEY` (32 caracteres minimum).
