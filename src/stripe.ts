import { faalt, type Foutcode } from "./fouten.js";
import { isAbonnementId, isKlantId, isSessieId, object, tekst, type Rauw } from "./meldingen.js";
import { BUNDEL_COUPON, BUNDELKORTING, JONA_VOORVOEGSEL, KOPPEL, namenVan, PLANNEN, type Namen, type Plan, type Portaalsoort } from "./namen.js";

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

/** Een klant bij Stripe, met de koppelcode uit zijn metadata. */
export type KlantMetCode = { id: string; naam: string | null; email: string | null; hash: string | null; tot: Date | null; app: string | null };

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
  const portalen: Partial<Record<Portaalsoort, Promise<Antwoord<string>>>> = {};

  /** Alleen voor tests: vergeet wat er bij Stripe is opgezocht. */
  function vergeetInrichting() {
    inrichting = null;
    for (const soort of Object.keys(portalen) as Portaalsoort[]) delete portalen[soort];
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

  /*
   * Twee instellingen voor het klantportaal. De klant bij Stripe kan gedeeld
   * zijn met andere apps van Jona (zie koppelcode.ts), en het portaal toont
   * alle abonnementen van de klant. Daarom kan in het gewone portaal niemand
   * opzeggen: alleen facturen, betaalwijze, klantgegevens en wisselen tussen
   * jaar en maand (en dat alleen voor het product van deze app).
   *
   * Opzeggen gaat met een eigen knop in de app. Die opent het portaal met de
   * tweede instelling, in de flow `subscription_cancel` voor alleen het
   * abonnement van deze organisatie. Een flow verbergt de rest van het
   * portaal, en na het opzeggen gaat de klant meteen terug naar de app.
   */
  function zorgVoorPortaal(soort: Portaalsoort, prijzen: Record<Plan, string>): Promise<Antwoord<string>> {
    if (!portalen[soort]) {
      portalen[soort] = richtPortaalIn(soort, prijzen).then((uitkomst) => {
        if (!uitkomst.ok) delete portalen[soort];
        return uitkomst;
      });
    }
    return portalen[soort]!;
  }

  async function richtPortaalIn(soort: Portaalsoort, prijzen: Record<Plan, string>): Promise<Antwoord<string>> {
    const { sleutel, eenmalig } = namen.portalen[soort];
    const bestaand = await vraag("billing_portal/configurations?active=true&limit=100");
    if (!bestaand.ok) return bestaand;
    const gevonden = lijst(bestaand.waarde).find((c) => object(c.metadata)?.[namen.metadata] === sleutel);
    if (gevonden && tekst(gevonden.id)) return { ok: true, waarde: tekst(gevonden.id)! };
    const velden: Velden =
      soort === "algemeen"
        ? [
            ["business_profile[headline]", `${instelling.naam}: facturen en betaalwijze`],
            ["features[invoice_history][enabled]", "true"],
            ["features[payment_method_update][enabled]", "true"],
            ["features[customer_update][enabled]", "true"],
            ["features[customer_update][allowed_updates][0]", "name"],
            ["features[customer_update][allowed_updates][1]", "email"],
            ["features[customer_update][allowed_updates][2]", "address"],
            ["features[customer_update][allowed_updates][3]", "tax_id"],
            ["features[subscription_cancel][enabled]", "false"],
            ["features[subscription_update][enabled]", "true"],
            ["features[subscription_update][default_allowed_updates][0]", "price"],
            ["features[subscription_update][proration_behavior]", "create_prorations"],
            ["features[subscription_update][products][0][product]", namen.product],
            ["features[subscription_update][products][0][prices][0]", prijzen.jaar],
            ["features[subscription_update][products][0][prices][1]", prijzen.maand],
          ]
        : [
            ["business_profile[headline]", `${instelling.naam}: abonnement opzeggen`],
            ["features[invoice_history][enabled]", "false"],
            ["features[payment_method_update][enabled]", "false"],
            ["features[customer_update][enabled]", "false"],
            ["features[subscription_update][enabled]", "false"],
            ["features[subscription_cancel][enabled]", "true"],
            ["features[subscription_cancel][mode]", "at_period_end"],
          ];
    const nieuw = await vraag("billing_portal/configurations", { methode: "POST", eenmalig, velden: [...velden, [`metadata[${namen.metadata}]`, sleutel]] });
    if (!nieuw.ok) return nieuw;
    const id = tekst(nieuw.waarde.id);
    return id ? { ok: true, waarde: id } : mislukt(0, "stripe_geen_portaal");
  }

  async function portaalSessie(soort: Portaalsoort, velden: Velden): Promise<Antwoord<string>> {
    const ingericht = await zorgVoorInrichting();
    if (!ingericht.ok) return ingericht;
    const configuratie = await zorgVoorPortaal(soort, ingericht.waarde.prijzen);
    if (!configuratie.ok) return configuratie;
    const antwoord = await vraag("billing_portal/sessions", { methode: "POST", velden: [...velden, ["configuration", configuratie.waarde], ["locale", "nl"]] });
    if (!antwoord.ok) return antwoord;
    const url = tekst(antwoord.waarde.url);
    return url && /^https:\/\//.test(url) ? { ok: true, waarde: url } : mislukt(0, "stripe_geen_portaal");
  }

  /** Het klantportaal van Stripe: facturen, betaalwijze en wisselen tussen jaar en maand. Opzeggen kan hier niet. */
  function maakPortaal(klantId: string, terugadres: string): Promise<Antwoord<string>> {
    return portaalSessie("algemeen", [
      ["customer", klantId],
      ["return_url", terugadres],
    ]);
  }

  /** Het portaal in de flow voor opzeggen, voor alleen dit abonnement. Na het opzeggen gaat de klant naar `naOpzeggen`. */
  function maakOpzegPortaal(invoer: { klantId: string; abonnementId: string; terugadres: string; naOpzeggen: string }): Promise<Antwoord<string>> {
    return portaalSessie("opzeggen", [
      ["customer", invoer.klantId],
      ["return_url", invoer.terugadres],
      ["flow_data[type]", "subscription_cancel"],
      ["flow_data[subscription_cancel][subscription]", invoer.abonnementId],
      ["flow_data[after_completion][type]", "redirect"],
      ["flow_data[after_completion][redirect][return_url]", invoer.naOpzeggen],
    ]);
  }

  /**
   * Draait een opzegging terug: het abonnement loopt dan gewoon door. Stripe
   * legt een opzegging per einde periode vast als `cancel_at_period_end` of
   * (sinds 2025) als `cancel_at`; beide worden gewist.
   */
  async function zetOpzeggingTerug(abonnementId: string): Promise<Antwoord<true>> {
    if (!isAbonnementId(abonnementId)) return mislukt(404, "abonnement_onbekend");
    const eerst = await vraag(`subscriptions/${abonnementId}`, { methode: "POST", velden: [["cancel_at_period_end", "false"]] });
    if (!eerst.ok) return eerst;
    if (eerst.waarde.cancel_at === null || eerst.waarde.cancel_at === undefined) return { ok: true, waarde: true };
    const daarna = await vraag(`subscriptions/${abonnementId}`, { methode: "POST", velden: [["cancel_at", ""]] });
    return daarna.ok ? { ok: true, waarde: true } : daarna;
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

  /* ---------------------------------------------------- koppelcodes */

  function klantMetCode(klant: Rauw): KlantMetCode | null {
    if (!isKlantId(klant.id) || klant.deleted === true) return null;
    const metadata = object(klant.metadata) ?? {};
    const hash = tekst(metadata[KOPPEL.code]);
    const tot = Number(tekst(metadata[KOPPEL.tot]));
    return {
      id: klant.id,
      naam: tekst(klant.name),
      email: tekst(klant.email),
      hash: hash && /^[0-9a-f]{64}$/.test(hash) ? hash : null,
      tot: Number.isFinite(tot) && tot > 0 ? new Date(tot * 1000) : null,
      app: tekst(metadata[KOPPEL.app]),
    };
  }

  /** Een klant met de koppelcode in zijn metadata; `null` als hij niet bestaat of is verwijderd. */
  async function haalKlant(klantId: string): Promise<Antwoord<KlantMetCode | null>> {
    if (!isKlantId(klantId)) return { ok: true, waarde: null };
    const antwoord = await vraag(`customers/${klantId}`);
    if (!antwoord.ok) return antwoord.status === 404 ? { ok: true, waarde: null } : antwoord;
    return { ok: true, waarde: klantMetCode(antwoord.waarde) };
  }

  /** Zet een koppelcode (als hash) bij de klant, of wist hem met `null`. Een lege waarde wist een sleutel bij Stripe. */
  async function zetKoppelcode(klantId: string, code: { hash: string; tot: Date } | null): Promise<Antwoord<true>> {
    const antwoord = await vraag(`customers/${klantId}`, {
      methode: "POST",
      velden: [
        [`metadata[${KOPPEL.code}]`, code?.hash ?? ""],
        [`metadata[${KOPPEL.tot}]`, code ? String(Math.floor(code.tot.getTime() / 1000)) : ""],
        [`metadata[${KOPPEL.app}]`, code ? instelling.app : ""],
      ],
    });
    return antwoord.ok ? { ok: true, waarde: true } : antwoord;
  }

  /**
   * De klant bij de hash van een koppelcode, via de zoekfunctie van Stripe. Die
   * loopt iets achter (meestal minder dan een minuut), dus elke gevonden klant
   * wordt daarna nog direct opgehaald en opnieuw gecontroleerd.
   */
  async function zoekKlantOpKoppelcode(hash: string): Promise<Antwoord<KlantMetCode | null>> {
    if (!/^[0-9a-f]{64}$/.test(hash)) return { ok: true, waarde: null };
    const antwoord = await vraag(`customers/search?${new URLSearchParams([["query", `metadata['${KOPPEL.code}']:'${hash}'`], ["limit", "10"]]).toString()}`);
    if (!antwoord.ok) return antwoord;
    for (const gevonden of lijst(antwoord.waarde)) {
      if (!isKlantId(gevonden.id)) continue;
      const klant = await haalKlant(gevonden.id);
      if (!klant.ok) return klant;
      if (klant.waarde?.hash === hash) return klant;
    }
    return { ok: true, waarde: null };
  }

  return { namen, sleutel, lees, vergeetInrichting, zorgVoorInrichting, maakAfrekening, maakPortaal, maakOpzegPortaal, zetOpzeggingTerug, haalStripeAbonnement, haalAfrekening, klantLooptElders, haalKlant, zetKoppelcode, zoekKlantOpKoppelcode };
}
