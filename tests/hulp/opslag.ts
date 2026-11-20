import type { Opslag, Rij } from "../../src/index.js";

/**
 * Een opslag in het geheugen, in de vorm die een app aanlevert bovenop haar
 * eigen database. `bewerk` laat per organisatie één bewerking tegelijk toe,
 * zoals de vergrendelde rij in een echte database.
 */
export function maakGeheugenopslag() {
  const organisaties = new Map<string, Date>();
  const rijen = new Map<string, Rij>();
  const wachtrij = new Map<string, Promise<unknown>>();
  const logboek: { organisatieId: string; namens: string; actie: string; details?: Record<string, unknown> }[] = [];
  const gelezenNamens: string[] = [];
  const LEEG: Rij = { stripeKlantId: null, stripeAbonnementId: null, plan: null, status: null, live: false, proefTot: null, periodeTot: null, stoptOp: null, vrijgesteld: false, proefVerlengdTot: null };

  const opslag: Opslag = {
    aangemaaktOp: async (organisatieId) => organisaties.get(organisatieId) ?? null,
    leesRij: async (organisatieId, namens) => {
      gelezenNamens.push(namens);
      return rijen.get(organisatieId) ?? null;
    },
    bewerk: (organisatieId, namens, fn) => {
      const beurt = (wachtrij.get(organisatieId) ?? Promise.resolve()).then(() =>
        fn({
          huidig: rijen.get(organisatieId) ?? null,
          schrijf: async (velden) => {
            rijen.set(organisatieId, { ...(rijen.get(organisatieId) ?? LEEG), ...velden });
          },
          log: async (actie, details) => {
            logboek.push({ organisatieId, namens, actie, ...(details ? { details } : {}) });
          },
        }),
      );
      wachtrij.set(organisatieId, beurt.catch(() => undefined));
      return beurt;
    },
  };

  return {
    opslag,
    logboek,
    gelezenNamens,
    rijen,
    /** Een organisatie die zoveel dagen geleden is aangemaakt. */
    organisatie: (id: string, dagenGeleden = 0) => organisaties.set(id, new Date(Date.now() - dagenGeleden * 24 * 3600_000)),
    zet: (id: string, velden: Partial<Rij>) => rijen.set(id, { ...(rijen.get(id) ?? LEEG), ...velden }),
  };
}
