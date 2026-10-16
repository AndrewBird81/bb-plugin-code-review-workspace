// Globs from files a PR controls (.gitattributes, applyTo), matched by stepping every pattern
// position at once over the path, O(pattern × path), so no pattern can backtrack for long.

type GlobToken =
  | { kind: "char"; test: (c: string) => boolean }
  | { kind: "star" } // any run inside one name
  | { kind: "globstar" } // anything, slashes included
  | { kind: "dirs" }; // "**/": any number of directories, even none

export type Glob = GlobToken[];

const MAX_GLOB_LENGTH = 256;

// `*`, `?`, `**`, `**/`, `[a-z]`, `[!a]` and `\` escapes; null for a glob too long or malformed to use.
export function compileGlob(glob: string): Glob | null {
  if (glob.length > MAX_GLOB_LENGTH) return null;
  const tokens: Glob = [];
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      if (glob[i + 2] === "/") { tokens.push({ kind: "dirs" }); i += 2; } else { tokens.push({ kind: "globstar" }); i++; }
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

export function globMatches(glob: Glob, path: string): boolean {
  // Two arrays of positions, swapped per character rather than one per character: every path meets every rule.
  let on = new Uint8Array(glob.length + 1);
  let next = new Uint8Array(glob.length + 1);
  on[0] = 1;
  reach(glob, on);
  for (let j = 0; j < path.length; j++) {
    const c = path[j];
    next.fill(0);
    for (let i = 0; i < glob.length; i++) {
      if (!on[i]) continue;
      const token = glob[i];
      if (token.kind === "char") { if (token.test(c)) next[i + 1] = 1; }
      else if (token.kind === "star") { if (c !== "/") next[i] = 1; }
      else {
        next[i] = 1;
        if (token.kind === "dirs" && c === "/") next[i + 1] = 1;
      }
    }
    if (!next.includes(1)) return false;
    reach(glob, next);
    [on, next] = [next, on];
  }
  return on[glob.length] === 1;
}

// Adds the positions reachable by matching nothing: past a star, a globstar or "**/".
function reach(glob: Glob, on: Uint8Array) {
  for (let i = 0; i < glob.length; i++) if (on[i] && glob[i].kind !== "char") on[i + 1] = 1;
}
