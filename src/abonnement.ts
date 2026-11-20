import { faalt, type Mislukt } from "./fouten.js";
import { hashKoppelcode, nieuweKoppelcode, normaliseerKoppelcode } from "./koppelcode.js";
import { abonnementUitMelding, klopHandtekening } from "./meldingen.js";
import { appNaam, type Plan } from "./namen.js";
import { bepaalStand, MET_TOEGANG, type Rij, type Stand } from "./stand.js";
import { maakStripe, type StripeAbonnement, type StripeInstelling } from "./stripe.js";

/**
 * Het abonnement van een organisatie op een app van Jona, van begin tot eind:
 * de stand, kiezen, het klantportaal, opzeggen, meldingen van Stripe, de nacht
 * en het koppelen aan een bestaande klant.
 *
 * Het pakket kent geen database. De app levert een kleine opslag aan bovenop
 * haar eigen tabel `abonnementen` en haar eigen rijbeveiliging.
 *
 * Staat ABONNEMENT_STRIPE_SECRET_KEY niet in de omgeving, dan staat dit
 * allemaal uit en heeft iedereen toegang.
 */

/** Namens wie een achtergrondtaak werkt: een melding van Stripe of de nachtelijke taak. */
export const SYSTEEM = "systeem";

/** Wat het pakket in de rij van een organisatie mag zetten. Vrijstelling en een verlengde proef zet de app zelf. */
export type Schrijfvelden = Partial<Pick<Rij, "stripeKlantId" | "stripeAbonnementId" | "plan" | "status" | "live" | "proefTot" | "periodeTot" | "stoptOp">>;

export type Bewerking = {
  /** De rij zoals hij nu is, vergrendeld tot het einde van de transactie. */
  huidig: Rij | null;
  /** Zet de velden in de rij; maakt de rij aan als hij er nog niet is. */
  schrijf(velden: Schrijfvelden): Promise<void>;
  /** Een regel in het auditlog van de organisatie. Mag niets doen als de app dat hier niet bijhoudt. */
  log(actie: string, details?: Record<string, unknown>): Promise<void>;
};

/**
 * De opslag die de app aanlevert. `namens` is de gebruiker die iets doet, of
 * `SYSTEEM`; een app waarvan de rijbeveiliging geen gebruiker kent, negeert het.
 */
export type Opslag = {
  /** Wanneer de organisatie is aangemaakt (daar begint de proef), of null als zij niet bestaat. */
  aangemaaktOp(organisatieId: string): Promise<Date | null>;
  leesRij(organisatieId: string, namens: string): Promise<Rij | null>;
  /** Voert `fn` uit in één transactie, met de rij van de organisatie vergrendeld. */
  bewerk<T>(organisatieId: string, namens: string, fn: (bewerking: Bewerking) => Promise<T>): Promise<T>;
};

export type Instelling = StripeInstelling & {
  opslag: Opslag;
  /** Het logboek van de app. Zonder gaat het naar `console.error`. */
  logFout?: (bericht: string, details: Record<string, string>) => void | Promise<void>;
};

export type Adres = { ok: true; adres: string } | Mislukt;
export type Gelukt = { ok: true } | Mislukt;
/** Of er een geldige koppelcode is bij de klant van een organisatie, en tot wanneer. */
export type CodeStand = { tot: Date } | null;
/** De klant bij een ingevulde code. `app` is de naam van de app waar de code is gemaakt. */
export type GevondenKlant = { ok: true; klantId: string; naam: string | null; email: string | null; app: string } | Mislukt;
export type MeldingUitkomst = "verwerkt" | "genegeerd" | "geweigerd" | "later";

const UUR = 3600_000;
/** Een koppelcode is 7 dagen geldig. */
const CODE_GELDIG = 7 * 24 * UUR;
/** Hooguit zoveel verkeerde codes per uur per organisatie. */
const POGINGEN = 5;
/** Een melding van Stripe is klein; een groot verzoek is niet van Stripe. */
const MAX_MELDING = 500_000;

export type Abonnement = ReturnType<typeof maakAbonnement>;

export function maakAbonnement(instelling: Instelling) {
  const stripe = maakStripe(instelling);
  const { opslag } = instelling;
  const log = async (bericht: string, details: Record<string, string>) => {
    if (instelling.logFout) await instelling.logFout(bericht, details);
    else console.error(bericht, details);
  };

  /** Staan abonnementen aan? Zonder sleutel heeft iedereen toegang. */
  const aan = () => stripe.sleutel() !== null;

  /* ------------------------------------------------------ de stand */

  /** De stand voor een lid van de organisatie (of SYSTEEM). */
  async function haalStand(organisatieId: string, namens: string = SYSTEEM): Promise<Stand> {
    if (!aan()) return { soort: "uit", toegang: true };
    const aangemaaktOp = await opslag.aangemaaktOp(organisatieId);
    if (!aangemaaktOp) return { soort: "verlopen", toegang: false, proefTot: new Date(0), status: null, klantId: null };
    return bepaalStand({ aan: true, aangemaaktOp, rij: await opslag.leesRij(organisatieId, namens) });
  }

  /* ------------------------------------------------------ bijwerken */

  /**
   * Legt de stand van een abonnement bij Stripe vast bij de organisatie uit de
   * metadata. Een oud, gestopt abonnement overschrijft nooit een lopend ander
   * abonnement (bijvoorbeeld als iemand twee keer heeft afgerekend).
   *
   * Een abonnement op een ander product telt niet: in hetzelfde Stripe-account
   * staan ook de abonnementen op andere apps van Jona, en het meldadres krijgt
   * ook daarvan de meldingen.
   *
   * `namens` is de gebruiker die terugkomt uit de betaalpagina, of SYSTEEM
   * voor meldingen van Stripe en de nachtelijke taak.
   */
  async function legVast(abonnement: StripeAbonnement, verwachteOrganisatie?: string, namens: string = SYSTEEM): Promise<"vastgelegd" | "genegeerd"> {
    if (!abonnement.eigenProduct) return "genegeerd";
    const organisatieId = abonnement.organisatieId;
    if (!organisatieId || (verwachteOrganisatie && organisatieId !== verwachteOrganisatie)) return "genegeerd";
    if (!(await opslag.aangemaaktOp(organisatieId))) return "genegeerd";

    return opslag.bewerk(organisatieId, namens, async ({ huidig, schrijf }) => {
      const anderLopend = huidig?.stripeAbonnementId && huidig.stripeAbonnementId !== abonnement.id && huidig.status && MET_TOEGANG.has(huidig.status);
      if (anderLopend && !MET_TOEGANG.has(abonnement.status)) return "genegeerd";
      await schrijf({
        stripeKlantId: abonnement.klantId ?? huidig?.stripeKlantId ?? null,
        stripeAbonnementId: abonnement.id,
        plan: abonnement.plan,
        status: abonnement.status,
        live: abonnement.live,
        proefTot: abonnement.proefTot,
        periodeTot: abonnement.periodeTot,
        stoptOp: abonnement.stoptOp,
      });
      return "vastgelegd";
    });
  }

  /**
   * Een melding van Stripe op het meldadres. De handtekening moet kloppen;
   * daarna haalt de app het abonnement zelf op, zodat de volgorde van
   * meldingen er niet toe doet.
   */
  async function verwerkMelding(lichaam: string, handtekening: string | null): Promise<MeldingUitkomst> {
    const geheim = stripe.lees("ABONNEMENT_STRIPE_WEBHOOK_SECRET");
    if (!geheim || !aan()) return "geweigerd";
    if (!klopHandtekening(lichaam, handtekening, geheim)) return "geweigerd";
    let melding: unknown;
    try {
      melding = JSON.parse(lichaam);
    } catch {
      return "geweigerd";
    }
    const id = abonnementUitMelding(melding);
    if (!id) return "genegeerd";
    const abonnement = await stripe.haalStripeAbonnement(id);
    if (!abonnement.ok) return abonnement.status === 404 ? "genegeerd" : "later";
    return (await legVast(abonnement.waarde)) === "vastgelegd" ? "verwerkt" : "genegeerd";
  }

  /**
   * Het hele meldadres, voor de route `/api/abonnement/stripe`. Bij 503
   * probeert Stripe het opnieuw; een verkeerde handtekening krijgt 400.
   */
  async function ontvangMelding(verzoek: Request): Promise<Response> {
    // Eerst de opgegeven grootte, dan de echte.
    const opgegeven = Number(verzoek.headers.get("content-length") ?? "0");
    if (!Number.isFinite(opgegeven) || opgegeven > MAX_MELDING) return new Response(null, { status: 413 });
    const lichaam = await verzoek.text();
    if (lichaam.length > MAX_MELDING) return new Response(null, { status: 413 });
    let uitkomst: MeldingUitkomst;
    try {
      uitkomst = await verwerkMelding(lichaam, verzoek.headers.get("stripe-signature"));
    } catch (fout) {
      await log("Abonnement: melding van Stripe mislukt", { detail: fout instanceof Error ? fout.message : "" });
      uitkomst = "later";
    }
    return new Response(null, { status: uitkomst === "geweigerd" ? 400 : uitkomst === "later" ? 503 : 200 });
  }

  /** Bij terugkeer uit de betaalpagina: meteen vastleggen, zonder op de melding te wachten. */
  async function verwerkTerugkeer(invoer: { organisatieId: string; namens?: string; sessieId: string }): Promise<void> {
    const sessie = await stripe.haalAfrekening(invoer.sessieId);
    if (!sessie.ok || sessie.waarde.organisatieId !== invoer.organisatieId || !sessie.waarde.abonnementId) return;
    const abonnement = await stripe.haalStripeAbonnement(sessie.waarde.abonnementId);
    if (abonnement.ok) await legVast(abonnement.waarde, invoer.organisatieId, invoer.namens ?? SYSTEEM);
  }

  /** Voor de nachtelijke taak: haalt de stand opnieuw op, voor het geval een melding is gemist. */
  async function werkBij(organisatieId: string): Promise<boolean> {
    if (!aan()) return false;
    const rij = await opslag.leesRij(organisatieId, SYSTEEM);
    if (!rij?.stripeAbonnementId || rij.status === "canceled") return false;
    const abonnement = await stripe.haalStripeAbonnement(rij.stripeAbonnementId);
    if (!abonnement.ok) {
      if (abonnement.status === 404) return false;
      throw new Error(abonnement.fout);
    }
    return (await legVast(abonnement.waarde, organisatieId)) === "vastgelegd";
  }

  /** Haalt het abonnement van de organisatie opnieuw op bij Stripe, bijvoorbeeld na opzeggen. */
  async function ververs(organisatieId: string, namens: string = SYSTEEM): Promise<void> {
    if (!aan()) return;
    const rij = await opslag.leesRij(organisatieId, namens);
    if (!rij?.stripeAbonnementId) return;
    const abonnement = await stripe.haalStripeAbonnement(rij.stripeAbonnementId);
    if (abonnement.ok) await legVast(abonnement.waarde, organisatieId, namens);
  }

  /* ------------------------------------------------------ afrekenen */

  /** Het adres van de betaalpagina van Stripe, of van het klantportaal als er al een lopend abonnement is. */
  async function startAbonnement(invoer: { organisatieId: string; namens?: string; organisatieNaam: string; email: string; plan: Plan; herkomst: string }): Promise<Adres> {
    if (!aan()) return faalt("abonnementen_uit");
    const namens = invoer.namens ?? SYSTEEM;
    const stand = await haalStand(invoer.organisatieId, namens);
    if (stand.soort === "abonnement" && stand.klantId) return openPortaal({ organisatieId: invoer.organisatieId, namens, herkomst: invoer.herkomst });
    const klantId = stand.soort === "uit" || stand.soort === "vrij" ? null : stand.klantId;
    // Een klant met een lopend abonnement op een andere app van Jona krijgt de bundelkorting.
    // De klant is dan altijd via de bevestiging per e-mail gekoppeld, of van deze organisatie zelf.
    const elders = klantId ? await stripe.klantLooptElders(klantId) : null;
    if (elders && !elders.ok) {
      await log("Abonnement: bundel nagaan mislukt", { organisatie: invoer.organisatieId, detail: elders.fout });
      return faalt("betaalpagina_mislukt");
    }
    const uitkomst = await stripe.maakAfrekening({
      organisatieId: invoer.organisatieId,
      organisatieNaam: invoer.organisatieNaam,
      plan: invoer.plan,
      email: invoer.email,
      klantId,
      bundelkorting: elders?.waarde === true,
      proefTot: stand.soort === "proef" ? stand.proefTot : null,
      terugadres: `${invoer.herkomst}/abonnement?sessie={CHECKOUT_SESSION_ID}`,
      stopadres: `${invoer.herkomst}/abonnement`,
    });
    if (!uitkomst.ok) {
      await log("Abonnement: afrekenen mislukt", { organisatie: invoer.organisatieId, detail: uitkomst.fout });
      return faalt("betaalpagina_mislukt");
    }
    return { ok: true, adres: uitkomst.waarde };
  }

  async function openPortaal(invoer: { organisatieId: string; namens?: string; herkomst: string }): Promise<Adres> {
    const rij = await opslag.leesRij(invoer.organisatieId, invoer.namens ?? SYSTEEM);
    if (!rij?.stripeKlantId) return faalt("geen_abonnement");
    const uitkomst = await stripe.maakPortaal(rij.stripeKlantId, `${invoer.herkomst}/abonnement`);
    if (!uitkomst.ok) {
      await log("Abonnement: portaal mislukt", { organisatie: invoer.organisatieId, detail: uitkomst.fout });
      return faalt("portaal_mislukt");
    }
    return { ok: true, adres: uitkomst.waarde };
  }

  /* ------------------------------------------------------ opzeggen */

  /** Het lopende abonnement van deze organisatie, als dat er is. */
  async function lopendAbonnement(organisatieId: string, namens: string) {
    const rij = await opslag.leesRij(organisatieId, namens);
    if (!rij?.stripeKlantId || !rij.stripeAbonnementId || !rij.status || !MET_TOEGANG.has(rij.status)) return null;
    return { klantId: rij.stripeKlantId, abonnementId: rij.stripeAbonnementId, opgezegd: rij.stoptOp !== null };
  }

  /**
   * Opent bij Stripe het opzeggen van alleen het abonnement van deze
   * organisatie. In het gewone portaal kan dat niet: de klant kan gedeeld zijn
   * met andere apps van Jona, en het portaal toont al hun abonnementen.
   */
  async function openOpzeggen(invoer: { organisatieId: string; namens?: string; herkomst: string }): Promise<Adres> {
    const lopend = await lopendAbonnement(invoer.organisatieId, invoer.namens ?? SYSTEEM);
    if (!lopend) return faalt("geen_lopend_abonnement");
    if (lopend.opgezegd) return faalt("al_opgezegd");
    const uitkomst = await stripe.maakOpzegPortaal({ klantId: lopend.klantId, abonnementId: lopend.abonnementId, terugadres: `${invoer.herkomst}/abonnement`, naOpzeggen: `${invoer.herkomst}/abonnement?opgezegd=1` });
    if (!uitkomst.ok) {
      await log("Abonnement: opzeggen openen mislukt", { organisatie: invoer.organisatieId, detail: uitkomst.fout });
      return faalt("opzeggen_mislukt");
    }
    return { ok: true, adres: uitkomst.waarde };
  }

  /** Draait een opzegging terug, zodat het abonnement doorloopt. */
  async function draaiOpzeggingTerug(invoer: { organisatieId: string; namens?: string }): Promise<Gelukt> {
    const namens = invoer.namens ?? SYSTEEM;
    const lopend = await lopendAbonnement(invoer.organisatieId, namens);
    if (!lopend?.opgezegd) return faalt("geen_opzegging");
    const uitkomst = await stripe.zetOpzeggingTerug(lopend.abonnementId);
    if (!uitkomst.ok) {
      await log("Abonnement: opzegging terugdraaien mislukt", { organisatie: invoer.organisatieId, detail: uitkomst.fout });
      return faalt("terugdraaien_mislukt");
    }
    await ververs(invoer.organisatieId, namens);
    return { ok: true };
  }

  /* ------------------------------------------------------ koppelen */

  /*
   * Een organisatie koppelen aan een klant die al bestaat bij Jona, met een
   * koppelcode (zie koppelcode.ts). Het abonnement komt dan op dezelfde
   * Stripe-klant: één plek voor facturen en betaalwijze, en de bundelkorting.
   *
   * Een code is 7 dagen geldig, werkt één keer (koppelen wist hem), en een
   * nieuwe code of intrekken vervangt de oude. App A is de app waar al een
   * abonnement loopt en de code wordt gemaakt; app B de app waar hij wordt
   * ingevuld.
   */

  /** Koppelen kan zodra abonnementen aanstaan. */
  const koppelenKan = () => aan();

  /* --- app A */

  /** Of er een geldige code is bij de klant van deze organisatie, voor de kaart. Bij een fout van Stripe: geen code tonen. */
  async function haalCodeStand(klantId: string, nu = new Date()): Promise<CodeStand> {
    const klant = await stripe.haalKlant(klantId);
    if (!klant.ok || !klant.waarde?.hash || !klant.waarde.tot || klant.waarde.tot <= nu) return null;
    return { tot: klant.waarde.tot };
  }

  async function eigenKlant(organisatieId: string, namens: string): Promise<{ ok: true; klantId: string } | Mislukt> {
    if (!koppelenKan()) return faalt("abonnementen_uit");
    const stand = await haalStand(organisatieId, namens);
    if (stand.soort !== "abonnement" || !stand.klantId || !MET_TOEGANG.has(stand.status)) return faalt("koppelcode_alleen_met_abonnement");
    return { ok: true, klantId: stand.klantId };
  }

  /** Maakt een nieuwe code voor de klant van deze organisatie. De vorige vervalt. De code is alleen nu te zien. */
  async function maakKoppelcode(invoer: { organisatieId: string; namens?: string }, nu = new Date()): Promise<{ ok: true; code: string; tot: Date } | Mislukt> {
    const namens = invoer.namens ?? SYSTEEM;
    const klant = await eigenKlant(invoer.organisatieId, namens);
    if (!klant.ok) return klant;
    const code = nieuweKoppelcode();
    const tot = new Date(nu.getTime() + CODE_GELDIG);
    const gezet = await stripe.zetKoppelcode(klant.klantId, { hash: hashKoppelcode(normaliseerKoppelcode(code)!), tot });
    if (!gezet.ok) {
      await log("Abonnement: koppelcode zetten mislukt", { organisatie: invoer.organisatieId, detail: gezet.fout });
      return faalt("koppelcode_maken_mislukt");
    }
    await opslag.bewerk(invoer.organisatieId, namens, ({ log: logActie }) => logActie("abonnement.koppelcode_gemaakt"));
    return { ok: true, code, tot };
  }

  /** Trekt de code van deze organisatie in. */
  async function trekKoppelcodeIn(invoer: { organisatieId: string; namens?: string }): Promise<Gelukt> {
    const namens = invoer.namens ?? SYSTEEM;
    const klant = await eigenKlant(invoer.organisatieId, namens);
    if (!klant.ok) return klant;
    const gewist = await stripe.zetKoppelcode(klant.klantId, null);
    if (!gewist.ok) {
      await log("Abonnement: koppelcode intrekken mislukt", { organisatie: invoer.organisatieId, detail: gewist.fout });
      return faalt("koppelcode_intrekken_mislukt");
    }
    await opslag.bewerk(invoer.organisatieId, namens, ({ log: logActie }) => logActie("abonnement.koppelcode_ingetrokken"));
    return { ok: true };
  }

  /* --- app B */

  /** Verkeerde pogingen per organisatie, per proces: een rem op raden. */
  const misPogingen = new Map<string, number[]>();

  /** Zoekt de klant bij een ingevulde code, met alle controles. Een verkeerde code telt als poging. */
  async function zoek(invoer: { organisatieId: string; namens?: string; code: unknown }, nu = Date.now()): Promise<GevondenKlant> {
    if (!koppelenKan()) return faalt("abonnementen_uit");
    const stand = await haalStand(invoer.organisatieId, invoer.namens ?? SYSTEEM);
    if (stand.soort !== "proef" && stand.soort !== "verlopen") return faalt("abonnement_loopt_koppelen");
    if (stand.klantId) return faalt("organisatie_al_gekoppeld");

    const eerder = (misPogingen.get(invoer.organisatieId) ?? []).filter((t) => t > nu - UUR);
    if (eerder.length >= POGINGEN) return faalt("koppelcode_te_vaak");
    const mis = (): GevondenKlant => {
      misPogingen.set(invoer.organisatieId, [...eerder, nu]);
      return faalt("koppelcode_ongeldig");
    };

    const tekens = normaliseerKoppelcode(invoer.code);
    if (!tekens) return mis();
    const klant = await stripe.zoekKlantOpKoppelcode(hashKoppelcode(tekens));
    if (!klant.ok) {
      await log("Abonnement: koppelcode zoeken mislukt", { organisatie: invoer.organisatieId, detail: klant.fout });
      return faalt("koppelcode_controleren_mislukt");
    }
    const gevonden = klant.waarde;
    if (!gevonden || !gevonden.tot || gevonden.tot.getTime() <= nu) return mis();
    if (gevonden.app === instelling.app) return { ...faalt("koppelcode_zelfde_app"), fout: `Deze code is gemaakt in ${instelling.naam}. Gebruik hem in een andere app van Jona.` };
    return { ok: true, klantId: gevonden.id, naam: gevonden.naam, email: gevonden.email, app: appNaam(gevonden.app) };
  }

  /** De controlestap: bij welke klant hoort deze code? Er wordt nog niets gekoppeld. */
  async function controleerKoppelcode(invoer: { organisatieId: string; namens?: string; code: unknown }): Promise<{ ok: true; naam: string | null; app: string } | Mislukt> {
    const uitkomst = await zoek(invoer);
    return uitkomst.ok ? { ok: true, naam: uitkomst.naam, app: uitkomst.app } : uitkomst;
  }

  /**
   * Koppelt de organisatie aan de klant bij de code. Eerst wordt de code bij
   * Stripe gewist, zodat hij geen tweede keer werkt; lukt daarna het vastleggen
   * niet, dan maakt app A een nieuwe code. Geeft de klant terug, zodat de app
   * de betaler een seintje kan mailen.
   */
  async function bevestigKoppeling(invoer: { organisatieId: string; namens?: string; code: unknown }): Promise<GevondenKlant> {
    const gevonden = await zoek(invoer);
    if (!gevonden.ok) return gevonden;
    const klantId = gevonden.klantId;
    const gewist = await stripe.zetKoppelcode(klantId, null);
    if (!gewist.ok) {
      await log("Abonnement: koppelcode wissen mislukt", { organisatie: invoer.organisatieId, detail: gewist.fout });
      return faalt("koppelen_mislukt");
    }
    const vastgelegd = await opslag.bewerk(invoer.organisatieId, invoer.namens ?? SYSTEEM, async ({ huidig, schrijf, log: logActie }): Promise<Gelukt> => {
      if (huidig?.status && MET_TOEGANG.has(huidig.status)) return faalt("abonnement_loopt_koppelen");
      if (huidig?.stripeKlantId && huidig.stripeKlantId !== klantId) return faalt("organisatie_heeft_klant");
      await schrijf({ stripeKlantId: klantId });
      await logActie("abonnement.klant_gekoppeld", { via: "koppelcode" });
      return { ok: true };
    });
    return vastgelegd.ok ? gevonden : vastgelegd;
  }

  /** Alleen voor tests: vergeet wat er bij Stripe is opgezocht en de verkeerde pogingen. */
  function vergeet() {
    stripe.vergeetInrichting();
    misPogingen.clear();
  }

  return {
    /** De namen van deze app bij Stripe: het product, de prijzen. */
    namen: stripe.namen,
    /** Het Stripe-deel los, voor wie meer nodig heeft dan de stromen hieronder. */
    stripe,
    aan,
    haalStand,
    legVast,
    verwerkMelding,
    ontvangMelding,
    verwerkTerugkeer,
    werkBij,
    ververs,
    startAbonnement,
    openPortaal,
    openOpzeggen,
    draaiOpzeggingTerug,
    koppelenKan,
    haalCodeStand,
    maakKoppelcode,
    trekKoppelcodeIn,
    controleerKoppelcode,
    bevestigKoppeling,
    vergeet,
  };
}
