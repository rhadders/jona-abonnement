import { faalt, type Foutcode } from "./fouten.js";
import { isAbonnementId, isKlantId, isSessieId, object, tekst, type Rauw } from "./meldingen.js";
import { BUNDEL_COUPON, BUNDELKORTING, JONA_VOORVOEGSEL, namenVan, PLANNEN, type Namen, type Plan } from "./namen.js";

/**
 * Stripe voor het abonnement van organisaties op een app van Jona. Het is het
 * Stripe-account van Jona zelf, dat alle apps delen, met de sleutel uit
 * ABONNEMENT_STRIPE_SECRET_KEY. Elke app heeft er een eigen product en eigen
 * prijzen, zodat de apps elkaar niet raken.
 *
 * Het product, de twee prijzen, het btw-tarief en de instellingen van het
 * klantportaal maakt de app zelf aan als ze er nog niet zijn. Ze worden
 * teruggevonden op een vaste sleutel (lookup_key of metadata), zodat er na
 * een herstart of in een tweede container niets dubbel komt.
 */

/** De versie van de Stripe-API waarmee alle apps voor het abonnement praten. */
export const STRIPE_VERSIE = "2026-10-28.endive";

export type Omgeving = Record<string, string | undefined>;

export type StripeInstelling = {
  /** Het korte woord van de app in kleine letters: "giften", "bestuur". */
  app: string;
  /** De naam op het scherm en op de factuur: "Jona Giften". */
  naam: string;
  /** Eén regel over de app, bij het product in Stripe. */
  omschrijving: string;
  /** Een andere prijs dan de gewone, in centen en inclusief btw. */
  prijzen?: Record<Plan, number>;
  /** Waar de instellingen vandaan komen; standaard `process.env`. Wordt bij elk gebruik gelezen. */
  omgeving?: () => Omgeving;
};

export type Antwoord<T> = { ok: true; waarde: T } | { ok: false; status: number; fout: string; code?: Foutcode };

export type StripeAbonnement = {
  id: string;
  organisatieId: string | null;
  klantId: string | null;
  /** Hoort het abonnement bij het product van deze app? In hetzelfde Stripe-account staan ook abonnementen op andere apps van Jona. */
  eigenProduct: boolean;
  plan: Plan | null;
  status: string;
  live: boolean;
  proefTot: Date | null;
  periodeTot: Date | null;
  stoptOp: Date | null;
};

export type Afrekening = {
  organisatieId: string;
  organisatieNaam: string;
  plan: Plan;
  email: string;
  klantId: string | null;
  proefTot: Date | null;
  /** De bundelkorting toepassen. Een eigen kortingscode invullen kan dan niet: Stripe staat die twee niet samen toe. */
  bundelkorting?: boolean;
  terugadres: string;
  stopadres: string;
};

type Velden = [string, string][];
type Inrichting = { prijzen: Record<Plan, string>; btw: string | null };

/** Standen waarin een abonnement loopt. */
const LOPEND = new Set(["active", "trialing", "past_due"]);

const lijst = (waarde: unknown): Rauw[] => (Array.isArray(object(waarde)?.data) ? ((object(waarde)!.data as unknown[]).map(object).filter(Boolean) as Rauw[]) : []);
/** Het product van een prijs: Stripe geeft het id, of het hele product als het is uitgeklapt. */
const productVan = (prijs: Rauw | null) => (typeof prijs?.product === "string" ? prijs.product : tekst(object(prijs?.product)?.id));
const moment = (seconden: unknown) => (typeof seconden === "number" && seconden > 0 ? new Date(seconden * 1000) : null);
const mislukt = (status: number, code: Foutcode): { ok: false; status: number; fout: string; code: Foutcode } => ({ status, ...faalt(code) });

export type Stripe = ReturnType<typeof maakStripe>;

export function maakStripe(instelling: StripeInstelling) {
  const namen: Namen = namenVan(instelling.app, instelling.naam, instelling.prijzen);
  const omgeving = instelling.omgeving ?? (() => process.env);
  const lees = (naam: string) => omgeving()[naam]?.trim() || null;
  const basis = () => (lees("STRIPE_API_URL") ?? "https://api.stripe.com").replace(/\/$/, "");

  /** De geheime sleutel van het Stripe-account van Jona, of null: dan staan abonnementen uit. */
  const sleutel = () => lees("ABONNEMENT_STRIPE_SECRET_KEY");

  async function vraag(pad: string, verzoek: { methode?: "GET" | "POST"; velden?: Velden; eenmalig?: string } = {}): Promise<Antwoord<Rauw>> {
    const geheim = sleutel();
    if (!geheim) return mislukt(0, "abonnementen_sleutel_ontbreekt");
    let antwoord: Response;
    try {
      antwoord = await fetch(`${basis()}/v1/${pad}`, {
        method: verzoek.methode ?? "GET",
        headers: {
          Authorization: `Bearer ${geheim}`,
          Accept: "application/json",
          "Stripe-Version": STRIPE_VERSIE,
          ...(verzoek.velden ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(verzoek.eenmalig ? { "Idempotency-Key": verzoek.eenmalig } : {}),
        },
        body: verzoek.velden ? new URLSearchParams(verzoek.velden).toString() : undefined,
        signal: AbortSignal.timeout(15_000),
        // Next.js mag een antwoord van Stripe nooit bewaren. De types van Node kennen `cache` niet, die van de browser wel.
        ...({ cache: "no-store" } as RequestInit),
      });
    } catch {
      return mislukt(0, "stripe_onbereikbaar");
    }
    let inhoud: unknown = null;
    try {
      inhoud = await antwoord.json();
    } catch {
      // Geen leesbaar antwoord; de status zegt genoeg.
    }
    const gelezen = object(inhoud);
    if (antwoord.ok && gelezen) return { ok: true, waarde: gelezen };
    const detail = String(object(gelezen?.error)?.message ?? "").slice(0, 300);
    return { ok: false, status: antwoord.status, fout: `Stripe gaf een fout (${antwoord.status})${detail ? `: ${detail}` : "."}` };
  }

  /* ------------------------------------------------- inrichting bij Stripe */

  let inrichting: Promise<Antwoord<Inrichting>> | null = null;
  let portaal: Promise<Antwoord<string>> | null = null;

  /** Alleen voor tests: vergeet wat er bij Stripe is opgezocht. */
  function vergeetInrichting() {
    inrichting = null;
    portaal = null;
  }

  /** Het product, de twee prijzen (inclusief btw) en het btw-tarief. Maakt aan wat ontbreekt. */
  function zorgVoorInrichting(): Promise<Antwoord<Inrichting>> {
    if (!inrichting) {
      inrichting = richtIn().then((uitkomst) => {
        if (!uitkomst.ok) inrichting = null; // een volgende poging begint opnieuw
        return uitkomst;
      });
    }
    return inrichting;
  }

  async function richtIn(): Promise<Antwoord<Inrichting>> {
    const sleutels = PLANNEN.map((p): [string, string] => ["lookup_keys[]", namen.plannen[p].lookupKey]);
    const gevonden = await vraag(`prices?active=true&limit=10&${new URLSearchParams(sleutels).toString()}`);
    if (!gevonden.ok) return gevonden;
    const prijzen: Partial<Record<Plan, string>> = {};
    for (const prijs of lijst(gevonden.waarde)) {
      const plan = PLANNEN.find((p) => namen.plannen[p].lookupKey === prijs.lookup_key);
      const id = tekst(prijs.id);
      if (plan && id) prijzen[plan] = id;
    }

    if (!prijzen.jaar || !prijzen.maand) {
      const product = await vraag(`products/${namen.product}`);
      if (!product.ok) {
        if (product.status !== 404) return product;
        const nieuw = await vraag("products", {
          methode: "POST",
          velden: [
            ["id", namen.product],
            ["name", instelling.naam],
            ["description", instelling.omschrijving],
          ],
        });
        if (!nieuw.ok) return nieuw;
      }
      for (const plan of PLANNEN) {
        if (prijzen[plan]) continue;
        const p = namen.plannen[plan];
        const nieuw = await vraag("prices", {
          methode: "POST",
          eenmalig: p.eenmalig,
          velden: [
            ["product", namen.product],
            ["currency", "eur"],
            ["unit_amount", String(p.centen)],
            ["recurring[interval]", p.interval],
            ["tax_behavior", "inclusive"],
            ["lookup_key", p.lookupKey],
            ["nickname", p.naam],
          ],
        });
        if (!nieuw.ok) return nieuw;
        const id = tekst(nieuw.waarde.id);
        if (!id) return mislukt(0, "stripe_geen_prijs");
        prijzen[plan] = id;
      }
    }

    const btw = await zorgVoorBtw();
    if (!btw.ok) return btw;
    return { ok: true, waarde: { prijzen: prijzen as Record<Plan, string>, btw: btw.waarde } };
  }

  /**
   * Het btw-tarief van 21%, inclusief: de prijs blijft gelijk en de factuur
   * toont welk deel btw is. Met ABONNEMENT_BTW=uit laat de app het weg
   * (bijvoorbeeld als Stripe Tax de btw berekent).
   */
  async function zorgVoorBtw(): Promise<Antwoord<string | null>> {
    if (lees("ABONNEMENT_BTW")?.toLowerCase() === "uit") return { ok: true, waarde: null };
    const tarieven = await vraag("tax_rates?active=true&inclusive=true&limit=100");
    if (!tarieven.ok) return tarieven;
    const bestaand = lijst(tarieven.waarde).find((t) => object(t.metadata)?.[namen.metadata] === "btw" && t.percentage === 21);
    if (bestaand && tekst(bestaand.id)) return { ok: true, waarde: tekst(bestaand.id) };
    const nieuw = await vraag("tax_rates", {
      methode: "POST",
      eenmalig: namen.eenmaligBtw,
      velden: [
        ["display_name", "Btw"],
        ["description", "Btw 21%"],
        ["percentage", "21"],
        ["inclusive", "true"],
        ["country", "NL"],
        ["jurisdiction", "NL"],
        ["tax_type", "vat"],
        [`metadata[${namen.metadata}]`, "btw"],
      ],
    });
    if (!nieuw.ok) return nieuw;
    return { ok: true, waarde: tekst(nieuw.waarde.id) };
  }

  /** De instellingen van het klantportaal: facturen, betaalwijze, wisselen tussen jaar en maand, opzeggen per einde periode. */
  function zorgVoorPortaal(prijzen: Record<Plan, string>): Promise<Antwoord<string>> {
    if (!portaal) {
      portaal = richtPortaalIn(prijzen).then((uitkomst) => {
        if (!uitkomst.ok) portaal = null;
        return uitkomst;
      });
    }
    return portaal;
  }

  async function richtPortaalIn(prijzen: Record<Plan, string>): Promise<Antwoord<string>> {
    const bestaand = await vraag("billing_portal/configurations?active=true&limit=100");
    if (!bestaand.ok) return bestaand;
    const gevonden = lijst(bestaand.waarde).find((c) => object(c.metadata)?.[namen.metadata] === "abonnement");
    if (gevonden && tekst(gevonden.id)) return { ok: true, waarde: tekst(gevonden.id)! };
    const nieuw = await vraag("billing_portal/configurations", {
      methode: "POST",
      eenmalig: namen.eenmaligPortaal,
      velden: [
        ["business_profile[headline]", `${instelling.naam}: uw abonnement`],
        ["features[invoice_history][enabled]", "true"],
        ["features[payment_method_update][enabled]", "true"],
        ["features[customer_update][enabled]", "true"],
        ["features[customer_update][allowed_updates][0]", "name"],
        ["features[customer_update][allowed_updates][1]", "email"],
        ["features[customer_update][allowed_updates][2]", "address"],
        ["features[customer_update][allowed_updates][3]", "tax_id"],
        ["features[subscription_cancel][enabled]", "true"],
        ["features[subscription_cancel][mode]", "at_period_end"],
        ["features[subscription_update][enabled]", "true"],
        ["features[subscription_update][default_allowed_updates][0]", "price"],
        ["features[subscription_update][proration_behavior]", "create_prorations"],
        ["features[subscription_update][products][0][product]", namen.product],
        ["features[subscription_update][products][0][prices][0]", prijzen.jaar],
        ["features[subscription_update][products][0][prices][1]", prijzen.maand],
        [`metadata[${namen.metadata}]`, "abonnement"],
      ],
    });
    if (!nieuw.ok) return nieuw;
    const id = tekst(nieuw.waarde.id);
    return id ? { ok: true, waarde: id } : mislukt(0, "stripe_geen_portaal");
  }

  /* ------------------------------------------------------ afrekenen */

  /**
   * Start de betaalpagina van Stripe voor een abonnement. `proefTot` laat de
   * eerste afschrijving pas na de proefperiode vallen; Stripe wil daarvoor
   * minstens twee dagen, dus korter dan dat begint het abonnement direct.
   */
  async function maakAfrekening(invoer: Afrekening): Promise<Antwoord<string>> {
    const ingericht = await zorgVoorInrichting();
    if (!ingericht.ok) return ingericht;
    const velden: Velden = [
      ["mode", "subscription"],
      ["locale", "nl"],
      ["line_items[0][price]", ingericht.waarde.prijzen[invoer.plan]],
      ["line_items[0][quantity]", "1"],
      ["client_reference_id", invoer.organisatieId],
      ["metadata[organisatie_id]", invoer.organisatieId],
      ["subscription_data[metadata][organisatie_id]", invoer.organisatieId],
      ["subscription_data[description]", `${instelling.naam} voor ${invoer.organisatieNaam}`.slice(0, 200)],
      ["billing_address_collection", "required"],
      ["tax_id_collection[enabled]", "true"],
      ["success_url", invoer.terugadres],
      ["cancel_url", invoer.stopadres],
    ];
    if (invoer.bundelkorting) {
      const coupon = await zorgVoorBundelcoupon();
      if (!coupon.ok) return coupon;
      velden.push(["discounts[0][coupon]", coupon.waarde]);
    } else velden.push(["allow_promotion_codes", "true"]);
    if (ingericht.waarde.btw) velden.push(["line_items[0][tax_rates][0]", ingericht.waarde.btw]);
    if (invoer.klantId) velden.push(["customer", invoer.klantId], ["customer_update[address]", "auto"], ["customer_update[name]", "auto"]);
    else velden.push(["customer_email", invoer.email]);
    if (invoer.proefTot && invoer.proefTot.getTime() - Date.now() > 49 * 3600_000) {
      velden.push(["subscription_data[trial_end]", String(Math.floor(invoer.proefTot.getTime() / 1000))]);
    }
    const antwoord = await vraag("checkout/sessions", { methode: "POST", velden });
    if (!antwoord.ok) return antwoord;
    const url = tekst(antwoord.waarde.url);
    return url && /^https:\/\//.test(url) ? { ok: true, waarde: url } : mislukt(0, "stripe_geen_betaalpagina");
  }

  /** Het klantportaal van Stripe, waar de organisatie facturen ziet, wisselt van plan of opzegt. */
  async function maakPortaal(klantId: string, terugadres: string): Promise<Antwoord<string>> {
    const ingericht = await zorgVoorInrichting();
    if (!ingericht.ok) return ingericht;
    const configuratie = await zorgVoorPortaal(ingericht.waarde.prijzen);
    if (!configuratie.ok) return configuratie;
    const antwoord = await vraag("billing_portal/sessions", {
      methode: "POST",
      velden: [
        ["customer", klantId],
        ["return_url", terugadres],
        ["configuration", configuratie.waarde],
        ["locale", "nl"],
      ],
    });
    if (!antwoord.ok) return antwoord;
    const url = tekst(antwoord.waarde.url);
    return url && /^https:\/\//.test(url) ? { ok: true, waarde: url } : mislukt(0, "stripe_geen_portaal");
  }

  /* ------------------------------------------------------ de stand */

  /** Haalt het abonnement zelf op bij Stripe; een melding wordt nooit op haar woord geloofd. */
  async function haalStripeAbonnement(id: string): Promise<Antwoord<StripeAbonnement>> {
    if (!isAbonnementId(id)) return mislukt(404, "abonnement_onbekend");
    const antwoord = await vraag(`subscriptions/${id}`);
    if (!antwoord.ok) return antwoord;
    const a = antwoord.waarde;
    const status = tekst(a.status);
    if (tekst(a.id) !== id || !status) return mislukt(0, "stripe_onbegrepen");
    const regel = lijst(a.items)[0] ?? null;
    const prijs = object(regel?.price);
    const lookupKey = tekst(prijs?.lookup_key);
    const interval = tekst(object(prijs?.recurring)?.interval);
    const eigenProduct = productVan(prijs) === namen.product;
    // Een prijs zonder lookup key (na "Transfer lookup key") wordt herkend aan haar interval, maar alleen bij het eigen product.
    const plan: Plan | null = !eigenProduct ? null : lookupKey === namen.plannen.jaar.lookupKey || interval === "year" ? "jaar" : lookupKey === namen.plannen.maand.lookupKey || interval === "month" ? "maand" : null;
    const klant = typeof a.customer === "string" ? a.customer : tekst(object(a.customer)?.id);
    return {
      ok: true,
      waarde: {
        id,
        organisatieId: tekst(object(a.metadata)?.organisatie_id),
        klantId: isKlantId(klant) ? klant : null,
        eigenProduct,
        plan,
        status,
        live: a.livemode === true,
        proefTot: moment(a.trial_end),
        // Sinds 2025 staat het einde van de periode bij de regel, daarvoor bij het abonnement.
        periodeTot: moment(regel?.current_period_end) ?? moment(a.current_period_end),
        stoptOp: moment(a.ended_at) ?? moment(a.cancel_at) ?? (a.cancel_at_period_end === true ? (moment(regel?.current_period_end) ?? moment(a.current_period_end)) : null),
      },
    };
  }

  /** Een afgeronde betaalsessie: bij welke organisatie en welk abonnement hoort zij? */
  async function haalAfrekening(id: string): Promise<Antwoord<{ organisatieId: string | null; abonnementId: string | null }>> {
    if (!isSessieId(id)) return mislukt(404, "sessie_onbekend");
    const antwoord = await vraag(`checkout/sessions/${id}`);
    if (!antwoord.ok) return antwoord;
    const s = antwoord.waarde;
    const abonnement = typeof s.subscription === "string" ? s.subscription : tekst(object(s.subscription)?.id);
    return { ok: true, waarde: { organisatieId: tekst(s.client_reference_id), abonnementId: isAbonnementId(abonnement) ? abonnement : null } };
  }

  /* ------------------------------------------------------ klant bij een andere app */

  /** Zit er een lopend abonnement op een andere app van Jona tussen? */
  function looptElders(abonnementen: Rauw[]): boolean {
    return abonnementen.some(
      (abonnement) =>
        LOPEND.has(String(abonnement.status)) &&
        lijst(abonnement.items).some((regel) => {
          const product = productVan(object(regel.price));
          return product !== null && product !== namen.product && product.startsWith(JONA_VOORVOEGSEL);
        }),
    );
  }

  /** Heeft deze klant een lopend abonnement op een andere app van Jona? Dan geldt de bundelkorting. */
  async function klantLooptElders(klantId: string): Promise<Antwoord<boolean>> {
    if (!isKlantId(klantId)) return { ok: true, waarde: false };
    const antwoord = await vraag(`subscriptions?${new URLSearchParams([["customer", klantId], ["status", "all"], ["limit", "50"]]).toString()}`);
    if (!antwoord.ok) return antwoord;
    return { ok: true, waarde: looptElders(lijst(antwoord.waarde)) };
  }

  /** De coupon van de bundelkorting; maakt hem aan als hij er nog niet is. */
  async function zorgVoorBundelcoupon(): Promise<Antwoord<string>> {
    const bestaand = await vraag(`coupons/${BUNDEL_COUPON}`);
    if (bestaand.ok) return { ok: true, waarde: BUNDEL_COUPON };
    if (bestaand.status !== 404) return bestaand;
    const nieuw = await vraag("coupons", {
      methode: "POST",
      velden: [
        ["id", BUNDEL_COUPON],
        ["name", `Bundelkorting Jona ${BUNDELKORTING}%`],
        ["percent_off", String(BUNDELKORTING)],
        ["duration", "forever"],
      ],
    });
    if (nieuw.ok) return { ok: true, waarde: BUNDEL_COUPON };
    // Een andere app van Jona kan de coupon op hetzelfde moment hebben aangemaakt.
    const opnieuw = await vraag(`coupons/${BUNDEL_COUPON}`);
    return opnieuw.ok ? { ok: true, waarde: BUNDEL_COUPON } : nieuw;
  }

  /**
   * Zoekt een klant met dit e-mailadres die al een lopend abonnement heeft op
   * een andere app van Jona in hetzelfde Stripe-account (een product dat met
   * `jona_` begint en niet dat van deze app is). Zo'n klant kan ook dit
   * abonnement dragen: één plek voor facturen en betaalwijze.
   *
   * Het e-mailadres in de app is niet bevestigd. Wie hier een klant vindt, mag
   * die dus nooit zomaar gebruiken: eerst de bevestiging per e-mail.
   */
  async function zoekKlantElders(email: string): Promise<Antwoord<string | null>> {
    const adres = email.trim().toLowerCase();
    if (!adres) return { ok: true, waarde: null };
    const vraagtekst = new URLSearchParams([
      ["email", adres],
      ["limit", "10"],
      ["expand[]", "data.subscriptions"],
    ]).toString();
    const antwoord = await vraag(`customers?${vraagtekst}`);
    if (!antwoord.ok) return antwoord;
    for (const klant of lijst(antwoord.waarde)) {
      if (!isKlantId(klant.id) || klant.deleted === true) continue;
      if (looptElders(lijst(klant.subscriptions))) return { ok: true, waarde: klant.id };
    }
    return { ok: true, waarde: null };
  }

  return { namen, sleutel, lees, vergeetInrichting, zorgVoorInrichting, maakAfrekening, maakPortaal, haalStripeAbonnement, haalAfrekening, klantLooptElders, zoekKlantElders };
}
