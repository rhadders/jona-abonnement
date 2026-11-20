import { describe, expect, it } from "vitest";
import { hashKoppelcode, nieuweKoppelcode, normaliseerKoppelcode } from "../src/index.js";

describe("de koppelcode", () => {
  it("een nieuwe code is JONA en drie groepen van vier tekens, zonder I, L, O en U", () => {
    for (let i = 0; i < 50; i++) expect(nieuweKoppelcode()).toMatch(/^JONA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(nieuweKoppelcode()).not.toBe(nieuweKoppelcode());
  });

  it("een code leest ook met kleine letters, spaties, zonder JONA en met O voor 0", () => {
    expect(normaliseerKoppelcode("JONA-0A1B-2C3D-4E5F")).toBe("0A1B2C3D4E5F");
    expect(normaliseerKoppelcode("oa1b 2c3d 4e5f")).toBe("0A1B2C3D4E5F");
    expect(normaliseerKoppelcode("jona oaib2c3d4e5f")).toBe("0A1B2C3D4E5F");
    expect(normaliseerKoppelcode("0A1B-2C3D")).toBeNull();
    expect(normaliseerKoppelcode("JONA-0A1B-2C3D-4E5U")).toBeNull();
    expect(normaliseerKoppelcode("x".repeat(61))).toBeNull();
    expect(normaliseerKoppelcode(undefined)).toBeNull();
  });

  it("dezelfde code geeft in elke app dezelfde hash", () => {
    // Vast voorbeeld, gelijk aan de test in de apps van voor het pakket: verandert dit, dan werken codes tussen de apps niet meer.
    expect(hashKoppelcode("0A1B2C3D4E5F")).toBe("4e1ee95464059f7fb3464ce07d2ef44db08a8676904f688fa8b0ed6ace8be5ed");
  });
});
