import { createHmac, timingSafeEqual } from "node:crypto";
import { isKlantId } from "./meldingen.js";

/**
 * De code in de link waarmee een organisatie wordt gekoppeld aan een klant die
 * al bestaat bij Jona: de klant en het verloopmoment, ondertekend samen met
 * de organisatie. De code klopt dus alleen voor de organisatie waarvoor hij is
 * aangevraagd, en er is geen tabel voor nodig.
 */

const GELDIG = 24 * 3600_000;

function teken(inhoud: string, geheim: string): string {
  if (!geheim) throw new Error("Het geheim voor de koppelcode ontbreekt (BETTER_AUTH_SECRET).");
  return createHmac("sha256", geheim).update(`abonnement-koppelen:${inhoud}`).digest("base64url");
}

export function maakKoppelcode(geheim: string, organisatieId: string, klantId: string, nu = Date.now()): string {
  const inhoud = `${klantId}.${nu + GELDIG}`;
  return `${inhoud}.${teken(`${organisatieId}.${inhoud}`, geheim)}`;
}

/** De klant uit een code, of `null` als de code niet klopt, verlopen is of bij een andere organisatie hoort. */
export function leesKoppelcode(geheim: string, code: unknown, organisatieId: string, nu = Date.now()): string | null {
  if (typeof code !== "string" || code.length > 300) return null;
  const delen = code.split(".");
  if (delen.length !== 3) return null;
  const [klantId, tot, handtekening] = delen as [string, string, string];
  if (!isKlantId(klantId) || !/^\d{10,16}$/.test(tot)) return null;
  const verwacht = Buffer.from(teken(`${organisatieId}.${klantId}.${tot}`, geheim));
  const gegeven = Buffer.from(handtekening);
  if (gegeven.length !== verwacht.length || !timingSafeEqual(gegeven, verwacht)) return null;
  return Number(tot) > nu ? klantId : null;
}
