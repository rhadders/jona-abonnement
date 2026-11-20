import { describe, expect, it } from "vitest";
import { BUNDEL_COUPON, namenVan, STRIPE_VERSIE } from "../src/index.js";

/**
 * De namentest. Elke naam hieronder staat zo bij Stripe, of stond letterlijk
 * zo in de code van de app voordat het pakket er was. Een app vindt haar
 * product, prijzen, btw-tarief en portaal op deze namen terug; verandert er
 * één teken, dan maakt zij ze opnieuw aan en staan ze dubbel.
 *
 * Deze test mag alleen veranderen als er een app bij komt.
 */
describe("de namen bij Stripe", () => {
  it("Jona Giften", () => {
    expect(namenVan("giften", "Jona Giften")).toEqual({
      product: "jona_giften_abonnement",
      metadata: "jona_giften",
      plannen: {
        jaar: { lookupKey: "jona_giften_jaar", centen: 11940, interval: "year", naam: "Jona Giften per jaar", eenmalig: "jona-giften-prijs-jona_giften_jaar-11940" },
        maand: { lookupKey: "jona_giften_maand", centen: 1295, interval: "month", naam: "Jona Giften per maand", eenmalig: "jona-giften-prijs-jona_giften_maand-1295" },
      },
      eenmaligBtw: "jona-giften-btw-21",
      eenmaligPortaal: "jona-giften-portaal-1",
    });
  });

  it("Jona Bestuur", () => {
    expect(namenVan("bestuur", "Jona Bestuur")).toEqual({
      product: "jona_bestuur_abonnement",
      metadata: "jona_bestuur",
      plannen: {
        jaar: { lookupKey: "jona_bestuur_jaar", centen: 11940, interval: "year", naam: "Jona Bestuur per jaar", eenmalig: "jona-bestuur-prijs-jona_bestuur_jaar-11940" },
        maand: { lookupKey: "jona_bestuur_maand", centen: 1295, interval: "month", naam: "Jona Bestuur per maand", eenmalig: "jona-bestuur-prijs-jona_bestuur_maand-1295" },
      },
      eenmaligBtw: "jona-bestuur-btw-21",
      eenmaligPortaal: "jona-bestuur-portaal-1",
    });
  });

  it("de coupon van de bundelkorting is van alle apps samen", () => {
    expect(BUNDEL_COUPON).toBe("jona_bundel_15");
  });

  it("de versie van de Stripe-API", () => {
    expect(STRIPE_VERSIE).toBe("2026-10-28.endive");
  });

  it("een eigen prijs komt in de prijs en in de sleutel tegen dubbel aanmaken, niet in de lookup key", () => {
    const namen = namenVan("giften", "Jona Giften", { jaar: 9900, maand: 995 });
    expect(namen.plannen.jaar).toMatchObject({ lookupKey: "jona_giften_jaar", centen: 9900, eenmalig: "jona-giften-prijs-jona_giften_jaar-9900" });
  });

  it("weigert een naam die bij Stripe iets anders zou opleveren", () => {
    for (const fout of ["Giften", "jona giften", "jona_giften", "", "g"]) expect(() => namenVan(fout, "Jona Giften")).toThrow();
  });
});
