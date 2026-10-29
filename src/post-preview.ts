// What the review agent posts under your name, shown first, exactly: the Post form's payload (components/PostPreview.tsx),
// and the words that confirm it in chat instead. The page reads this too, so it imports nothing of the server's.

/** The Post form's renderer, registered in app.tsx. */
export const POST_PREVIEW_RENDERER = "post-preview";

/** The form's one button: what clicking it does. */
export type PostButton = "Post" | "Approve" | "Request changes" | "Merge" | "Close" | "Apply";

/** What the Post form shows: where it posts and as whom, then each part exactly as it posts. */
export interface PostShown {
  /** "Approve flosports/api#4512 as @casey", led by what it does: the form's title, and its row in the agent's chat. */
  title: string;
  /** What it does: "Approve", "Reply", "Merge"…, the form's chip. */
  action: string;
  button: PostButton;
  /** The text that posts, each part with what it is: "Summary", "src/a.ts:12" (`path`), "Title". */
  parts: Array<{ label: string; body: string; path?: boolean }>;
  /** What to know before posting, a warning a line: "2 new commits since you reviewed. Approving now covers them unseen." */
  notes: string[];
  /** How it's done, when it isn't text, a fact a line: "Squashed into one commit, at 1a2b3c4". */
  details?: string[];
}

/** The form's text in chat, for the reviewer to answer yes to when the form can't show. */
export function shownText(shown: PostShown): string {
  return [`**${shown.title}** · ${shown.action}`, ...shown.notes.map((note) => `> ${note}`), ...(shown.details ?? []).map((detail) => `- ${detail}`),
    ...shown.parts.map(({ label, body }) => `${label}:\n\n${body.split("\n").map((line) => `    ${line}`).join("\n")}`)].join("\n\n");
}

/**
 * The lines of text the plugin put in a message, by which it can be told the message carries it: each trimmed, its
 * spaces run together, of 3 characters or more.
 */
export function insertLines(text: string): string[] {
  return [...new Set(text.split(/\r\n?|\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line.length >= 3))];
}
/** Whether `text` has any of `lines` in it, its spaces run together as theirs are. */
export function carries(text: string, lines: readonly string[]): boolean {
  const flat = text.replace(/\s+/g, " ");
  return lines.some((line) => flat.includes(line));
}

/**
 * What of a message is the sender's own words: not a fenced block, a `>` quote line, or inline code, where the plugin and
 * bb put what they quote into it (a file's path, selected lines, a check's log), which the PR wrote. A fence or inline
 * code left open runs to the end. Only a backstop: a message carrying text the plugin put in it confirms nothing.
 */
export function ownWords(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(/\r\n?|\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (marker) { fence = marker; continue; }
    if (!/^\s*>/.test(line)) kept.push(line);
  }
  return withoutCode(kept.join("\n"));
}
/** `text` without its inline code: a run of backticks to the next run of as many, or to the end. */
function withoutCode(text: string): string {
  let out = "";
  let rest = text;
  for (let open = rest.match(/`+/); open; open = rest.match(/`+/)) {
    out += `${rest.slice(0, open.index)} `;
    const after = rest.slice(open.index! + open[0].length);
    const close = after.match(new RegExp(`(?<!\`)\`{${open[0].length}}(?!\`)`));
    if (!close) return out;
    rest = after.slice(close.index! + open[0].length);
  }
  return out + rest;
}
/** A message's own words as the yes and just-post-it rules read them. */
const plain = (text: string) => ownWords(text).toLowerCase().replace(/[‘’]/g, "'");
/** Words that turn a message into something other than a yes or a go-ahead: a condition, a change, a question, a no. */
const NEGATED = /\b(not|no|never|don't|dont|do not|can't|cant|cannot|won't|wont|shouldn't|shouldnt)\b/;
const NOT_YES = new RegExp(`${NEGATED.source}|\\b(but|nope|nah|wait|instead|first|hold|stop|cancel|change|edit|fix|later|unless|except|why|what|how|rather)\\b`);
/** Words a yes is made of. */
const YES = new Set(["yes", "yeah", "yep", "yup", "y", "ok", "okay", "k", "sure", "go", "ahead", "do", "ship", "lgtm", "confirm", "confirmed", "good", "great", "fine", "perfect"]);
const FILLER = new Set(["it", "that", "this", "please", "thanks", "thank", "you", "now", "looks", "sounds", "all", "the", "one", "for", "and"]);
/** The verbs that say yes to each button, and only to it: "close it" doesn't answer a Merge form. */
const VERBS: Record<Exclude<PostButton, "Apply">, string[]> = {
  Post: ["post", "send", "submit", "reply", "comment"], Approve: ["approve", "approved", "post", "send", "submit"], "Request changes": ["request", "changes", "post", "send", "submit"],
  Merge: ["merge"], Close: ["close"],
};

/**
 * Whether the whole message is a short yes to the form's `button`: "yes", "go for it", "approve it"; never "ok, but…".
 * An Apply form takes its own `action`'s verb ("add it" to Add label), and never another's ("remove it").
 */
export function affirms(text: string, button: PostButton, action = ""): boolean {
  const t = plain(text);
  if (t.includes("?") || NOT_YES.test(t)) return false;
  const words = t.replace(/[^a-z' ]+/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 6) return false;
  // An Apply form's own verb only: "request review" is no yes to Remove review request.
  const verbs = button === "Apply" ? ["apply", plain(action).split(/\s+/)[0]] : VERBS[button];
  return words.every((w) => YES.has(w) || FILLER.has(w) || verbs.includes(w)) && words.some((w) => YES.has(w) || verbs.includes(w));
}

/** What a form posts, as a message must say to post it without showing it first. */
export type JustVerb = "post" | "approve" | "request-changes" | "merge" | "close";

/**
 * The whole message, as the commands below are read: lowercased, quotes folded, punctuation gone, and a leading "ok",
 * "yes", "sure" or "please", or a trailing "please", "now" or "thanks", taken off.
 */
function command(text: string): string | null {
  const t = plain(text).replace(/[“”"]/g, " ").replace(/[.,!;:]/g, " ");
  // A question, or anything but words (an emoji, a number, another script), isn't a bare command.
  if (/[^a-z' \s]/.test(t)) return null;
  let words = t.trim().split(/\s+/).filter(Boolean);
  while (["ok", "okay", "yes", "yep", "sure", "please"].includes(words[0])) words = words.slice(1);
  for (;;) {
    if (["please", "now", "thanks"].includes(words.at(-1)!)) words = words.slice(0, -1);
    else if (words.at(-2) === "thank" && words.at(-1) === "you") words = words.slice(0, -2);
    else break;
  }
  return words.join(" ");
}
/** The whole messages that order an approve, request changes, merge or close without the form, and nothing else. */
const ORDERS: Record<Exclude<JustVerb, "post">, string[]> = {
  approve: ["approve it", "just approve it", "approve it just post it", "approve it and just post it", "approve it and post it", "approve and post it", "just approve it and post it"],
  "request-changes": ["request changes", "just request changes", "request changes just post it", "request changes and just post it", "request changes and post it"],
  merge: ["merge it", "just merge it", "merge it just post it", "merge it and just post it"],
  close: ["close it", "just close it", "close it just post it", "close it and just post it"],
};
/** Where a command starts: the message's start, after punctuation, or after a joining or softening word. */
const COMMAND = "(^|[.,;:!]\\s*|\\b(and|then|so|please|ok|okay)\\s+)";

/**
 * Whether the message says to post without showing it first. An approve, request changes, merge or close: only when
 * the whole message is a short command for exactly that ("just merge it", "approve it, just post it"); anything more,
 * a condition, a quote, another clause, goes through the form. Rules for intent in free text keep missing cases, so
 * these consequential ones take an allowlist. A reply, a PR comment or a Comment review: "just post it" as a command of
 * its own anywhere in it ("say thanks, just post it"), never negated. A named action authorizes only itself.
 */
export function justPost(text: string, verb: JustVerb): boolean {
  if (verb !== "post") {
    const order = command(text);
    return order !== null && ORDERS[verb].includes(order);
  }
  const t = plain(text);
  // A message that orders an approve, request changes, merge or close authorizes that alone.
  if (NEGATED.test(t) || /\b(approve|merge|close) it\b|\brequest changes\b/.test(t)) return false;
  return new RegExp(`${COMMAND}just (post|send|submit) it\\b`).test(t);
}
