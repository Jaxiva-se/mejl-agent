/*
  Textarbete utan nätverk: läsa ett mejl till en rad i arkivet, ta bort citerade svar, avgöra
  vilka mejl agenten inte ska svara på, och göra sökord av en fråga.
*/
import PostalMime from "postal-mime";

const MAX_TEXT = 20000;

export function htmlToText(html) {
  return String(html)
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Where the quoted earlier mail starts, in the mail clients our customers use. */
const QUOTE_START = [
  /^Den .{4,80} skrev .*:\s*$/i,
  /^On .{4,120} wrote:\s*$/i,
  /^-{2,}\s*(Ursprungligt meddelande|Original Message|Vidarebefordrat meddelande|Forwarded message)\s*-{2,}\s*$/i,
  /^(Från|From):\s.+$/i,
  /^_{10,}\s*$/,
];

/** The line where the quoted earlier mail starts, or -1. */
function quoteStart(lines) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    // "From:" only counts as a quote header when "Sent/Skickat/Date/Datum" follows, as in Outlook.
    if (/^(Från|From):/i.test(line) && !/^(Skickat|Sent|Datum|Date):/i.test((lines[i + 1] ?? "").trim())) continue;
    if (QUOTE_START.some((re) => re.test(line))) return i;
  }
  return -1;
}

const toLines = (text) => String(text).replace(/\r\n/g, "\n").split("\n");

/** The new text of a mail, without the earlier mails quoted below it. */
export function stripQuoted(text) {
  const lines = toLines(text);
  const start = quoteStart(lines);
  const kept = lines.slice(0, start < 0 ? lines.length : start);
  while (kept.length && /^\s*(>.*)?$/.test(kept[kept.length - 1])) kept.pop();
  return kept
    .filter((l) => !/^\s*>/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
  The mail that a reply quotes, as its own text: what follows the quote header, one level of
  ">" removed, the header lines of Outlook skipped, and older mails further down cut off.
  Empty when the reply quotes nothing.
*/
export function quotedText(text) {
  const lines = toLines(text);
  const start = quoteStart(lines);
  let body;
  if (start >= 0) {
    body = lines.slice(start + 1);
    // Outlook and forwards: "Från/Skickat/Till/Ämne" lines up to the first empty line.
    if (/^(Från|From):|^-{2,}/i.test(lines[start].trim())) {
      while (body.length && body[0].trim() && /^[\p{L} -]{2,20}:/u.test(body[0].trim())) body.shift();
    }
  } else {
    body = lines.filter((l) => /^\s*>/.test(l));
  }
  return stripQuoted(body.map((l) => l.replace(/^\s*> ?/, "")).join("\n"));
}
const header = (mail, name) => mail.headers?.find((h) => h.key === name)?.value?.trim() ?? "";
const address = (a) => (a?.address ?? "").toLowerCase();
const cleanId = (id) => String(id ?? "").trim().replace(/^<|>$/g, "");

/**
  One mail from IMAP as a row for the archive, plus what the reply needs.
  `riktning` is "in" (to us) or "ut" (from us).
*/
export async function parseMail(raw, { mapp, uid, riktning }) {
  const mail = await PostalMime.parse(raw);
  const full = (mail.text || htmlToText(mail.html || "")).replace(/\r\n/g, "\n").trim();
  const references = header(mail, "references").split(/\s+/).map(cleanId).filter(Boolean);
  const svarPa = cleanId(mail.inReplyTo) || references.at(-1) || "";
  return {
    messageId: cleanId(mail.messageId) || `saknas-${mapp}-${uid}`,
    svarPa,
    references,
    riktning,
    mapp,
    uid,
    fran: address(mail.from),
    franNamn: mail.from?.name ?? "",
    svaraTill: address(mail.replyTo?.[0]) || address(mail.from),
    till: (mail.to ?? []).map(address).filter(Boolean).join(", "),
    amne: (mail.subject ?? "").trim().slice(0, 300),
    datum: mail.date ? new Date(mail.date).toISOString() : "",
    text: stripQuoted(full).slice(0, MAX_TEXT),
    citat: quotedText(full).slice(0, MAX_TEXT),
    helText: full.slice(0, MAX_TEXT),
    bilagor: (mail.attachments ?? []).map((a) => a.filename).filter(Boolean),
    huvuden: Object.fromEntries((mail.headers ?? []).map((h) => [h.key, h.value])),
  };
}

const ROBOT = /(^|[._+-])(no-?reply|do-?not-?reply|noreply|mailer-daemon|postmaster|bounce[s]?|notification[s]?|newsletter|nyhetsbrev)([._+-]|@)/i;

/**
  Why the agent leaves this mail alone, or null when it should write a draft.
  Newsletters, automatic replies and bounces are never answered. `egna` are our own addresses:
  mail from them is skipped unless it is the contact form, which sets Reply-To to the visitor.
*/
export function skipReason(m, { egna = [] } = {}) {
  const h = m.huvuden ?? {};
  const auto = (h["auto-submitted"] ?? "").toLowerCase();
  if (auto && auto !== "no") return "automatiskt svar";
  if (h["x-autoreply"] || h["x-autorespond"] || h["x-auto-response-suppress"]) return "automatiskt svar";
  if (/^(bulk|list|junk)$/i.test((h["precedence"] ?? "").trim())) return "massutskick";
  if (h["list-unsubscribe"] || h["list-id"]) return "massutskick";
  if (ROBOT.test(m.fran)) return "avsändare som inte tar emot svar";
  if (/^(multipart\/report)/i.test(h["content-type"] ?? "")) return "studs";
  const own = egna.map((e) => e.toLowerCase());
  if (own.includes(m.fran) && (m.svaraTill === m.fran || own.includes(m.svaraTill))) return "från oss själva";
  if (!m.svaraTill) return "ingen avsändare";
  if (!m.text) return "tomt mejl";
  return null;
}

// Words that say nothing about what a mail is about.
const STOP = new Set(
  `och att det som inte för med har jag den till var men ett han hon vi ni de om så kan man från eller när nu
   min mitt mina din ditt dina sig vad hur här där ska skulle vill vara blir blev också bara mycket efter under
   över utan mot vid hos alla allt något någon inga inget hej hejsan tack hälsningar vänliga mvh tjena god
   the and for you that this with have from are was will your our can not but would could please thanks regards
   hello dear best kind undrar skulle gärna finns får gör göra vore tacksam svar fråga frågor mejl mail`.split(/\s+/),
);

/**
  An FTS5 expression of the words that carry a mail's meaning: any of them may match, and the
  ranking (bm25) puts the mails that share the rarest words first.
*/
export function ftsQuery(text, { max = 14 } = {}) {
  const seen = new Set();
  for (const word of String(text).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []) {
    if (STOP.has(word) || /^\d+$/.test(word)) continue;
    seen.add(word);
    if (seen.size >= max) break;
  }
  return [...seen].map((w) => `"${w}"`).join(" OR ");
}
