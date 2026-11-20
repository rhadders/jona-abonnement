import type { Plan } from "./namen.js";

/**
 * De stand van het abonnement van een organisatie, zonder database of Stripe:
 * alleen uit wat er al bekend is.
 *
 * - Een nieuwe organisatie heeft 14 dagen proef, zonder betaalgegevens.
 * - Na de proef, of als het abonnement stopt, heeft de organisatie geen
 *   toegang meer tot er een abonnement loopt. De gegevens blijven bewaard.
 */

export const PROEFDAGEN = 14;
const DAG = 24 * 3600_000;

/** Standen van Stripe waarin de organisatie de app gewoon gebruikt. Bij past_due probeert Stripe de betaling nog opnieuw. */
export const MET_TOEGANG: ReadonlySet<string> = new Set(["active", "trialing", "past_due"]);

/** Wat een app per organisatie bewaart in de tabel `abonnementen`. Zonder rij geldt de proef vanaf het aanmaken. */
export type Rij = {
  stripeKlantId: string | null;
  stripeAbonnementId: string | null;
  plan: Plan | null;
  /** De stand bij Stripe: trialing, active, past_due, canceled, unpaid, incomplete, ... */
  status: string | null;
  live: boolean;
  /** Het einde van de proefperiode bij Stripe, als het abonnement met een proef begon. */
  proefTot: Date | null;
  /** Tot wanneer de huidige periode betaald is (of loopt). */
  periodeTot: Date | null;
  /** Opgezegd: het abonnement stopt op deze datum. */
  stoptOp: Date | null;
  /** Gebruikt de app zonder abonnement (bijvoorbeeld Jona zelf). */
  vrijgesteld: boolean;
  /** Door de platformbeheerder verlengde proef: telt als hij later valt dan de gewone proefdagen. */
  proefVerlengdTot: Date | null;
};

export type Stand =
  | { soort: "uit"; toegang: true }
  | { soort: "vrij"; toegang: true }
  | { soort: "abonnement"; toegang: true; plan: Plan | null; status: string; proefTot: Date | null; periodeTot: Date | null; stoptOp: Date | null; klantId: string | null }
  | { soort: "proef"; toegang: true; proefTot: Date; dagenOver: number; klantId: string | null }
  | { soort: "verlopen"; toegang: false; proefTot: Date; status: string | null; klantId: string | null };

/** De velden van de rij die de stand bepalen; een app mag een rij met meer kolommen meegeven. */
type RijVoorStand = Pick<Rij, "stripeKlantId" | "plan" | "status" | "proefTot" | "periodeTot" | "stoptOp" | "vrijgesteld"> & { proefVerlengdTot?: Date | null };

export function bepaalStand(invoer: { aan: boolean; aangemaaktOp: Date; rij: RijVoorStand | null; nu?: Date }): Stand {
  const nu = invoer.nu ?? new Date();
  const { rij } = invoer;
  if (!invoer.aan) return { soort: "uit", toegang: true };
  if (rij?.vrijgesteld) return { soort: "vrij", toegang: true };
  if (rij?.status && MET_TOEGANG.has(rij.status)) {
    return { soort: "abonnement", toegang: true, plan: rij.plan, status: rij.status, proefTot: rij.proefTot, periodeTot: rij.periodeTot, stoptOp: rij.stoptOp, klantId: rij.stripeKlantId };
  }
  const gewoon = new Date(invoer.aangemaaktOp.getTime() + PROEFDAGEN * DAG);
  // De platformbeheerder kan de proef verlengen; korter maken kan niet.
  const proefTot = rij?.proefVerlengdTot && rij.proefVerlengdTot > gewoon ? rij.proefVerlengdTot : gewoon;
  const klantId = rij?.stripeKlantId ?? null;
  if (nu < proefTot) return { soort: "proef", toegang: true, proefTot, dagenOver: Math.max(1, Math.ceil((proefTot.getTime() - nu.getTime()) / DAG)), klantId };
  return { soort: "verlopen", toegang: false, proefTot, status: rij?.status ?? null, klantId };
}
