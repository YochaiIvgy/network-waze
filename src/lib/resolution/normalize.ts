/** Text normalisation and string similarity. No dependencies on purpose — these
 *  are the primitives every resolution decision rests on, so they stay readable. */

const HONORIFICS = new Set(["mr", "mrs", "ms", "miss", "dr", "prof", "sir", "rev"]);
const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "phd", "md", "esq"]);

const ORG_NOISE = [
  "inc", "inc.", "llc", "l.l.c.", "ltd", "limited", "corp", "corporation", "co", "company",
  "plc", "gmbh", "sa", "nv", "ag", "holdings", "group", "partners", "capital", "ventures",
  "the",
];

export function stripAccents(s: string): string {
  if (!s) return "";
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

/** Canonical form used as the blocking key and for exact-match short circuits. */
export function normalizeName(raw: string): string {
  const tokens = stripAccents(raw)
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !HONORIFICS.has(t) && !SUFFIXES.has(t));
  return tokens.join(" ").trim();
}

export function normalizeOrg(raw: string): string {
  const tokens = stripAccents(raw)
    .toLowerCase()
    .replace(/[^a-z0-9\s&-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !ORG_NOISE.includes(t));
  return (tokens.length ? tokens : [stripAccents(raw).toLowerCase().trim()]).join(" ");
}

export function nameParts(raw: string): { first: string; last: string; middle: string[] } {
  const tokens = normalizeName(raw).split(" ").filter(Boolean);
  if (tokens.length === 0) return { first: "", last: "", middle: [] };
  if (tokens.length === 1) return { first: tokens[0], last: "", middle: [] };
  return { first: tokens[0], last: tokens[tokens.length - 1], middle: tokens.slice(1, -1) };
}

/**
 * Blocking keys. Every key an entity emits is one bucket it can be found in;
 * candidate generation is a lookup on these rather than a scan of the graph.
 */
export function blockingKeys(name: string, extra: { email?: string | null; org?: string | null } = {}): string[] {
  const keys = new Set<string>();
  const norm = normalizeName(name);
  if (!norm) return [];
  keys.add(`n:${norm}`);

  const { first, last } = nameParts(name);
  if (last) {
    keys.add(`l:${last}`);
    if (first) keys.add(`fl:${first[0]}:${last}`);
  } else if (first) {
    // First-name-only mentions get their own bucket. They are never merged on
    // this key alone — see resolve.ts — but they must remain findable.
    keys.add(`f:${first}`);
  }

  if (extra.email) keys.add(`e:${extra.email.toLowerCase().trim()}`);
  if (extra.email?.includes("@")) keys.add(`d:${extra.email.split("@")[1].toLowerCase()}`);
  if (extra.org) keys.add(`o:${normalizeOrg(extra.org)}`);
  return [...keys];
}

/** Jaro-Winkler: handles transpositions and shared prefixes, which is exactly
 *  how human name variants differ. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;

  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Name similarity with the surname rule baked in: matching surnames plus a
 * compatible first name is strong evidence; a bare first-name match is not.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const pa = nameParts(a);
  const pb = nameParts(b);

  // "Sarah" vs "Sarah Chen": compatible, not proof. Capped well below auto-merge.
  if (!pa.last || !pb.last) {
    return pa.first && pa.first === pb.first ? 0.55 : jaroWinkler(na, nb) * 0.5;
  }

  const lastSim = jaroWinkler(pa.last, pb.last);
  if (lastSim < 0.85) return Math.min(jaroWinkler(na, nb), 0.6);

  // Initials count: "M. Chen" and "Michael Chen".
  const firstSim =
    pa.first === pb.first
      ? 1
      : pa.first.length === 1 || pb.first.length === 1
        ? pa.first[0] === pb.first[0]
          ? 0.85
          : 0
        : jaroWinkler(pa.first, pb.first);

  return lastSim * 0.55 + firstSim * 0.45;
}

export function tokenSet(s: string): Set<string> {
  return new Set(
    stripAccents(s)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 2),
  );
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
