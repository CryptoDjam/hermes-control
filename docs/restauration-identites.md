# Fraîcheur des identités et restauration contrôlée — contrat HC ↔ pack

Branche `lot-b-fraicheur` (prototype, non fusionné, non publié). Suite de la revue Codex du 08/10 (§0, §1) et du GO des quatre chantiers (§2).

## 1. Qui possède quoi (choix d'architecture)

| Donnée | Propriétaire | Écrit par | Lu par |
|---|---|---|---|
| Projection `<enveloppe>/donnees/identites.json` | pack | pack seul (sous son verrou `identites.json.lock`) | HC |
| État de suivi `<compte>/.config/hermes-control/identites-vues.json` (+ `.prec`) | HC | HC seul | HC, `hermes-control-suivi etat` |
| Marqueur `<enveloppe>/donnees/.hermes-control-suivi.json` | HC | HC seul | HC |
| Sauvegardes et bilans `<compte>/.config/hermes-control/restaurations/<clé>/<opération>/` | HC | HC seul | opérateur, pack |
| File `<compte>/.config/hermes-control/notifications/` (`file.jsonl` active bornée, `recus/` un reçu durable par événement, `etat.json` pertes et compteurs) | HC | HC (événements, reçus écrits après confirmation du consommateur), opérateur (acquittement = reçu « operateur ») | futur notifier (relation persistante événement → ticket de son côté), opérateur |

**La restauration est donc partagée.** Le pack restaure la projection, parce qu'il est le seul à pouvoir la réécrire et à pouvoir réconcilier avec Paperclip. HC re-scelle son propre suivi, parce que lui seul peut l'écrire. Aucun des deux n'écrit dans les fichiers de l'autre. Le seul geste croisé est la prise du verrou de la projection pendant l'opération HC, au même format que celui du pack.

## 2. Ce que fait Hermes Control (fait dans cette branche)

- **Jamais amorcée.** S'il n'y a ni entrée de suivi ni marqueur, le refus a la cause `suivi_non_amorce`. Il n'y a **aucun amorçage implicite**. L'opérateur lance `hermes-control-suivi amorcer --enveloppe <dossier> --operateur <nom>`.
- **État absent après usage, tronqué, illisible, permission refusée, schéma invalide, ancien format, marqueur absent ou différent, opération en cours** : le refus a la cause `etat_suivi_invalide`, avec une `regle`. Ce n'est jamais traité comme un état vide. Un état global illisible refuse toutes les enveloppes. La réinitialisation se fait enveloppe par enveloppe.
- **Retour en arrière** (`projection_perimee`) : révision plus basse ; même révision avec un autre contenu ; compteur en recul ; identité retirée remise active ou disparue ; alias qui change d'identité.
- **Écriture** sous verrou : fichier temporaire exclusif, fsync, rename, puis fsync du dossier. `.prec` garde la version valide précédente. Le marqueur garde une deuxième copie du maximum (révision, compteurs, retirés).
- **Restauration** : `hermes-control-suivi restaurer --enveloppe <dossier> --operateur <nom> [--revision-min N] [--compteurs-min e,i,a] [--sans-reference]`
  1. Refus dans l'environnement d'un run d'agent (`PAPERCLIP_AGENT_ID`, `PAPERCLIP_RUN_ID`, `PAPERCLIP_API_KEY`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_REASON`, `HERMES_HOME`). Il faut un terminal et retaper le chemin exact.
  2. Refus si un écrivain tourne : verrou du pack tenu, suivi en cours d'écriture, ou Hermes lancé avec un `HERMES_HOME` dans l'enveloppe (`/proc`). Le verrou du pack est **tenu** jusqu'à la fin.
  3. `en-cours.json` est écrit en premier : à partir de là, les lecteurs refusent l'enveloppe (`restauration_en_cours`).
  4. Sauvegarde brute de la projection, du suivi, de `.prec` et du marqueur. Chaque copie est relue et comparée par sha256.
  5. Maximum fiable = maximum de : suivi courant, `.prec`, ancien format, marqueur, **toutes** les sauvegardes et bilans de cette enveloppe, minimums donnés par l'opérateur. Sans aucune source, la restauration est refusée, sauf avec `--sans-reference` (consigné dans le bilan).
  6. La projection est validée contre ce maximum, avec les mêmes règles que la lecture. Une révision plus haute ne suffit pas : compteurs, retirés et alias sont vérifiés aussi.
  7. HC écrit un nouveau marqueur, puis le suivi de **cette** enveloppe : alias et retirés réunis, compteurs au maximum. Les autres enveloppes ne changent pas.
  8. HC écrit le bilan avant/après dans `bilan.json` et l'affiche à l'opérateur. Il place un événement `restauration` dans la file bornée, puis supprime `en-cours.json`.
  9. **Reprise** : on relance la même commande. Elle reprend à la phase notée, sans refaire la sauvegarde ni dupliquer l'événement.
  10. **Notification perdue** (file pleine, écriture impossible) : la restauration reste faite et prouvée par le bilan. La perte est inscrite dans `etat.json` (avec un compteur de débordements jamais remis à zéro) ou dans le bilan. `hermes-control-suivi notifications --rejouer` remet dans la file tout événement **sans reçu** ; un événement qui a son reçu (`recus/<id>.json` : bilan et son SHA-256, source, ticket, dates) ne réapparaît jamais, quel que soit le nombre d'acquittements. Affichage : « événement enregistré, notification en attente » tant qu'aucun reçu n'existe, jamais « Chef informé ».
  11. **Livraison** (futur notifier, `livrer(consommateur)`) : ticket existant cherché d'abord (`trouver(id)`), sinon créé (`creer`, relation événement → ticket persistée par le consommateur avant de répondre) ; le reçu est écrit seulement après cette confirmation. Une panne entre la confirmation et le reçu laisse l'événement en file : la reprise retrouve le ticket, n'en crée pas un second, puis écrit le reçu.
- `hermes-control-suivi etat --enveloppe <dossier>` donne en JSON l'état, l'historique (avec le maximum fiable de chaque opération) et le nombre de notifications en attente ou perdues.

## 3. Ce que le pack doit fournir (à intégrer au candidat B)

Commande `identites restaurer --enveloppe <dossier>` (opérateur seulement) :

1. Mettre en pause les agents de l'enveloppe dans Paperclip et vérifier qu'aucun run n'est actif.
2. Sauvegarder `identites.json` courant, sous son verrou.
3. Lire le maximum connu par HC : `hermes-control-suivi etat --enveloppe <dossier>`, puis `historique[].maxFiable`. Quand l'état est lisible, ajouter révision et compteurs de l'état.
4. Remettre la projection voulue, la réconcilier avec Paperclip (identifiants `companyId` / `agentId`), puis l'écrire avec :
   - `revision` > tout maximum connu (HC et pack) ;
   - `compteurs` ≥ maximum connu ;
   - chaque identité vue « retire » toujours présente et « retire » ;
   - aucun alias réattribué.
5. Rendre son verrou, puis appeler `hermes-control-suivi restaurer --enveloppe <dossier> --operateur <nom>`. Si HC refuse, il ne modifie rien et le message dit quel maximum respecter.
6. Faire relire l'enveloppe par HC. Montrer à l'opérateur le bilan HC et le diff de la projection.

Amorçage à l'installation : après la première écriture de la projection, le pack (ou l'opérateur) lance `hermes-control-suivi amorcer`. Un désinstalleur doit savoir que `donnees/.hermes-control-suivi.json` appartient à HC.

## 4. Contrat `identite_inactive` (schéma 1)

Dans `resultJson.configurationIncomplete.identite` et `resultJson.hermesControl.identite`. Les champs lus par Paperclip ne changent pas : `errorCode: configuration_incomplete`, `reason`, `fingerprint`, `missingBindings`, `message`.

```json
{ "schema": 1, "code": "identite_inactive", "cause": "agent_absent", "regle": null,
  "agentId": "…", "companyId": "…", "empreinte": "<sha256 de la projection lue>", "revision": 5 }
```

| Cause | Sens |
|---|---|
| `agent_absent`, `agent_retire`, `entreprise_absente`, `entreprise_retiree`, `statut_inconnu` | statut dans la projection |
| `absente` | agent sans entrée dans la projection |
| `projection_invalide` | projection illisible, corrompue, mauvais schéma ou autre enveloppe |
| `projection_perimee` | retour en arrière (voir `regle`) |
| `etat_suivi_invalide` | suivi absent après usage, tronqué, illisible, permission refusée, etc. (voir `regle`) |
| `suivi_non_amorce` | enveloppe jamais amorcée |

La cause est posée par le code qui décide le refus. Elle n'est jamais déduite d'un texte. Ajouter une cause ou retirer un champ fait passer au schéma 2. `refus.jsonl` (même dossier) reçoit une ligne par refus. Il est borné à 256 Kio, avec une seule rotation `.1`. Il ne bloque jamais le refus : une erreur ou un délai de plus de 500 ms est seulement signalé.

## 5. Limites

- Le mécanisme refuse un retour en arrière **observé**. Il ne prouve pas que la projection correspond à l'état courant de Paperclip.
- Ce n'est pas une frontière de sécurité contre le même compte Unix. Un administrateur qui remet ensemble le suivi, `.prec`, les sauvegardes HC **et** l'enveloppe (marqueur compris) à une ancienne copie n'est pas détecté.
- Les gardes « opérateur seulement » (environnement, terminal, confirmation) protègent contre l'erreur et contre l'Assistant lancé par Paperclip. Elles ne protègent pas contre un programme hostile du même compte.
- Le notifier n'existe pas encore : la file est seulement remplie et affichée.
