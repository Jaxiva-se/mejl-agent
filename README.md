# Mejlagenten

Läser nya mejl i en brevlåda och lägger ett utkast till svar i en utkastmapp, i samma tråd.
En människa läser, ändrar och skickar. Agenten kan inte skicka mejl: här finns ingen SMTP.

Den lär sig av två saker: tidigare svar i brevlådan, och skillnaden mellan sina utkast och det
som faktiskt skickades. Varje måndag lägger den en veckorapport i inkorgen med förslag på nya
regler, och svaret på rapporten blir regler automatiskt.

Byggd för en IMAP-brevlåda hos Oderland (cPanel), med arkivet i Cloudflare D1 inom EU och
körningarna i GitHub Actions. Utkasten skrivs av Claude (Anthropic).

**Snabbast:** öppna repot i Claude Code eller Codex och skriv "sätt upp mejlagenten". Skillen i
`.claude/skills/mejl-agent/SKILL.md` leder dig genom stegen nedan.

## Så går det till

1. **Import** (läget `importera`, en gång): alla mappar med mejl läses in i arkivet, utom utkast,
   papperskorg, skräppost, mappar som heter Privat och de du listar i `MEJL_UTESLUT`. Ett svar
   paras ihop med sin fråga via tråden. Saknas frågan används kundens mejl som det står citerat
   i svaret.
2. **Körning** (läget `kor`, var 30:e minut 07 till 21 när `MEJL_AGENT` är `true`):
   - Nya mejl i skickat läses in, och varje svar jämförs med agentens utkast (lärandet).
   - Nya mejl i inkorgen sparas. Nyhetsbrev, autosvar, studsar, besvarade mejl och trådar som
     är flaggade i inkorgen hoppas över.
   - De mest lika frågorna som ni svarat på förut hämtas ur arkivet.
   - Claude får frågan, de tidigare svaren, kunskapen och reglerna, och skriver ett utkast.
   - Utkastet läggs i utkastmappen med kundens mejl citerat under.
3. **Veckorapport** (måndag 06:23 UTC): siffror, hur utkasten användes, vanligaste ämnen, vad
   agenten lärt sig och numrerade förslag på regler. Svarar man från brevlådan med numren
   läggs de in i `regler.md` vid nästa körning, och filen sparas i repot.

Det agenten inte vet skriver den som `[[FRÅGA: ...]]` i utkastet. Ta bort markeringen innan du
skickar.

## Vad agenten vet

- **Kunskapen:** Markdown-filerna i `kunskap/` (se `kunskap/README.md`).
- **Förmågekartan:** `kunskap/tjanst.md`, vad kunden kan göra i er tjänst, skapad ur koden.
- **Reglerna:** `regler.md`, det som inte står någon annanstans. Går före allt annat.
- **Tidigare svar** ur arkivet.

## Var mejlen finns

Mejlen innehåller personuppgifter och ligger i en Cloudflare D1-databas inom EU, aldrig i repot.
Loggarna i GitHub visar bara antal och kategorier. Mejlens text skickas till Anthropic när ett
utkast skrivs. Veckorapporten skickar bara lärdomarna, som är allmänt formulerade.

## Sätta upp, steg för steg

1. **Skapa ert repo** från den här mallen (Use this template). Gör det privat.
2. **Cloudflare D1:** skapa en databas inom EU, i Cloudflare under Storage & databases, D1,
   Create, med Location: EU. Eller:

   ```sh
   npx wrangler d1 create mejl-agent --jurisdiction eu
   ```

   Skapa en API-nyckel med bara rättigheten Account, D1, Edit (Manage Account, API Tokens).
3. **Anthropic:** en API-nyckel från console.anthropic.com.
4. **Brevlådan:** IMAP-servern står i cPanel hos Oderland under E-postkonton, Anslut enheter.
   Vanligtvis `mail.er-doman.se`, port 993.
5. **Secrets** (Settings, Secrets and variables, Actions, fliken Secrets):

   | Secret | Värde |
   |---|---|
   | `MEJL_IMAP_HOST` | IMAP-servern |
   | `MEJL_IMAP_USER` | brevlådans adress |
   | `MEJL_IMAP_PASSWORD` | brevlådans lösenord |
   | `MEJL_D1_DATABASE_ID` | databasens id |
   | `MEJL_CLOUDFLARE_API_TOKEN` | nyckeln från steg 2 |
   | `CLOUDFLARE_ACCOUNT_ID` | står i Cloudflare under Account home |
   | `ANTHROPIC_API_KEY` | nyckeln från steg 3 |

6. **Variabler** (samma ställe, fliken Variables, inte Secrets):

   | Variabel | Värde |
   |---|---|
   | `MEJL_UTKASTMAPP` | `Agentutkast`, så att utkasten hålls isär från personalens |
   | `MEJL_FRAN` | avsändaren kunden ser, till exempel `Företaget <info@er-doman.se>` |
   | `MEJL_UTESLUT` | sätts i steg 7 |

7. **Välj mappar:** kör Actions, Mejlagenten, Run workflow, läge `mappar`. Det läser inga mejl,
   bara mappnamn och antal. Lägg mappar med löner, ansökningar, avtal, personal och annat
   känsligt i `MEJL_UTESLUT`, kommaseparerade. Allt i arkivet kan bli underlag till modellen.
8. **Fyll i kunskapen** i `kunskap/verksamhet.md`, och gör förmågekartan `kunskap/tjanst.md`
   om ni har en tjänst eller app (skillen gör den ur koden).
9. **Prova:** skicka testmejlen i `docs/testmejl.md` och kör läget `prov`. Importen går till en
   tillfällig fil på GitHub, inte till Cloudflare, och de senaste mejlen får riktiga utkast.
10. **Importera:** läget `importera`, gärna med ett datum i fältet sedan, till exempel två år
    bakåt. Läs om D1:s gränser nedan.
11. **Startpunkt:** läget `kor` en gång. Första gången skriver den inga utkast.
12. **Möte och regler:** gå igenom `docs/fragor-till-mote.md` med den som sköter mejlen, och
    skriv `regler.md` från transkriberingen (skillen gör det).
13. **Slå på:** variabeln `MEJL_AGENT` = `true`. Stäng av genom att ta bort den.

## Lägen (Actions, Mejlagenten, Run workflow)

| Läge | Vad det gör |
|---|---|
| `mappar` | Visar mappar, antal mejl och vilka som läses. Läser inga mejl |
| `prov` | Import till en tillfällig fil och utkast till de senaste mejlen. Ingen Cloudflare |
| `importera` | Läser in historiken till D1. Kan köras om, fortsätter där den slutade |
| `kor` | En vanlig körning |
| `rapport` | Lägger veckorapporten i inkorgen nu |

## Inställningar (variabler, alla valfria)

| Variabel | Standard | Vad den gör |
|---|---|---|
| `MEJL_AGENT` | (av) | `true` slår på schemat och veckorapporten |
| `MEJL_UTKASTMAPP` | brevlådans utkastmapp | Egen mapp för utkasten. Skapas om den saknas |
| `MEJL_FRAN` | `MEJL_IMAP_USER` | Avsändare i utkastet |
| `MEJL_UTESLUT` | (inga) | Mappar som aldrig läses, med allt inuti |
| `MEJL_SKICKATMAPP` | hittas automatiskt | Mappen för skickat |
| `MEJL_EGNA` | (inga) | Fler egna adresser, kommaseparerade. Mejl från dem får inget utkast, utom kontaktformulär med Reply-To |
| `MEJL_MAX` | `10` | Högst så många mejl per körning |
| `MEJL_RAPPORT_SVAR` | (brevlådan) | Om svar på veckorapporten också ska gå till någon annan |
| `CLAUDE_MODEL` | `claude-sonnet-5-5` | Modellen som skriver |

## Bra att veta

- **D1:s gratisplan:** 100 000 skrivna och 5 miljoner lästa rader per dygn, nollställs vid
  midnatt UTC. En import skriver ungefär 4 rader per mejl, så mer än cirka 20 000 mejl tar flera
  dygn (importen fortsätter där den slutade). En vanlig körning skriver bara några rader.
  Workers Paid (5 dollar i månaden) tar bort gränsen i praktiken.
- **Oderland stänger ibland långa IMAP-sessioner.** Importen kopplar då upp igen och fortsätter.
- **Nyare Claude-modeller tar inte emot tvingade verktygsanrop** (`tool_choice`). Agenten ber om
  JSON enligt ett schema i stället (`lib/claude.js`).
- **Är `main` skyddad** mot direkta ändringar kan flödet inte spara nya regler. Ge GitHub Actions
  rätt att skriva, eller lägg in reglerna för hand från körningens sammanfattning.
- **Använd en databas per brevlåda.** Bokmärkena i databasen hör till en brevlåda.

## Köra lokalt

```sh
npm ci
npm test
```

Utan `MEJL_D1_DATABASE_ID` används en lokal fil, `.mejl.sqlite`. Testerna kör hela flödet mot
en IMAP-server i minnet och en påhittad modell.
