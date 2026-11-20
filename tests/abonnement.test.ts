import { createHmac, randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { maakAbonnement, STRIPE_VERSIE, SYSTEEM, type Koppelmail } from "../src/index.js";
import { maakGeheugenopslag } from "./hulp/opslag.js";
import { maakNepStripe } from "./hulp/stripe.js";

// Geen vaste geheimen in een openbare repository: elke run maakt zijn eigen.
const GEHEIM = randomBytes(24).toString("hex");
const NEPSLEUTEL = `nep-${randomBytes(12).toString("hex")}`;
const DAG = 24 * 3600_000;

function onderteken(lichaam: string, tijd = Math.floor(Date.now() / 1000), geheim = GEHEIM) {
  return `t=${tijd},v1=${createHmac("sha256", geheim).update(`${tijd}.${lichaam}`).digest("hex")}`;
}

function melding(onderwerp: Record<string, unknown>, soort = "customer.subscription.updated") {
  return JSON.stringify({ id: "evt_test1234567890", type: soort, data: { object: onderwerp } });
}

/**
 * De hele reeks draait voor beide bestaande apps: zo is bewezen dat het pakket
 * voor elk dezelfde namen gebruikt als hun eigen code deed. De tests binnen
 * een reeks bouwen op elkaar voort, zoals een organisatie die de proef
 * doorloopt, een abonnement neemt en weer opzegt.
 */
describe.each([
  { app: "giften", naam: "Jona Giften", omschrijving: "Giftenadministratie voor kerken en stichtingen", herkomst: "https://jonagiften.nl", andereApp: "jona_bestuur_abonnement" },
  { app: "bestuur", naam: "Jona Bestuur", omschrijving: "Vergaderen, notuleren en besluiten voor besturen", herkomst: "https://jonabestuur.nl", andereApp: "jona_giften_abonnement" },
])("het abonnement op $naam", ({ app, naam, omschrijving, herkomst, andereApp }) => {
  const NIEUW = "org_nieuw"; // vandaag aangemaakt: in de proef
  const OUD = "org_oud"; // 20 dagen geleden: proef voorbij
  const ANDER = "org_ander";
  const KOPPEL = "org_koppel";
  const KLANT = "cus_gedeeld0001";
  const GEBRUIKER = "gebruiker_1";
  const email = "penningmeester@koppel.test";

  const nep = maakNepStripe(app);
  const stripe = nep.stand;
  const geheugen = maakGeheugenopslag();
  const omgeving: Record<string, string | undefined> = {};
  const mails: Koppelmail[] = [];
  const fouten: string[] = [];
  let mailAan = true;
  let mailLukt = true;

  const abonnement = maakAbonnement({
    app,
    naam,
    omschrijving,
    omgeving: () => omgeving,
    opslag: geheugen.opslag,
    mailIngesteld: () => mailAan,
    stuurKoppelmail: async (mail) => {
      if (mailLukt) mails.push(mail);
      return mailLukt;
    },
    logFout: (bericht) => void fouten.push(bericht),
  });
  const start = (organisatieId: string, plan: "jaar" | "maand", adres = "pen@voorbeeld.test") => abonnement.startAbonnement({ organisatieId, namens: GEBRUIKER, organisatieNaam: "Stichting Voorbeeld", email: adres, plan, herkomst });
  const meld = (lichaam: string, handtekening: string | null = onderteken(lichaam)) => abonnement.verwerkMelding(lichaam, handtekening);

  beforeAll(async () => {
    omgeving.STRIPE_API_URL = await nep.start();
    omgeving.ABONNEMENT_STRIPE_SECRET_KEY = NEPSLEUTEL;
    omgeving.ABONNEMENT_STRIPE_WEBHOOK_SECRET = GEHEIM;
    omgeving.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
    geheugen.organisatie(NIEUW);
    geheugen.organisatie(OUD, 20);
    geheugen.organisatie(ANDER, 20);
    geheugen.organisatie(KOPPEL);
  });

  afterAll(() => nep.stop());

  beforeEach(() => {
    stripe.verzoeken = [];
  });

  describe("afrekenen en vastleggen", () => {
    it("een nieuwe organisatie zit in de proef, een onbekende heeft geen toegang", async () => {
      expect(await abonnement.haalStand(NIEUW)).toMatchObject({ soort: "proef", toegang: true, dagenOver: 14 });
      expect(await abonnement.haalStand(OUD)).toMatchObject({ soort: "verlopen", toegang: false, status: null });
      expect(await abonnement.haalStand("bestaat_niet")).toMatchObject({ soort: "verlopen", toegang: false });
    });

    it("richt het product, de prijzen inclusief btw en het btw-tarief één keer in", async () => {
      expect(await start(NIEUW, "jaar", "pen@nieuw.test")).toEqual({ ok: true, adres: "https://checkout.stripe.com/c/pay/1" });
      expect(Object.fromEntries(stripe.product!)).toEqual({ id: `jona_${app}_abonnement`, name: naam, description: omschrijving });
      expect([...stripe.prijzen.values()].map((p) => [p.lookup_key, p.unit_amount, p.interval, p.tax_behavior]).sort()).toEqual([
        [`jona_${app}_jaar`, 11940, "year", "inclusive"],
        [`jona_${app}_maand`, 1295, "month", "inclusive"],
      ]);
      expect(stripe.btw).toEqual(["txr_btw21"]);
      expect(stripe.sleutels).toEqual(new Set([`Bearer ${NEPSLEUTEL}`]));
      expect(stripe.versies).toEqual(new Set([STRIPE_VERSIE]));
      expect(stripe.eenmalig.sort()).toEqual([`jona-${app}-btw-21`, `jona-${app}-prijs-jona_${app}_jaar-11940`, `jona-${app}-prijs-jona_${app}_maand-1295`]);

      // Een tweede keer, ook na het vergeten van wat de app al wist: niets dubbel.
      abonnement.vergeet();
      stripe.verzoeken = [];
      await start(NIEUW, "maand", "pen@nieuw.test");
      expect(stripe.prijzen.size).toBe(2);
      expect(stripe.btw).toHaveLength(1);
      expect(stripe.verzoeken.filter((v) => v === "POST /v1/prices" || v === "POST /v1/products" || v === "POST /v1/tax_rates")).toEqual([]);
    });

    it("de betaalpagina hoort bij de organisatie en schuift de eerste betaling tot na de proef", () => {
      const [jaar, maand] = stripe.sessies as [URLSearchParams, URLSearchParams];
      expect(jaar.get("mode")).toBe("subscription");
      expect(jaar.get("line_items[0][price]")).toBe(`price_jona_${app}_jaar`);
      expect(maand.get("line_items[0][price]")).toBe(`price_jona_${app}_maand`);
      expect(jaar.get("line_items[0][tax_rates][0]")).toBe("txr_btw21");
      expect(jaar.get("client_reference_id")).toBe(NIEUW);
      expect(jaar.get("subscription_data[metadata][organisatie_id]")).toBe(NIEUW);
      expect(jaar.get("subscription_data[description]")).toBe(`${naam} voor Stichting Voorbeeld`);
      expect(jaar.get("customer_email")).toBe("pen@nieuw.test");
      expect(jaar.get("success_url")).toBe(`${herkomst}/abonnement?sessie={CHECKOUT_SESSION_ID}`);
      expect(jaar.get("cancel_url")).toBe(`${herkomst}/abonnement`);
      const proefEinde = Number(jaar.get("subscription_data[trial_end]")) * 1000;
      expect(Math.abs(proefEinde - (Date.now() + 14 * DAG))).toBeLessThan(60_000);
    });

    it("na de proef begint een abonnement direct", async () => {
      expect((await start(OUD, "maand")).ok).toBe(true);
      expect(stripe.sessies.at(-1)!.get("subscription_data[trial_end]")).toBeNull();
    });

    it("zonder btw-tarief als ABONNEMENT_BTW uit staat", async () => {
      omgeving.ABONNEMENT_BTW = "uit";
      abonnement.vergeet();
      expect((await start(OUD, "maand")).ok).toBe(true);
      expect(stripe.sessies.at(-1)!.get("line_items[0][tax_rates][0]")).toBeNull();
      delete omgeving.ABONNEMENT_BTW;
      abonnement.vergeet();
    });

    it("legt bij terugkeer uit de betaalpagina het abonnement direct vast, namens de gebruiker", async () => {
      stripe.abonnementen.set("sub_oud0000001", { id: "sub_oud0000001", status: "active", organisatie: OUD, klant: "cus_oud0000001", interval: "month", trialEnd: null, periodeEind: Math.floor((Date.now() + 30 * DAG) / 1000), cancelAtPeriodEnd: false });
      stripe.afrekeningen.set("cs_test_terugkeer000001", { client_reference_id: OUD, subscription: "sub_oud0000001" });
      // Een sessie van een andere organisatie doet niets.
      await abonnement.verwerkTerugkeer({ organisatieId: ANDER, namens: GEBRUIKER, sessieId: "cs_test_terugkeer000001" });
      expect(await abonnement.haalStand(ANDER)).toMatchObject({ soort: "verlopen" });
      await abonnement.verwerkTerugkeer({ organisatieId: OUD, namens: GEBRUIKER, sessieId: "cs_test_terugkeer000001" });
      expect(await abonnement.haalStand(OUD)).toMatchObject({ soort: "abonnement", toegang: true, plan: "maand", status: "active", klantId: "cus_oud0000001" });
      // Een sessie-id dat er niet uitziet als een sessie gaat niet naar Stripe.
      stripe.verzoeken = [];
      await abonnement.verwerkTerugkeer({ organisatieId: OUD, sessieId: "../subscriptions/sub_oud0000001" });
      expect(stripe.verzoeken).toEqual([]);
    });

    it("met een lopend abonnement opent kiezen het klantportaal in plaats van een tweede abonnement", async () => {
      const aantal = stripe.sessies.length;
      expect(await start(OUD, "jaar")).toEqual({ ok: true, adres: "https://billing.stripe.com/p/session/cus_oud0000001" });
      expect(stripe.sessies).toHaveLength(aantal);
      expect(stripe.portalen).toHaveLength(1);
      const portaal = stripe.portalen[0]!;
      expect(portaal.get(`metadata[jona_${app}]`)).toBe("abonnement");
      expect(portaal.get("business_profile[headline]")).toBe(`${naam}: uw abonnement`);
      expect(portaal.get("features[subscription_update][products][0][product]")).toBe(`jona_${app}_abonnement`);
      expect(portaal.get("features[subscription_cancel][mode]")).toBe("at_period_end");
      expect(stripe.eenmalig).toContain(`jona-${app}-portaal-1`);
      // Een tweede keer: het portaal wordt teruggevonden, niet opnieuw aangemaakt.
      abonnement.vergeet();
      expect((await abonnement.openPortaal({ organisatieId: OUD, namens: GEBRUIKER, herkomst })).ok).toBe(true);
      expect(stripe.portalen).toHaveLength(1);
    });

    it("zonder klant is er geen portaal", async () => {
      expect(await abonnement.openPortaal({ organisatieId: ANDER, herkomst })).toMatchObject({ ok: false, code: "geen_abonnement" });
    });

    it("verwerkt een ondertekende melding en haalt de stand zelf op", async () => {
      stripe.abonnementen.set("sub_nieuw00001", { id: "sub_nieuw00001", status: "trialing", organisatie: NIEUW, klant: "cus_nieuw00001", interval: "year", trialEnd: Math.floor((Date.now() + 13 * DAG) / 1000), periodeEind: Math.floor((Date.now() + 13 * DAG) / 1000), cancelAtPeriodEnd: false });
      // In de melding zelf staat 'active' en een andere organisatie; de app gelooft alleen wat zij zelf ophaalt.
      const lichaam = melding({ id: "sub_nieuw00001", object: "subscription", status: "active", metadata: { organisatie_id: ANDER } });
      expect(await meld(lichaam)).toBe("verwerkt");
      expect(await abonnement.haalStand(NIEUW)).toMatchObject({ soort: "abonnement", status: "trialing", plan: "jaar" });
      expect(await abonnement.haalStand(ANDER)).toMatchObject({ soort: "verlopen" });
    });

    it("weigert een melding met een verkeerde handtekening, en een melding die geen JSON is", async () => {
      const lichaam = melding({ id: "sub_nieuw00001", object: "subscription" });
      expect(await meld(lichaam, onderteken(lichaam, undefined, "een ander geheim"))).toBe("geweigerd");
      expect(await meld(lichaam, null)).toBe("geweigerd");
      expect(await meld("geen json")).toBe("geweigerd");
      expect(stripe.verzoeken).toEqual([]);
    });

    it("negeert een melding die niet over een abonnement gaat of over een onbekend abonnement", async () => {
      expect(await meld(melding({ id: "pi_x", object: "payment_intent" }))).toBe("genegeerd");
      expect(await meld(melding({ id: "sub_bestaatniet1", object: "subscription" }))).toBe("genegeerd");
    });

    it("opzeggen en stoppen: toegang tot het einde, daarna niet meer", async () => {
      const a = stripe.abonnementen.get("sub_oud0000001")!;
      a.cancelAtPeriodEnd = true;
      expect(await meld(melding({ id: a.id, object: "subscription" }))).toBe("verwerkt");
      const opgezegd = await abonnement.haalStand(OUD);
      expect(opgezegd).toMatchObject({ soort: "abonnement", toegang: true });
      expect(opgezegd.soort === "abonnement" && opgezegd.stoptOp).toBeInstanceOf(Date);

      a.status = "canceled";
      expect(await meld(melding({ id: a.id, object: "subscription" }, "customer.subscription.deleted"))).toBe("verwerkt");
      expect(await abonnement.haalStand(OUD)).toMatchObject({ soort: "verlopen", toegang: false, status: "canceled", klantId: "cus_oud0000001" });
    });

    it("een oud, gestopt abonnement overschrijft geen lopend ander abonnement", async () => {
      stripe.abonnementen.set("sub_ander00001", { id: "sub_ander00001", status: "active", organisatie: ANDER, klant: "cus_ander00001", interval: "year", trialEnd: null, periodeEind: Math.floor((Date.now() + 300 * DAG) / 1000), cancelAtPeriodEnd: false });
      stripe.abonnementen.set("sub_ander00002", { id: "sub_ander00002", status: "canceled", organisatie: ANDER, klant: "cus_ander00001", interval: "month", trialEnd: null, periodeEind: Math.floor(Date.now() / 1000), cancelAtPeriodEnd: false });
      for (const id of ["sub_ander00001", "sub_ander00002"]) await meld(melding({ id, object: "subscription" }));
      expect(await abonnement.haalStand(ANDER)).toMatchObject({ soort: "abonnement", status: "active", plan: "jaar" });
    });

    it("negeert een abonnement zonder of met een onbekende organisatie", async () => {
      const basis = { klantId: null, eigenProduct: true, plan: "jaar" as const, status: "active", live: false, proefTot: null, periodeTot: null, stoptOp: null };
      expect(await abonnement.legVast({ id: "sub_zonder0001", organisatieId: null, ...basis })).toBe("genegeerd");
      expect(await abonnement.legVast({ id: "sub_zonder0002", organisatieId: "bestaat_niet", ...basis })).toBe("genegeerd");
      expect(await abonnement.legVast({ id: "sub_zonder0003", organisatieId: NIEUW, ...basis }, ANDER)).toBe("genegeerd");
    });

    it("negeert een abonnement op een andere app in hetzelfde Stripe-account", async () => {
      // Zelfs met een organisatie die hier bestaat: het product beslist, niet de metadata.
      stripe.abonnementen.set("sub_vreemd0001", { id: "sub_vreemd0001", status: "active", organisatie: OUD, klant: "cus_oud0000001", interval: "year", trialEnd: null, periodeEind: Math.floor((Date.now() + 300 * DAG) / 1000), cancelAtPeriodEnd: false, product: andereApp });
      expect(await meld(melding({ id: "sub_vreemd0001", object: "subscription" }))).toBe("genegeerd");
      expect(await abonnement.haalStand(OUD)).toMatchObject({ soort: "verlopen", toegang: false, status: "canceled" });
    });

    it("de nachtelijke taak haalt de stand opnieuw op, als SYSTEEM", async () => {
      stripe.abonnementen.get("sub_ander00001")!.status = "past_due";
      geheugen.gelezenNamens.length = 0;
      expect(await abonnement.werkBij(ANDER)).toBe(true);
      expect(geheugen.gelezenNamens).toEqual([SYSTEEM]);
      expect(await abonnement.haalStand(ANDER)).toMatchObject({ soort: "abonnement", status: "past_due", toegang: true });
      // Een gestopt abonnement wordt niet meer nagelopen, een organisatie zonder abonnement ook niet.
      expect(await abonnement.werkBij(OUD)).toBe(false);
      expect(await abonnement.werkBij(KOPPEL)).toBe(false);
    });

    it("een vrijstelling en een verlengde proef van de app blijven staan als het pakket schrijft", async () => {
      geheugen.organisatie("org_vrij", 30);
      geheugen.zet("org_vrij", { vrijgesteld: true, proefVerlengdTot: new Date("2027-01-01") });
      stripe.abonnementen.set("sub_vrij000001", { id: "sub_vrij000001", status: "canceled", organisatie: "org_vrij", klant: "cus_vrij000001", interval: "year", trialEnd: null, periodeEind: Math.floor(Date.now() / 1000), cancelAtPeriodEnd: false });
      expect(await meld(melding({ id: "sub_vrij000001", object: "subscription" }))).toBe("verwerkt");
      expect(geheugen.rijen.get("org_vrij")).toMatchObject({ vrijgesteld: true, proefVerlengdTot: new Date("2027-01-01"), status: "canceled" });
      expect(await abonnement.haalStand("org_vrij")).toEqual({ soort: "vrij", toegang: true });
    });
  });

  describe("het meldadres", () => {
    const verzoek = (lichaam: string, koppen: Record<string, string> = {}) => new Request("https://voorbeeld.test/api/abonnement/stripe", { method: "POST", body: lichaam, headers: { "stripe-signature": onderteken(lichaam), ...koppen } });

    it("geeft 200 bij een verwerkte of genegeerde melding en 400 bij een verkeerde handtekening", async () => {
      expect((await abonnement.ontvangMelding(verzoek(melding({ id: "sub_ander00001", object: "subscription" })))).status).toBe(200);
      expect((await abonnement.ontvangMelding(verzoek(melding({ id: "pi_x", object: "payment_intent" })))).status).toBe(200);
      expect((await abonnement.ontvangMelding(verzoek(melding({ id: "sub_ander00001", object: "subscription" }), { "stripe-signature": "t=1,v1=zz" }))).status).toBe(400);
    });

    it("geeft 413 bij een te groot verzoek, zonder het te verwerken", async () => {
      expect((await abonnement.ontvangMelding(verzoek("x".repeat(500_001)))).status).toBe(413);
      expect((await abonnement.ontvangMelding(verzoek("{}", { "content-length": "600000" }))).status).toBe(413);
    });

    it("geeft 503 als Stripe niet bereikbaar is, zodat Stripe het opnieuw probeert", async () => {
      const echt = omgeving.STRIPE_API_URL;
      omgeving.STRIPE_API_URL = "http://127.0.0.1:1";
      expect((await abonnement.ontvangMelding(verzoek(melding({ id: "sub_ander00001", object: "subscription" })))).status).toBe(503);
      omgeving.STRIPE_API_URL = echt;
    });
  });

  describe("koppelen aan een bestaande klant bij Jona", () => {
    const vraag = () => abonnement.vraagKoppelingAan({ organisatieId: KOPPEL, namens: GEBRUIKER, organisatieNaam: "Stichting Koppel", email, herkomst });

    it("stuurt niets als er geen klant met dit adres is, met hetzelfde antwoord", async () => {
      expect(await vraag()).toEqual({ ok: true });
      expect(mails).toHaveLength(0);
    });

    it("een klant met alleen een abonnement op deze app zelf, of een gestopt abonnement elders, telt niet", async () => {
      stripe.klanten = [
        { id: "cus_alleenhier01", email, abonnementen: [{ status: "active", product: `jona_${app}_abonnement` }] },
        { id: "cus_gestopt00001", email, abonnementen: [{ status: "canceled", product: andereApp }] },
        { id: "cus_vreemdprod01", email, abonnementen: [{ status: "active", product: "prod_ietsanders" }] },
        { id: KLANT, email: "iemand@anders.test", abonnementen: [{ status: "active", product: andereApp }] },
      ];
      expect(await vraag()).toEqual({ ok: true });
      expect(mails).toHaveLength(0);
    });

    it("mislukt het versturen, dan is het antwoord hetzelfde en mag een volgende poging meteen", async () => {
      stripe.klanten.push({ id: KLANT, email, abonnementen: [{ status: "active", product: andereApp }] });
      mailLukt = false;
      expect(await vraag()).toEqual({ ok: true });
      mailLukt = true;
      expect(mails).toHaveLength(0);
    });

    it("stuurt een link als het adres al klant is bij een andere app van Jona, hooguit één per uur", async () => {
      expect(await vraag()).toEqual({ ok: true });
      expect(await vraag()).toEqual({ ok: true });
      expect(mails).toHaveLength(1);
      expect(mails[0]).toMatchObject({ organisatieId: KOPPEL, namens: GEBRUIKER, organisatieNaam: "Stichting Koppel", email });
      expect(mails[0]!.adres.startsWith(`${herkomst}/abonnement/koppelen?code=`)).toBe(true);
      expect(abonnement.leesKoppelcode(new URL(mails[0]!.adres).searchParams.get("code"), KOPPEL)).toBe(KLANT);
    });

    it("zonder e-mailinstelling kan koppelen niet", async () => {
      mailAan = false;
      expect(abonnement.koppelenKan()).toBe(false);
      expect(await vraag()).toMatchObject({ ok: false, code: "koppelen_kan_niet" });
      mailAan = true;
    });

    it("zonder gekoppelde klant geen bundelkorting, wel een veld voor een kortingscode", async () => {
      expect((await start(KOPPEL, "jaar", email)).ok).toBe(true);
      const sessie = stripe.sessies.at(-1)!;
      expect(sessie.get("allow_promotion_codes")).toBe("true");
      expect(sessie.get("discounts[0][coupon]")).toBeNull();
      expect(stripe.couponsGemaakt).toBe(0);
    });

    it("weigert een code van een andere organisatie of een verlopen code", async () => {
      expect(await abonnement.bevestigKoppeling({ organisatieId: KOPPEL, namens: GEBRUIKER, code: abonnement.maakKoppelcode(ANDER, KLANT) })).toMatchObject({ ok: false, code: "koppellink_verlopen" });
      expect(await abonnement.bevestigKoppeling({ organisatieId: KOPPEL, namens: GEBRUIKER, code: abonnement.maakKoppelcode(KOPPEL, KLANT, Date.now() - 25 * 3600_000) })).toMatchObject({ ok: false });
      expect(await abonnement.haalStand(KOPPEL)).toMatchObject({ soort: "proef", klantId: null });
      expect(geheugen.logboek).toEqual([]);
    });

    it("na bevestigen komt het abonnement op de bestaande klant, met een regel in het auditlog", async () => {
      expect(await abonnement.bevestigKoppeling({ organisatieId: KOPPEL, namens: GEBRUIKER, code: abonnement.maakKoppelcode(KOPPEL, KLANT) })).toEqual({ ok: true });
      expect(geheugen.logboek).toEqual([{ organisatieId: KOPPEL, namens: GEBRUIKER, actie: "abonnement.klant_gekoppeld" }]);
      expect(await abonnement.haalStand(KOPPEL)).toMatchObject({ soort: "proef", klantId: KLANT });
      expect((await start(KOPPEL, "jaar", email)).ok).toBe(true);
      const sessie = stripe.sessies.at(-1)!;
      expect(sessie.get("customer")).toBe(KLANT);
      expect(sessie.get("customer_email")).toBeNull();
      // De klant heeft al een lopend abonnement op een andere app: 15% bundelkorting, en dan geen eigen kortingscode.
      expect(sessie.get("discounts[0][coupon]")).toBe("jona_bundel_15");
      expect(sessie.get("allow_promotion_codes")).toBeNull();
      // De coupon wordt één keer aangemaakt.
      expect((await start(KOPPEL, "jaar", email)).ok).toBe(true);
      expect(stripe.couponsGemaakt).toBe(1);
      // Loopt het andere abonnement niet meer, dan is er geen bundelkorting.
      for (const klant of stripe.klanten.filter((k) => k.id === KLANT)) klant.abonnementen[0]!.status = "canceled";
      expect((await start(KOPPEL, "jaar", email)).ok).toBe(true);
      expect(stripe.sessies.at(-1)!.get("discounts[0][coupon]")).toBeNull();
      expect(stripe.sessies.at(-1)!.get("allow_promotion_codes")).toBe("true");
      // Eenmaal gekoppeld vraagt de app geen tweede link meer aan.
      abonnement.vergeet();
      expect(await vraag()).toMatchObject({ ok: false, code: "organisatie_al_gekoppeld" });
    });

    it("koppelen kan niet meer als er al een abonnement loopt of een andere klant is", async () => {
      expect(await abonnement.bevestigKoppeling({ organisatieId: ANDER, code: abonnement.maakKoppelcode(ANDER, KLANT) })).toMatchObject({ ok: false, code: "abonnement_loopt_koppelen" });
      expect(await abonnement.haalStand(ANDER)).toMatchObject({ soort: "abonnement", klantId: "cus_ander00001" });
      expect(await abonnement.bevestigKoppeling({ organisatieId: OUD, code: abonnement.maakKoppelcode(OUD, KLANT) })).toMatchObject({ ok: false, code: "organisatie_heeft_klant" });
    });
  });

  describe("als er iets misgaat", () => {
    it("een fout van Stripe geeft een gewone zin op het scherm en de uitleg in het logboek", async () => {
      const echt = omgeving.STRIPE_API_URL;
      omgeving.STRIPE_API_URL = "http://127.0.0.1:1";
      abonnement.vergeet();
      fouten.length = 0;
      geheugen.organisatie("org_nieuw2");
      expect(await start("org_nieuw2", "jaar")).toEqual({ ok: false, code: "betaalpagina_mislukt", fout: "De betaalpagina kon niet worden geopend. Probeer het later opnieuw." });
      expect(fouten).toContain("Abonnement: afrekenen mislukt");
      await expect(abonnement.werkBij(ANDER)).rejects.toThrow();
      omgeving.STRIPE_API_URL = echt;
      abonnement.vergeet();
    });

    it("zonder sleutel staat alles uit en heeft iedereen toegang", async () => {
      const sleutel = omgeving.ABONNEMENT_STRIPE_SECRET_KEY;
      delete omgeving.ABONNEMENT_STRIPE_SECRET_KEY;
      expect(abonnement.aan()).toBe(false);
      expect(await abonnement.haalStand(OUD)).toEqual({ soort: "uit", toegang: true });
      expect(await start(OUD, "jaar")).toMatchObject({ ok: false, code: "abonnementen_uit" });
      expect(await abonnement.werkBij(ANDER)).toBe(false);
      const lichaam = melding({ id: "sub_ander00001", object: "subscription" });
      expect(await meld(lichaam)).toBe("geweigerd");
      expect(await abonnement.bevestigKoppeling({ organisatieId: KOPPEL, code: "x" })).toMatchObject({ ok: false, code: "abonnementen_uit" });
      expect(stripe.verzoeken).toEqual([]);
      omgeving.ABONNEMENT_STRIPE_SECRET_KEY = sleutel;
    });

    it("zonder geheim van het meldadres wordt elke melding geweigerd", async () => {
      delete omgeving.ABONNEMENT_STRIPE_WEBHOOK_SECRET;
      const lichaam = melding({ id: "sub_ander00001", object: "subscription" });
      expect(await meld(lichaam)).toBe("geweigerd");
      omgeving.ABONNEMENT_STRIPE_WEBHOOK_SECRET = GEHEIM;
    });
  });
});
