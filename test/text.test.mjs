import { test } from "node:test";
import assert from "node:assert/strict";
import { ftsQuery, parseMail, quotedText, skipReason, stripQuoted } from "../lib/text.js";
import { knowledge } from "../lib/kunskap.js";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composeReply, userPrompt } from "../lib/utkast.js";

const mail = (headers, body = "Hej, kan jag byta kurs?") => `${headers.join("\r\n")}\r\n\r\n${body}`;

test("citerade svar tas bort, i Apple Mail, Gmail och Outlook", () => {
  assert.equal(stripQuoted("Tack!\n\nDen 16 okt. 2026 kl. 10:00 skrev Exempel <info@exempel.se>:\n> Hej\n> gammalt"), "Tack!");
  assert.equal(stripQuoted("Thanks\n\nOn Mon, 16 Oct 2026 at 10:00, Exempel <info@exempel.se> wrote:\n> Hi"), "Thanks");
  assert.equal(stripQuoted("Okej.\n\nFrån: Exempel <info@exempel.se>\nSkickat: den 16 oktober 2026 10:00\nTill: Kim\n\nHej"), "Okej.");
  assert.equal(stripQuoted("Från: början vill jag säga tack.\nHälsningar Kim"), "Från: början vill jag säga tack.\nHälsningar Kim");
});

test("ett mejl blir en rad i arkivet", async () => {
  const m = await parseMail(
    mail(["From: Kim Ek <Kim@Example.com>", "To: info@exempel.se", "Subject: =?utf-8?Q?Byta_kurs_p=C3=A5_torsdag?=", "Message-ID: <a1@example.com>", "In-Reply-To: <z9@exempel.se>", "References: <y8@exempel.se> <z9@exempel.se>", "Date: Tue, 24 Nov 2026 10:00:00 +0100"]),
    { mapp: "INBOX", uid: 7, riktning: "in" },
  );
  assert.equal(m.messageId, "a1@example.com");
  assert.equal(m.svarPa, "z9@exempel.se");
  assert.deepEqual(m.references, ["y8@exempel.se", "z9@exempel.se"]);
  assert.equal(m.fran, "kim@example.com");
  assert.equal(m.svaraTill, "kim@example.com");
  assert.equal(m.amne, "Byta kurs på torsdag");
  assert.equal(m.datum, "2026-11-24T09:00:00.000Z");
  assert.equal(m.text, "Hej, kan jag byta kurs?");
});

test("mejl utan Message-ID får ett eget, och HTML blir text", async () => {
  const m = await parseMail(mail(["From: a@b.se", "Content-Type: text/html; charset=utf-8"], "<p>Hej</p><p>Vad kostar <b>salsa</b>?</p>"), { mapp: "INBOX", uid: 3, riktning: "in" });
  assert.equal(m.messageId, "saknas-INBOX-3");
  assert.equal(m.text, "Hej\nVad kostar salsa?");
});

test("nyhetsbrev, autosvar och robotar får inget utkast", async () => {
  const parse = (headers, body) => parseMail(mail(headers, body), { mapp: "INBOX", uid: 1, riktning: "in" });
  const egna = ["info@exempel.se", "webb@exempel.se"];
  assert.equal(skipReason(await parse(["From: kim@example.com"]), { egna }), null);
  assert.equal(skipReason(await parse(["From: nyheter@butik.se", "List-Unsubscribe: <mailto:x@butik.se>"]), { egna }), "massutskick");
  assert.equal(skipReason(await parse(["From: kim@example.com", "Auto-Submitted: auto-replied"]), { egna }), "automatiskt svar");
  assert.equal(skipReason(await parse(["From: no-reply@bokning.se"]), { egna }), "avsändare som inte tar emot svar");
  assert.equal(skipReason(await parse(["From: MAILER-DAEMON@oderland.com"]), { egna }), "avsändare som inte tar emot svar");
  assert.equal(skipReason(await parse(["From: info@exempel.se"]), { egna }), "från oss själva");
  assert.equal(skipReason(await parse(["From: kim@example.com"], ""), { egna }), "tomt mejl");
  // The contact form sends from our own address with the visitor in Reply-To: that one is answered.
  const form = await parse(["From: Webbplatsen <webb@exempel.se>", "Reply-To: kim@example.com"]);
  assert.equal(skipReason(form, { egna }), null);
  assert.equal(form.svaraTill, "kim@example.com");
});

test("sökorden är de ord som bär frågan", () => {
  assert.equal(ftsQuery("Hej! Jag undrar om jag kan byta kurs till salsa på torsdagar? Mvh Kim 0701234567"), '"byta" OR "kurs" OR "salsa" OR "torsdagar"');
  assert.equal(ftsQuery("Hej och tack"), "");
  assert.equal(ftsQuery('fråga om "citat" (parentes) NEAR'), '"citat" OR "parentes" OR "near"');
});

test("underlaget är kunskapsfilerna i namnordning och reglerna, utan README", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "kunskap-"));
  await mkdir(path.join(dir, "kunskap"));
  await writeFile(path.join(dir, "kunskap", "2-tjanst.md"), "## Bokning\nBoka i appen.");
  await writeFile(path.join(dir, "kunskap", "1-verksamhet.md"), "# Exempelbolaget\nVi finns på Storgatan 1.");
  await writeFile(path.join(dir, "kunskap", "README.md"), "Instruktioner till den som fyller i.");
  await writeFile(path.join(dir, "regler.md"), "## Ton\n- Hälsa med Hej.");
  const k = await knowledge({ MEJL_KUNSKAP: path.join(dir, "kunskap"), MEJL_REGLER: path.join(dir, "regler.md") });
  assert.equal(k.namn, "Exempelbolaget");
  assert.equal(k.text, "# Exempelbolaget\nVi finns på Storgatan 1.\n\n## Bokning\nBoka i appen.\n\n# Regler från verksamheten\n## Ton\n- Hälsa med Hej.");
  assert.equal((await knowledge({ MEJL_KUNSKAP: path.join(dir, "kunskap"), MEJL_REGLER: "/finns/inte", MEJL_NAMN: "Annat" })).namn, "Annat");
});

test("svaret hamnar i samma tråd, till den som ska ha det", async () => {
  const mejl = await parseMail(
    mail(["From: =?utf-8?Q?Kim_=C3=85kesson?= <kim@example.com>", "Subject: Byta kurs", "Message-ID: <a1@example.com>", "References: <y8@exempel.se>", "Date: Tue, 24 Nov 2026 10:00:00 +0100"]),
    { mapp: "INBOX", uid: 7, riktning: "in" },
  );
  const raw = (await composeReply({ fran: "info@exempel.se", mejl, svar: "Hej Kim,\n\nDet går bra." })).toString();
  assert.match(raw, /^To: kim@example\.com$/m);
  assert.match(raw, /^From: info@exempel\.se$/m);
  assert.match(raw, /^Subject: Re: Byta kurs$/m);
  assert.match(raw, /^In-Reply-To: <a1@example\.com>$/m);
  assert.match(raw, /^References: <y8@exempel\.se> <a1@example\.com>$/m);
  const back = await parseMail(raw, { mapp: "Drafts", uid: 1, riktning: "ut" });
  assert.equal(back.svarPa, "a1@example.com");
  assert.equal(back.text, "Hej Kim,\n\nDet går bra.");
  assert.match(back.helText, /Den 24 nov\. 2026 10:00 skrev Kim Åkesson:\n> Hej, kan jag byta kurs\?/);
});

test("frågan till modellen bär mejlet och tidigare svar, inte adresser", async () => {
  const mejl = await parseMail(mail(["From: Kim Ek <kim@example.com>", "Subject: Byta kurs", "Date: Tue, 24 Nov 2026 10:00:00 +0100"]), { mapp: "INBOX", uid: 7, riktning: "in" });
  const p = userPrompt(mejl, [{ amne: "Byte", datum: "2026-09-01T08:00:00.000Z", fraga: "Kan jag byta?", svar: "Ja, mejla oss." }]);
  assert.match(p, /<tidigare_1>\nÄmne: Byte\nDatum: 2026-09-01\n\nKunden skrev:\nKan jag byta\?\n\nVi svarade:\nJa, mejla oss\.\n<\/tidigare_1>/);
  assert.match(p, /<mejl>\nFrån: Kim Ek\nÄmne: Byta kurs/);
  assert.doesNotMatch(p, /kim@example\.com/);
  assert.match(userPrompt(mejl, []), /Inga liknande frågor hittades/);
});

test("frågan tas ur citatet i ett svar, i Apple Mail, Gmail och Outlook", () => {
  assert.equal(quotedText("Ja.\n\nDen 5 okt. 2026 kl. 09:00 skrev Anna <a@x.se>:\n> Kan jag byta?\n>\n> Mvh Anna\n>\n> Den 1 okt skrev Exempel <info@exempel.se>:\n>> gammalt"), "Kan jag byta?\n\nMvh Anna");
  assert.equal(quotedText("Yes.\n\nOn Mon, 5 Oct 2026 at 09:00, Kim <k@x.se> wrote:\n> Do you teach in English?"), "Do you teach in English?");
  assert.equal(quotedText("Okej.\n\nFrån: Kim <k@x.se>\nSkickat: den 16 oktober 2026 10:00\nTill: Exempel\nÄmne: Fråga\n\nHar ni salsa?"), "Har ni salsa?");
  assert.equal(quotedText("Bara ett nytt mejl."), "");
});
