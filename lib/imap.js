/*
  Brevlådan över IMAP: läsa mappar och lägga ett utkast i en mapp. Agenten skickar aldrig något;
  här finns ingen SMTP.
*/
import { ImapFlow } from "imapflow";

export function connect(env = process.env) {
  for (const k of ["MEJL_IMAP_HOST", "MEJL_IMAP_USER", "MEJL_IMAP_PASSWORD"]) if (!env[k]) throw new Error(`${k} saknas`);
  const port = Number(env.MEJL_IMAP_PORT || 993);
  return new ImapFlow({
    host: env.MEJL_IMAP_HOST,
    port,
    // 993 is TLS from the first byte. Only a local test server runs without it.
    secure: env.MEJL_IMAP_TLS ? env.MEJL_IMAP_TLS !== "av" : port === 993,
    auth: { user: env.MEJL_IMAP_USER, pass: env.MEJL_IMAP_PASSWORD },
    logger: false,
  });
}

const NAMES = {
  "\\Sent": ["Sent", "Sent Items", "Sent Messages", "Skickat", "Skickade"],
  "\\Drafts": ["Drafts", "Utkast"],
};

/** The folder with a special role (\Sent, \Drafts), by its flag or its usual names. */
export async function findFolder(client, role) {
  const folders = await client.list();
  const flagged = folders.find((f) => f.specialUse === role);
  if (flagged) return flagged.path;
  const names = NAMES[role].map((n) => n.toLowerCase());
  // cPanel puts everything under "INBOX.", so the last part of the path is what we compare.
  return folders.find((f) => names.includes(f.name.toLowerCase()))?.path ?? null;
}

// Folders that hold no conversations worth learning from, or that would count mail twice.
// A folder inside one of these (Trash.Old) is left out too.
const NOT_MAIL = new Set(["\\Drafts", "\\Trash", "\\Junk", "\\All", "\\Flagged"]);
const NOT_MAIL_NAMES = /^(drafts|utkast|trash|deleted( items| messages)?|papperskorg(en)?|borttaget|borttagna( objekt)?|raderat|raderade( objekt)?|spam|junk( e-?mail)?|skräppost|privat|private|personligt)$/i;
const SENT_NAMES = /^(sent|sent items|sent messages|sent mail|skickat|skickade|skickade objekt)$/i;

const segments = (f) => f.path.split(f.delimiter || ".");
// "Löner" and "INBOX.Löner" are the same folder to whoever writes the list.
const bare = (p) => p.trim().replace(/^INBOX[./]/i, "").toLowerCase();

/**
  Every folder with mail in it worth archiving, as { path, sent }, the inbox first and the sent
  folders last. `exclude` is a list of folders (with or without "INBOX.") that are never read,
  nor any folder inside them: for mail that must not end up in the archive, such as salaries
  or job applications.
*/
export async function mailFolders(client, { exclude = [] } = {}) {
  const ex = exclude.filter(Boolean).map(bare);
  const out = (await client.list())
    .filter((f) => !f.flags?.has?.("\\Noselect") && !NOT_MAIL.has(f.specialUse))
    .filter((f) => !segments(f).some((n) => NOT_MAIL_NAMES.test(n)))
    .filter((f) => {
      const b = bare(f.path);
      return !ex.some((e) => b === e || b.startsWith(`${e}${f.delimiter || "."}`));
    })
    .map((f) => ({ path: f.path, sent: f.specialUse === "\\Sent" || SENT_NAMES.test(f.name) || segments(f).some((n) => SENT_NAMES.test(n)) }));
  // Some servers leave the inbox out of the list when other folders live under "INBOX.".
  if (!ex.includes("inbox") && !out.some((f) => f.path.toUpperCase() === "INBOX")) out.unshift({ path: "INBOX", sent: false });
  const rank = (f) => (f.path.toUpperCase() === "INBOX" ? 0 : f.sent ? 2 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

/** The path of a folder by name, created if missing, under the server's own prefix. */
export async function ensureFolder(client, name) {
  const folders = await client.list();
  const found = folders.find((f) => f.path === name || f.name === name);
  if (found) return found.path;
  const inbox = folders.find((f) => f.path.toUpperCase() === "INBOX");
  const nested = folders.find((f) => f.path.toUpperCase().startsWith("INBOX") && f.path.length > 5);
  const path = nested ? `INBOX${nested.delimiter || inbox?.delimiter || "."}${name}` : name;
  await client.mailboxCreate(path);
  return path;
}

/**
  Every mail in a folder with a UID above `after`, oldest first, as { uid, flags, raw }.
  `skip` is a set of UIDs to leave out (already archived). The mails are fetched `chunk` at a
  time in one command each, then handed to `each` one by one, so a large folder never sits in
  memory and `each` may use the connection itself (to save a draft).
*/
export async function readFolder(client, path, { after = 0, limit = Infinity, since, skip, chunk = 100 } = {}, each) {
  const lock = await client.getMailboxLock(path);
  try {
    const box = client.mailbox;
    const info = { uidValidity: String(box.uidValidity), uidNext: Number(box.uidNext), exists: box.exists, antal: 0 };
    if (!box.exists || !each) return info;
    const search = since ? { since } : { uid: `${after + 1}:*` };
    // "n:*" also returns the newest mail when nothing is newer than n, so filter on the UID.
    const uids = ((await client.search(search, { uid: true })) || [])
      .filter((u) => u > after && !skip?.has(u))
      .sort((a, b) => a - b)
      .slice(0, limit);
    info.antal = uids.length;
    for (let i = 0; i < uids.length; i += chunk) {
      const part = uids.slice(i, i + chunk);
      const got = [];
      for await (const msg of client.fetch(part.join(","), { uid: true, flags: true, source: true }, { uid: true })) {
        if (msg?.source) got.push({ uid: msg.uid, flags: msg.flags ?? new Set(), raw: msg.source });
      }
      got.sort((a, b) => a.uid - b.uid);
      for (const m of got) await each(m, { klara: i + got.length, totalt: uids.length });
    }
    return info;
  } finally {
    lock.release();
  }
}

/**
  The Message-IDs of the flagged mails in a folder, without angle brackets. A flag means
  "I handle this thread myself": a new mail in the same thread gets no draft.
*/
export async function flaggedIds(client, path = "INBOX") {
  const lock = await client.getMailboxLock(path);
  try {
    const uids = (await client.search({ flagged: true }, { uid: true })) || [];
    const ids = new Set();
    if (!uids.length) return ids;
    for await (const m of client.fetch(uids.join(","), { envelope: true }, { uid: true })) {
      const id = String(m.envelope?.messageId ?? "").trim().replace(/^<|>$/g, "");
      if (id) ids.add(id);
    }
    return ids;
  } finally {
    lock.release();
  }
}

/** Saves a finished message (RFC 822) in a folder as a draft. */
export async function appendDraft(client, path, raw) {
  await client.append(path, raw, ["\\Draft"]);
}
