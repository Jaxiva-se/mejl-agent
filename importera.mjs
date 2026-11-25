#!/usr/bin/env node
/*
  Läser in brevlådans historik till arkivet: inkorgen, skickat och alla andra mappar med mejl
  (inte utkast, papperskorg och skräppost). Ett svar vars fråga inte finns kvar i brevlådan
  får frågan ur sitt citat. Körs en gång innan agenten
  slås på, och kan köras om när som helst (ett mejl som redan finns hoppas över).

    node importera.mjs                 allt
    node importera.mjs --sedan 2024-01-01
    node importera.mjs --bara-mappar   visa mapparna och vad som läses, utan att läsa några mejl

  Avbryts den (tidsgränsen i GitHub) går det bra att köra igen: mejl som redan finns i arkivet
  hämtas inte en gång till.

  Skriver bara antal, aldrig avsändare eller innehåll.
*/
import { archivedUids, CITAT, getState, open, saveMail, setState } from "./lib/db.js";
import { connect, findFolder, mailFolders, readFolder } from "./lib/imap.js";
import { parseMail } from "./lib/text.js";

// Per call to the database: at most this many mails, and at most about this much text.
const BATCH = 100;
const BATCH_BYTES = 800_000;
const PROGRESS = 500;
// A closed connection is retried this many times in all, waiting a little longer each time.
const RETRIES = 6;
const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));

export async function importAll({ env = process.env, since, log = console.log, connectTo = connect } = {}) {
  const db = await open(env);
  let client = connectTo(env);
  await client.connect();
  const result = {};
  try {
    const sent = env.MEJL_SKICKATMAPP || (await findFolder(client, "\\Sent"));
    if (!sent) throw new Error("Hittar ingen mapp för skickat. Sätt MEJL_SKICKATMAPP.");
    const exclude = (env.MEJL_UTESLUT || "").split(",").map((x) => x.trim()).filter(Boolean);
    const folders = await mailFolders(client, { exclude: [...exclude, env.MEJL_UTKASTMAPP] });
    if (!folders.some((f) => f.path === sent)) folders.push({ path: sent, sent: true });
    // In folders other than sent, a mail from us (not the contact form, which sets Reply-To) is ours.
    const egna = [env.MEJL_IMAP_USER, ...(env.MEJL_EGNA || "").split(",")].map((s) => (s ?? "").trim().toLowerCase()).filter(Boolean);
    const ours = (m) => egna.includes(m.fran) && (m.svaraTill === m.fran || egna.includes(m.svaraTill));
    result.in = { lasta: 0, olasbara: 0 };
    result.ut = { lasta: 0, olasbara: 0 };
    if (exclude.length) log(`Läses aldrig: ${exclude.join(", ")}`);
    for (const { path: mapp, sent: isSent } of folders) {
      // Mail already in the archive is not fetched again, unless the server has renumbered the
      // folder (UIDVALIDITY) since the last import. The mark is set before reading, so a run that
      // stops halfway continues from where the archive ends.
      const box = await readFolder(client, mapp);
      const key = `import:${mapp}`;
      const stored = await getState(db, key);
      const renumbered = stored !== null && stored !== box.uidValidity;
      if (stored !== box.uidValidity) await setState(db, key, box.uidValidity);
      let skip = renumbered ? undefined : await archivedUids(db, mapp);
      const before = skip?.size ?? 0;
      let batch = [];
      let bytes = 0;
      let count = 0;
      let failed = 0;
      const flush = async () => {
        if (batch.length) await saveMail(db, batch);
        count += batch.length;
        batch = [];
        bytes = 0;
      };
      const namn = mapp === "INBOX" ? "Inkorgen" : mapp === sent ? "Skickat" : mapp;
      for (let attempt = 1; ; attempt++) {
        let shown = 0;
        try {
          await readFolder(client, mapp, { since, skip }, async ({ uid, raw }, { klara, totalt }) => {
            try {
              const m = await parseMail(raw, { mapp, uid, riktning: isSent ? "ut" : "in" });
              if (!isSent && ours(m)) m.riktning = "ut";
              batch.push(m);
              result[m.riktning].lasta++;
              bytes += (m.text.length + m.citat.length) * 2 + m.amne.length + 300;
            } catch {
              failed++;
              result[isSent ? "ut" : "in"].olasbara++;
            }
            if (batch.length >= BATCH || bytes >= BATCH_BYTES) await flush();
            if (klara - shown >= PROGRESS && klara < totalt) log(`${namn}: ${(shown = klara)} av ${totalt} hämtade`);
          });
          await flush();
          break;
        } catch (e) {
          // The mail server sometimes closes a long session. Save what was read, connect again
          // and go on from there; anything else (the database, say) stops the import.
          if (client.usable !== false || attempt >= RETRIES) throw e;
          await flush();
          log(`${namn}: anslutningen bröts, kopplar upp igen (${attempt} av ${RETRIES - 1})`);
          await wait(attempt * Number(env.MEJL_VANTA_MS ?? 5000));
          await client.logout().catch(() => {});
          client = connectTo(env);
          await client.connect();
          skip = await archivedUids(db, mapp);
        }
      }
      log(`${namn}: ${count} mejl lästa${before ? `, ${before} fanns redan` : ""}${failed ? `, ${failed} gick inte att läsa` : ""}`);
    }
    const [pairs] = await db.query(`SELECT COUNT(DISTINCT f.id) AS n FROM mejl f JOIN mejl s ON s.svar_pa = f.message_id AND s.riktning = 'ut' WHERE f.riktning = 'in'`);
    result.besvarade = pairs?.n ?? 0;
    const [quoted] = await db.query(`SELECT COUNT(*) AS n FROM mejl WHERE mapp = ?`, [CITAT]);
    result.franCitat = quoted?.n ?? 0;
    log(`Frågor med svar i arkivet: ${result.besvarade}${result.franCitat ? `, varav ${result.franCitat} hämtade ur citatet i svaret` : ""}`);
    return result;
  } finally {
    await client.logout().catch(() => {});
    await db.close();
  }
}

/**
  Every folder in the mailbox with its number of mails, and whether the import reads it, as
  "läses", "skickat" or "läses aldrig". Reads no mail and needs no database: for choosing
  MEJL_UTESLUT before the first import of a new mailbox.
*/
export async function listFolders({ env = process.env, log = console.log } = {}) {
  const client = connect(env);
  await client.connect();
  try {
    const exclude = (env.MEJL_UTESLUT || "").split(",").map((x) => x.trim()).filter(Boolean);
    const read = new Map((await mailFolders(client, { exclude: [...exclude, env.MEJL_UTKASTMAPP] })).map((f) => [f.path, f]));
    const all = (await client.list()).filter((f) => !f.flags?.has?.("\\Noselect")).map((f) => f.path);
    if (!all.includes("INBOX")) all.unshift("INBOX");
    const rows = [];
    for (const path of all.sort((a, b) => (a === "INBOX" ? -1 : b === "INBOX" ? 1 : a.localeCompare(b)))) {
      const { messages = 0 } = await client.status(path, { messages: true }).catch(() => ({}));
      const f = read.get(path);
      rows.push({ mapp: path, antal: messages, lage: f ? (f.sent ? "skickat" : "läses") : "läses aldrig" });
    }
    if (exclude.length) log(`MEJL_UTESLUT: ${exclude.join(", ")}`);
    for (const r of rows) log(`${r.lage === "läses aldrig" ? "  -" : r.lage === "skickat" ? "  >" : "  +"} ${r.mapp}: ${r.antal} mejl${r.lage === "läses" ? "" : ` (${r.lage})`}`);
    const sum = (l) => rows.filter((r) => r.lage === l).reduce((n, r) => n + r.antal, 0);
    log(`Läses: ${sum("läses")} mejl, skickat: ${sum("skickat")}, läses aldrig: ${sum("läses aldrig")}`);
    return rows;
  } finally {
    await client.logout().catch(() => {});
  }
}

if (import.meta.url === `file://${process.argv[1]}` && process.argv.includes("--bara-mappar")) {
  listFolders().catch((e) => {
    console.error(`Gick inte att läsa mapparna: ${e.message}`);
    process.exit(1);
  });
} else if (import.meta.url === `file://${process.argv[1]}`) {
  const i = process.argv.indexOf("--sedan");
  const since = i > 0 ? new Date(process.argv[i + 1]) : undefined;
  if (since && Number.isNaN(since.getTime())) {
    console.error("--sedan ska vara ett datum, till exempel 2024-01-01");
    process.exit(1);
  }
  importAll({ since }).catch((e) => {
    console.error(`Importen stannade: ${e.message}`);
    process.exit(1);
  });
}
