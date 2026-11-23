/**
 * De talen van de meldingen en van de pagina's bij Stripe. Nederlands is
 * de standaard: een app die geen taal meegeeft, krijgt alles in het
 * Nederlands, zoals voorheen. Engels is Brits, Duits spreekt met "du".
 */
export const TALEN = ["nl", "en", "de"] as const;
export type Taal = (typeof TALEN)[number];
export const STANDAARDTAAL: Taal = "nl";

export function isTaal(waarde: unknown): waarde is Taal {
  return typeof waarde === "string" && (TALEN as readonly string[]).includes(waarde);
}

/** De taal uit wat een app aanlevert; alles wat geen bekende taal is, wordt Nederlands. */
export const leesTaal = (waarde: unknown): Taal => (isTaal(waarde) ? waarde : STANDAARDTAAL);
