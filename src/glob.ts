// Globs from files a PR controls (.gitattributes, applyTo), matched by stepping every pattern
// position at once over the path, O(pattern × path), so no pattern can backtrack for long.

type GlobToken =
  | { kind: "char"; test: (c: string) => boolean }
  | { kind: "star" } // any run inside one name
  | { kind: "globstar" } // anything, slashes included
  | { kind: "dirs" }; // "**/": any number of directories, even none, so what follows starts a name

export type Glob = GlobToken[];

const MAX_GLOB_LENGTH = 256;

// `*`, `?`, `**`, `**/`, `[a-z]`, `[!a]` and `\` escapes; null for a glob too long or malformed to use. As in git,
// `**` is a globstar only as a whole name, at the start or after a slash and at the end or before one; else it's `*`.
export function compileGlob(glob: string): Glob | null {
  if (glob.length > MAX_GLOB_LENGTH) return null;
  const tokens: Glob = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      const whole = i === 0 || glob[i - 1] === "/";
      while (glob[i + 1] === "*") i++;
      if (whole && glob[i + 1] === "/") { tokens.push({ kind: "dirs" }); i++; }
      else if (whole && i + 1 === glob.length) tokens.push({ kind: "globstar" });
      else tokens.push({ kind: "star" });
    } else if (c === "*") tokens.push({ kind: "star" });
    else if (c === "?") tokens.push({ kind: "char", test: (ch) => ch !== "/" });
    else if (c === "[" && glob.indexOf("]", i + 2) > 0) {
      const end = glob.indexOf("]", i + 2);
      const test = charClass(glob.slice(i + 1, end));
      if (!test) return null;
      tokens.push({ kind: "char", test });
      i = end;
    } else {
      const literal = c === "\\" && i + 1 < glob.length ? glob[++i] : c;
      tokens.push({ kind: "char", test: (ch) => ch === literal });
    }
  }
  return tokens;
}

function charClass(body: string): ((c: string) => boolean) | null {
  const negate = body[0] === "!" || body[0] === "^";
  const ranges: Array<[string, string]> = [];
  for (let i = negate ? 1 : 0; i < body.length; i++) {
    if (body[i + 1] === "-" && i + 2 < body.length) {
      if (body[i] > body[i + 2]) return null;
      ranges.push([body[i], body[i + 2]]);
      i += 2;
    } else ranges.push([body[i], body[i]]);
  }
  return (c) => c !== "/" && ranges.some(([from, to]) => c >= from && c <= to) !== negate;
}

// A position's flags: it may be passed by matching nothing there (FREE), or it's inside a "**/" that has begun a name
// (INSIDE), which only a slash ends; otherwise "**/b" would match any name ending in "b".
const FREE = 1;
const INSIDE = 2;

export function globMatches(glob: Glob, path: string): boolean {
  // Two arrays of positions, swapped per character rather than one per character: every path meets every rule.
  let on = new Uint8Array(glob.length + 1);
  let next = new Uint8Array(glob.length + 1);
  on[0] = FREE;
  reach(glob, on);
  for (let j = 0; j < path.length; j++) {
    const c = path[j];
    next.fill(0);
    for (let i = 0; i < glob.length; i++) {
      if (!on[i]) continue;
      const token = glob[i];
      if (token.kind === "char") { if (token.test(c)) next[i + 1] |= FREE; }
      else if (token.kind === "star") { if (c !== "/") next[i] |= FREE; }
      else if (token.kind === "globstar" || c === "/") next[i] |= FREE;
      else next[i] |= INSIDE;
    }
    if (!next.some((flags) => flags !== 0)) return false;
    reach(glob, next);
    [on, next] = [next, on];
  }
  return on[glob.length] !== 0;
}

// Adds the positions reachable by matching nothing: past a star, a globstar or a "**/" where a name begins.
function reach(glob: Glob, on: Uint8Array) {
  for (let i = 0; i < glob.length; i++) if (on[i] & FREE && glob[i].kind !== "char") on[i + 1] |= FREE;
}
