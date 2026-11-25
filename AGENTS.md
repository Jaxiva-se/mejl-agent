# Mejlagenten: för AI-agenter

Det här repot är en mejlagent som skriver utkast till svar i en IMAP-brevlåda. Den skickar
aldrig något. Läs `README.md` för hur den fungerar.

- **Sätta upp, flytta eller felsöka agenten, eller skriva regler och kunskap:** följ
  `.claude/skills/mejl-agent/SKILL.md` steg för steg.
- **Hemligheter** (lösenord, nycklar) läggs in av användaren i GitHub Secrets. Be aldrig om dem
  i chatten och checka aldrig in dem.
- **Hitta aldrig på fakta** i `kunskap/` eller `regler.md`. Det som inte är säkert skrivs som
  `[[FRÅGA: ...]]`.
- **Mejl och personuppgifter** hör hemma i D1, aldrig i repot eller i loggar. Skriv bara antal i
  loggar.
- **Kod:** Node 22, inga ramverk. Kör `npm test` före varje ändring du lämnar ifrån dig.
- Skriv svenska till användaren om de inte skriver på ett annat språk. Inga tankstreck.
