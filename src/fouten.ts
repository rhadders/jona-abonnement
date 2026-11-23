import { leesTaal, type Taal } from "./taal.js";

/**
 * De meldingen die het pakket teruggeeft, elk met een vaste code. De uitkomst
 * draagt de Nederlandse zin; `foutIn(code, taal)` geeft dezelfde zin in het
 * Engels of Duits, voor het scherm van wie in die taal werkt.
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

const FOUTEN_EN: Record<Foutcode, string> = {
  abonnementen_uit: "Subscriptions aren't switched on yet.",
  betaalpagina_mislukt: "The payment page couldn't be opened. Please try again later.",
  geen_abonnement: "There's no subscription yet.",
  portaal_mislukt: "The Stripe overview couldn't be opened. Please try again later.",
  geen_lopend_abonnement: "There's no active subscription.",
  al_opgezegd: "The subscription has already been cancelled.",
  opzeggen_mislukt: "Cancelling at Stripe couldn't be opened. Please try again later.",
  geen_opzegging: "There's no cancellation to undo.",
  terugdraaien_mislukt: "Undoing didn't work just now. Please try again later.",
  organisatie_al_gekoppeld: "This organisation is already linked to a customer.",
  koppelcode_alleen_met_abonnement: "You can only create a link code while a subscription is active.",
  koppelcode_maken_mislukt: "Creating a code didn't work just now. Please try again later.",
  koppelcode_intrekken_mislukt: "Withdrawing didn't work just now. Please try again later.",
  koppelcode_ongeldig: "This code isn't right or has expired. Ask for a new code. Was the code only just created? Then it can take a minute before it works.",
  koppelcode_te_vaak: "A wrong code has been entered too many times. Please try again in an hour.",
  koppelcode_zelfde_app: "This code was created in this app. Use it in another Jona app.",
  koppelcode_controleren_mislukt: "Checking didn't work just now. Please try again later.",
  koppelen_mislukt: "Linking didn't work just now. Please try again later.",
  abonnement_loopt_koppelen: "A subscription is already active. Linking is only possible before a subscription has been chosen.",
  organisatie_heeft_klant: "This organisation already has its own customer details at Stripe.",
  abonnementen_sleutel_ontbreekt: "Subscriptions are switched off: ABONNEMENT_STRIPE_SECRET_KEY is missing.",
  stripe_onbereikbaar: "Stripe can't be reached right now. Please try again later.",
  stripe_geen_prijs: "Stripe didn't return a price.",
  stripe_geen_portaal: "Stripe didn't return a portal.",
  stripe_geen_betaalpagina: "Stripe didn't return a payment page.",
  stripe_onbegrepen: "Stripe gave a response the app doesn't understand.",
  abonnement_onbekend: "Unknown subscription.",
  sessie_onbekend: "Unknown session.",
};

const FOUTEN_DE: Record<Foutcode, string> = {
  abonnementen_uit: "Abonnements sind noch nicht eingeschaltet.",
  betaalpagina_mislukt: "Die Zahlungsseite konnte nicht geöffnet werden. Versuche es später noch einmal.",
  geen_abonnement: "Es gibt noch kein Abonnement.",
  portaal_mislukt: "Die Übersicht bei Stripe konnte nicht geöffnet werden. Versuche es später noch einmal.",
  geen_lopend_abonnement: "Es gibt kein laufendes Abonnement.",
  al_opgezegd: "Das Abonnement ist bereits gekündigt.",
  opzeggen_mislukt: "Die Kündigung bei Stripe konnte nicht geöffnet werden. Versuche es später noch einmal.",
  geen_opzegging: "Es gibt keine Kündigung, die rückgängig gemacht werden kann.",
  terugdraaien_mislukt: "Das Rückgängigmachen hat gerade nicht geklappt. Versuche es später noch einmal.",
  organisatie_al_gekoppeld: "Diese Organisation ist bereits mit einem Kunden verknüpft.",
  koppelcode_alleen_met_abonnement: "Einen Verknüpfungscode kannst du nur erstellen, wenn ein Abonnement läuft.",
  koppelcode_maken_mislukt: "Das Erstellen eines Codes hat gerade nicht geklappt. Versuche es später noch einmal.",
  koppelcode_intrekken_mislukt: "Das Zurückziehen hat gerade nicht geklappt. Versuche es später noch einmal.",
  koppelcode_ongeldig: "Dieser Code stimmt nicht oder ist abgelaufen. Fordere einen neuen Code an. Wurde der Code gerade erst erstellt? Dann kann es eine Minute dauern, bis er funktioniert.",
  koppelcode_te_vaak: "Es wurde zu oft ein falscher Code eingegeben. Versuche es in einer Stunde noch einmal.",
  koppelcode_zelfde_app: "Dieser Code wurde in dieser App erstellt. Verwende ihn in einer anderen App von Jona.",
  koppelcode_controleren_mislukt: "Die Prüfung hat gerade nicht geklappt. Versuche es später noch einmal.",
  koppelen_mislukt: "Das Verknüpfen hat gerade nicht geklappt. Versuche es später noch einmal.",
  abonnement_loopt_koppelen: "Es läuft bereits ein Abonnement. Verknüpfen geht nur, bevor ein Abonnement gewählt wurde.",
  organisatie_heeft_klant: "Diese Organisation hat bei Stripe bereits eigene Kundendaten.",
  abonnementen_sleutel_ontbreekt: "Abonnements sind ausgeschaltet: ABONNEMENT_STRIPE_SECRET_KEY fehlt.",
  stripe_onbereikbaar: "Stripe ist gerade nicht erreichbar. Versuche es später noch einmal.",
  stripe_geen_prijs: "Stripe hat keinen Preis zurückgegeben.",
  stripe_geen_portaal: "Stripe hat kein Portal zurückgegeben.",
  stripe_geen_betaalpagina: "Stripe hat keine Zahlungsseite zurückgegeben.",
  stripe_onbegrepen: "Stripe hat eine Antwort gegeben, die die App nicht versteht.",
  abonnement_onbekend: "Unbekanntes Abonnement.",
  sessie_onbekend: "Unbekannte Sitzung.",
};

const PER_TAAL: Record<Taal, Record<Foutcode, string>> = { nl: FOUTEN, en: FOUTEN_EN, de: FOUTEN_DE };

/** De zin bij een code in de gevraagde taal; een onbekende taal geeft Nederlands. */
export const foutIn = (code: Foutcode, taal: unknown): string => PER_TAAL[leesTaal(taal)][code];

export type Mislukt = { ok: false; fout: string; code?: Foutcode };

/** Een verwachte fout met een vaste code en de zin erbij. */
export const faalt = <C extends Foutcode>(code: C): { ok: false; fout: string; code: C } => ({ ok: false, fout: FOUTEN[code], code });
