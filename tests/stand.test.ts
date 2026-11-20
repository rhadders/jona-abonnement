import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { abonnementUitMelding, bepaalStand, klopHandtekening, leesKoppelcode, maakKoppelcode, type Rij } from "../src/index.js";

// Geen vaste geheimen in een openbare repository: elke run maakt zijn eigen.
const GEHEIM = randomBytes(24).toString("hex");

function onderteken(lichaam: string, tijd = Math.floor(Date.now() / 1000), geheim = GEHEIM) {
  return `t=${tijd},v1=${createHmac("sha256", geheim).update(`${tijd}.${lichaam}`).digest("hex")}`;
}

function melding(onderwerp: Record<string, unknown>) {
  return JSON.stringify({ id: "evt_test1234567890", type: "customer.subscription.updated", data: { object: onderwerp } });
}

describe("de stand zonder database", () => {
  const aangemaaktOp = new Date("2026-11-01T10:00:00Z");
  const rij = (velden: Partial<Rij>): Rij => ({ stripeKlantId: null, stripeAbonnementId: null, plan: null, status: null, live: false, proefTot: null, periodeTot: null, stoptOp: null, vrijgesteld: false, proefVerlengdTot: null, ...velden });

  it("staat uit zonder sleutel: iedereen heeft toegang", () => {
    expect(bepaalStand({ aan: false, aangemaaktOp, rij: null, nu: new Date("2027-01-01") })).toEqual({ soort: "uit", toegang: true });
  });

  it("geeft 14 dagen proef vanaf het aanmaken", () => {
    expect(bepaalStand({ aan: true, aangemaaktOp, rij: null, nu: new Date("2026-11-05T10:00:00Z") })).toMatchObject({ soort: "proef", toegang: true, dagenOver: 10 });
    expect(bepaalStand({ aan: true, aangemaaktOp, rij: null, nu: new Date("2026-11-15T09:59:00Z") })).toMatchObject({ soort: "proef", dagenOver: 1 });
    expect(bepaalStand({ aan: true, aangemaaktOp, rij: null, nu: new Date("2026-11-15T10:00:00Z") })).toMatchObject({ soort: "verlopen", toegang: false });
  });

  it("geeft toegang bij trialing, active en past_due, niet bij canceled of unpaid", () => {
    const nu = new Date("2026-12-31");
    for (const status of ["trialing", "active", "past_due"]) expect(bepaalStand({ aan: true, aangemaaktOp, rij: rij({ status }), nu }).toegang).toBe(true);
    for (const status of ["canceled", "unpaid", "incomplete_expired", "incomplete"]) expect(bepaalStand({ aan: true, aangemaaktOp, rij: rij({ status }), nu })).toMatchObject({ soort: "verlopen", toegang: false, status });
  });

  it("een gestopt abonnement gaat niet voor op de proef die nog loopt", () => {
    expect(bepaalStand({ aan: true, aangemaaktOp, rij: rij({ status: "canceled" }), nu: new Date("2026-11-03") })).toMatchObject({ soort: "proef" });
  });

  it("een vrijgestelde organisatie heeft altijd toegang", () => {
    expect(bepaalStand({ aan: true, aangemaaktOp, rij: rij({ vrijgesteld: true, status: "canceled" }), nu: new Date("2030-01-01") })).toEqual({ soort: "vrij", toegang: true });
  });

  it("een verlengde proef telt als hij later valt, en maakt de proef nooit korter", () => {
    const later = new Date("2026-12-01T10:00:00Z");
    expect(bepaalStand({ aan: true, aangemaaktOp, rij: rij({ proefVerlengdTot: later }), nu: new Date("2026-11-20") })).toMatchObject({ soort: "proef", proefTot: later });
    const eerder = new Date("2026-11-05T10:00:00Z");
    expect(bepaalStand({ aan: true, aangemaaktOp, rij: rij({ proefVerlengdTot: eerder }), nu: new Date("2026-11-10") })).toMatchObject({ soort: "proef", proefTot: new Date("2026-11-15T10:00:00Z") });
  });
});

describe("meldingen", () => {
  it("controleert de handtekening", () => {
    const lichaam = melding({ id: "sub_1234567890", object: "subscription" });
    expect(klopHandtekening(lichaam, onderteken(lichaam), GEHEIM)).toBe(true);
    expect(klopHandtekening(lichaam, onderteken(lichaam, undefined, "een ander geheim"), GEHEIM)).toBe(false);
    expect(klopHandtekening(lichaam + " ", onderteken(lichaam), GEHEIM)).toBe(false);
    expect(klopHandtekening(lichaam, onderteken(lichaam, Math.floor(Date.now() / 1000) - 600), GEHEIM)).toBe(false);
    expect(klopHandtekening(lichaam, null, GEHEIM)).toBe(false);
    expect(klopHandtekening(lichaam, "t=1,v1=zz", GEHEIM)).toBe(false);
    expect(klopHandtekening(lichaam, onderteken(lichaam), "")).toBe(false);
  });

  it("vindt het abonnement in een melding over een abonnement, sessie of factuur", () => {
    expect(abonnementUitMelding(JSON.parse(melding({ id: "sub_1234567890", object: "subscription" })))).toBe("sub_1234567890");
    expect(abonnementUitMelding(JSON.parse(melding({ id: "cs_x", object: "checkout.session", subscription: "sub_abcdefghij" })))).toBe("sub_abcdefghij");
    expect(abonnementUitMelding(JSON.parse(melding({ id: "in_x", object: "invoice", parent: { subscription_details: { subscription: "sub_viaparent12" } } })))).toBe("sub_viaparent12");
    expect(abonnementUitMelding(JSON.parse(melding({ id: "pi_x", object: "payment_intent" })))).toBeNull();
    expect(abonnementUitMelding("onzin")).toBeNull();
  });
});

describe("de koppelcode", () => {
  const ONDERTEKENING = randomBytes(32).toString("hex");
  const KLANT = "cus_gedeeld0001";

  it("klopt alleen voor de eigen organisatie, ongewijzigd en binnen 24 uur", () => {
    const nu = Date.now();
    const code = maakKoppelcode(ONDERTEKENING, "org_a", KLANT, nu);
    expect(leesKoppelcode(ONDERTEKENING, code, "org_a", nu)).toBe(KLANT);
    expect(leesKoppelcode(ONDERTEKENING, code, "org_b", nu)).toBeNull();
    expect(leesKoppelcode(ONDERTEKENING, code.replace(KLANT, "cus_iemandanders1"), "org_a", nu)).toBeNull();
    expect(leesKoppelcode(ONDERTEKENING, code, "org_a", nu + 25 * 3600_000)).toBeNull();
    expect(leesKoppelcode(ONDERTEKENING, "onzin", "org_a", nu)).toBeNull();
    expect(leesKoppelcode(ONDERTEKENING, undefined, "org_a", nu)).toBeNull();
  });

  it("klopt niet met een ander geheim, en kan niet zonder geheim", () => {
    const code = maakKoppelcode(ONDERTEKENING, "org_a", KLANT);
    expect(leesKoppelcode(randomBytes(32).toString("hex"), code, "org_a")).toBeNull();
    expect(() => maakKoppelcode("", "org_a", KLANT)).toThrow();
  });

  it("is dezelfde code als de apps maakten voordat het pakket er was", () => {
    // Zo ondertekenden Jona Giften en Jona Bestuur: een link die onderweg is, blijft na de overstap geldig.
    const tot = 1_800_000_000_000;
    const verwacht = createHmac("sha256", ONDERTEKENING).update(`abonnement-koppelen:org_a.${KLANT}.${tot}`).digest("base64url");
    expect(maakKoppelcode(ONDERTEKENING, "org_a", KLANT, tot - 24 * 3600_000)).toBe(`${KLANT}.${tot}.${verwacht}`);
  });
});
