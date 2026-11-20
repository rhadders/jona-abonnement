import { createHmac, timingSafeEqual } from "node:crypto";

/** Wat Stripe teruggeeft, voordat de app weet wat erin staat. */
export type Rauw = Record<string, unknown>;

/** Een niet-lege tekst uit een antwoord, of null. */
export const tekst = (waarde: unknown) => (typeof waarde === "string" && waarde.trim() ? waarde.trim() : null);

/** Een object uit een antwoord (geen lijst), of null. */
export const object = (waarde: unknown): Rauw | null => (waarde && typeof waarde === "object" && !Array.isArray(waarde) ? (waarde as Rauw) : null);

export const isAbonnementId = (id: unknown): id is string => typeof id === "string" && /^sub_[A-Za-z0-9]{8,80}$/.test(id);
export const isKlantId = (id: unknown): id is string => typeof id === "string" && /^cus_[A-Za-z0-9]{8,80}$/.test(id);
export const isSessieId = (id: unknown): id is string => typeof id === "string" && /^cs_(test|live)_[A-Za-z0-9]{8,200}$/.test(id);

/**
 * Controleert de handtekening van een melding (kop Stripe-Signature) met het
 * geheim van het meldadres. Een melding ouder dan vijf minuten telt niet,
 * zodat een opgevangen melding niet opnieuw kan worden afgespeeld.
 */
export function klopHandtekening(lichaam: string, kop: string | null, geheim: string, nu = Date.now()): boolean {
  if (!kop || !geheim) return false;
  let tijd: number | null = null;
  const handtekeningen: string[] = [];
  for (const deel of kop.split(",")) {
    const [sleutel, waarde] = deel.split("=", 2).map((s) => s?.trim());
    if (sleutel === "t" && waarde && /^\d+$/.test(waarde)) tijd = Number(waarde);
    if (sleutel === "v1" && waarde && /^[0-9a-f]{64}$/.test(waarde)) handtekeningen.push(waarde);
  }
  if (tijd === null || handtekeningen.length === 0) return false;
  if (Math.abs(nu / 1000 - tijd) > 300) return false;
  const verwacht = createHmac("sha256", geheim).update(`${tijd}.${lichaam}`).digest();
  return handtekeningen.some((h) => {
    const gegeven = Buffer.from(h, "hex");
    return gegeven.length === verwacht.length && timingSafeEqual(gegeven, verwacht);
  });
}

/** Uit een (gecontroleerde) melding: over welk abonnement gaat het? */
export function abonnementUitMelding(melding: unknown): string | null {
  const m = object(melding);
  const onderwerp = object(object(m?.data)?.object);
  if (!onderwerp) return null;
  if (onderwerp.object === "subscription") return isAbonnementId(onderwerp.id) ? onderwerp.id : null;
  if (onderwerp.object === "checkout.session" || onderwerp.object === "invoice") {
    const id = typeof onderwerp.subscription === "string" ? onderwerp.subscription : tekst(object(onderwerp.subscription)?.id);
    if (isAbonnementId(id)) return id;
    // Nieuwere API-versies zetten het abonnement van een factuur bij parent.subscription_details.
    const via = tekst(object(object(onderwerp.parent)?.subscription_details)?.subscription);
    return isAbonnementId(via) ? via : null;
  }
  return null;
}
