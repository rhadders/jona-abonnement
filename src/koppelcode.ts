import { createHash, randomInt } from "node:crypto";

/**
 * De koppelcode waarmee een organisatie in de ene app van Jona wordt gekoppeld
 * aan de klant die zij in een andere app al is.
 *
 * De klant bij Jona is de organisatie, niet de persoon: de secretaris in de
 * ene app heeft meestal een ander e-mailadres dan de penningmeester in de
 * andere. Daarom maakt een beheerder in de app waar al een abonnement loopt
 * een code, en vult een beheerder in de andere app die in.
 *
 * De apps praten niet rechtstreeks met elkaar. De code staat als SHA-256-hash
 * in de metadata van de Stripe-klant (zie `KOPPEL` in namen.ts), met een
 * verloopmoment. Een code heeft 12 tekens uit het alfabet van Crockford:
 * ongeveer 60 bits, dus raden is kansloos.
 *
 * Alles in dit bestand moet in elke app precies gelijk zijn: anders werkt een
 * code uit de ene app niet in de andere.
 */

const TEKENS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const LENGTE = 12;

/** Een nieuwe code, als JONA-XXXX-XXXX-XXXX. */
export function nieuweKoppelcode(): string {
  const tekens = Array.from({ length: LENGTE }, () => TEKENS[randomInt(TEKENS.length)]).join("");
  return `JONA-${tekens.slice(0, 4)}-${tekens.slice(4, 8)}-${tekens.slice(8)}`;
}

/**
 * De code zoals iemand hem invult, terug naar de 12 tekens: hoofdletters,
 * zonder spaties, streepjes en het voorvoegsel JONA, met O als 0 en I of L
 * als 1. `null` als het geen code kan zijn.
 */
export function normaliseerKoppelcode(invoer: unknown): string | null {
  if (typeof invoer !== "string" || invoer.length > 60) return null;
  let tekens = invoer.toUpperCase().replace(/[^0-9A-Z]/g, "");
  if (tekens.length === LENGTE + 4 && tekens.startsWith("JONA")) tekens = tekens.slice(4);
  tekens = tekens.replace(/O/g, "0").replace(/[IL]/g, "1");
  if (tekens.length !== LENGTE || [...tekens].some((t) => !TEKENS.includes(t))) return null;
  return tekens;
}

/** De hash die bij de klant staat. */
export const hashKoppelcode = (tekens: string) => createHash("sha256").update(`jona-koppelcode:${tekens}`).digest("hex");
