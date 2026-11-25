---
name: mejl-agent
description: Sätter upp mejlagenten för en ny brevlåda steg för steg (Cloudflare D1, secrets, mappar, prov, import, startpunkt), gör förmågekartan ur koden till kundens tjänst, tar fram frågor till den som sköter mejlen och skriver regler.md från mötets transkribering. Använd när någon vill sätta upp, flytta eller felsöka mejlagenten, eller ge den regler och kunskap.
---

# Sätta upp mejlagenten

Du hjälper någon att sätta upp mejlagenten i det här repot för sin egen brevlåda. Läs
`README.md` först: den beskriver hur agenten fungerar och varje inställning. Den här filen säger
i vilken ordning du gör det, vad du kontrollerar efter varje steg, och vad som brukar gå fel.

## Hållning

- **Gå ett steg i taget.** Säg vad nästa steg är, vänta tills det är gjort, läs resultatet och
  bekräfta innan du går vidare. Hoppa inte över kontrollerna.
- **Hemligheter rör du aldrig.** Lösenord och nycklar läggs in av användaren själv under
  Settings, Secrets and variables, Actions. Be aldrig om dem i chatten, skriv dem aldrig i en fil
  och checka aldrig in dem.
- **Hitta aldrig på fakta.** Det som ska stå i `kunskap/` och `regler.md` kommer från
  användaren, från den som sköter mejlen, från deras webbplats eller från koden till deras
  tjänst, och du vet varifrån. Vet du inte: skriv `[[FRÅGA: ...]]`.
- **Inget skickas.** Agenten lägger bara utkast. Säg det till användaren när det är relevant.
- **Skriv svenska** till användaren, kort och konkret, om de inte skriver på ett annat språk.
- **Läs loggarna själv** om du kan (GitHub-verktyg eller `gh run view --log`). Annars: be
  användaren klistra in de sista raderna. Loggarna innehåller bara antal och mappnamn.

## Steg 1: Förutsättningar

Fråga efter, och notera i `docs/installation.md` (skapa filen, inga hemligheter i den):
- Brevlådans adress och var den ligger (Oderland eller annan IMAP-värd, servernamnet).
- Vem som sköter mejlen i dag, och om fler skriver i brevlådan.
- Om de har en egen tjänst eller app med kod som kunderna använder (för steg 5), och var
  koden finns: ett GitHub-repo (`ägare/namn`), en lokal mapp, eller ingen.
- Deras webbplats.

## Steg 2: Cloudflare, Anthropic och secrets

Led användaren genom README, steg 2 till 6. Kontrollera:
- D1-databasen skapas med jurisdiktion EU.
- Cloudflare-nyckeln har bara Account, D1, Edit.
- Variablerna läggs under fliken **Variables**, inte Secrets. Flödet läser `vars.*` och
  ignorerar secrets med samma namn. Det är det vanligaste misstaget.
- `MEJL_UTKASTMAPP` = `Agentutkast`.

## Steg 3: Mappar

Be användaren köra läget `mappar` och läs listan. Föreslå `MEJL_UTESLUT`:
- Alltid ute: löner, ansökningar (jobb, lärare, personal), avtal, styrelse, budget, ekonomi som
  inte rör kunder, personliga mappar med en persons namn om de inte är kundärenden.
- Fråga om allt du inte kan avgöra från namnet. Fråga hellre en gång för mycket.
- Papperskorg, raderat, skräppost, utkast och mappar som heter Privat stängs ute av sig själva.
- Skickat-mappar (Sent, Sent Items, Skickat) räknas som svar och ska vara med.
Kontrollera med en ny körning av `mappar` att listan stämmer när variabeln är satt.

## Steg 4: Kunskapen

Fyll i `kunskap/verksamhet.md` med användaren. Hämta från deras webbplats om du kan läsa den,
men bara det som står där, och ange sidan. Det som saknas blir `[[FRÅGA: ...]]`.

## Steg 5: Förmågekartan (om de har en tjänst eller app)

Målet är `kunskap/tjanst.md`: vad kunden kan göra själv i tjänsten, var och hur, och vad bara
personalen kan göra. Det är det agenten behöver för att svara "det gör du under Mina sidor,
Bokningar" i stället för att gissa.

1. **Få åtkomst.** Be om repot (`ägare/namn`) eller en lokal sökväg. Du behöver bara läsrätt.
   Har användaren inte namnet: hoppa över steget nu och kom tillbaka. Agenten fungerar utan
   kartan, men skriver fler frågor till granskaren.
2. **Läs koden** i den här ordningen, och anteckna fil och rad för varje fynd:
   - README och dokumentation.
   - Kundens gränssnitt: sidor, menyer, formulär, routes. Vad kan en inloggad kund göra?
     Boka, avboka, ändra, betala, ladda ner kvitto, byta lösenord, säga upp, radera konto?
   - Roller och behörigheter: vad är bara för personal eller admin?
   - Mejl som tjänsten skickar själv: bekräftelse, kvitto, påminnelse, kö, antagning. När
     skickas de, och vad står i dem?
   - Regler i koden: avbokningstider, avgifter, gränser, giltighetstider.
   - Adresser kunden använder (inloggning, mina sidor, bokningssidan).
3. **Skriv ett utkast** i `docs/tjanst-utkast.md` (inte i `kunskap/`, så agenten använder det
   inte än) med rubrikerna:
   - Kunden kan själv (vad, var i tjänsten, villkor)
   - Bara personalen kan (vad, var i admin)
   - Mejl som tjänsten skickar automatiskt
   - Regler som koden styr (tider, avgifter, gränser)
   - Länkar
   Skriv bara det koden visar. Lägg källan som en HTML-kommentar efter varje rad, till
   exempel `<!-- src/routes/booking.ts:42 -->`. Det du inte kan avgöra blir `[[FRÅGA: ...]]`.
   Skriv inga personuppgifter, nycklar eller interna adresser som kunder inte ska se.
4. **Godkännande.** Gå igenom utkastet med användaren, rad för rad om det behövs. Ändra det de
   rättar. Först när de säger att det stämmer: flytta det till `kunskap/tjanst.md`, ta bort
   källkommentarerna, och skriv överst `Godkänd av <namn>, <datum>`.
5. Ändras tjänsten senare: gör om steget för det som ändrats, och godkänn igen.

## Steg 6: Prova utan databas

Be användaren skicka testmejlen i `docs/testmejl.md` från en annan adress (eller skicka dem
själv om du har ett e-postverktyg och de säger ja). Kör läget `prov`, gärna med ett datum i
fältet sedan för att det ska gå fortare. Kontrollera i loggen:
- `Frågor med svar i arkivet: N` ska vara mer än 0. Är det 0: frågorna ligger i mappar som inte
  lästes, eller är raderade utan citat i svaren. Kör `mappar` och titta.
- Sammanfattningen `### Mejlagenten: N nya mejl, N utkast, N hoppade över, N fel`. Säljmejlet
  ska hoppas över. Fel ska vara 0.
Be användaren läsa utkasten i utkastmappen och jämföra med tabellen i `docs/testmejl.md`.

## Steg 7: Import

Läget `importera`, med ett datum i sedan (två år bakåt räcker oftast). Räkna först: läget
`mappar` visar antalet mejl. D1:s gratisplan skriver 100 000 rader per dygn och importen cirka
4 rader per mejl. Är det fler än cirka 20 000 mejl: välj ett senare datum, kör över flera dygn
(importen fortsätter där den slutade), eller föreslå Workers Paid. Kontrollera
`Frågor med svar i arkivet` på sista raden.

## Steg 8: Startpunkt

Läget `kor` en gång, utan datum. Loggen ska säga `Första körningen: agenten börjar med mejl som
kommer från och med nu.` och visa `MEJL_UTKASTMAPP: Agentutkast` i miljölistan.

## Steg 9: Möte och regler

1. Ge användaren `docs/fragor-till-mote.md`. Lägg till frågor som hör till just deras
   verksamhet och förmågekarta, och frågorna om mappar du inte kunde avgöra i steg 3.
2. Be om transkriberingen när mötet är gjort.
3. Skriv `regler.md` från den:
   - Bara det som sades. En sak som sades i förbigående är också en regel.
   - Det som är fakta om verksamheten (adresser, priser, betalsätt) hör hemma i
     `kunskap/verksamhet.md`. Det som är hur man svarar (ton, vad som får lovas, när man ska
     fråga) hör hemma i `regler.md`.
   - Skillnaden mellan villkoren och hur personen gör i praktiken är viktig. Skriv båda, och
     låt agenten fråga granskaren i stället för att lova undantag.
   - Signatur: läggs den till av e-postprogrammet ska agenten inte skriva någon.
   - Jämför med `kunskap/` och webbplatsen. Säger de olika saker: tala om det för användaren.
   - Det du tolkat själv: säg det till användaren, med vad du valde.
4. Saknas något viktigt: lista frågorna, i stället för att gissa.

## Steg 10: Slå på

- Variabeln `MEJL_AGENT` = `true`. Schemat kör var 30:e minut 07 till 21, och veckorapporten
  på måndagar.
- Be användaren berätta för den som sköter mejlen: utkasten finns i `Agentutkast`, leta efter
  `[[FRÅGA: ...]]` i varje utkast, flagga trådar du vill sköta själv, inget skickas automatiskt,
  och svara på veckorapporten med numren på de regler du vill ha.
- Följ upp dagen efter: har schemat kört, hur många utkast, några fel?

## När något går fel

| Det står | Det betyder | Gör så här |
|---|---|---|
| `D1: ... daily row write limit` | Gratisplanens skrivgräns | Vänta till midnatt UTC. Inget går förlorat |
| `Connection not available` i importen | Mejlservern stängde anslutningen | Importen kopplar upp igen. Stannar den ändå: kör igen, den fortsätter |
| `tool_choice ... not supported` | Gammal kod med tvingat verktyg | Använd `lib/claude.js` (strukturerade svar) |
| Variabler tomma i loggen | De ligger under Secrets | Lägg dem under Variables |
| Schemalagda körningar syns inte | GitHub kör inte schemat än, eller `MEJL_AGENT` är inte exakt `true` | Kontrollera variabeln, kör `kor` för hand under tiden |
| `Frågor med svar i arkivet: 0` | Frågorna ligger i olästa mappar | Kör `mappar`, kontrollera `MEJL_UTESLUT` |
| Spara nya regler stoppas | `main` är skyddad | Ge Actions skrivrätt, eller lägg in reglerna för hand |
