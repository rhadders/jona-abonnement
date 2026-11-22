import { describe, expect, it } from "vitest";
import { appNaam, foutIn, FOUTEN, leesTaal, TALEN, type Foutcode } from "../src/index.js";

describe("talen", () => {
  it("heeft elke foutmelding in elke taal", () => {
    for (const taal of TALEN) for (const code of Object.keys(FOUTEN) as Foutcode[]) expect(foutIn(code, taal).length).toBeGreaterThan(10);
    expect(foutIn("geen_abonnement", "en")).toBe("There's no subscription yet.");
    expect(foutIn("geen_abonnement", "de")).toBe("Es gibt noch kein Abonnement.");
    expect(foutIn("geen_abonnement", "fr")).toBe(FOUTEN.geen_abonnement);
  });

  it("noemt een onbekende app in de taal van het scherm", () => {
    expect(appNaam("giften", "en")).toBe("Jona Giften");
    expect(appNaam(null)).toBe("een andere app van Jona");
    expect(appNaam("onbekend", "en")).toBe("another Jona app");
    expect(appNaam(null, "de")).toBe("eine andere App von Jona");
  });

  it("valt terug op Nederlands", () => {
    expect(leesTaal("en")).toBe("en");
    expect(leesTaal("EN")).toBe("nl");
    expect(leesTaal(null)).toBe("nl");
  });
});
