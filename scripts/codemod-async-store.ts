/**
 * Converts the Store's callers from the synchronous Store to the AsyncStore (1.3.0):
 * - each store call is awaited, and so is each call to a function this makes async;
 * - a synchronous function that makes either call becomes async, and so do its callers, up the call chains. One already
 *   async gains only the awaits; one that already returned a Promise becomes async without its callers changing;
 * - rule R1: outside tests, a function made async runs its whole body as one `store.exclusive` block, the store its
 *   body uses (`store`, `deps.store`, or one destructured from them) replaced there by the block's `tx`, which is also
 *   what an object carrying the store (`deps`) carries into the helpers it's handed to. A body that reaches the store
 *   once isn't wrapped: one call, or one call to a helper whose own body is a block, is one turn of the queue already.
 *   Async work a block starts and doesn't await keeps the outer store, since tx is stale once the block ends, and is
 *   listed: it has to start after the block;
 * - an array method's callback that reaches the store: a `forEach` statement over an array, Map or Set becomes a
 *   `for…of` loop, which runs the callbacks in the same order; a `map` or `flatMap` over an array becomes `Promise.all`
 *   over async callbacks when they only read the store and change nothing declared outside them, so that running them
 *   together changes nothing they see or leave;
 * - the Store's type becomes AsyncStore, and createStore's result goes through queueStore;
 * - in tests, `expect(() => …).toThrow()` of what is now async becomes `await expect(…).rejects.toThrow()`.
 *
 * What it can't convert faithfully it leaves for a hand fix and lists, with why. It still awaits each call there, so an
 * await where none can go (a default parameter, a callback it didn't make async) fails to compile at that spot.
 *
 * Run from the repo root: `node scripts/codemod-async-store.ts [--write] [tsconfig.json]`. It prints what it would
 * change and what it leaves; only with --write does it write the files.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Node, Project, SyntaxKind, ts } from "ts-morph";
import type {
  ArrowFunction, CallExpression, ConstructorDeclaration, FunctionDeclaration, FunctionExpression, GetAccessorDeclaration,
  MethodDeclaration, ObjectLiteralExpression, PropertyAccessExpression, SetAccessorDeclaration, Signature, SourceFile, Type,
} from "ts-morph";

export interface CodemodOptions {
  /** Paths in the plan are relative to it. */
  root: string;
  /** The interfaces whose methods are store calls, by the file (relative to root) that declares each. */
  storeInterfaces: ReadonlyArray<{ file: string; name: string }>;
  /** The store's methods that only read it. */
  readMethods: ReadonlySet<string>;
  /** The module, relative to root, that exports AsyncStore and queueStore. */
  queueModule: string;
  /** The function that creates the synchronous store, whose result goes through queueStore. */
  storeFactory: { file: string; name: string };
  /** Whether to convert a source file. */
  include: (filePath: string) => boolean;
  /** Whether rule R1 wraps the functions of a converted file: not in tests. */
  wrap: (filePath: string) => boolean;
}

export interface Site { file: string; line: number }

export type ChangeKind =
  | "async" // a synchronous function made async
  | "block" // R1: its body made one store.exclusive block
  | "await" // a store call, or a call to a function made async, awaited
  | "loop" // a forEach statement made a for…of loop
  | "promise-all" // a map or flatMap made Promise.all over async callbacks
  | "expect" // expect(() => …).toThrow() made await expect(…).rejects.toThrow()
  | "lift" // a closure over the store made to take it as its first parameter, so a block can hand it tx
  | "type" // the Store's type made AsyncStore
  | "queue"; // createStore's result put through queueStore

export interface Change extends Site { kind: ChangeKind; name: string; detail: string }

export type UnhandledKind =
  | "array callback" // a store-using callback of an array method it can't rewrite
  | "default parameter" // a store use in a default parameter, which can't await
  | "sync position" // a store use at module scope, or in a constructor, accessor or generator
  | "sync callback" // a function made async, handed on where its result is used synchronously
  | "closure in block" // a call in an R1 block to a function that reaches the store through its closure
  | "outer store in block" // the outer store in an R1 block, kept as a value or handed on inside something
  | "detached in block" // a call in an R1 block that leaves async work reaching the store running past the block
  | "nested function in block" // a function in an R1 block that reaches the store, and may run outside it
  | "returns a promise" // a function made async that returned a Promise, which an R1 block would wait for
  | "several stores" // a function R1 would wrap whose body uses more than one store, or one it can't trace
  | "no store to wrap" // a function R1 would wrap whose body reaches the store only through what it calls
  | "store stand-in" // an object implementing the store, or cast to it, outside the store's own files
  | "pinned" // a function the store's implementation calls, which stays synchronous
  | "type predicate" // a function made async whose return type is a type predicate
  | "method as value"; // a store method taken without being called, whose calls it can't follow

export interface Unhandled extends Site { kind: UnhandledKind; name: string; detail: string }

export interface CodemodPlan {
  /** Each changed file's new text, by its path relative to root. */
  files: Array<{ file: string; text: string }>;
  changes: Change[];
  unhandled: Unhandled[];
}

/** R1's block around a function's body: `receiver.exclusive(async (tx) => …)`, on the store `source` declares. */
interface Block { receiver: string; source: Node; tx: string }

type Fn = FunctionDeclaration | FunctionExpression | ArrowFunction | MethodDeclaration | GetAccessorDeclaration | SetAccessorDeclaration | ConstructorDeclaration;
type Owner = Fn | SourceFile;

const FN_KINDS = new Set([SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression, SyntaxKind.ArrowFunction, SyntaxKind.MethodDeclaration, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor, SyntaxKind.Constructor]);
const isFn = (node: Node | undefined): node is Fn => !!node && FN_KINDS.has(node.getKind());

/** Array methods that call their callback before they return. */
const ARRAY_CALLBACK_METHODS = new Set(["filter", "map", "flatMap", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "sort", "toSorted", "forEach", "reduce", "reduceRight"]);
const TO_THROW = new Set(["toThrow", "toThrowError"]);
const ASSIGNMENTS = new Set([
  SyntaxKind.EqualsToken, SyntaxKind.PlusEqualsToken, SyntaxKind.MinusEqualsToken, SyntaxKind.AsteriskEqualsToken, SyntaxKind.AsteriskAsteriskEqualsToken,
  SyntaxKind.SlashEqualsToken, SyntaxKind.PercentEqualsToken, SyntaxKind.LessThanLessThanEqualsToken, SyntaxKind.GreaterThanGreaterThanEqualsToken,
  SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, SyntaxKind.AmpersandEqualsToken, SyntaxKind.BarEqualsToken, SyntaxKind.CaretEqualsToken,
  SyntaxKind.BarBarEqualsToken, SyntaxKind.AmpersandAmpersandEqualsToken, SyntaxKind.QuestionQuestionEqualsToken,
]);
const INCREMENTS = new Set([SyntaxKind.PlusPlusToken, SyntaxKind.MinusMinusToken]);
/** Methods that change an array, Map or Set. */
const MUTATORS = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "copyWithin", "set", "add", "delete", "clear"]);

type Collection = "array" | "map" | "set";

/** What a forEach or map is called on, when it's a collection whose for…of runs what forEach does. */
function collectionOf(type: Type): Collection | null {
  if (type.isArray() || type.isReadonlyArray() || type.isTuple()) return "array";
  const name = type.getSymbol()?.getName();
  return name === "Map" || name === "ReadonlyMap" ? "map" : name === "Set" || name === "ReadonlySet" ? "set" : null;
}

const unwrap = (node: Node): Node => Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node) ? unwrap(node.getExpression()) : node;

/** The array method a call is, when its callbacks run before it returns. */
function arrayMethod(call: CallExpression): string | null {
  const callee = unwrap(call.getExpression());
  return Node.isPropertyAccessExpression(callee) && ARRAY_CALLBACK_METHODS.has(callee.getName()) ? callee.getName() : null;
}

/** An expression's position, through the parentheses and casts around it. */
function outermost(expression: Node): Node {
  let node = expression;
  for (let parent = node.getParent(); parent && (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isSatisfiesExpression(parent)); parent = parent.getParent()) node = parent;
  return node;
}

/** The array-method call a function is written inline as a callback of. */
function arrayCallbackCall(fn: Node): CallExpression | null {
  const position = outermost(fn);
  const parent = position.getParent();
  return Node.isCallExpression(parent) && parent.getArguments().includes(position) && arrayMethod(parent) ? parent : null;
}

/** Whether a function is called where it's written: `(() => …)()`. */
function isIife(fn: Node): boolean {
  const position = outermost(fn);
  const parent = position.getParent();
  return Node.isCallExpression(parent) && parent.getExpression() === position;
}

/** `expect(…)` in `expect(…).toThrow(…)` or `expect(…).not.toThrow(…)`. */
function isExpectOfThrow(call: CallExpression): boolean {
  if (call.getExpression().getText() !== "expect") return false;
  let chain = call.getParent();
  if (Node.isPropertyAccessExpression(chain) && chain.getName() === "not") chain = chain.getParent();
  return Node.isPropertyAccessExpression(chain) && TO_THROW.has(chain.getName()) && Node.isCallExpression(chain.getParent());
}

/** Text changes to a node, which the printer makes to the node's own text, after its leading trivia. */
interface Transform {
  /** Its new text; `print` gives a descendant's text with its own changes. */
  replace?: (print: Printer) => string;
  /** Wrapped around it, innermost first. */
  wraps: Array<{ before: string; after: string }>;
}

interface Printer {
  /** A node's changed text without its leading trivia, each new line indented by `more` too. */
  inner(node: Node, more?: string): string;
  /** With its leading trivia. */
  full(node: Node, more?: string): string;
}

const LITERAL_TOKENS = new Set([ts.SyntaxKind.StringLiteral, ts.SyntaxKind.NoSubstitutionTemplateLiteral, ts.SyntaxKind.TemplateHead, ts.SyntaxKind.TemplateMiddle, ts.SyntaxKind.TemplateTail, ts.SyntaxKind.JsxText]);

/**
 * A source file with its transforms. It prints the compiler's children, whose texts with their trivia make up the file
 * (a JSDoc comment is its node's leading trivia), so whatever no transform touches is printed as it was.
 */
function printFile(sf: SourceFile, transforms: ReadonlyMap<ts.Node, Transform>): string {
  const file = sf.compilerNode;
  const text = file.getFullText();
  // A node is touched when a transformed node lies in it. Ranges, not parents: getChildren's syntax lists aren't parents.
  const changed = [...transforms.keys()].map((n) => ({ start: n.getStart(file), end: n.end })).sort((a, b) => a.start - b.start || a.end - b.end);
  const touched = (node: ts.Node) => {
    let low = 0;
    for (let high = changed.length; low < high;) { const mid = (low + high) >> 1; if (changed[mid].start < node.pos) low = mid + 1; else high = mid; }
    for (let i = low; i < changed.length && changed[i].start < node.end; i++) if (changed[i].end <= node.end) return true;
    return false;
  };
  // Each line but a blank one; a string's or template's own lines keep their indent.
  const indent = (s: string, more: string) => more ? s.replace(/\n(?![ \t]*\r?\n)/g, `\n${more}`) : s;
  const children = (node: ts.Node) => node.getChildren(file).filter((c) => c.kind !== ts.SyntaxKind.JSDoc && c.end > c.pos);
  const inner = (node: ts.Node, more: string): string => {
    const transform = transforms.get(node);
    let out: string;
    if (transform?.replace) {
      out = transform.replace({ inner: (n, extra = "") => inner(n.compilerNode, more + extra), full: (n, extra = "") => full(n.compilerNode, more + extra) });
    } else if (!touched(node) && (!more || !node.getChildCount(file))) {
      const own = text.slice(node.getStart(file), node.end);
      out = LITERAL_TOKENS.has(node.kind) ? own : indent(own, more);
    } else {
      const [first, ...rest] = children(node);
      out = first ? inner(first, more) + rest.map((c) => full(c, more)).join("") : text.slice(node.getStart(file), node.end);
    }
    for (const { before, after } of transform?.wraps ?? []) out = before + out + after;
    return out;
  };
  const full = (node: ts.Node, more: string): string => indent(text.slice(node.pos, node.getStart(file)), more) + inner(node, more);
  return full(file, "");
}

export function planCodemod(project: Project, options: CodemodOptions): CodemodPlan {
  const checker = project.getTypeChecker();
  const files = project.getSourceFiles().filter((sf) => !sf.isDeclarationFile() && options.include(sf.getFilePath()));
  const included = new Set(files);
  const relative = (node: Node) => path.relative(options.root, node.getSourceFile().getFilePath());
  const site = (node: Node): Site => ({ file: relative(node), line: node.getStartLineNumber() });
  const at = (node: Node) => `${relative(node)}:${node.getStartLineNumber()}`;
  const changes: Change[] = [];
  const unhandled: Unhandled[] = [];
  const flagged = new Set<string>();
  const flag = (node: Node, kind: UnhandledKind, name: string, detail: string) => {
    const key = `${relative(node)}:${node.getStart()}:${kind}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    unhandled.push({ ...site(node), kind, name, detail });
  };
  const note = (node: Node, kind: ChangeKind, name: string, detail = "") => { changes.push({ ...site(node), kind, name, detail }); };

  // The store's methods and interfaces, and the object literals that implement them.
  const storeMethods = new Map<Node, string>();
  const storeInterfaces = new Set<Node>();
  for (const { file, name } of options.storeInterfaces) {
    const declaration = project.getSourceFileOrThrow(path.resolve(options.root, file)).getInterfaceOrThrow(name);
    storeInterfaces.add(declaration);
    for (const member of declaration.getMethods()) storeMethods.set(member, member.getName());
  }
  /** A store's type: the Store, an interface it extends, a Pick of it, or an intersection with one. */
  const isStoreType = (type: Type): boolean => {
    const t = type.getNonNullableType();
    return [t, ...t.getIntersectionTypes()].some((part) => part.getProperties().some((p) => p.getDeclarations().some((d) => storeMethods.has(d))));
  };
  const implementsStore = (type: Type): boolean =>
    [type, ...type.getIntersectionTypes()].some((t) => (t.getSymbol()?.getDeclarations() ?? []).some((d) => storeInterfaces.has(d)));
  const storeFiles = new Set(options.storeInterfaces.map(({ file }) => path.resolve(options.root, file)));
  const implementations = new Set<ObjectLiteralExpression>();
  for (const sf of files) for (const literal of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const type = checker.getContextualType(literal);
    if (type && implementsStore(type)) implementations.add(literal);
  }
  const inImplementation = (node: Node) => !!node.getFirstAncestor((a) => Node.isObjectLiteralExpression(a) && implementations.has(a));
  /** The functions that build an implementation, whose Store types stay. */
  const factories = new Set<Node>();
  for (const literal of implementations) {
    if (storeFiles.has(literal.getSourceFile().getFilePath())) {
      const factory = literal.getFirstAncestor((a) => isFn(a) && !inImplementation(a));
      if (factory) factories.add(factory);
    } else if (!Node.isAsExpression(literal.getParent())) {
      // A cast's literal is listed with its cast, below.
      flag(literal, "store stand-in", nameOf(ownerOf(literal)), "an object implementing the synchronous Store outside the store's own files; it's left as it is");
    }
  }

  const declarationOf = (signature: Signature | undefined): Node | undefined => {
    try { return signature?.getDeclaration(); } catch { return undefined; }
  };
  /** A call's target; an overload's is the function's implementation. */
  const targetOf = (call: CallExpression): Node | undefined => {
    const declaration = declarationOf(checker.getResolvedSignature(call));
    return Node.isFunctionDeclaration(declaration) && !declaration.hasBody() ? declaration.getImplementation() ?? declaration : declaration;
  };
  const isProjectFn = (node: Node | undefined): node is Fn => isFn(node) && included.has(node.getSourceFile()) && !inImplementation(node);
  /** The project function an expression names, when it names one. */
  const namedFunction = (expression: Node): Fn | undefined => {
    const node = unwrap(expression);
    if (isFn(node)) return node;
    if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) return undefined;
    let symbol = node.getSymbol();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    for (const declaration of symbol?.getDeclarations() ?? []) {
      const fn = Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration) ? declaration.getInitializer() && unwrap(declaration.getInitializer()!) : declaration;
      if (isProjectFn(fn)) return fn;
    }
    return undefined;
  };
  function ownerOf(node: Node): Owner { return (node.getFirstAncestor((a) => isFn(a)) as Fn | undefined) ?? node.getSourceFile(); }
  function nameOf(owner: Owner): string {
    if (Node.isSourceFile(owner)) return "<module scope>";
    const parent = owner.getFirstAncestor((a) => isFn(a)) as Fn | undefined;
    return parent ? `${ownName(parent)} > ${ownName(owner)}` : ownName(owner);
  }
  const isAsync = (fn: Fn) => Node.isAsyncable(fn) && fn.isAsync();
  const isGenerator = (fn: Fn) => (Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn)) && fn.isGenerator();
  const cannotBeAsync = (fn: Fn) => Node.isConstructorDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn) || isGenerator(fn);
  const returnsPromise = (fn: Fn) => {
    const type = fn.getReturnType();
    return (type.isUnion() ? type.getUnionTypes() : [type]).some((t) => !!t.getProperty("then"));
  };
  /** Whether the node runs more than once each time `top` runs: in a loop's body or test, or an array method's callback. */
  const repeats = (node: Node, top: Node): boolean => {
    for (let child = node, a = node.getParent(); a && a !== top; child = a, a = a.getParent()) {
      if (isFn(a) && arrayCallbackCall(a)) return true;
      if (Node.isWhileStatement(a) || Node.isDoStatement(a)) return true;
      if ((Node.isForOfStatement(a) || Node.isForInStatement(a)) && child === a.getStatement()) return true;
      if (Node.isForStatement(a) && (child === a.getStatement() || child === a.getCondition() || child === a.getIncrementor())) return true;
    }
    return false;
  };
  const inDefaultParameter = (node: Node, owner: Owner) => !Node.isSourceFile(owner)
    && owner.getParameters().some((p) => { const init = p.getInitializer(); return !!init && node.getStart() >= init.getStart() && node.getEnd() <= init.getEnd(); });

  // Functions the store's implementation calls (reanchorAll from restoreGuide) stay synchronous with it.
  const pinned = new Map<Fn, CallExpression>();
  for (const literal of implementations) for (const call of literal.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const target = targetOf(call);
    if (isProjectFn(target) && !pinned.has(target)) pinned.set(target, call);
  }
  const inPinned = (node: Node) => !!node.getFirstAncestor((a) => isFn(a) && pinned.has(a));
  /** The store method a node takes without calling it: `store.getReview` not called, or `const { getReview } = store`. */
  const storeMethodAsValue = (node: Node): string | undefined => {
    if (Node.isPropertyAccessExpression(node)) {
      const position = outermost(node);
      const holder = position.getParent();
      if (Node.isCallExpression(holder) && holder.getExpression() === position) return undefined;
      return node.getNameNode().getSymbol()?.getDeclarations().map((d) => storeMethods.get(d)).find(Boolean);
    }
    if (!Node.isBindingElement(node) || node.getDotDotDotToken()) return undefined;
    const holder = node.getParentOrThrow().getParent();
    const property = node.getPropertyNameNode()?.getText() ?? node.getName();
    const destructured = Node.isVariableDeclaration(holder) ? holder.getInitializer()?.getType() : Node.isParameterDeclaration(holder) ? holder.getType() : undefined;
    return destructured && new Set(storeMethods.values()).has(property) && isStoreType(destructured) ? property : undefined;
  };

  // Every store call, call to a project function, and array callback, by the function it's in.
  const storeCalls = new Map<Owner, CallExpression[]>();
  const functionCalls = new Map<Owner, Array<{ call: CallExpression; target: Fn }>>();
  /** Project functions passed by name to an array method. */
  const namedCallbacks = new Map<Owner, Array<{ call: CallExpression; target: Fn }>>();
  const inlineCallbacks = new Map<Owner, Fn[]>();
  /** expect(() => …).toThrow() with the callback written inline. */
  const expectCalls = new Map<Owner, Array<{ call: CallExpression; callback: Fn }>>();
  /** Every function, with the functions written directly in it; a file's too. */
  const functionsIn = new Map<Owner, Fn[]>();
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
  for (const sf of files) sf.forEachDescendant((node, traversal) => {
    if ((Node.isObjectLiteralExpression(node) && implementations.has(node)) || (isFn(node) && pinned.has(node))) { traversal.skip(); return; }
    if (isFn(node)) {
      if (!functionsIn.has(node)) functionsIn.set(node, []);
      push(functionsIn, ownerOf(node), node);
    }
    if (isFn(node) && arrayCallbackCall(node)) push(inlineCallbacks, ownerOf(node), node);
    const method = storeMethodAsValue(node);
    if (method) flag(node, "method as value", nameOf(ownerOf(node)), `the store's ${method} is taken here as a value, so its calls can't be found to await; call it on the store instead`);
    if (!Node.isCallExpression(node)) return;
    const target = targetOf(node);
    if (target && storeMethods.has(target)) push(storeCalls, ownerOf(node), node);
    else if (isProjectFn(target)) push(functionCalls, ownerOf(node), { call: node, target });
    if (arrayMethod(node)) for (const argument of node.getArguments()) {
      const named = isFn(unwrap(argument)) ? undefined : namedFunction(argument);
      if (named) push(namedCallbacks, ownerOf(node), { call: node, target: named });
    }
    const [first] = node.getArguments();
    if (first && isFn(unwrap(first)) && isExpectOfThrow(node)) push(expectCalls, ownerOf(node), { call: node, callback: unwrap(first) as Fn });
  });

  // The synchronous functions made async: each awaits a store call, a call to one of them, an array method or expect
  // whose callback became async; up the call chains until nothing changes.
  const converted = new Set<Fn>();
  /** Calls to it are awaited: it became async, and didn't return a Promise before. */
  const awaited = (fn: Fn) => converted.has(fn) && !returnsPromise(fn);
  const owners = new Set<Owner>([...storeCalls.keys(), ...functionCalls.keys(), ...namedCallbacks.keys(), ...inlineCallbacks.keys(), ...expectCalls.keys()]);
  const awaitsHere = (owner: Owner) => (storeCalls.get(owner) ?? []).length > 0
    || (functionCalls.get(owner) ?? []).some(({ target }) => awaited(target))
    || (namedCallbacks.get(owner) ?? []).some(({ target }) => converted.has(target))
    || (inlineCallbacks.get(owner) ?? []).some((cb) => converted.has(cb))
    || (expectCalls.get(owner) ?? []).some(({ callback }) => converted.has(callback));
  for (let grew = true; grew;) {
    grew = false;
    for (const owner of owners) {
      if (Node.isSourceFile(owner) || converted.has(owner) || isAsync(owner)) continue;
      if (awaitsHere(owner)) { converted.add(owner); grew = true; }
    }
  }
  for (const [fn, call] of pinned) if (fn.getDescendantsOfKind(SyntaxKind.CallExpression).some((c) => storeMethods.has(targetOf(c)!))) {
    flag(fn, "pinned", nameOf(fn), `the store's implementation calls it (${at(call)}), so it stays synchronous`);
    for (const calls of functionCalls.values()) for (const { call: outside, target } of calls) {
      if (target === fn) flag(outside, "pinned", nameOf(ownerOf(outside)), `${nameOf(fn)} (${at(fn)}) stays synchronous for the store's implementation, and gets the AsyncStore here`);
    }
  }

  /**
   * How many turns of the queue a function's body takes, counted up to 2: a store call takes one, and so does a call to a
   * helper that takes one or whose body R1 makes a block; one that repeats in a loop or array callback counts twice. A
   * default parameter runs before the body, outside its block.
   */
  const turnsMemo = new Map<Owner, number>();
  const turns = (owner: Owner, seen = new Set<Owner>()): number => {
    if (turnsMemo.has(owner)) return turnsMemo.get(owner)!;
    if (seen.has(owner)) return 2;
    seen.add(owner);
    let count = 0;
    const add = (node: Node, n: number) => { if (n && !inDefaultParameter(node, owner)) count += repeats(node, owner) ? 2 : n; };
    for (const call of storeCalls.get(owner) ?? []) add(call, 1);
    for (const { call, target } of functionCalls.get(owner) ?? []) if (awaited(target)) add(call, turns(target, seen) <= 1 || wrapped(target) ? 1 : 2);
    for (const { call, target } of namedCallbacks.get(owner) ?? []) if (converted.has(target)) add(call, 2);
    for (const cb of inlineCallbacks.get(owner) ?? []) if (converted.has(cb) && turns(cb, seen)) add(arrayCallbackCall(cb)!, 2);
    const result = Math.min(count, 2);
    turnsMemo.set(owner, result);
    return result;
  };
  /** Whether R1 makes a block of a function's body, when it takes two turns or more. */
  const wrapped = (fn: Fn) => options.wrap(fn.getSourceFile().getFilePath()) && !arrayCallbackCall(fn) && !cannotBeAsync(fn) && !returnsPromise(fn);
  // What writes to the store: a store call that isn't a read, or a call to what writes, until nothing changes.
  const writers = new Set<Owner>();
  for (let grew = true; grew;) {
    grew = false;
    for (const owner of owners) {
      if (writers.has(owner)) continue;
      const writes = (storeCalls.get(owner) ?? []).some((call) => !options.readMethods.has(storeMethods.get(targetOf(call)!)!))
        || (functionCalls.get(owner) ?? []).some(({ target }) => awaited(target) && writers.has(target))
        || (namedCallbacks.get(owner) ?? []).some(({ target }) => converted.has(target) && writers.has(target))
        || (inlineCallbacks.get(owner) ?? []).some((cb) => converted.has(cb) && writers.has(cb));
      if (writes) { writers.add(owner); grew = true; }
    }
  }
  const readOnly = (owner: Owner) => !writers.has(owner);
  /** The first variable declared outside a function that its body assigns, or changes with a method such as push. */
  const changesOutside = (fn: Fn): string | null => {
    const outside = (node: Node) => {
      let root = node;
      while (Node.isPropertyAccessExpression(root) || Node.isElementAccessExpression(root) || Node.isParenthesizedExpression(root) || Node.isNonNullExpression(root)) root = root.getExpression();
      const declarations = Node.isIdentifier(root) ? root.getSymbol()?.getDeclarations() ?? [] : [];
      return declarations.length && declarations.every((d) => d.getFirstAncestor((a) => a === fn) !== fn) ? root.getText() : null;
    };
    for (const node of fn.getDescendants()) {
      let changed: Node | undefined;
      if (Node.isBinaryExpression(node) && ASSIGNMENTS.has(node.getOperatorToken().getKind())) changed = node.getLeft();
      else if ((Node.isPrefixUnaryExpression(node) || Node.isPostfixUnaryExpression(node)) && INCREMENTS.has(node.getOperatorToken())) changed = node.getOperand();
      else if (Node.isDeleteExpression(node)) changed = node.getExpression();
      else if (Node.isCallExpression(node) && !storeMethods.has(targetOf(node)!)) {
        const callee = unwrap(node.getExpression());
        if (Node.isPropertyAccessExpression(callee) && MUTATORS.has(callee.getName())) changed = callee.getExpression();
      }
      const name = changed && outside(changed);
      if (name) return name;
    }
    return null;
  };

  // The array calls whose callbacks reach the store: a loop, Promise.all, or left for a hand fix.
  const arrayPlans = new Map<CallExpression, "loop" | "promise-all" | "left">();
  /** Why a forEach can't become a for…of loop that runs the same callbacks in the same order, or null when it can. */
  const loopProblem = (call: CallExpression, callback: Fn | undefined, collection: Collection | null): string | null => {
    if (!callback) return "its callback is passed by name";
    if (!Node.isExpressionStatement(call.getParent())) return "it isn't a statement of its own";
    if (call.getArguments().length > 1) return "it's given a this argument";
    if (!collection) return "it isn't called on an array, Map or Set";
    const params = callback.getParameters();
    if (params.length > 2 || params.some((p) => p.isRestParameter() || p.hasInitializer())) return "its callback takes the collection, a rest parameter or a default";
    if (!Node.isArrowFunction(callback) && callback.getDescendants().some((n) => Node.isThisExpression(n) || (Node.isIdentifier(n) && n.getText() === "arguments"))) return "its callback uses this or arguments";
    const returns = callback.getDescendantsOfKind(SyntaxKind.ReturnStatement).filter((r) => ownerOf(r) === callback);
    if (returns.some((r) => r.getExpression())) return "its callback returns a value";
    // A return becomes continue, which in a loop inside the callback would continue that loop instead.
    if (returns.some((r) => r.getFirstAncestor((a) => a === callback || Node.isIterationStatement(a)) !== callback)) return "its callback returns from inside a loop";
    return null;
  };
  /**
   * Why a map or flatMap can't run its callbacks together under Promise.all, or null when it can: they must only read
   * the store, since a write a callback's throw would have stopped runs anyway, and must change nothing declared
   * outside them, whose order would change.
   */
  const allProblem = (call: CallExpression, target: Fn, collection: Collection | null): string | null => {
    if (call.getArguments().length > 1) return "it's given a this argument";
    if (Node.isAwaitExpression(outermost(call).getParent())) return "it's awaited already";
    if (collection !== "array") return "it isn't called on an array";
    if (!readOnly(target)) return "its callbacks write to the store, so running them together could make writes a throw would have stopped";
    const changed = changesOutside(target);
    return changed ? `its callbacks change \`${changed}\`, declared outside them, so running them together could change the order of that` : null;
  };
  const planArray = (call: CallExpression, callback: Fn | undefined, target: Fn) => {
    if (arrayPlans.has(call)) return;
    const method = arrayMethod(call)!;
    const access = unwrap(call.getExpression()) as PropertyAccessExpression;
    const collection = collectionOf(access.getExpression().getType());
    const why = call.hasQuestionDotToken() || access.hasQuestionDotToken() ? "it's an optional call"
      : method === "forEach" ? loopProblem(call, callback, collection)
      : method === "map" || method === "flatMap" ? allProblem(call, target, collection)
      : `.${method} needs each callback's answer before it goes on`;
    if (!why) {
      arrayPlans.set(call, method === "forEach" ? "loop" : "promise-all");
      return;
    }
    arrayPlans.set(call, "left");
    flag(call, "array callback", nameOf(ownerOf(call)), `.${method}(${callback ? "…" : target.getSymbol()?.getName() ?? "fn"}) reaches the store, and ${why}`);
  };
  for (const callbacks of inlineCallbacks.values()) for (const cb of callbacks) if (converted.has(cb)) planArray(arrayCallbackCall(cb)!, cb, cb);
  for (const calls of namedCallbacks.values()) for (const { call, target } of calls) if (converted.has(target)) planArray(call, undefined, target);
  const madeAsync = new Set([...converted].filter((fn) => !arrayCallbackCall(fn) || arrayPlans.get(arrayCallbackCall(fn)!) === "promise-all"));

  // What reaches the store at all, awaited or not, through what it calls or the functions written in it.
  const allFunctions = [...functionsIn.keys()].filter((owner): owner is Fn => !Node.isSourceFile(owner));
  const reaching = new Set<Fn>(allFunctions.filter((fn) => storeCalls.has(fn)));
  for (let grew = true; grew;) {
    grew = false;
    for (const fn of allFunctions) {
      if (reaching.has(fn) || ![...(functionCalls.get(fn) ?? []).map(({ target }) => target), ...functionsIn.get(fn)!].some((f) => reaching.has(f))) continue;
      reaching.add(fn);
      grew = true;
    }
  }
  const reachesStore = (fn: Fn) => reaching.has(fn);
  /** Functions written in a function's body that can run after it returns: not the array callbacks it runs, nor an IIFE. */
  const laterFunctions = (fn: Fn): Fn[] => functionsIn.get(fn)!.flatMap((nested) => arrayCallbackCall(nested) || isIife(nested) ? laterFunctions(nested) : [nested]);
  /** A call that leaves async work running that reaches the store: a block hands it the outer store, for after the block. */
  const detached = (target: Fn) => !awaited(target) && (isAsync(target) || converted.has(target)) && reachesStore(target);
  // What starts such work, or awaits a function that does. Handed a block's tx, the work finds it stale once the block ends.
  const keeps = new Map<Fn, string>();
  for (const fn of allFunctions) {
    const started = callsIn(fn).find(({ target }) => detached(target));
    if (started) keeps.set(fn, `starts ${nameOf(started.target)} (${at(started.call)}) and doesn't await it`);
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const fn of allFunctions) {
      const through = keeps.has(fn) ? undefined : callsIn(fn).find(({ target }) => awaited(target) && keeps.has(target));
      if (!through) continue;
      keeps.set(fn, `awaits ${nameOf(through.target)} (${at(through.call)}), which ${keeps.get(through.target)}`);
      grew = true;
    }
  }

  const transforms = new Map<SourceFile, Map<ts.Node, Transform>>();
  const transformOf = (node: Node): Transform => {
    let map = transforms.get(node.getSourceFile());
    if (!map) transforms.set(node.getSourceFile(), map = new Map());
    let transform = map.get(node.compilerNode);
    if (!transform) map.set(node.compilerNode, transform = { wraps: [] });
    return transform;
  };
  const wrapNode = (node: Node, before: string, after = "") => { transformOf(node).wraps.push({ before, after }); };
  const replaceNode = (node: Node, replace: (print: Printer) => string) => {
    const transform = transformOf(node);
    if (transform.replace) throw new Error(`Two replacements at ${at(node)}`);
    transform.replace = replace;
  };
  const imports = new Map<SourceFile, Set<"AsyncStore" | "queueStore">>();
  const needImport = (sf: SourceFile, name: "AsyncStore" | "queueStore") => { let set = imports.get(sf); if (!set) imports.set(sf, set = new Set()); set.add(name); };

  // Value uses of the functions made async, where they're handed on rather than called.
  for (const fn of madeAsync) if (!arrayCallbackCall(fn)) for (const use of valueUses(fn)) checkValueUse(fn, use);

  // Closures over the store that are only ever called directly can take it as their first parameter instead, so that a
  // block can hand them its tx: the plugin's handlers share helpers (draftState, view) over the plugin's store. Each
  // candidate closes over one store variable, visible by its name wherever it's called, through what it calls too.
  const candidates = new Map<Fn, Node>();
  for (const fn of converted) {
    if (!awaited(fn) || !wrapped(fn)) continue;
    const free = freeStores(fn);
    const store = free.length === 1 ? free[0] : undefined;
    const name = store && variableName(store);
    if (!store || !name || !namedOnlyCalled(fn)) continue;
    if (functionsIn.get(fn)!.some((nested) => nested.getDescendantsOfKind(SyntaxKind.Identifier).some((i) => i.getText() === name && declarationOfName(i) === store))) continue;
    if (!callsTo(fn).every((call) => visibleByName(store, call))) continue;
    candidates.set(fn, store);
  }
  // A candidate whose store comes through a helper that can't take it as a parameter keeps its closure.
  for (let dropped = true; dropped;) {
    dropped = false;
    for (const fn of candidates.keys()) {
      const through = callsIn(fn).filter(({ target }) => awaited(target) && freeStores(target).length);
      if (through.every(({ target }) => candidates.has(target))) continue;
      candidates.delete(fn);
      dropped = true;
    }
  }

  // R1: the functions made async whose bodies become blocks, each on the one store its body uses: its own references,
  // or the one it would hand a helper that takes it as a parameter now.
  const blocks = new Map<Fn, Block>();
  for (const fn of madeAsync) {
    if (turns(fn) < 2 || !options.wrap(fn.getSourceFile().getFilePath()) || arrayCallbackCall(fn) || cannotBeAsync(fn)) continue;
    const name = nameOf(fn);
    if (returnsPromise(fn)) { flag(fn, "returns a promise", name, "it returned a Promise already, which a block would hold the queue for until it settles; it isn't wrapped"); continue; }
    const sources = new Map<string, Node>();
    let untraced: Node | null = null;
    for (const ref of storeRefs(fn)) {
      const source = sourceOf(ref, fn);
      if (source) sources.set(source.path, source.declaration); else untraced ??= ref;
    }
    for (const { target } of callsIn(fn)) {
      const store = candidates.get(target);
      if (store) sources.set(variableName(store)!, store);
    }
    if (untraced) { flag(untraced, "several stores", name, `can't tell which store \`${shorten(untraced.getText())}\` is; it isn't wrapped`); continue; }
    if (sources.size > 1) { flag(fn, "several stores", name, `its body uses ${[...sources.keys()].map((s) => `\`${s}\``).join(" and ")}; it isn't wrapped`); continue; }
    if (!sources.size) { flag(fn, "no store to wrap", name, "its body reaches the store only through functions that close over it, so it has no store of its own to run a block on; it isn't wrapped"); continue; }
    const [[receiver, source]] = sources;
    const taken = new Set(fn.getDescendantsOfKind(SyntaxKind.Identifier).map((i) => i.getText()));
    let tx = "tx";
    for (let i = 2; taken.has(tx); i++) tx = `tx${i}`;
    blocks.set(fn, { receiver, source, tx });
  }
  // The candidates a block calls are lifted, with the candidates they call.
  const lifted = new Map<Fn, Node>();
  const lift = (fn: Fn) => {
    if (lifted.has(fn) || !candidates.has(fn)) return;
    lifted.set(fn, candidates.get(fn)!);
    for (const { target } of callsIn(fn)) lift(target);
  };
  for (const fn of blocks.keys()) for (const { target } of callsIn(fn)) lift(target);
  for (const [fn, store] of lifted) planLift(fn, store);
  for (const [fn, block] of blocks) planBlock(fn, block);

  // Awaits: each store call and each call to a function made async, and each array call rewritten to Promise.all.
  // An expect whose callback is one such call takes the call's Promise instead.
  const expectBodies = new Set<Node>();
  for (const calls of expectCalls.values()) for (const { callback } of calls) {
    const body = callback.getBody();
    if (converted.has(callback) && Node.isCallExpression(body)) expectBodies.add(body);
  }
  const awaitSites: Node[] = [];
  for (const calls of storeCalls.values()) awaitSites.push(...calls);
  for (const calls of functionCalls.values()) for (const { call, target } of calls) if (awaited(target)) awaitSites.push(call);
  for (const [call, plan] of arrayPlans) if (plan === "promise-all") awaitSites.push(call);
  for (const node of awaitSites.sort((a, b) => a.getStart() - b.getStart())) {
    if (expectBodies.has(node) || Node.isAwaitExpression(outermost(node).getParent())) continue;
    const owner = ownerOf(node);
    if (Node.isSourceFile(owner)) flag(node, "sync position", "<module scope>", `\`${shorten(node.getText())}\` runs at module scope, which can't await`);
    else if (inDefaultParameter(node, owner)) flag(node, "default parameter", nameOf(owner), `\`${shorten(node.getText())}\` can't be awaited in a default parameter: move the default into the body`);
    else if (cannotBeAsync(owner)) flag(node, "sync position", nameOf(owner), `\`${shorten(node.getText())}\` is in a ${owner.getKindName()}, which can't be async`);
    const parent = node.getParent();
    const operand = (Node.isPropertyAccessExpression(parent) || Node.isElementAccessExpression(parent) || Node.isCallExpression(parent) || Node.isNonNullExpression(parent) || Node.isTaggedTemplateExpression(parent) || Node.isNewExpression(parent))
      && (parent as Node & { getExpression(): Node }).getExpression() === node;
    const exponent = Node.isBinaryExpression(parent) && parent.getOperatorToken().getKind() === SyntaxKind.AsteriskAsteriskToken && parent.getLeft() === node;
    if (operand || exponent) wrapNode(node, "(await ", ")"); else wrapNode(node, "await ");
    note(node, "await", nameOf(owner), shorten(node.getText(), 50));
  }

  // The array rewrites.
  for (const [call, plan] of arrayPlans) {
    if (plan === "left") continue;
    const name = nameOf(ownerOf(call));
    const access = unwrap(call.getExpression()) as Node & { getExpression(): Node; getNameNode(): Node };
    const method = arrayMethod(call)!;
    if (plan === "promise-all") {
      // Promise.all(xs.map(…)), whose await then wraps it; a flatMap's arrays are flattened after.
      transformOf(call).wraps.unshift({ before: "Promise.all(", after: ")" });
      if (method === "flatMap") {
        replaceNode(access.getNameNode(), () => "map");
        const awaitWrap = transformOf(call).wraps[1];
        awaitWrap.before = "(await ";
        awaitWrap.after = ").flat()";
      }
      note(call, "promise-all", name, `.${method}(…)`);
      continue;
    }
    // A forEach statement: for (const x of xs) body, a return in the callback now a continue.
    const callback = unwrap(call.getArguments()[0]) as Fn;
    const params = callback.getParameters();
    const body = callback.getBody()!;
    for (const ret of callback.getDescendantsOfKind(SyntaxKind.ReturnStatement)) if (ownerOf(ret) === callback) replaceNode(ret, () => "continue;");
    // A Map's forEach takes its values, then their keys; an array's, its items, then their indexes.
    const values = collectionOf(access.getExpression().getType()) === "map" ? ".values()" : "";
    replaceNode(call.getParentOrThrow(), (print) => {
      const binding = (i: number) => print.inner(params[i].getNameNode());
      const items = print.inner(access.getExpression());
      const head = params.length === 2 ? `for (const [${binding(1)}, ${binding(0)}] of ${items}.entries())` : `for (const ${params.length ? binding(0) : "_"} of ${items}${values})`;
      return Node.isBlock(body) ? `${head} ${print.inner(body)}` : `${head} ${print.inner(body)};`;
    });
    note(call, "loop", name, ".forEach(…)");
  }

  // expect(() => …).toThrow() of what's now async awaits its Promise's rejection, or for .not, its resolution.
  for (const [owner, calls] of expectCalls) for (const { call, callback } of calls) {
    if (!converted.has(callback)) continue;
    const negated = (call.getParentOrThrow() as Node & { getName(): string }).getName() === "not";
    const body = callback.getBody()!;
    if (expectBodies.has(body)) replaceNode(outermost(callback), (print) => print.inner(body));
    else wrapNode(outermost(callback), "(", ")()");
    wrapNode(call, "", negated ? ".resolves" : ".rejects");
    const assertion = (negated ? call.getParentOrThrow().getParentOrThrow().getParentOrThrow() : call.getParentOrThrow().getParentOrThrow()) as Node;
    wrapNode(assertion, "await ");
    if (!Node.isSourceFile(owner) && !isAsync(owner)) madeAsync.add(owner as Fn);
    note(call, "expect", nameOf(owner), negated ? ".resolves.not.toThrow()" : ".rejects.toThrow()");
  }

  // async, and a Promise return type, on each function made async; a block around the body of each that R1 wraps.
  for (const fn of madeAsync) {
    const name = nameOf(fn);
    if (cannotBeAsync(fn)) { flag(fn, "sync position", name, `a ${fn.getKindName()} can't be async`); continue; }
    const first = Node.isFunctionDeclaration(fn) || Node.isFunctionExpression(fn) ? fn.getFirstChildByKind(SyntaxKind.FunctionKeyword)
      : Node.isMethodDeclaration(fn) ? fn.getNameNode() : fn.getChildren().find((c) => c.getWidth() > 0);
    if (first) wrapNode(first, "async ");
    const overloads = Node.isFunctionDeclaration(fn) || Node.isMethodDeclaration(fn) ? fn.getOverloads() : [];
    for (const returnType of [fn, ...overloads].map((f) => f.getReturnTypeNode())) {
      if (returnType && Node.isTypePredicate(returnType)) flag(returnType, "type predicate", name, "a type predicate can't be async");
      else if (returnType && !returnsPromise(fn)) wrapNode(returnType, "Promise<", ">");
    }
    // An expect's callback that's only a call gives way to the call.
    if (!arrayCallbackCall(fn) && !expectBodies.has(fn.getBody()!)) note(fn, "async", name, blocks.has(fn) ? "R1 block" : "");
  }
  for (const [fn, { receiver, tx }] of blocks) {
    const body = fn.getBody()!;
    if (!Node.isBlock(body)) { wrapNode(body, `${receiver}.exclusive(async (${tx}) => `, ")"); continue; }
    replaceNode(body, (print) => {
      const statements = body.getStatements();
      const close = body.getLastChildByKindOrThrow(SyntaxKind.CloseBraceToken);
      const source = body.getSourceFile().getFullText();
      const beforeClose = source.slice(close.getPos(), close.getStart());
      const inside = statements.map((s) => print.full(s, "  ")).join("");
      if (!beforeClose.includes("\n")) return `{ return ${receiver}.exclusive(async (${tx}) => {${inside}${beforeClose}}); }`;
      const closeIndent = beforeClose.slice(beforeClose.lastIndexOf("\n") + 1);
      const firstStatement = statements[0];
      const bodyIndent = firstStatement ? /^[ \t]*/.exec(source.slice(source.lastIndexOf("\n", firstStatement.getStart()) + 1))![0] : `${closeIndent}  `;
      // Comments after the last statement stay inside, indented with it.
      const trailing = beforeClose.slice(0, beforeClose.lastIndexOf("\n")).replace(/\n(?![ \t]*\r?\n)/g, "\n  ");
      return `{\n${bodyIndent}return ${receiver}.exclusive(async (${tx}) => {${inside}${trailing}\n${bodyIndent}});\n${closeIndent}}`;
    });
  }

  // The Store's type becomes AsyncStore, except where it means the synchronous store: in its implementations, the
  // functions they pin, an indexed type (Store["getReview"]), or a cast to it (a test's stand-in).
  const factory = project.getSourceFileOrThrow(path.resolve(options.root, options.storeFactory.file)).getFunctionOrThrow(options.storeFactory.name);
  for (const sf of files) {
    for (const ref of sf.getDescendantsOfKind(SyntaxKind.TypeReference)) {
      let symbol = ref.getTypeName().getSymbol();
      if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
      const isStore = (symbol?.getDeclarations() ?? []).some((d) => storeInterfaces.has(d));
      const [argument] = ref.getTypeArguments();
      // ReturnType<typeof createStore>
      const factoryType = ref.getTypeName().getText() === "ReturnType" && Node.isTypeQuery(argument) && (() => {
        let named = argument.getExprName().getSymbol();
        if (named?.isAlias()) named = named.getAliasedSymbol();
        return !!named?.getDeclarations().includes(factory);
      })();
      // ReturnType<typeof f> of a function made async is what awaiting it gives.
      const returned = ref.getTypeName().getText() === "ReturnType" && Node.isTypeQuery(argument) ? namedFunction(argument.getExprName()) : undefined;
      if (returned && awaited(returned)) {
        wrapNode(ref, "Awaited<", ">");
        note(ref, "type", nameOf(ownerOf(ref)), ref.getText());
        continue;
      }
      if (!isStore && !factoryType) continue;
      if (ref.getFirstAncestor((a) => factories.has(a) || (isFn(a) && pinned.has(a)) || storeInterfaces.has(a))) continue;
      const parent = ref.getParent();
      if (Node.isIndexedAccessTypeNode(parent) && parent.getObjectTypeNode() === ref) continue;
      if (Node.isAsExpression(parent)) { flag(ref, "store stand-in", nameOf(ownerOf(ref)), "a cast to the synchronous Store, as a test's stand-in store; it's left as Store"); continue; }
      replaceNode(ref, () => "AsyncStore");
      needImport(sf, "AsyncStore");
      note(ref, "type", nameOf(ownerOf(ref)), ref.getText());
    }
    // createStore(bb) becomes queueStore(createStore(bb)), outside the store's own files and where it's queued already.
    if (storeFiles.has(sf.getFilePath())) continue;
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      if (targetOf(call) !== factory) continue;
      const holder = outermost(call).getParent();
      if (Node.isCallExpression(holder) && holder.getExpression().getText() === "queueStore") continue;
      wrapNode(call, "queueStore(", ")");
      needImport(sf, "queueStore");
      note(call, "queue", nameOf(ownerOf(call)), call.getText());
    }
  }

  // Each changed file, with AsyncStore and queueStore imported, and the Store's import gone once nothing names it.
  const queueModule = path.resolve(options.root, options.queueModule).replace(/\.tsx?$/, "");
  const out: Array<{ file: string; text: string }> = [];
  for (const sf of files) {
    const map = transforms.get(sf);
    if (!map?.size) continue;
    let text = printFile(sf, map);
    const wanted = imports.get(sf);
    if (wanted) {
      const from = path.relative(path.dirname(sf.getFilePath()), queueModule);
      text = addImports(text, [...wanted], from.startsWith(".") ? from : `./${from}`);
    }
    out.push({ file: relative(sf), text: dropUnusedImports(text, options.storeInterfaces.map((i) => i.name)) });
  }

  const bySite = (a: Site, b: Site) => a.file.localeCompare(b.file) || a.line - b.line;
  return {
    files: out.sort((a, b) => a.file.localeCompare(b.file)),
    changes: changes.sort((a, b) => bySite(a, b) || CHANGE_ORDER.indexOf(a.kind) - CHANGE_ORDER.indexOf(b.kind)),
    unhandled: unhandled.sort((a, b) => bySite(a, b) || a.kind.localeCompare(b.kind)),
  };

  /** Where a function is used other than called: its own position when it's written inline, or each reference to its name. */
  function valueUses(fn: Fn): Node[] {
    const position = outermost(fn);
    const parent = position.getParent();
    const nameNode = Node.isFunctionDeclaration(fn) ? fn.getNameNode() : Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode()) ? parent.getNameNode() : undefined;
    if (!nameNode) return Node.isFunctionDeclaration(fn) ? [] : [Node.isMethodDeclaration(fn) ? fn : position];
    // A variable's declared type is a use too: `const f: () => string = () => store.get(k)`.
    const uses: Node[] = Node.isVariableDeclaration(parent) && parent.getTypeNode() ? [position] : [];
    for (const ref of (nameNode as Node & { findReferencesAsNodes(): Node[] }).findReferencesAsNodes()) {
      if (!included.has(ref.getSourceFile()) || ref === nameNode) continue;
      const refParent = ref.getParent();
      if (Node.isImportSpecifier(refParent) || Node.isExportSpecifier(refParent) || Node.isTypeQuery(refParent) || Node.isQualifiedName(refParent)) continue;
      const expression = Node.isPropertyAccessExpression(refParent) && refParent.getNameNode() === ref ? refParent : ref;
      const holder = outermost(expression).getParent();
      if (Node.isCallExpression(holder) && unwrap(holder.getExpression()) === expression) continue;
      uses.push(Node.isShorthandPropertyAssignment(refParent) ? refParent : outermost(expression));
    }
    return uses;
  }

  /** Lists a function made async that's handed where a synchronous result is expected. */
  function checkValueUse(fn: Fn, use: Node) {
    const parent = use.getParent();
    const expects = (type: Type | undefined, where: string) => {
      const kind = type && returnKind(type);
      if (!kind || kind === "promise" || kind === "any") return;
      flag(use, "sync callback", nameOf(fn), `${where} ${kind === "void" ? "expects no result, so its Promise would go unwatched" : "expects its result synchronously"}`);
    };
    if (Node.isCallExpression(parent) && parent.getArguments().includes(use)) {
      if (arrayMethod(parent)) return;
      // One written inline becomes await expect(…).rejects.toThrow() below.
      if (isExpectOfThrow(parent)) {
        if (!isFn(unwrap(use))) flag(use, "sync callback", nameOf(fn), "expect(fn).toThrow() calls it and gets a Promise, which never throws: await expect(fn()).rejects.toThrow() instead");
        return;
      }
      const target = targetOf(parent);
      expects(checker.getContextualType(use as never), `handed to ${isProjectFn(target) ? `${nameOf(target)} (${at(target)})` : callLabel(parent)}, which`);
      return;
    }
    const member = Node.isMethodDeclaration(use) || Node.isShorthandPropertyAssignment(use) ? use : Node.isPropertyAssignment(parent) ? parent : undefined;
    if (member) {
      const literal = member.getParent();
      const property = Node.isObjectLiteralExpression(literal) ? checker.getContextualType(literal)?.getNonNullableType().getProperty(member.getName()) : undefined;
      expects(property?.getTypeAtLocation(member), `the ${member.getName()} it's in`);
      return;
    }
    if (Node.isVariableDeclaration(parent)) { if (parent.getTypeNode()) expects(parent.getType(), `${parent.getName()}, whose declared type`); return; }
    if (Node.isReturnStatement(parent) || Node.isArrowFunction(parent)) { expects(checker.getContextualType(use as never), "returned where the declared type"); return; }
    if (Node.isExportAssignment(parent)) return;
    expects(checker.getContextualType(use as never), "where it's used, the type");
  }

  /** The store references in a function's own body, and in the array callbacks it runs. */
  function storeRefs(fn: Fn): Node[] {
    const refs: Node[] = [];
    fn.getBody()?.forEachDescendant((node, traversal) => {
      if ((isFn(node) && !arrayCallbackCall(node)) || Node.isTypeNode(node)) { traversal.skip(); return; }
      if (isStoreReference(node)) { refs.push(node); traversal.skip(); }
    });
    return refs;
  }
  function isStoreReference(node: Node): boolean {
    if (Node.isIdentifier(node)) {
      const parent = node.getParent();
      if (Node.isPropertyAccessExpression(parent) && parent.getNameNode() === node) return false;
      if (Node.isBindingElement(parent) && parent.getPropertyNameNode() === node) return false;
      if ((Node.isVariableDeclaration(parent) || Node.isParameterDeclaration(parent) || Node.isBindingElement(parent) || Node.isPropertyAssignment(parent) || Node.isFunctionDeclaration(parent) || Node.isMethodDeclaration(parent))
        && (parent as Node & { getNameNode(): Node }).getNameNode() === node) return false;
    } else if (!Node.isPropertyAccessExpression(node)) return false;
    return isStoreType(node.getType());
  }
  /** A reference's root identifier, and its names from there: `deps.store` is ["deps", "store"]. */
  function pathOf(node: Node): { root: Node; names: string[] } | null {
    if (Node.isIdentifier(node)) return { root: node, names: [node.getText()] };
    if (!Node.isPropertyAccessExpression(node)) return null;
    const base = pathOf(node.getExpression());
    return base && { root: base.root, names: [...base.names, node.getName()] };
  }
  /** The declaration an identifier refers to; for `{ store }`, the variable's. */
  function declarationOfName(identifier: Node): Node | undefined {
    const parent = identifier.getParent();
    const symbol = Node.isShorthandPropertyAssignment(parent) ? checker.getShorthandAssignmentValueSymbol(parent) : identifier.getSymbol();
    return symbol?.getDeclarations()[0];
  }
  /** Whether a declaration is the function's, or inside it. */
  function bound(declaration: Node, fn: Fn): boolean { return declaration.getFirstAncestor((a) => a === fn) === fn; }
  /** Where a store reference comes from seen from outside the function, through aliases in it (`const { store } = deps`). */
  function sourceOf(ref: Node, fn: Fn): { path: string; declaration: Node } | null {
    const p = pathOf(ref);
    const declaration = p && declarationOfName(p.root);
    if (!p || !declaration) return null;
    const parameter = declaration.getFirstAncestor((a) => Node.isParameterDeclaration(a) && a.getParent() === fn);
    if (!bound(declaration, fn) || parameter || Node.isParameterDeclaration(declaration) && declaration.getParent() === fn) return { path: p.names.join("."), declaration };
    // An alias in the body: `const s = deps.store`, or `const { store } = deps`.
    if (Node.isVariableDeclaration(declaration) && declaration.getInitializer()) {
      const outer = sourceOf(unwrap(declaration.getInitializerOrThrow()), fn);
      return outer && { path: [outer.path, ...p.names.slice(1)].join("."), declaration: outer.declaration };
    }
    const pattern = declaration.getParent();
    const holder = pattern?.getParent();
    if (Node.isBindingElement(declaration) && Node.isObjectBindingPattern(pattern) && Node.isVariableDeclaration(holder) && holder.getInitializer() && !declaration.getDotDotDotToken()) {
      const outer = sourceOf(unwrap(holder.getInitializerOrThrow()), fn);
      const property = declaration.getPropertyNameNode()?.getText() ?? declaration.getName();
      return outer && { path: [outer.path, property, ...p.names.slice(1)].join("."), declaration: outer.declaration };
    }
    return null;
  }
  /** The store variables a function reaches but doesn't declare, which it closes over; through what it calls too. */
  function freeStores(fn: Fn, seen = new Set<Fn>()): Node[] {
    if (seen.has(fn)) return [];
    seen.add(fn);
    const free = new Set<Node>();
    for (const ref of [...storeRefs(fn), ...parameterStoreRefs(fn)]) {
      const p = pathOf(ref);
      const declaration = p && declarationOfName(p.root);
      if (declaration && !bound(declaration, fn)) free.add(declaration);
    }
    for (const { target } of callsIn(fn)) if (awaited(target)) for (const d of freeStores(target, seen)) if (!bound(d, fn)) free.add(d);
    return [...free];
  }
  /** The store references in a function's default parameters. */
  function parameterStoreRefs(fn: Fn): Node[] {
    return fn.getParameters().flatMap((p) => p.getInitializer()?.getDescendants().filter((node) => isStoreReference(node) && !node.getFirstAncestor((a) => isFn(a) && a !== fn && !!a.getFirstAncestor((b) => b === p))) ?? []);
  }
  /** The name a store variable is declared with, when it's an identifier. */
  function variableName(declaration: Node): string | undefined {
    const nameNode = Node.isVariableDeclaration(declaration) || Node.isParameterDeclaration(declaration) || Node.isBindingElement(declaration) ? declaration.getNameNode() : undefined;
    return nameNode && Node.isIdentifier(nameNode) ? nameNode.getText() : undefined;
  }
  /** Whether the declaration is what its name means at the node. */
  function visibleByName(declaration: Node, node: Node): boolean {
    const name = variableName(declaration);
    return !!name && !!node.getSymbolsInScope(ts.SymbolFlags.Value).find((s) => s.getName() === name)?.getDeclarations().includes(declaration);
  }
  /** Whether a function has a name, and every use of it calls it. */
  function namedOnlyCalled(fn: Fn): boolean {
    const parent = outermost(fn).getParent();
    const named = Node.isFunctionDeclaration(fn) ? !!fn.getName() : Node.isVariableDeclaration(parent) && Node.isIdentifier(parent.getNameNode());
    return named && !valueUses(fn).length;
  }
  function callsTo(fn: Fn): CallExpression[] {
    return [...functionCalls.values()].flatMap((calls) => calls.filter(({ target }) => target === fn).map(({ call }) => call));
  }
  /** The function whose body a node runs in, through the array callbacks it runs. */
  function bodyOwner(node: Node): Fn | undefined {
    let owner = ownerOf(node);
    while (!Node.isSourceFile(owner) && arrayCallbackCall(owner)) owner = ownerOf(arrayCallbackCall(owner)!);
    return Node.isSourceFile(owner) ? undefined : owner;
  }
  /** Whether a node runs inside a block on the store: in its function's body, not its default parameters. */
  function blockAt(node: Node, store: Node): Block | undefined {
    const owner = bodyOwner(node);
    const block = owner && blocks.get(owner);
    return block && block.source === store && !inDefaultParameter(node, owner) ? block : undefined;
  }

  /** A closure over the store takes it as its first parameter, and each call hands it a block's tx or the store by name. */
  function planLift(fn: Fn, store: Node) {
    const name = variableName(store)!;
    const params = fn.getParameters();
    const open = fn.getFirstChildByKind(SyntaxKind.OpenParenToken);
    if (open) wrapNode(open, "", `${name}: AsyncStore${params.length ? ", " : ""}`);
    else wrapNode(params[0], `(${name}: AsyncStore, `, ")");
    needImport(fn.getSourceFile(), "AsyncStore");
    for (const call of callsTo(fn)) {
      const argument = blockAt(call, store)?.tx ?? name;
      wrapNode(call.getFirstChildByKindOrThrow(SyntaxKind.OpenParenToken), "", `${argument}${call.getArguments().length ? ", " : ""}`);
    }
    note(fn, "lift", nameOf(fn), `takes \`${name}\` (${at(store)}) as its first parameter`);
  }
  /** The calls a function's body makes to project functions, the array callbacks it runs included. */
  function callsIn(fn: Fn): Array<{ call: CallExpression; target: Fn }> {
    const calls = [...(functionCalls.get(fn) ?? [])];
    for (const cb of inlineCallbacks.get(fn) ?? []) calls.push(...callsIn(cb));
    return calls;
  }

  /** In an R1 block: the store's references become tx, objects carrying it carry tx, and what can't is listed. */
  function planBlock(fn: Fn, { receiver, source, tx }: Block) {
    const name = nameOf(fn);
    note(fn, "block", name, `${receiver}.exclusive(async (${tx}) => …)`);
    // A parameter typed as a Pick of the store picks exclusive too.
    const typeNode = Node.isParameterDeclaration(source) && variableName(source) === receiver ? source.getTypeNode() : undefined;
    const [picked, keys] = Node.isTypeReference(typeNode) && typeNode.getTypeName().getText() === "Pick" ? typeNode.getTypeArguments() : [];
    if (keys && isStoreType(picked.getType()) && !keys.getText().includes('"exclusive"')) wrapNode(keys, "", ' | "exclusive"');
    const passed = new Set<Node>();
    for (const ref of storeRefs(fn)) {
      if (sourceOf(ref, fn)?.declaration !== source) continue;
      const parent = ref.getParentOrThrow();
      if (Node.isShorthandPropertyAssignment(parent)) { replaceNode(parent, () => `${parent.getName()}: ${tx}`); passed.add(ref); continue; }
      const receiverOfCall = Node.isPropertyAccessExpression(parent) && parent.getExpression() === ref && Node.isCallExpression(parent.getParent()) && (parent.getParent() as CallExpression).getExpression() === parent;
      const call = Node.isCallExpression(parent) && parent.getArguments().includes(ref) ? parent : undefined;
      const target = call && targetOf(call);
      if (isProjectFn(target) && detached(target)) { passed.add(ref); continue; }
      // An alias (`const s = deps.store`) is the block's tx too; sourceOf follows its uses back here.
      const alias = Node.isVariableDeclaration(parent) && parent.getInitializer() === outermost(ref);
      if (receiverOfCall || alias || isProjectFn(target)) { replaceNode(ref, () => tx); passed.add(ref); continue; }
      flag(ref, "outer store in block", name, `\`${shorten(ref.getText())}\` is used here as a value (${parent.getKindName()}), not called or handed to a helper; it's left as the outer store`);
    }
    // An object carrying the store (`deps`), handed to a helper that reaches it, carries tx instead.
    const inBody = callsIn(fn).filter(({ call }) => !inDefaultParameter(call, fn));
    for (const { call, target } of inBody) {
      if (!reachesStore(target) || detached(target)) continue;
      for (const argument of call.getArguments()) {
        if (isStoreType(argument.getType())) {
          if (!passed.has(argument)) flag(argument, "outer store in block", name, `\`${shorten(argument.getText())}\` hands ${nameOf(target)} a store other than the block's`);
          continue;
        }
        const property = argument.getType().getProperties().find((p) => isStoreType(p.getTypeAtLocation(argument)));
        if (!property) continue;
        const carried = Node.isIdentifier(argument) || Node.isPropertyAccessExpression(argument) ? sourceOf(argument, fn) : null;
        if (carried?.path && `${carried.path}.${property.getName()}` === receiver) {
          wrapNode(argument, "{ ...", `, ${property.getName()}: ${tx} }`);
        } else {
          flag(argument, "outer store in block", name, `\`${shorten(argument.getText())}\` carries a store into ${nameOf(target)}, and it isn't the block's`);
        }
      }
    }
    // A function made async that closes over the store would use the outer one, which throws in the block. Work left
    // running that reaches the store throws if it reaches the outer one while the block runs, and the block's tx is
    // stale once it ends: it's started after the block, by hand.
    for (const { call, target } of inBody) {
      if (detached(target)) {
        flag(call, "detached in block", name, `${nameOf(target)} (${at(target)}) is async, reaches the store, and isn't awaited here: it keeps the outer store, which throws if reached while the block runs, so start it after the block`);
        continue;
      }
      if (!awaited(target)) continue;
      const free = lifted.has(target) ? [] : freeStores(target);
      if (free.length) flag(call, "closure in block", name, `${nameOf(target)} (${at(target)}) reaches the store through its closure (${free.map((d) => `\`${(d as Node & { getName?(): string }).getName?.() ?? shorten(d.getText(), 20)}\` at ${at(d)}`).join(", ")}), and the outer store throws inside this block`);
      const kept = keeps.get(target);
      if (kept) flag(call, "detached in block", name, `${nameOf(target)} (${at(target)}) ${kept}: handed the block's tx, that work finds it stale once the block ends`);
    }
    for (const nested of laterFunctions(fn)) {
      if (!reachesStore(nested)) continue;
      flag(nested, "nested function in block", name, `${nameOf(nested)} reaches the store and can run after the block or alongside it; its store is left as the outer one`);
    }
  }
}

/** Adds the names to the module's import after the last import, into one from the module there already when it can. */
function addImports(text: string, names: ReadonlyArray<"AsyncStore" | "queueStore">, module: string): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("/file.tsx", text);
  const existing = sf.getImportDeclarations().find((d) => d.getModuleSpecifierValue() === module && !d.isTypeOnly());
  const have = new Set(sf.getImportDeclarations().filter((d) => d.getModuleSpecifierValue() === module).flatMap((d) => d.getNamedImports().map((n) => n.getName())));
  const missing = [...names].filter((n) => !have.has(n)).sort((a, b) => a === "queueStore" ? -1 : b === "queueStore" ? 1 : 0);
  if (!missing.length) return text;
  if (existing) {
    for (const n of missing) existing.addNamedImport({ name: n, isTypeOnly: n === "AsyncStore" });
    return sf.getFullText();
  }
  const declarations = sf.getImportDeclarations();
  const declaration = { moduleSpecifier: module, namedImports: missing.map((n) => ({ name: n, isTypeOnly: n === "AsyncStore" && missing.length > 1 })), isTypeOnly: missing.length === 1 && missing[0] === "AsyncStore" };
  if (declarations.length) sf.insertImportDeclaration(declarations.at(-1)!.getChildIndex() + 1, declaration);
  else sf.insertImportDeclaration(0, declaration);
  return sf.getFullText();
}

/** Drops the names from the imports when nothing else in the text names them. */
function dropUnusedImports(text: string, names: readonly string[]): string {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("/file.tsx", text);
  let changed = false;
  for (const name of names) {
    if (sf.getDescendantsOfKind(SyntaxKind.Identifier).some((i) => i.getText() === name && !i.getFirstAncestorByKind(SyntaxKind.ImportDeclaration))) continue;
    for (const declaration of sf.getImportDeclarations()) for (const specifier of declaration.getNamedImports()) {
      if (specifier.getName() !== name) continue;
      if (declaration.getNamedImports().length === 1 && !declaration.getDefaultImport() && !declaration.getNamespaceImport()) declaration.remove();
      else specifier.remove();
      changed = true;
    }
  }
  return changed ? sf.getFullText() : text;
}

function ownName(fn: Fn): string {
  if (Node.isConstructorDeclaration(fn)) return `${fn.getParent().getName() ?? "class"}.constructor`;
  if (Node.isFunctionDeclaration(fn)) return fn.getName() ?? "default function";
  if (Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
    const parent = fn.getParent();
    return Node.isClassDeclaration(parent) ? `${parent.getName() ?? "class"}.${fn.getName()}` : fn.getName();
  }
  if (Node.isFunctionExpression(fn) && fn.getName()) return fn.getName()!;
  const position = outermost(fn);
  const parent = position.getParent();
  if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent)) return parent.getName();
  if (Node.isCallExpression(parent)) return parent.getExpression() === position ? "IIFE" : `callback to ${callLabel(parent)}`;
  return "anonymous function";
}

const shorten = (text: string, length = 60) => { const flat = text.replace(/\s+/g, " "); return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat; };

/** A call's callee, with its first argument when that's a string: `bb.events.on("thread.idle")`. */
function callLabel(call: CallExpression): string {
  const first = call.getArguments()[0];
  const name = Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first) ? first.getText() : "";
  return `${shorten(call.getExpression().getText())}(${name})`;
}

/** What calls of a function type return: a value, nothing, a Promise, or anything. */
function returnKind(type: Type): "value" | "void" | "promise" | "any" {
  const signatures = (type.isUnion() ? type.getUnionTypes() : [type]).flatMap((t) => t.getCallSignatures());
  if (!signatures.length) return "any";
  const returned = signatures.map((s) => s.getReturnType());
  if (returned.some((r) => r.isAny() || r.isUnknown())) return "any";
  const parts = returned.flatMap((r) => r.isUnion() ? r.getUnionTypes() : [r]);
  if (parts.some((t) => !!t.getProperty("then"))) return "promise";
  if (parts.every((t) => t.isVoid() || t.isUndefined())) return "void";
  return "value";
}

const CHANGE_ORDER: ChangeKind[] = ["async", "block", "lift", "await", "loop", "promise-all", "expect", "type", "queue"];

export function formatPlan(plan: CodemodPlan): string {
  const out: string[] = [];
  const count = (kind: ChangeKind) => plan.changes.filter((c) => c.kind === kind).length;
  out.push("Codemod: the Store's callers onto the AsyncStore", "");
  out.push(`Files changed: ${plan.files.length}`);
  for (const kind of CHANGE_ORDER) out.push(`  ${kind}: ${count(kind)}`);
  out.push(`Unhandled: ${plan.unhandled.length}`);
  for (const kind of [...new Set(plan.unhandled.map((u) => u.kind))].sort()) out.push(`  ${kind}: ${plan.unhandled.filter((u) => u.kind === kind).length}`);

  out.push("", `Per file: ${CHANGE_ORDER.join(" / ")}`);
  for (const file of [...new Set(plan.changes.map((c) => c.file))].sort()) {
    const mine = plan.changes.filter((c) => c.file === file);
    out.push(`  ${file}  ${CHANGE_ORDER.map((k) => mine.filter((c) => c.kind === k).length).join(" / ")}`);
  }
  out.push("", "Functions made async, with each R1 block");
  for (const c of plan.changes.filter((c) => c.kind === "async")) out.push(`  ${c.file}:${c.line}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
  out.push("", "Array callbacks rewritten");
  for (const c of plan.changes.filter((c) => c.kind === "loop" || c.kind === "promise-all")) out.push(`  ${c.file}:${c.line}  ${c.kind} ${c.detail}  in ${c.name}`);
  out.push("", "Unhandled, for a hand fix");
  for (const u of plan.unhandled) out.push(`  ${u.file}:${u.line}  [${u.kind}]  in ${u.name}`, `      ${u.detail}`);
  return out.join("\n") + "\n";
}

/** This repo's settings. */
export function repoOptions(root: string): CodemodOptions {
  const own = new Set(["src/store-queue.ts", "src/store-queue.test.ts", "scripts/codemod-async-store.ts", "scripts/codemod-async-store.test.ts", "scripts/async-audit.ts", "scripts/async-audit.test.ts"].map((f) => path.join(root, f)));
  const isTest = (filePath: string) => /\.test(-support)?\.tsx?$/.test(filePath) || filePath.startsWith(path.join(root, "e2e") + path.sep);
  return {
    root,
    storeInterfaces: [{ file: "src/store.ts", name: "Store" }, { file: "src/learning.ts", name: "AgentCommentStore" }],
    readMethods: new Set([
      "getPreferences", "getReviewerNotes", "getReview", "listReviews", "getReviewContext", "patch", "hasPatch", "patchHash", "diffPositions",
      "fileHashes", "getGuide", "guideBackupHead", "isCurrentGeneration", "generationOf", "generationWorker", "getDraft", "staleDraftComments",
      "listDiscussions", "lastDiscussionChange", "getFileViews", "getAgentThread", "listAgentMessages", "getAssistantThread",
      "listAssistantThreads", "getSnapshot", "listFeedbackThreads", "feedbackFetched", "getAssessment", "latestAssessmentRun",
      "listReplyDrafts", "isDiscoveryIgnored", "draftCommentCode", "agentCommentChanges", "reasonedRemovals", "listAgentOutcomes",
    ]),
    queueModule: "src/store-queue.ts",
    storeFactory: { file: "src/store.ts", name: "createStore" },
    include: (filePath) => !filePath.includes("/node_modules/") && !filePath.endsWith(".d.ts") && !own.has(filePath),
    wrap: (filePath) => !isTest(filePath),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const tsConfigFilePath = path.resolve(args.find((a) => !a.startsWith("--")) ?? "tsconfig.json");
  const root = path.dirname(tsConfigFilePath);
  const plan = planCodemod(new Project({ tsConfigFilePath }), repoOptions(root));
  process.stdout.write(formatPlan(plan));
  if (args.includes("--write")) for (const { file, text } of plan.files) fs.writeFileSync(path.join(root, file), text);
}
