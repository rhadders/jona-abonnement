/**
 * De meldingen die het pakket teruggeeft, elk met een vaste code. De app toont
 * de Nederlandse zin, of vertaalt zelf op de code.
 *
 * Technische uitleg van Stripe (een statuscode, de tekst van Stripe) is vrije
 * tekst zonder code: die is voor het logboek, niet voor het scherm.
 */
export const FOUTEN = {
  abonnementen_uit: "Abonnementen staan nog niet aan.",
  betaalpagina_mislukt: "De betaalpagina kon niet worden geopend. Probeer het later opnieuw.",
  geen_abonnement: "Er is nog geen abonnement.",
  portaal_mislukt: "Het overzicht bij Stripe kon niet worden geopend. Probeer het later opnieuw.",
  koppelen_kan_niet: "Koppelen kan op deze installatie niet.",
  abonnement_loopt: "Er loopt al een abonnement.",
  organisatie_al_gekoppeld: "Deze organisatie is al aan een klant gekoppeld.",
  zoeken_mislukt: "Het zoeken lukte nu niet. Probeer het later opnieuw.",
  koppellink_verlopen: "Deze link is verlopen of hoort bij een andere organisatie. Vraag een nieuwe link aan.",
  abonnement_loopt_koppelen: "Er loopt al een abonnement. Koppelen kan alleen voordat je een abonnement kiest.",
  organisatie_heeft_klant: "Deze organisatie heeft al eigen klantgegevens bij Stripe.",
  abonnementen_sleutel_ontbreekt: "Abonnementen staan uit: ABONNEMENT_STRIPE_SECRET_KEY ontbreekt.",
  stripe_onbereikbaar: "Stripe is nu niet bereikbaar. Probeer het later opnieuw.",
  stripe_geen_prijs: "Stripe gaf geen prijs terug.",
  stripe_geen_portaal: "Stripe gaf geen portaal terug.",
  stripe_geen_betaalpagina: "Stripe gaf geen betaalpagina terug.",
  stripe_onbegrepen: "Stripe gaf een antwoord dat de app niet begrijpt.",
  abonnement_onbekend: "Onbekend abonnement.",
  sessie_onbekend: "Onbekende sessie.",
} as const;

export type Foutcode = keyof typeof FOUTEN;

export type Mislukt = { ok: false; fout: string; code?: Foutcode };

/** Een verwachte fout met een vaste code en de zin erbij. */
export const faalt = <C extends Foutcode>(code: C): { ok: false; fout: string; code: C } => ({ ok: false, fout: FOUTEN[code], code });
