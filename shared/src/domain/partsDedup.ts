import { normalizeLookupCompact, normalizeLookupText } from './lookupNormalize.js';
import { damerauLevenshtein, tokenizeLookup } from './tieredSearch.js';

// Т2 (docs/plans/parts-articul-acts-2026-06.md): grouping of duplicate-candidate
// directory parts for the operator merge screen. Pure — testable without DB.
//
// Identity key matches the Т1 write-gate: pair (name, артикул), both compact-normalized.
// - exact group: same pair key → «жёсткий дубль» (pre-gate legacy data).
// - code-collision group: same non-empty артикул on rows with DIFFERENT names. The
//   артикул is meant to identify the part, so a shared code is never a legal family
//   (unlike same-name/different-code). It is either a true duplicate (merge) or a
//   mis-keyed part (fix the code) — the operator decides. Without this tier such
//   pairs are invisible: their names are too far apart for the fuzzy matcher, yet a
//   shared code is exactly the kind of collision that breaks a cold ledger replay
//   (two rows replaying the same unique erp_nomenclature.code).
// - fuzzy group: similar names AND compatible артикулы (equal-compact or one empty).
//   Same name with two DIFFERENT артикулы is a legal family (Вал коленчатый
//   3305-01-18 / 3305-01-17), never a candidate.

export type DirectoryPartDuplicateInput = {
  id: string;
  name: string;
  code: string | null;
};

export type DirectoryPartDuplicateGroup = {
  kind: 'exact' | 'code-collision' | 'fuzzy';
  ids: string[];
};

export function directoryPartIdentityKey(name: string, code: string | null | undefined): string {
  return `${normalizeLookupCompact(String(name ?? ''))}|${normalizeLookupCompact(String(code ?? ''))}`;
}

function nameFuzzyBudget(len: number): number {
  if (len < 4) return 0;
  if (len <= 7) return 1;
  return 2;
}

function codesCompatible(a: string, b: string): boolean {
  return a === '' || b === '' || a === b;
}

function namesSimilar(aCompact: string, bCompact: string, aTokens: string[], bTokens: string[]): boolean {
  if (aCompact === bCompact) return true;
  // Word permutation / shuffled order: identical token multisets.
  const aSorted = [...aTokens].sort().join(' ');
  const bSorted = [...bTokens].sort().join(' ');
  if (aSorted && aSorted === bSorted) return true;
  // One extra/missing word, the rest identical.
  if (Math.abs(aTokens.length - bTokens.length) === 1) {
    const [longer, shorter] = aTokens.length > bTokens.length ? [aTokens, bTokens] : [bTokens, aTokens];
    const rest = [...longer];
    for (const t of shorter) {
      const i = rest.indexOf(t);
      if (i < 0) return namesTypoClose(aCompact, bCompact);
      rest.splice(i, 1);
    }
    if (rest.length === 1) return true;
  }
  return namesTypoClose(aCompact, bCompact);
}

function namesTypoClose(aCompact: string, bCompact: string): boolean {
  const budget = Math.min(nameFuzzyBudget(aCompact.length), nameFuzzyBudget(bCompact.length));
  if (budget === 0) return false;
  if (Math.abs(aCompact.length - bCompact.length) > budget) return false;
  return damerauLevenshtein(aCompact, bCompact, budget) <= budget;
}

export function groupDirectoryPartDuplicates(rows: DirectoryPartDuplicateInput[]): DirectoryPartDuplicateGroup[] {
  const groups: DirectoryPartDuplicateGroup[] = [];

  // Exact: same (name, артикул) pair key.
  const byKey = new Map<string, string[]>();
  for (const r of rows) {
    const key = directoryPartIdentityKey(r.name, r.code);
    const list = byKey.get(key);
    if (list) list.push(r.id);
    else byKey.set(key, [r.id]);
  }
  const inExact = new Set<string>();
  for (const ids of byKey.values()) {
    if (ids.length > 1) {
      groups.push({ kind: 'exact', ids: [...ids] });
      for (const id of ids) inExact.add(id);
    }
  }

  // Code collision: same non-empty артикул among non-exact rows. Exact members are
  // excluded (their identical name+code already pins them); among the rest, any rows
  // sharing a code necessarily differ in name (an identical name+code would have been
  // grouped as exact above), so every such group is a genuine code collision.
  const inCodeCollision = new Set<string>();
  const byCode = new Map<string, string[]>();
  for (const r of rows) {
    if (inExact.has(r.id)) continue;
    const code = normalizeLookupCompact(String(r.code ?? ''));
    if (!code) continue;
    const list = byCode.get(code);
    if (list) list.push(r.id);
    else byCode.set(code, [r.id]);
  }
  for (const ids of byCode.values()) {
    if (ids.length > 1) {
      groups.push({ kind: 'code-collision', ids: [...ids] });
      for (const id of ids) inCodeCollision.add(id);
    }
  }

  // Fuzzy: union-find over pairs with similar names + compatible артикулы.
  // Exact- and code-collision members are excluded — already decided above.
  const fuzzyRows = rows
    .filter((r) => !inExact.has(r.id) && !inCodeCollision.has(r.id))
    .map((r) => ({
      id: r.id,
      compactName: normalizeLookupCompact(r.name),
      tokens: tokenizeLookup(normalizeLookupText(r.name)),
      compactCode: normalizeLookupCompact(String(r.code ?? '')),
    }));
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = x;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const r of fuzzyRows) parent.set(r.id, r.id);
  for (let i = 0; i < fuzzyRows.length; i += 1) {
    const a = fuzzyRows[i]!;
    if (!a.compactName) continue;
    for (let j = i + 1; j < fuzzyRows.length; j += 1) {
      const b = fuzzyRows[j]!;
      if (!b.compactName) continue;
      if (!codesCompatible(a.compactCode, b.compactCode)) continue;
      if (namesSimilar(a.compactName, b.compactName, a.tokens, b.tokens)) union(a.id, b.id);
    }
  }
  const clusters = new Map<string, string[]>();
  for (const r of fuzzyRows) {
    const root = find(r.id);
    const list = clusters.get(root);
    if (list) list.push(r.id);
    else clusters.set(root, [r.id]);
  }
  for (const ids of clusters.values()) {
    if (ids.length > 1) groups.push({ kind: 'fuzzy', ids: [...ids] });
  }

  return groups;
}
