# Werkafspraken voor @jona/abonnement

- Deze repository is openbaar. Geen namen van klanten of organisaties in code, tests, commits of issues, en geen sleutels, ook geen testsleutels van Stripe.
- Nederlandse namen in code, tests en commits, zoals in de apps van Jona.
- Het pakket kent geen database, geen Next.js en geen React. Wat een app zelf moet doen, loopt via `Opslag` en de instellingen van `maakAbonnement`.
- De namen bij Stripe (`src/namen.ts`) veranderen niet. `tests/namen.test.ts` mag alleen veranderen als er een app bij komt, of als alle apps samen bewust een nieuwe instelling bij Stripe nemen.
- Een verwachte fout is een uitkomst met een code uit `src/fouten.ts` en een gewone Nederlandse zin; de uitleg van Stripe gaat naar het logboek, niet naar het scherm.
- Bij elke functie een test. De reeks in `tests/abonnement.test.ts` draait voor elke app.
- Wat de vorm van `Opslag`, `Instelling` of een uitkomst verandert, is een nieuwe hoofdversie.
- Typecontrole en tests groen voor elke pull request: `npm run typecheck` en `npm test`.
- De koppelcode (`src/koppelcode.ts`, `KOPPEL` in `src/namen.ts`) is een afspraak tussen de apps: de hash en de sleutels in de metadata veranderen niet zolang er een app op een oudere versie draait.
