/**
 * De namen waarmee een app haar eigen spullen bij Stripe terugvindt. Alle apps
 * van Jona delen één Stripe-account; elke app heeft daarin een eigen product,
 * eigen prijzen, een eigen btw-tarief en een eigen instelling van het
 * klantportaal.
 *
 * Verander hier nooit iets aan zonder de namentest: een app die haar product
 * of prijs niet terugvindt, maakt ze opnieuw aan, en dan staan ze dubbel.
 */

export const PLANNEN = ["jaar", "maand"] as const;
export type Plan = (typeof PLANNEN)[number];

/** De prijs van elke app, in centen en inclusief btw, tenzij de app zelf iets anders opgeeft. */
export const PRIJZEN: Record<Plan, number> = { jaar: 11940, maand: 1295 };

/**
 * De bundelkorting: wie al een lopend abonnement heeft op een andere app van
 * Jona, krijgt dit percentage korting op dit abonnement, zolang het loopt. De
 * coupon is van alle apps van Jona samen en heeft daarom een vast id.
 */
export const BUNDELKORTING = 15;
export const BUNDEL_COUPON = `jona_bundel_${BUNDELKORTING}`;

/** Waaraan de apps elkaars producten herkennen. */
export const JONA_VOORVOEGSEL = "jona_";

export type Planinstelling = { lookupKey: string; centen: number; interval: "year" | "month"; naam: string; eenmalig: string };

export type Namen = {
  /** Het id van het product bij Stripe. */
  product: string;
  /** De sleutel in de metadata van het btw-tarief en van het klantportaal. */
  metadata: string;
  plannen: Record<Plan, Planinstelling>;
  /** Sleutels tegen dubbel aanmaken (Idempotency-Key). */
  eenmaligBtw: string;
  eenmaligPortaal: string;
};

/**
 * @param app  het korte woord van de app in kleine letters: "giften", "bestuur"
 * @param naam de naam op het scherm: "Jona Giften"
 */
export function namenVan(app: string, naam: string, prijzen: Record<Plan, number> = PRIJZEN): Namen {
  if (!/^[a-z][a-z0-9]{1,30}$/.test(app)) throw new Error(`Ongeldige naam voor de app: "${app}". Gebruik één woord in kleine letters, zoals "giften".`);
  const plan = (soort: Plan, interval: "year" | "month"): Planinstelling => {
    const lookupKey = `jona_${app}_${soort}`;
    return { lookupKey, centen: prijzen[soort], interval, naam: `${naam} per ${soort}`, eenmalig: `jona-${app}-prijs-${lookupKey}-${prijzen[soort]}` };
  };
  return {
    product: `jona_${app}_abonnement`,
    metadata: `jona_${app}`,
    plannen: { jaar: plan("jaar", "year"), maand: plan("maand", "month") },
    eenmaligBtw: `jona-${app}-btw-21`,
    eenmaligPortaal: `jona-${app}-portaal-1`,
  };
}
