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
  geen_lopend_abonnement: "Er is geen lopend abonnement.",
  al_opgezegd: "Het abonnement is al opgezegd.",
  opzeggen_mislukt: "Opzeggen bij Stripe kon niet worden geopend. Probeer het later opnieuw.",
  geen_opzegging: "Er is geen opzegging om terug te draaien.",
  terugdraaien_mislukt: "Terugdraaien lukte nu niet. Probeer het later opnieuw.",
  organisatie_al_gekoppeld: "Deze organisatie is al aan een klant gekoppeld.",
  koppelcode_alleen_met_abonnement: "Een koppelcode maken kan alleen als er een abonnement loopt.",
  koppelcode_maken_mislukt: "Het maken van een code lukte nu niet. Probeer het later opnieuw.",
  koppelcode_intrekken_mislukt: "Intrekken lukte nu niet. Probeer het later opnieuw.",
  koppelcode_ongeldig: "Deze code klopt niet of is verlopen. Vraag een nieuwe code aan. Is de code net gemaakt? Dan kan het een minuut duren voordat hij werkt.",
  koppelcode_te_vaak: "Er is te vaak een verkeerde code ingevuld. Probeer het over een uur opnieuw.",
  koppelcode_zelfde_app: "Deze code is in deze app gemaakt. Gebruik hem in een andere app van Jona.",
  koppelcode_controleren_mislukt: "Het controleren lukte nu niet. Probeer het later opnieuw.",
  koppelen_mislukt: "Koppelen lukte nu niet. Probeer het later opnieuw.",
  abonnement_loopt_koppelen: "Er loopt al een abonnement. Koppelen kan alleen voordat er een abonnement is gekozen.",
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
