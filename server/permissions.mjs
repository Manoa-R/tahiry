// Droits d'écriture appliqués par le serveur, changement par changement.
// Le gérant peut tout écrire. Le vendeur ne peut que créer ses propres ventes
// et les sorties de stock qui en découlent ; tout le reste lui est refusé.

const SALE_MOVEMENT = /^(.+):v:(\d+)$/;

/**
 * @param {{c: string, id: string, data: object, deleted?: boolean}} change
 * @param {{ role: string, userId: string }} author
 * @param {(c: string, id: string) => object | null} lookup  enregistrement serveur existant
 * @param {Map<string, object>} batchSales  ventes créées dans le même lot
 * @returns {string | null} motif du refus, ou null si autorisé
 */
export function refusal(change, author, lookup, batchSales) {
  if (author.role === 'gerant') return null;
  if (author.role !== 'vendeur') return 'Rôle inconnu';
  if (change.deleted) return 'Suppression réservée au gérant';

  if (change.c === 'sales') {
    if (lookup('sales', change.id)) return 'Modification d’une vente réservée au gérant';
    if (change.data.userId !== author.userId) return 'Vente attribuée à un autre utilisateur';
    if (change.data.cancelled) return 'Annulation réservée au gérant';
    return null;
  }

  if (change.c === 'movements') {
    const match = SALE_MOVEMENT.exec(change.id);
    if (!match || change.data.type !== 'vente' || !(change.data.qty < 0)) return 'Mouvement de stock réservé au gérant';
    const sale = batchSales.get(match[1]) ?? lookup('sales', match[1]);
    if (!sale || sale.userId !== author.userId) return 'Sortie de stock sans vente de cet utilisateur';
    // La sortie doit refléter exactement sa ligne de vente : pas de stock retiré « en plus ».
    const line = Array.isArray(sale.lines) ? sale.lines[Number(match[2])] : null;
    if (!line || line.articleId !== change.data.articleId || -change.data.qty !== line.qty || change.data.depotId !== sale.depotId) {
      return 'Sortie de stock différente de la ligne de vente';
    }
    return null;
  }

  return 'Action réservée au gérant';
}
