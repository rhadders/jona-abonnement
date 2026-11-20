import { faalt, type Mislukt } from "./fouten.js";
import { leesKoppelcode, maakKoppelcode } from "./koppelcode.js";
import { abonnementUitMelding, klopHandtekening } from "./meldingen.js";
import type { Plan } from "./namen.js";
import { bepaalStand, MET_TOEGANG, type Rij, type Stand } from "./stand.js";
import { maakStripe, type StripeAbonnement, type StripeInstelling } from "./stripe.js";

/**
 * Het abonnement van een organisatie op een app van Jona, van begin tot eind:
 * de stand, kiezen, het klantportaal, meldingen van Stripe, de nacht en het
 * koppelen aan een bestaande klant.
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
  log(actie: string): Promise<void>;
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

export type Koppelmail = { organisatieId: string; namens: string; organisatieNaam: string | null; email: string; adres: string };

export type Instelling = StripeInstelling & {
  opslag: Opslag;
  /** Is e-mail ingesteld? Zonder e-mail kan koppelen niet. */
  mailIngesteld?: () => boolean;
  /** Stuurt de link om te koppelen naar het adres zelf. Geeft terug of de mail is verstuurd (of klaargezet). */
  stuurKoppelmail?: (mail: Koppelmail) => Promise<boolean>;
  /** Het logboek van de app. Zonder gaat het naar `console.error`. */
  logFout?: (bericht: string, details: Record<string, string>) => void | Promise<void>;
};

export type Adres = { ok: true; adres: string } | Mislukt;
export type KoppelUitkomst = { ok: true } | Mislukt;
export type MeldingUitkomst = "verwerkt" | "genegeerd" | "geweigerd" | "later";

const UUR = 3600_000;
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

  /* ------------------------------------------------------ koppelen */

  /*
   * Een organisatie koppelen aan een klant die al bestaat bij Jona. Wie al een
   * abonnement heeft op een andere app, kan dit abonnement op dezelfde klant
   * zetten: één plek voor facturen en betaalwijze.
   *
   * Het e-mailadres van een gebruiker is in de app niet bevestigd. Daarom
   * koppelt de app nooit vanzelf op een gelijk adres: iemand zou zich met het
   * adres van een ander kunnen aanmelden en dan diens facturen zien. De
   * gebruiker vraagt een link aan; die gaat naar het adres zelf, en alleen wie
   * de mail kan lezen en bij deze organisatie is ingelogd, kan bevestigen.
   */

  const ondertekening = () => stripe.lees("BETTER_AUTH_SECRET") ?? "";

  /** Koppelen kan alleen met abonnementen aan en e-mail ingesteld. */
  const koppelenKan = () => aan() && Boolean(instelling.stuurKoppelmail) && (instelling.mailIngesteld?.() ?? true);

  /** Wanneer er voor een organisatie het laatst een link is verstuurd; per proces, als rem op herhaald aanvragen. */
  const laatstVerstuurd = new Map<string, number>();

  /**
   * Stuurt de gebruiker een link om te koppelen, als er bij Jona een klant met
   * zijn e-mailadres is. Het antwoord is in beide gevallen hetzelfde, zodat
   * niemand hier kan nagaan of een adres klant is. Hooguit één mail per uur.
   */
  async function vraagKoppelingAan(invoer: { organisatieId: string; namens?: string; organisatieNaam?: string; email: string; herkomst: string }): Promise<KoppelUitkomst> {
    if (!koppelenKan()) return faalt("koppelen_kan_niet");
    const namens = invoer.namens ?? SYSTEEM;
    const stand = await haalStand(invoer.organisatieId, namens);
    if (stand.soort !== "proef" && stand.soort !== "verlopen") return faalt("abonnement_loopt");
    if (stand.klantId) return faalt("organisatie_al_gekoppeld");
    if (Date.now() - (laatstVerstuurd.get(invoer.organisatieId) ?? 0) < UUR) return { ok: true };

    const klant = await stripe.zoekKlantElders(invoer.email);
    if (!klant.ok) {
      await log("Abonnement: klant zoeken mislukt", { organisatie: invoer.organisatieId, detail: klant.fout });
      return faalt("zoeken_mislukt");
    }
    const klantId = klant.waarde;
    if (!klantId) return { ok: true };

    const adres = `${invoer.herkomst}/abonnement/koppelen?code=${encodeURIComponent(maakKoppelcode(ondertekening(), invoer.organisatieId, klantId))}`;
    let verzonden = false;
    try {
      verzonden = await instelling.stuurKoppelmail!({ organisatieId: invoer.organisatieId, namens, organisatieNaam: invoer.organisatieNaam ?? null, email: invoer.email, adres });
    } catch (fout) {
      await log("Abonnement: koppelmail mislukt", { organisatie: invoer.organisatieId, detail: fout instanceof Error ? fout.message : "" });
    }
    // Ook als versturen mislukt hetzelfde antwoord: een foutmelding zou verraden dat het adres klant is.
    if (verzonden) laatstVerstuurd.set(invoer.organisatieId, Date.now());
    return { ok: true };
  }

  /** Legt de klant uit de code vast bij de organisatie. Het eerstvolgende abonnement komt dan op die klant. */
  async function bevestigKoppeling(invoer: { organisatieId: string; namens?: string; code: unknown }): Promise<KoppelUitkomst> {
    if (!aan()) return faalt("abonnementen_uit");
    const klantId = leesKoppelcode(ondertekening(), invoer.code, invoer.organisatieId);
    if (!klantId) return faalt("koppellink_verlopen");
    return opslag.bewerk(invoer.organisatieId, invoer.namens ?? SYSTEEM, async ({ huidig, schrijf, log: logActie }): Promise<KoppelUitkomst> => {
      if (huidig?.status && MET_TOEGANG.has(huidig.status)) return faalt("abonnement_loopt_koppelen");
      if (huidig?.stripeKlantId && huidig.stripeKlantId !== klantId) return faalt("organisatie_heeft_klant");
      await schrijf({ stripeKlantId: klantId });
      await logActie("abonnement.klant_gekoppeld");
      return { ok: true };
    });
  }

  /** Alleen voor tests: vergeet wat er bij Stripe is opgezocht en wanneer er een link is verstuurd. */
  function vergeet() {
    stripe.vergeetInrichting();
    laatstVerstuurd.clear();
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
    startAbonnement,
    openPortaal,
    koppelenKan,
    vraagKoppelingAan,
    bevestigKoppeling,
    maakKoppelcode: (organisatieId: string, klantId: string, nu?: number) => maakKoppelcode(ondertekening(), organisatieId, klantId, nu),
    leesKoppelcode: (code: unknown, organisatieId: string, nu?: number) => leesKoppelcode(ondertekening(), code, organisatieId, nu),
    vergeet,
  };
}
