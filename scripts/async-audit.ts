/**
 * Where the code reaches the Store, ahead of making it async (1.3.0):
 * (a) every function that calls the store, directly or through a synchronous helper that does;
 * (b) stretches of async functions between awaits that call the store twice or more (rule R2's candidates);
 * (c) store calls in array-method callbacks and in positions that can't await (default parameters, constructors, accessors, field initializers, module scope);
 * (d) BB's callbacks that call the store, synchronous ones first.
 *
 * Run from the repo root: `node scripts/async-audit.ts [tsconfig.json]`. It prints the report and changes nothing.
 *
 * Approximations: branches merge, so a stretch can list calls from different branches; a loop's body counts as running
 * at least twice; a try's catch can follow any call in the try; an unawaited call to an async function ends nothing and
 * adds nothing. A synchronous helper's store calls count once where it's called, since rule R1 makes it one unit. A call
 * through a plugin-declared interface or function type (an injected callback) isn't followed to what implements it;
 * the implementation is listed on its own.
 */
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Node, Project, SyntaxKind } from "ts-morph";
import type {
  ArrowFunction, CallExpression, ConstructorDeclaration, FunctionDeclaration, FunctionExpression, GetAccessorDeclaration,
  MethodDeclaration, ObjectLiteralExpression, PropertyAccessExpression, SetAccessorDeclaration, Signature, SourceFile, Type,
} from "ts-morph";

export interface AuditOptions {
  /** Paths in the report are relative to it. */
  root: string;
  /** The interfaces whose methods are store calls, by the file (relative to root) that declares each. */
  storeInterfaces: ReadonlyArray<{ file: string; name: string }>;
  /** Whether a source file is BB's (the plugin SDK's types), whose callbacks section (d) lists. */
  isHostFile: (filePath: string) => boolean;
  /** Whether to audit a source file. */
  include: (filePath: string) => boolean;
}

export interface Site { file: string; line: number }

/** A store call, or a call to a synchronous function that calls the store. */
export interface StoreUse extends Site {
  /** `Store.getReview`, or for a helper `helper name (file:line)`. */
  label: string;
  helper: boolean;
}

export interface FunctionEntry extends Site {
  name: string;
  async: boolean;
  /** Its own store calls and helper calls; the array-method callbacks it runs are their own entries. */
  uses: StoreUse[];
  /** Array-method callbacks in it that use the store. */
  callbacks: number;
}

export interface Stretch {
  fn: FunctionEntry;
  /** It runs from the function's start, before its first await. */
  fromStart: boolean;
  uses: Array<StoreUse & { repeated: boolean }>;
}

export interface CallbackEntry extends Site {
  /** `.filter callback`, `default parameter`, `constructor`, `getter`, `setter`, `field initializer`, `module scope`, or `method used as a value`. */
  position: string;
  name: string;
  async: boolean;
  uses: StoreUse[];
}

/** What a BB callback's type says it returns. */
export type HostReturn = "value" | "void" | "promise" | "any";

export interface HostCallback extends Site {
  name: string;
  /** The call that hands it to BB, with the property it's passed as. */
  registeredBy: string;
  returns: HostReturn;
  async: boolean;
  uses: StoreUse[];
}

export interface AuditReport {
  files: number;
  /** Store call sites outside the store's implementations. */
  storeCalls: number;
  /** Calls between a store implementation's own methods, not audited. */
  implementationCalls: number;
  functions: FunctionEntry[];
  stretches: Stretch[];
  callbacks: CallbackEntry[];
  hostCallbacks: HostCallback[];
}

type Fn = FunctionDeclaration | FunctionExpression | ArrowFunction | MethodDeclaration | GetAccessorDeclaration | SetAccessorDeclaration | ConstructorDeclaration;
type Owner = Fn | SourceFile;

const FN_KINDS = new Set([SyntaxKind.FunctionDeclaration, SyntaxKind.FunctionExpression, SyntaxKind.ArrowFunction, SyntaxKind.MethodDeclaration, SyntaxKind.GetAccessor, SyntaxKind.SetAccessor, SyntaxKind.Constructor]);
const isFn = (node: Node | undefined): node is Fn => !!node && FN_KINDS.has(node.getKind());

/** Array methods that call their callback before they return. */
const ARRAY_CALLBACK_METHODS = new Set(["filter", "map", "flatMap", "some", "every", "find", "findIndex", "findLast", "findLastIndex", "sort", "toSorted", "forEach", "reduce", "reduceRight"]);

const LOGICAL_OPERATORS = new Set([SyntaxKind.AmpersandAmpersandToken, SyntaxKind.BarBarToken, SyntaxKind.QuestionQuestionToken,
  SyntaxKind.AmpersandAmpersandEqualsToken, SyntaxKind.BarBarEqualsToken, SyntaxKind.QuestionQuestionEqualsToken]);

const unwrap = (node: Node): Node => Node.isParenthesizedExpression(node) || Node.isAsExpression(node) || Node.isSatisfiesExpression(node) || Node.isNonNullExpression(node) ? unwrap(node.getExpression()) : node;

/** The array method a call is, when its callbacks run before it returns. */
function arrayMethod(call: CallExpression): string | null {
  const callee = unwrap(call.getExpression());
  return Node.isPropertyAccessExpression(callee) && ARRAY_CALLBACK_METHODS.has(callee.getName()) ? callee.getName() : null;
}

/** An argument's call, when it's an array method's callback. */
function arrayCallbackCall(node: Node): CallExpression | null {
  const parent = node.getParent();
  return Node.isCallExpression(parent) && parent.getArguments().includes(node) && arrayMethod(parent) ? parent : null;
}

/**
 * What a path through a function has done since its last await: the store uses it made (nodes), START while it's still
 * in the function's synchronous start, LIVE once an await has passed, and SUSPENDED when it went past an await inside an
 * array method's callback, so the rest of it isn't in the caller's stretch. An empty state is a path that ended.
 */
const START = Symbol("start");
const LIVE = Symbol("live");
const SUSPENDED = Symbol("suspended");
type State = ReadonlySet<Node | typeof START | typeof LIVE | typeof SUSPENDED>;

class UnionFind<T> {
  private parent = new Map<T, T>();
  find(x: T): T {
    let root = this.parent.get(x) ?? x;
    while (root !== (this.parent.get(root) ?? root)) root = this.parent.get(root)!;
    this.parent.set(x, root);
    return root;
  }
  union(a: T, b: T) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent.set(ra, rb); }
}

export function auditProject(project: Project, options: AuditOptions): AuditReport {
  const checker = project.getTypeChecker();
  const files = project.getSourceFiles().filter((sf) => !sf.isDeclarationFile() && options.include(sf.getFilePath()));
  const relative = (node: Node) => path.relative(options.root, node.getSourceFile().getFilePath());
  const site = (node: Node): Site => ({ file: relative(node), line: node.getStartLineNumber() });

  // The store's methods, and the object literals that implement them.
  const storeMethods = new Map<Node, string>();
  const storeInterfaces = new Set<Node>();
  for (const { file, name } of options.storeInterfaces) {
    const declaration = project.getSourceFileOrThrow(path.resolve(options.root, file)).getInterfaceOrThrow(name);
    storeInterfaces.add(declaration);
    for (const member of declaration.getMethods()) storeMethods.set(member, `${name}.${member.getName()}`);
  }
  const implementsStore = (type: Type): boolean =>
    [type, ...type.getIntersectionTypes()].some((t) => (t.getSymbol()?.getDeclarations() ?? []).some((d) => storeInterfaces.has(d)));
  const implementations = new Set<ObjectLiteralExpression>();
  for (const sf of files) for (const literal of sf.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
    const type = checker.getContextualType(literal);
    if (type && implementsStore(type)) implementations.add(literal);
  }
  const inImplementation = (node: Node) => !!node.getFirstAncestor((a) => Node.isObjectLiteralExpression(a) && implementations.has(a));

  const declarationOf = (signature: Signature | undefined): Node | undefined => {
    try { return signature?.getDeclaration(); } catch { return undefined; }
  };
  /** The project function an expression names, when it names one. */
  const namedFunction = (expression: Node): Fn | undefined => {
    const node = unwrap(expression);
    if (isFn(node)) return node;
    if (!Node.isIdentifier(node) && !Node.isPropertyAccessExpression(node)) return undefined;
    let symbol = node.getSymbol();
    if (symbol?.isAlias()) symbol = symbol.getAliasedSymbol();
    for (const declaration of symbol?.getDeclarations() ?? []) {
      const fn = Node.isVariableDeclaration(declaration) || Node.isPropertyAssignment(declaration) ? declaration.getInitializer() && unwrap(declaration.getInitializer()!) : declaration;
      if (isFn(fn) && options.include(fn.getSourceFile().getFilePath()) && !inImplementation(fn)) return fn;
    }
    return undefined;
  };

  // Every call to the store, and every call to a project function, by the function it's in.
  const ownerOf = (node: Node): Owner => (node.getFirstAncestor((a) => isFn(a)) as Fn | undefined) ?? node.getSourceFile();
  const storeCalls = new Map<Owner, Array<{ call: CallExpression; label: string }>>();
  const functionCalls = new Map<Owner, Array<{ call: Node; target: Fn; repeated: boolean }>>();
  const methodValues: PropertyAccessExpression[] = [];
  let storeCallCount = 0;
  let implementationCalls = 0;
  const push = <K, V>(map: Map<K, V[]>, key: K, value: V) => { const list = map.get(key); if (list) list.push(value); else map.set(key, [value]); };
  for (const sf of files) sf.forEachDescendant((node) => {
    if (Node.isPropertyAccessExpression(node)) {
      const parent = node.getParent();
      const called = Node.isCallExpression(parent) && unwrap(parent.getExpression()) === node;
      if (!called && !inImplementation(node) && (node.getNameNode().getSymbol()?.getDeclarations() ?? []).some((d) => storeMethods.has(d))) methodValues.push(node);
      return;
    }
    if (!Node.isCallExpression(node)) return;
    const signatureDeclaration = declarationOf(checker.getResolvedSignature(node));
    // An overload's signature stands for the function's implementation.
    const declaration = Node.isFunctionDeclaration(signatureDeclaration) && !signatureDeclaration.hasBody() ? signatureDeclaration.getImplementation() ?? signatureDeclaration : signatureDeclaration;
    if (inImplementation(node)) {
      if (declaration && (storeMethods.has(declaration) || inImplementation(declaration))) implementationCalls++;
      return;
    }
    if (declaration && storeMethods.has(declaration)) {
      storeCallCount++;
      push(storeCalls, ownerOf(node), { call: node, label: storeMethods.get(declaration)! });
    } else if (isFn(declaration) && options.include(declaration.getSourceFile().getFilePath()) && !inImplementation(declaration)) {
      push(functionCalls, ownerOf(node), { call: node, target: declaration, repeated: false });
    }
    // A function passed by name to an array method runs there, once per element.
    if (arrayMethod(node)) for (const argument of node.getArguments()) {
      const target = isFn(unwrap(argument)) ? undefined : namedFunction(argument);
      if (target) push(functionCalls, ownerOf(node), { call: argument, target, repeated: true });
    }
  });

  // The array-method callbacks written inline in each function, which run as part of it.
  const inlineCallbacks = new Map<Owner, Fn[]>();
  for (const sf of files) sf.forEachDescendant((node) => {
    if (isFn(node) && arrayCallbackCall(unwrapParent(node))) push(inlineCallbacks, ownerOf(node), node);
  });

  // Which functions use the store: by calling it, calling a synchronous function that does, or running a callback that does.
  const usesStore = new Set<Owner>();
  const owners = new Set<Owner>([...storeCalls.keys(), ...functionCalls.keys(), ...inlineCallbacks.keys()]);
  const syncHelper = (fn: Fn) => !Node.isAsyncable(fn) || !fn.isAsync();
  for (let changed = true; changed;) {
    changed = false;
    for (const owner of owners) {
      if (usesStore.has(owner)) continue;
      if (storeCalls.has(owner) || (functionCalls.get(owner) ?? []).some(({ target }) => syncHelper(target) && usesStore.has(target)) || (inlineCallbacks.get(owner) ?? []).some((cb) => usesStore.has(cb))) {
        usesStore.add(owner);
        changed = true;
      }
    }
  }

  const isAsync = (owner: Owner) => !Node.isSourceFile(owner) && Node.isAsyncable(owner) && owner.isAsync();
  const nameOf = (owner: Owner): string => {
    if (Node.isSourceFile(owner)) return "<module scope>";
    const own = ownName(owner);
    const parent = owner.getFirstAncestor((a) => isFn(a)) as Fn | undefined;
    return parent ? `${ownName(parent)} > ${own}` : own;
  };
  const helperLabel = (target: Fn) => `${nameOf(target)} (${relative(target)}:${target.getStartLineNumber()})`;
  /** A function's own store uses, in source order. */
  const ownUses = (owner: Owner): Array<{ node: Node; use: StoreUse; repeated: boolean }> => [
    ...(storeCalls.get(owner) ?? []).map(({ call, label }) => ({ node: call as Node, use: { ...site(call), label, helper: false }, repeated: false })),
    ...(functionCalls.get(owner) ?? []).filter(({ target }) => syncHelper(target) && usesStore.has(target))
      .map(({ call, target, repeated }) => ({ node: call, use: { ...site(call), label: helperLabel(target), helper: true }, repeated })),
  ].sort((a, b) => a.node.getStart() - b.node.getStart());
  /** Its uses with those of the inline callbacks it runs. */
  const allUses = (owner: Owner): StoreUse[] => [...ownUses(owner).map(({ use }) => use), ...(inlineCallbacks.get(owner) ?? []).flatMap(allUses)];

  const entries = new Map<Owner, FunctionEntry>();
  for (const owner of usesStore) entries.set(owner, {
    ...site(owner), name: nameOf(owner), async: isAsync(owner),
    uses: ownUses(owner).map(({ use }) => use), callbacks: (inlineCallbacks.get(owner) ?? []).filter((cb) => usesStore.has(cb)).length,
  });

  // (b) The stretches between awaits, per async function.
  const stretches: Stretch[] = [];
  for (const owner of usesStore) if (isAsync(owner)) stretches.push(...stretchesOf(owner as Fn));

  function stretchesOf(fn: Fn): Stretch[] {
    const uses = new Map<Node, { use: StoreUse; repeated: boolean }>();
    const collect = (owner: Owner) => {
      for (const own of ownUses(owner)) uses.set(own.node, own);
      for (const cb of inlineCallbacks.get(owner) ?? []) collect(cb);
    };
    collect(fn);
    const groups = new UnionFind<Node>();
    const repeated = new Set<Node>();
    const atStart = new Set<Node>();
    type Collector = Set<Node | typeof START | typeof LIVE | typeof SUSPENDED>;
    const breaks: Collector[] = [];
    const continues: Collector[] = [];
    /** Per callback being run: the states its caller goes on from (at an await or a return in it). */
    const exits: Collector[] = [];
    /** Per try being run: every use in it, which its catch can follow. */
    const tries: Collector[] = [];
    const union = (...states: State[]): State => new Set(states.flatMap((s) => [...s]));
    const ended: State = new Set();
    const event = (node: Node, state: State): State => {
      if (![...state].some((e) => e !== SUSPENDED)) return state;
      if (state.has(node)) repeated.add(node);
      if (state.has(START)) atStart.add(node);
      for (const other of state) if (other instanceof Node) groups.union(node, other);
      for (const seen of tries) seen.add(node);
      return new Set([...state, node]);
    };
    /** An await: in a callback its caller goes on; in the function itself a new stretch starts. */
    const awaitBoundary = (state: State): State => {
      if (!state.size) return state;
      if (!exits.length) return new Set([LIVE]);
      for (const e of state) exits.at(-1)!.add(e);
      return new Set([SUSPENDED]);
    };
    const loop = (head: State, body: (s: State) => State): State => {
      breaks.push(new Set());
      continues.push(new Set());
      let state = head;
      // Twice, so a use in the body meets itself and the end of one pass meets the start of the next.
      for (let pass = 0; pass < 2; pass++) state = union(state, body(state), continues.at(-1)!);
      continues.pop();
      return union(state, breaks.pop()!);
    };
    const runCallback = (cb: Fn, state: State): State => {
      const body = cb.getBody();
      if (!body) return state;
      exits.push(new Set());
      const after = union(flow(body, state), exits.pop()!);
      return new Set([...after].filter((e) => e !== SUSPENDED));
    };
    const flow = (node: Node, state: State): State => {
      if (isFn(node) || Node.isClassDeclaration(node) || Node.isClassExpression(node)) return state;
      if (Node.isAwaitExpression(node)) return awaitBoundary(flow(node.getExpression(), state));
      if (Node.isCallExpression(node)) {
        let s = flow(node.getExpression(), state);
        const callbacks: Fn[] = [];
        for (const argument of node.getArguments()) {
          const inline = unwrap(argument);
          if (isFn(inline) && arrayMethod(node)) callbacks.push(inline); else s = flow(argument, s);
        }
        for (const cb of callbacks) s = loop(s, (head) => runCallback(cb, head));
        for (const argument of node.getArguments()) if (uses.get(argument)?.repeated) s = event(argument, event(argument, s));
        if (uses.has(node)) s = event(node, s);
        return node.hasQuestionDotToken() ? union(state, s) : s;
      }
      if (Node.isConditionalExpression(node)) {
        const s = flow(node.getCondition(), state);
        return union(flow(node.getWhenTrue(), s), flow(node.getWhenFalse(), s));
      }
      if (Node.isBinaryExpression(node) && LOGICAL_OPERATORS.has(node.getOperatorToken().getKind())) {
        const s = flow(node.getLeft(), state);
        return union(s, flow(node.getRight(), s));
      }
      if (Node.isIfStatement(node)) {
        const s = flow(node.getExpression(), state);
        const otherwise = node.getElseStatement();
        return union(flow(node.getThenStatement(), s), otherwise ? flow(otherwise, s) : s);
      }
      if (Node.isForStatement(node)) {
        const initializer = node.getInitializer();
        const condition = node.getCondition();
        const incrementor = node.getIncrementor();
        return loop(initializer ? flow(initializer, state) : state, (head) => {
          const s = flow(node.getStatement(), condition ? flow(condition, head) : head);
          return incrementor ? flow(incrementor, s) : s;
        });
      }
      if (Node.isForOfStatement(node) || Node.isForInStatement(node)) {
        // A for await awaits before each pass and once more at the end.
        const awaited = Node.isForOfStatement(node) && node.isAwaited();
        const exit = loop(flow(node.getExpression(), state), (head) => flow(node.getStatement(), awaited ? awaitBoundary(head) : head));
        return awaited ? awaitBoundary(exit) : exit;
      }
      if (Node.isWhileStatement(node)) return loop(state, (head) => flow(node.getStatement(), flow(node.getExpression(), head)));
      if (Node.isDoStatement(node)) return loop(state, (head) => flow(node.getExpression(), flow(node.getStatement(), head)));
      if (Node.isSwitchStatement(node)) {
        const s = flow(node.getExpression(), state);
        breaks.push(new Set());
        let fall = ended;
        let hasDefault = false;
        for (const clause of node.getClauses()) {
          if (Node.isDefaultClause(clause)) hasDefault = true;
          fall = clause.getStatements().reduce((t, statement) => flow(statement, t), union(s, fall));
        }
        return union(fall, breaks.pop()!, hasDefault ? ended : s);
      }
      if (Node.isBreakStatement(node) || Node.isContinueStatement(node)) {
        const targets = Node.isBreakStatement(node) ? breaks : continues;
        if (!targets.length) return state;
        for (const e of state) targets.at(-1)!.add(e);
        return ended;
      }
      if (Node.isReturnStatement(node) || Node.isThrowStatement(node)) {
        const expression = node.getExpression();
        const s = expression ? flow(expression, state) : state;
        if (exits.length) for (const e of s) exits.at(-1)!.add(e);
        return ended;
      }
      if (Node.isTryStatement(node)) {
        tries.push(new Set(state));
        const afterTry = flow(node.getTryBlock(), state);
        const seen = tries.pop()!;
        const catchClause = node.getCatchClause();
        const after = union(afterTry, catchClause ? flow(catchClause.getBlock(), union(seen, afterTry)) : ended);
        const finallyBlock = node.getFinallyBlock();
        return finallyBlock ? flow(finallyBlock, union(after, seen)) : after;
      }
      let s = state;
      node.forEachChild((child) => { s = flow(child, s); });
      return s;
    };
    const body = fn.getBody();
    if (body) flow(body, new Set([START]));

    const byGroup = new Map<Node, Node[]>();
    for (const node of uses.keys()) push(byGroup, groups.find(node), node);
    const entry = entries.get(fn)!;
    const found: Stretch[] = [];
    for (const nodes of byGroup.values()) {
      const runs = nodes.length + nodes.filter((n) => repeated.has(n)).length;
      if (runs < 2) continue;
      nodes.sort((a, b) => a.getStart() - b.getStart());
      found.push({
        fn: entry, fromStart: nodes.some((n) => atStart.has(n)),
        uses: nodes.map((n) => ({ ...uses.get(n)!.use, repeated: repeated.has(n) })),
      });
    }
    return found.sort((a, b) => a.uses[0].line - b.uses[0].line);
  }

  // (c) Array-method callbacks, and positions that can't await.
  const callbacks: CallbackEntry[] = [];
  for (const owner of usesStore) {
    if (!Node.isSourceFile(owner)) {
      const call = arrayCallbackCall(unwrapParent(owner));
      if (call) callbacks.push({ ...site(owner), position: `.${arrayMethod(call)} callback`, name: nameOf(owner), async: isAsync(owner), uses: allUses(owner) });
      const kind = Node.isConstructorDeclaration(owner) ? "constructor" : Node.isGetAccessorDeclaration(owner) ? "getter" : Node.isSetAccessorDeclaration(owner) ? "setter" : null;
      if (kind) callbacks.push({ ...site(owner), position: kind, name: nameOf(owner), async: false, uses: allUses(owner) });
    }
    // Default parameters and field initializers run outside any async body, as module scope does.
    for (const { node, use } of ownUses(owner)) {
      const holder = node.getFirstAncestor((a) => isFn(a) || Node.isParameterDeclaration(a) || Node.isPropertyDeclaration(a));
      const position = Node.isParameterDeclaration(holder) ? "default parameter" : Node.isPropertyDeclaration(holder) ? "field initializer" : Node.isSourceFile(owner) ? "module scope" : null;
      if (position) callbacks.push({ ...use, position, name: nameOf(owner), async: isAsync(owner), uses: [use] });
    }
  }
  for (const node of methodValues) {
    const label = node.getNameNode().getSymbol()!.getDeclarations().map((d) => storeMethods.get(d)).find(Boolean)!;
    callbacks.push({ ...site(node), position: "method used as a value", name: nameOf(ownerOf(node)), async: false, uses: [{ ...site(node), label, helper: false }] });
  }

  // (d) Callbacks handed to BB.
  const hostCallbacks: HostCallback[] = [];
  const considerHost = (position: Node, fn: Fn, type: Type | undefined) => {
    if (!usesStore.has(fn) || !type) return;
    const types = type.getNonNullableType().isUnion() ? type.getNonNullableType().getUnionTypes() : [type.getNonNullableType()];
    const signature = types.flatMap((t) => t.getCallSignatures()).find((s) => {
      const declaration = declarationOf(s);
      return !!declaration && options.isHostFile(declaration.getSourceFile().getFilePath());
    });
    if (!signature) return;
    hostCallbacks.push({ ...site(fn), name: nameOf(fn), registeredBy: registration(position), returns: returnKind(signature.getReturnType()), async: isAsync(fn), uses: allUses(fn) });
  };
  for (const sf of files) sf.forEachDescendant((node) => {
    if (Node.isFunctionExpression(node) || Node.isArrowFunction(node)) {
      considerHost(node, node, checker.getContextualType(node));
    } else if ((Node.isMethodDeclaration(node) || Node.isShorthandPropertyAssignment(node) || Node.isPropertyAssignment(node)) && Node.isObjectLiteralExpression(node.getParent())) {
      // A function written inline as a property's value is the case above.
      if (Node.isPropertyAssignment(node) && isFn(unwrap(node.getInitializerOrThrow()))) return;
      const fn = Node.isMethodDeclaration(node) ? node : Node.isShorthandPropertyAssignment(node) ? namedFunction(node.getNameNode()) : namedFunction(node.getInitializerOrThrow());
      if (!fn) return;
      const literalType = checker.getContextualType(node.getParent() as ObjectLiteralExpression);
      const property = literalType?.getNonNullableType().getProperty(node.getName());
      considerHost(node, fn, property?.getTypeAtLocation(node));
    } else if (Node.isCallExpression(node)) {
      for (const argument of node.getArguments()) {
        if (isFn(unwrap(argument)) || !Node.isExpression(argument)) continue;
        const fn = namedFunction(argument);
        if (fn) considerHost(argument, fn, checker.getContextualType(argument));
      }
    }
  });

  const bySite = (a: Site, b: Site) => a.file.localeCompare(b.file) || a.line - b.line;
  return {
    files: files.length,
    storeCalls: storeCallCount,
    implementationCalls,
    functions: [...entries.values()].sort(bySite),
    stretches: stretches.sort((a, b) => bySite(a.fn, b.fn) || a.uses[0].line - b.uses[0].line),
    callbacks: callbacks.sort((a, b) => bySite(a, b) || a.position.localeCompare(b.position)),
    hostCallbacks: hostCallbacks.sort((a, b) => HOST_RETURN_ORDER.indexOf(a.returns) - HOST_RETURN_ORDER.indexOf(b.returns) || bySite(a, b)),
  };
}

/** A function's parent, through parentheses and casts. */
function unwrapParent(fn: Node): Node {
  let node = fn;
  for (let parent = node.getParent(); parent && (Node.isParenthesizedExpression(parent) || Node.isAsExpression(parent) || Node.isSatisfiesExpression(parent)); parent = parent.getParent()) node = parent;
  return node;
}

function ownName(fn: Fn): string {
  if (Node.isConstructorDeclaration(fn)) return `${fn.getParent().getName() ?? "class"}.constructor`;
  if (Node.isFunctionDeclaration(fn)) return fn.getName() ?? "default function";
  if (Node.isMethodDeclaration(fn) || Node.isGetAccessorDeclaration(fn) || Node.isSetAccessorDeclaration(fn)) {
    const parent = fn.getParent();
    return Node.isClassDeclaration(parent) ? `${parent.getName() ?? "class"}.${fn.getName()}` : fn.getName();
  }
  if (Node.isFunctionExpression(fn) && fn.getName()) return fn.getName()!;
  const position = unwrapParent(fn);
  const parent = position.getParent();
  if (Node.isVariableDeclaration(parent) || Node.isPropertyAssignment(parent) || Node.isPropertyDeclaration(parent)) return parent.getName();
  if (Node.isCallExpression(parent)) {
    if (parent.getExpression() === position) return "IIFE";
    return `callback to ${callLabel(parent)}`;
  }
  return "anonymous function";
}

const shorten = (text: string, length = 60) => { const flat = text.replace(/\s+/g, " "); return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat; };

/** A call's callee, with its first argument when that's a string: `bb.events.on("thread.idle")`. */
function callLabel(call: CallExpression): string {
  const first = call.getArguments()[0];
  const name = Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first) ? first.getText() : "";
  return `${shorten(call.getExpression().getText())}(${name})`;
}

/** The call a callback is handed to, with the properties it's under. */
function registration(position: Node): string {
  const names: string[] = [];
  let node: Node = position;
  for (let parent = node.getParent(); parent; node = parent, parent = parent.getParent()) {
    if (Node.isCallExpression(parent) && parent.getArguments().includes(node)) return `${callLabel(parent)}${names.map((n) => `.${n}`).join("")}`;
    if (Node.isMethodDeclaration(node) || Node.isPropertyAssignment(node) || Node.isShorthandPropertyAssignment(node)) names.unshift(node.getName());
    // An object of callbacks kept in a variable, typed as BB's, before it's handed over.
    if (Node.isVariableDeclaration(parent)) names.unshift(parent.getName());
    if (isFn(parent) || Node.isStatement(parent)) break;
  }
  return names.length ? names.join(".") : "(not passed in a call)";
}

const HOST_RETURN_ORDER: HostReturn[] = ["value", "void", "any", "promise"];

function returnKind(type: Type): HostReturn {
  if (type.isAny() || type.isUnknown()) return "any";
  const parts = type.isUnion() ? type.getUnionTypes() : [type];
  if (parts.some((t) => !!t.getProperty("then"))) return "promise";
  if (parts.every((t) => t.isVoid() || t.isUndefined())) return "void";
  return "value";
}

const RETURN_TEXT: Record<HostReturn, string> = {
  value: "must return its result synchronously",
  void: "returns void, so a Promise would go unwatched",
  any: "returns any or unknown",
  promise: "its type allows a Promise",
};

export function formatAudit(report: AuditReport): string {
  const out: string[] = [];
  const at = (s: Site) => `${s.file}:${s.line}`;
  const uses = (list: ReadonlyArray<StoreUse & { repeated?: boolean }>) => list.map((u) => `${u.label}${u.repeated ? " (repeats)" : ""} @${u.line}`).join(", ");
  const sync = report.functions.filter((f) => !f.async);
  const fromStart = report.stretches.filter((s) => s.fromStart);
  const r2Functions = new Set(report.stretches.map((s) => s.fn));
  const arrayCallbacks = report.callbacks.filter((c) => c.position.endsWith(" callback"));
  const mustBeSync = report.hostCallbacks.filter((h) => h.returns === "value");

  out.push("Async audit of the Store's callers", "");
  out.push(`Files audited: ${report.files}`);
  out.push(`Store call sites: ${report.storeCalls} (plus ${report.implementationCalls} calls inside the store implementations, not audited)`);
  out.push(`(a) Functions that use the store: ${report.functions.length} (${sync.length} sync, ${report.functions.length - sync.length} async); ${report.functions.filter((f) => f.uses.some((u) => !u.helper)).length} call it directly`);
  out.push(`(b) R2 candidates: ${report.stretches.length} stretches in ${r2Functions.size} async functions; ${fromStart.length} run from the function's start; ${report.stretches.filter((s) => s.uses.some((u) => u.repeated)).length} repeat a call in a loop or callback`);
  out.push(`(c) Callbacks and positions that can't await: ${report.callbacks.length} (${arrayCallbacks.length} array-method callbacks, ${arrayCallbacks.filter((c) => /^\.(filter|some|every|find|findIndex|findLast|findLastIndex) /.test(c.position)).length} of them predicates)`);
  out.push(`(d) BB callbacks that use the store: ${report.hostCallbacks.length}; ${mustBeSync.length} must return synchronously`);
  for (const kind of HOST_RETURN_ORDER) {
    const count = report.hostCallbacks.filter((h) => h.returns === kind).length;
    if (count) out.push(`    ${kind}: ${count} (${RETURN_TEXT[kind]})`);
  }

  out.push("", "(a) Functions that use the store, with their store calls and the synchronous helpers they call that do");
  for (const f of report.functions) {
    const direct = f.uses.filter((u) => !u.helper).length;
    out.push(`  ${at(f)}  ${f.async ? "async" : "sync "}  ${f.name}  [${direct} direct, ${f.uses.length - direct} via helpers${f.callbacks ? `, ${f.callbacks} in callbacks` : ""}]`);
    if (f.uses.length) out.push(`      ${uses(f.uses)}`);
  }

  out.push("", "(b) Stretches between awaits that use the store twice or more");
  for (const s of report.stretches) out.push(`  ${at(s.fn)}  ${s.fn.name}${s.fromStart ? "  [from the start]" : ""}`, `      ${uses(s.uses)}`);

  out.push("", "(c) Store use in array-method callbacks and positions that can't await");
  for (const c of report.callbacks) out.push(`  ${at(c)}  ${c.position}${c.async ? " (async)" : ""}  in ${c.name}`, `      ${uses(c.uses)}`);

  out.push("", "(d) BB callbacks that use the store");
  for (const h of report.hostCallbacks) out.push(`  ${at(h)}  ${h.returns.padEnd(7)} ${h.async ? "async" : "sync "}  ${h.registeredBy}  (${h.name})`, `      ${uses(h.uses)}`);
  return out.join("\n") + "\n";
}

/** This repo's settings for the audit. */
export function repoOptions(root: string): AuditOptions {
  return {
    root,
    storeInterfaces: [{ file: "src/store.ts", name: "Store" }, { file: "src/learning.ts", name: "AgentCommentStore" }],
    isHostFile: (filePath) => filePath.includes("/node_modules/@get-bb/plugin-sdk/"),
    include: (filePath) => !filePath.includes("/node_modules/") && !filePath.endsWith(".d.ts") && !/\.test(-support)?\.tsx?$/.test(filePath) && !filePath.startsWith(path.join(root, "e2e") + path.sep),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const tsConfigFilePath = path.resolve(process.argv[2] ?? "tsconfig.json");
  const project = new Project({ tsConfigFilePath });
  process.stdout.write(formatAudit(auditProject(project, repoOptions(path.dirname(tsConfigFilePath)))));
}
