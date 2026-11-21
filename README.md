# @jona/abonnement

Het abonnement van een organisatie op een app van Jona, op één plek. Elke app
van Jona (Jona Giften, Jona Bestuur, Jona Roosters) gebruikt dit pakket, zodat de regels
overal gelijk zijn: 14 dagen proef, per jaar of per maand, het klantportaal
van Stripe, opzeggen, koppelen aan een bestaande klant met een koppelcode en
15% bundelkorting.

Het is een pakket, geen dienst. Elke app praat zelf met Stripe en bewaart zelf
de stand in haar eigen tabel `abonnementen`. Het pakket kent geen database,
geen Next.js en geen React.

## Wat erin zit

- **Stripe voor het abonnement.** Het product, de twee prijzen (inclusief
  btw), het btw-tarief van 21% en de instellingen van het klantportaal maakt
  het pakket aan als ze ontbreken, en vindt ze daarna terug op een vaste naam.
  De betaalpagina (Checkout), het klantportaal, een abonnement ophalen.
- **Opzeggen** van alleen het eigen abonnement, en een opzegging terugdraaien.
- **De stand**: `bepaalStand()` zegt of een organisatie in de proef zit, een
  abonnement heeft, is vrijgesteld of geen toegang meer heeft.
- **Meldingen van Stripe**: de handtekening controleren en het abonnement
  daarna zelf ophalen, zodat de volgorde van meldingen er niet toe doet.
- **Koppelen aan een bestaande klant** bij een andere app van Jona, met een
  koppelcode die 7 dagen geldt, en de **bundelkorting**.
- **De vaste waarden** van alle apps samen: de prijzen, `PROEFDAGEN`,
  `MET_TOEGANG`, `BUNDELKORTING` en de versie van de Stripe-API.

## De regels

| | |
| --- | --- |
| Prijs per jaar | € 119,40 (€ 9,95 per maand), inclusief 21% btw |
| Prijs per maand | € 12,95, inclusief 21% btw |
| Proef | 14 dagen vanaf het aanmaken van de organisatie, zonder betaalgegevens |
| Toegang | bij de standen `trialing`, `active` en `past_due` van Stripe |
| Bundelkorting | 15% voor wie al een lopend abonnement heeft op een andere app van Jona (coupon `jona_bundel_15`) |

- Wie tijdens de proef een abonnement kiest, betaalt pas na de proef. Stripe
  wil daarvoor nog minstens twee dagen proef; korter dan dat begint het
  abonnement direct.
- Met een lopend abonnement opent "kiezen" het klantportaal, nooit een tweede
  abonnement.
- Een oud, gestopt abonnement overschrijft nooit een lopend ander abonnement.
- Alle apps delen één Stripe-account. Een app telt alleen abonnementen op haar
  eigen product en negeert meldingen over andere apps, ook als de organisatie
  in de metadata bij haar bestaat.
- De klant bij Stripe kan gedeeld zijn met een andere app van Jona, en het
  klantportaal toont alle abonnementen van die klant. In het gewone portaal
  kan daarom niemand opzeggen. Opzeggen gaat met een eigen knop, die Stripe
  opent voor alleen het abonnement van deze organisatie.
- Koppelen gaat met een koppelcode, niet op e-mailadres: de klant is de
  organisatie, niet de persoon. Een beheerder met een lopend abonnement maakt
  in de ene app een code (`JONA-XXXX-XXXX-XXXX`, 7 dagen geldig, eenmalig,
  intrekbaar); een beheerder in de andere app vult hem in. Bij Stripe staat
  alleen de hash van de code, in de metadata van de klant. Hooguit 5 verkeerde
  codes per uur per organisatie.
- Zonder `ABONNEMENT_STRIPE_SECRET_KEY` staan abonnementen uit en heeft
  iedereen toegang.

## Namen bij Stripe

Uit het korte woord van de app (`giften`, `bestuur`, `roosters`) volgt alles:

| Wat | Vorm |
| --- | --- |
| Product | `jona_<app>_abonnement` |
| Prijzen (lookup keys) | `jona_<app>_jaar`, `jona_<app>_maand` |
| Metadata van het btw-tarief en het portaal | `jona_<app>` |
| De twee instellingen van het portaal | `portaal-2` (facturen en betaalwijze) en `opzeggen-1`, in die metadata |
| De koppelcode bij de klant | metadata `jona_koppelcode` (hash), `jona_koppelcode_tot`, `jona_koppelcode_app` |

Aan het voorvoegsel `jona_` herkennen de apps elkaars abonnementen. Deze namen
veranderen niet: een app die haar product of prijs niet terugvindt, maakt ze
opnieuw aan. `tests/namen.test.ts` bewaakt dat.

Een andere prijs: maak in Stripe een nieuwe prijs bij het product en zet de
lookup key over ("Transfer lookup key"). Lopende abonnementen houden hun oude
prijs.

## Een app aansluiten

De app houdt zelf de tabel `abonnementen` met rijbeveiliging, en geeft het
pakket een **opslag** van drie functies bovenop haar eigen database.

```ts
// src/lib/abonnement.ts
import "server-only";
import { maakAbonnement, type Opslag } from "@jona/abonnement";

const opslag: Opslag = {
  // Wanneer de organisatie is aangemaakt (daar begint de proef), of null als zij niet bestaat.
  aangemaaktOp: async (organisatieId) => { /* ... */ },
  // De rij van de organisatie, of null. `namens` is een gebruiker of SYSTEEM.
  leesRij: async (organisatieId, namens) => { /* ... */ },
  // Eén transactie met de rij vergrendeld (select ... for update).
  bewerk: (organisatieId, namens, fn) =>
    withOrg(organisatieId, namens, async (tx) =>
      fn({
        huidig: /* de rij, of null */,
        schrijf: async (velden) => { /* insert ... on conflict do update, met bijgewerkt_op */ },
        log: async (actie, details) => { /* een regel in het auditlog, of niets */ },
      }),
    ),
};

export const abonnement = maakAbonnement({
  app: "bestuur",
  naam: "Jona Bestuur",
  omschrijving: "Vergaderen, notuleren en besluiten voor besturen",
  opslag,
  logFout,
});
```

Daarna:

| In de app | Met het pakket |
| --- | --- |
| `vereisSessie()` | `abonnement.haalStand(organisatieId, gebruikerId)`, en bij `toegang: false` naar `/abonnement` |
| Kiezen (alleen de beheerder) | `abonnement.startAbonnement({ ... })` geeft het adres van de betaalpagina |
| "Abonnement beheren" | `abonnement.openPortaal({ ... })` |
| Terug uit de betaalpagina (`?sessie=`) | `abonnement.verwerkTerugkeer({ ... })` |
| De route `/api/abonnement/stripe` | `export const POST = (verzoek: Request) => abonnement.ontvangMelding(verzoek)` |
| De nachtelijke taak | `abonnement.werkBij(organisatieId)` per organisatie |
| "Opzeggen" en "Toch doorgaan" | `abonnement.openOpzeggen({ ... })` en `abonnement.draaiOpzeggingTerug({ ... })`; na `?opgezegd=1` eerst `abonnement.ververs(...)` |
| Een koppelcode maken of intrekken (met een lopend abonnement) | `abonnement.maakKoppelcode({ ... })`, `abonnement.trekKoppelcodeIn({ ... })`, `abonnement.haalCodeStand(klantId)` |
| Een koppelcode invullen (zonder abonnement) | `abonnement.controleerKoppelcode({ ... })` en `abonnement.bevestigKoppeling({ ... })`; die geeft de klant terug, zodat de app de betaler kan mailen |
| Het dashboard | `bepaalStand()` voor proef, abonnement, verlopen en vrijgesteld |

De rij heeft deze kolommen: `stripe_klant_id`, `stripe_abonnement_id`, `plan`
(`jaar` of `maand`), `status`, `live`, `proef_tot`, `periode_tot`, `stopt_op`,
`vrijgesteld` en `proef_verlengd_tot`. De laatste twee zet alleen de app zelf
(de platformbeheerder); het pakket schrijft ze nooit.

Een uitkomst is `{ ok: true, ... }` of `{ ok: false, fout, code }`: een gewone
Nederlandse zin voor het scherm, en een vaste code uit `FOUTEN` voor wie
vertaalt. De uitleg van Stripe gaat naar `logFout`, niet naar het scherm.

### Omgeving

Het pakket leest deze variabelen bij elk gebruik uit `process.env` (of uit
`omgeving` als de app die meegeeft):

| Variabele | Waarvoor |
| --- | --- |
| `ABONNEMENT_STRIPE_SECRET_KEY` | de geheime sleutel van het Stripe-account van Jona; zonder staan abonnementen uit |
| `ABONNEMENT_STRIPE_WEBHOOK_SECRET` | het geheim (`whsec_...`) van het meldadres van deze app |
| `ABONNEMENT_BTW` | `uit` laat het btw-tarief van 21% weg (als Stripe Tax de btw berekent) |
| `STRIPE_API_URL` | alleen voor tests: een nagemaakt Stripe |

Een beperkte sleutel moet dit kunnen: producten, prijzen, btw-tarieven,
portaalinstellingen en coupons lezen en aanmaken, betaalsessies en
portaalsessies aanmaken, klanten lezen, zoeken en bijwerken (de metadata met de
koppelcode), en abonnementen lezen en bijwerken (een opzegging terugdraaien).

### Meldadres bij Stripe

Elke app heeft een eigen meldadres met een eigen geheim, bijvoorbeeld
`https://jonabestuur.nl/api/abonnement/stripe`, met de gebeurtenissen
`checkout.session.completed`, `customer.subscription.created`,
`customer.subscription.updated`, `customer.subscription.deleted`,
`customer.subscription.trial_will_end`, `invoice.paid` en
`invoice.payment_failed`.

## Installeren

Bij elke versie hangt het ingepakte pakket aan de release. De app wijst
daarnaar, met een exacte versie:

```json
"@jona/abonnement": "https://github.com/rhadders/jona-abonnement/releases/download/v2.0.0/jona-abonnement-2.0.0.tgz"
```

`package-lock.json` legt de controlesom vast. Er is geen sleutel en geen git
nodig, ook niet in de Dockerfile.

## Ontwikkelen

Nodig: Node 22.

| Opdracht | Doet |
| --- | --- |
| `npm test` | Vitest, tegen een nagemaakt Stripe en een opslag in het geheugen |
| `npm run typecheck` | TypeScript |
| `npm run build` | bouwt `dist/` |
| `npm run pakket` | bouwt en pakt in, zoals de release doet |

De tests in `tests/abonnement.test.ts` draaien de hele reeks voor elke app.
De gegevens in de tests zijn verzonnen.

### Een nieuwe versie

1. Een pull request met de wijziging en de nieuwe versie in `package.json`.
2. Na de merge: `git tag v1.2.3 && git push origin v1.2.3`. De workflow
   `release` test, bouwt en hangt het pakket aan de release.
3. In elke app één pull request die de regel in `package.json` ophoogt.

Semver: een oplossing is een patch, iets erbij een minor, en wat de vorm van
`Opslag`, `Instelling` of een uitkomst verandert een major.

### Een app erbij

Voeg de app toe aan `JONA_APPS` in `src/namen.ts` (de naam die een andere app
toont bij een koppelcode), aan `tests/namen.test.ts` en aan de reeks in
`tests/abonnement.test.ts`. Het woord van de app is één woord in kleine
letters.

## Mappen

```
src/namen.ts        de namen bij Stripe, de prijzen, de bundelkorting
src/stripe.ts       Stripe: inrichting, betaalpagina, portalen, opzeggen, abonnement, klant met koppelcode
src/stand.ts        de stand bepalen
src/meldingen.ts    handtekening van een melding, het abonnement uit een melding
src/koppelcode.ts   de koppelcode: maken, lezen wat iemand invult, de hash
src/fouten.ts       de meldingen met hun code
src/abonnement.ts   de stromen, tegen de opslag van de app
tests/              de namentest, de zuivere tests en de stromen tegen een nagemaakt Stripe
```

## Gebruik

Deze repository is openbaar omdat dat het installeren eenvoudig houdt. De code
is van Jona zinvolle technologie en is geschreven voor de eigen apps; er is
geen licentie voor hergebruik.
