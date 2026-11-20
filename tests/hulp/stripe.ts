import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Een nagebootst Stripe: net genoeg om de inrichting, de betaalpagina, het
 * portaal, opzeggen, abonnementen, klanten met een koppelcode en de coupon te
 * testen. Alle gegevens zijn
 * verzonnen.
 */

export type NepAbonnement = { id: string; status: string; organisatie: string; klant: string; interval: "year" | "month"; trialEnd: number | null; periodeEind: number; cancelAtPeriodEnd: boolean; product?: string };

export function maakNepStripe(app: string) {
  const product = `jona_${app}_abonnement`;
  const stand = {
    prijzen: new Map<string, { id: string; lookup_key: string; unit_amount: number; interval: string; tax_behavior: string }>(),
    product: null as URLSearchParams | null,
    btw: [] as string[],
    portalen: [] as { id: string; velden: URLSearchParams }[],
    portaalsessies: [] as URLSearchParams[],
    sessies: [] as URLSearchParams[],
    abonnementen: new Map<string, NepAbonnement>(),
    afrekeningen: new Map<string, { client_reference_id: string; subscription: string }>(),
    verzoeken: [] as string[],
    eenmalig: [] as string[],
    sleutels: new Set<string>(),
    versies: new Set<string>(),
    klanten: [] as { id: string; email: string; naam?: string; metadata?: Record<string, string>; abonnementen: { status: string; product: string }[] }[],
    /** Wat de zoekfunctie van Stripe nog niet ziet (die loopt achter). */
    zoekenLooptAchter: false,
    coupons: new Set<string>(),
    couponsGemaakt: 0,
  };

  const abonnementJson = (a: NepAbonnement) => ({
    id: a.id,
    object: "subscription",
    status: a.status,
    livemode: false,
    customer: a.klant,
    metadata: { organisatie_id: a.organisatie },
    trial_end: a.trialEnd,
    cancel_at_period_end: a.cancelAtPeriodEnd,
    cancel_at: null,
    ended_at: a.status === "canceled" ? Math.floor(Date.now() / 1000) : null,
    items: { data: [{ current_period_end: a.periodeEind, price: { product: a.product ?? product, lookup_key: a.product ? null : a.interval === "year" ? `jona_${app}_jaar` : `jona_${app}_maand`, recurring: { interval: a.interval } } }] },
  });

  const server: Server = createServer((verzoek, antwoord) => {
    let inhoud = "";
    verzoek.on("data", (deel) => (inhoud += deel));
    verzoek.on("end", () => {
      const url = new URL(verzoek.url ?? "/", "http://stripe");
      stand.verzoeken.push(`${verzoek.method} ${url.pathname}`);
      stand.sleutels.add(String(verzoek.headers.authorization));
      stand.versies.add(String(verzoek.headers["stripe-version"]));
      if (verzoek.headers["idempotency-key"]) stand.eenmalig.push(String(verzoek.headers["idempotency-key"]));
      const velden = new URLSearchParams(inhoud);
      const geef = (status: number, lichaam: unknown) => {
        antwoord.writeHead(status, { "Content-Type": "application/json" });
        antwoord.end(JSON.stringify(lichaam));
      };
      const pad = url.pathname;
      if (pad === "/v1/prices" && verzoek.method === "GET") {
        const gevraagd = url.searchParams.getAll("lookup_keys[]");
        return geef(200, { data: [...stand.prijzen.values()].filter((p) => gevraagd.includes(p.lookup_key)) });
      }
      if (pad === "/v1/prices" && verzoek.method === "POST") {
        const prijs = { id: `price_${velden.get("lookup_key")}`, lookup_key: velden.get("lookup_key")!, unit_amount: Number(velden.get("unit_amount")), interval: velden.get("recurring[interval]")!, tax_behavior: velden.get("tax_behavior")! };
        stand.prijzen.set(prijs.id, prijs);
        return geef(200, prijs);
      }
      if (pad === `/v1/products/${product}`) return stand.product ? geef(200, { id: product }) : geef(404, { error: { message: "No such product" } });
      if (pad === "/v1/products") {
        stand.product = velden;
        return geef(200, { id: velden.get("id") });
      }
      if (pad === "/v1/tax_rates" && verzoek.method === "GET") return geef(200, { data: stand.btw.map((id) => ({ id, percentage: 21, metadata: { [`jona_${app}`]: "btw" } })) });
      if (pad === "/v1/tax_rates") {
        stand.btw.push("txr_btw21");
        return geef(200, { id: "txr_btw21" });
      }
      if (pad === "/v1/billing_portal/configurations" && verzoek.method === "GET")
        // De oude instelling (met opzeggen) bestaat al bij Stripe, en wordt niet meer gebruikt.
        return geef(200, { data: [{ id: "bpc_oud", metadata: { [`jona_${app}`]: "abonnement" } }, ...stand.portalen.map((p) => ({ id: p.id, metadata: { [`jona_${app}`]: p.velden.get(`metadata[jona_${app}]`) } }))] });
      if (pad === "/v1/billing_portal/configurations") {
        const id = `bpc_${velden.get(`metadata[jona_${app}]`)!.replace(/\W/g, "")}`;
        stand.portalen.push({ id, velden });
        return geef(200, { id });
      }
      if (pad === "/v1/billing_portal/sessions") {
        stand.portaalsessies.push(velden);
        return geef(200, { url: `https://billing.stripe.com/p/session/${velden.get("customer")}` });
      }
      if (pad === "/v1/checkout/sessions" && verzoek.method === "POST") {
        stand.sessies.push(velden);
        return geef(200, { id: `cs_test_${"a".repeat(20)}${stand.sessies.length}`, url: `https://checkout.stripe.com/c/pay/${stand.sessies.length}` });
      }
      const sessie = pad.match(/^\/v1\/checkout\/sessions\/(cs_test_\w+)$/);
      if (sessie) {
        const s = stand.afrekeningen.get(sessie[1]!);
        return s ? geef(200, { id: sessie[1], ...s }) : geef(404, { error: { message: "No such session" } });
      }
      const klantJson = (k: (typeof stand.klanten)[number]) => ({ id: k.id, object: "customer", email: k.email, name: k.naam ?? null, metadata: k.metadata ?? {} });
      if (pad === "/v1/customers/search" && verzoek.method === "GET") {
        const gezocht = url.searchParams.get("query")?.match(/^metadata\['jona_koppelcode'\]:'([0-9a-f]{64})'$/);
        if (!gezocht) return geef(400, { error: { message: "Onbekende zoekvraag" } });
        return geef(200, { data: stand.zoekenLooptAchter ? [] : stand.klanten.filter((k) => k.metadata?.jona_koppelcode === gezocht[1]).map(klantJson) });
      }
      const klant = pad.match(/^\/v1\/customers\/(cus_\w+)$/);
      if (klant) {
        const k = stand.klanten.find((x) => x.id === klant[1]);
        if (!k) return geef(404, { error: { message: "No such customer" } });
        if (verzoek.method === "POST") {
          k.metadata ??= {};
          for (const [sleutel, waarde] of velden) {
            const naam = sleutel.match(/^metadata\[(\w+)\]$/)?.[1];
            if (!naam) continue;
            if (waarde === "") delete k.metadata[naam];
            else k.metadata[naam] = waarde;
          }
        }
        return geef(200, klantJson(k));
      }
      if (pad === "/v1/subscriptions" && verzoek.method === "GET") {
        const klant = stand.klanten.find((k) => k.id === url.searchParams.get("customer"));
        return geef(200, { data: (klant?.abonnementen ?? []).map((a) => ({ status: a.status, items: { data: [{ price: { product: a.product } }] } })) });
      }
      const coupon = pad.match(/^\/v1\/coupons\/(\w+)$/);
      if (coupon) return stand.coupons.has(coupon[1]!) ? geef(200, { id: coupon[1] }) : geef(404, { error: { message: "No such coupon" } });
      if (pad === "/v1/coupons" && verzoek.method === "POST") {
        stand.coupons.add(velden.get("id")!);
        stand.couponsGemaakt++;
        return geef(200, { id: velden.get("id"), percent_off: Number(velden.get("percent_off")), duration: velden.get("duration") });
      }
      const abo = pad.match(/^\/v1\/subscriptions\/(sub_\w+)$/);
      if (abo) {
        const a = stand.abonnementen.get(abo[1]!);
        if (a && verzoek.method === "POST" && velden.get("cancel_at_period_end") === "false") a.cancelAtPeriodEnd = false;
        return a ? geef(200, abonnementJson(a)) : geef(404, { error: { message: "No such subscription" } });
      }
      geef(404, { error: { message: `Onbekend: ${pad}` } });
    });
  });

  return {
    stand,
    /** Start de server en geeft het adres terug. */
    start: async () => {
      await new Promise<void>((klaar) => server.listen(0, "127.0.0.1", klaar));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    stop: () => new Promise((klaar) => server.close(klaar)),
  };
}
