/**
 * ESLint Rule: arkova/no-connector-bytes-to-sink
 *
 * SCRUM-2492 (§1.6A enforcement). Connector-fetched documents (DocuSign /
 * Google Drive) MAY be fingerprinted server-side, but the raw document bytes
 * must NEVER reach a logger, Sentry, an Error, `job_queue.last_error`, a temp
 * file, or Postgres. This rule makes that invariant a build-time error on the
 * connector code paths.
 *
 * Detection (AST-only — the worker eslint config has no
 * `parserOptions.project`, so no type information is available):
 *
 *   1. Identify a SINK call/expression:
 *        - `logger.*(...)` and child loggers (`x.child(...).warn(...)`,
 *          `createRpcLogger(...).error(...)`) — including nested object keys.
 *        - `Sentry.capture*` / `addBreadcrumb` / `setContext` / `setExtra`.
 *        - `new Error(...)` / `new <Foo>Error(...)` / `throw <expr>` /
 *          template literals (a `${bytes}` interpolation).
 *        - `last_error:` object-property assignments and `failJob(...)`.
 *        - `fs.write*` / `fs.createWriteStream` / `*.createWriteStream`.
 *        - `.insert(...)` / `.update(...)` / `.upsert(...)` object row VALUES
 *          (Postgres writes), excluding `.byteLength` / `.length` terminals.
 *        - `JSON.stringify(<bytes>)`.
 *   2. Walk the sink's relevant argument(s) — recursively through object
 *      properties, arrays, template literals, and a small set of pass-through
 *      member expressions — looking for a statically-identifiable BYTES value.
 *   3. A BYTES value is:
 *        - a `Buffer.from(...)` / `Buffer.concat(...)` / `Buffer.alloc(...)`
 *          / `Buffer.allocUnsafe(...)` call,
 *        - a typed-array `new Uint8Array(...)` / `new Uint16Array(...)` / ... ,
 *        - a member access ending in `.bytes` (e.g. `document.bytes`),
 *        - an identifier or property whose name matches
 *          `/(?:^|_)bytes$|buffer$|documentBytes/i`
 *          (e.g. `documentBytes`, `rawBuffer`, `file_bytes`),
 *        - a `<bytes>.toString()` / `<bytes>.toString('utf8' | 'latin1' |
 *          'binary' | 'ascii')` call (raw byte→string), but NOT
 *          `.toString('hex')` / `.toString('base64')` (those are safe digests),
 *        - a single-hop alias (same scope) of any of the above.
 *   4. NOT bytes (terminals that PASS):
 *        - `<bytes>.byteLength` / `<bytes>.length` (numeric metadata),
 *        - `createHash(...).update(<bytes>).digest('hex')` (the fingerprint),
 *        - any `.digest('hex' | 'base64' | 'hex'...)` result,
 *        - a hex/identifier named `fingerprint` / `sha256` / `digest` / `hash`.
 *
 * Scope guard (handled by the eslint config `files`/`ignores`, but also
 * defensively below): the PKI/timestamp `arrayBuffer()` readers
 * (`signatures/pki/crlManager.ts`, `signatures/pki/ocspClient.ts`,
 * `signatures/timestamp/rfc3161Client.ts`) are NOT connector files; the
 * canonical `enqueueSignedDocument` sink persists only `byte_length` and is a
 * recognised safe DB sink because the rule only flags raw byte VALUES, not
 * `.byteLength`.
 *
 * Static-only blind spots (documented, accepted): values that flow through a
 * spread (`{ ...obj }`), across files/modules, through multi-hop reassignment,
 * or through a helper function call are NOT tracked. The companion runtime
 * test (L6) plus the byte-safe error types / pino redact / Sentry type-scrub
 * defences cover what the static rule cannot see. Dynamically-typed values
 * with no byte-ish name and no byte-producer shape are deliberately NOT
 * flagged (false positives would push devs to disable the rule).
 *
 * Severity: error (scoped to connector files in eslint.config.js).
 */

// Single-hop alias chain cap — mirrors tenant-isolation's bounded walk.
const ALIAS_HOP_CAP = 1;
// Defensive recursion bound when walking argument trees.
const WALK_DEPTH_CAP = 8;

const BYTEISH_NAME_RE = /(?:^|_)bytes$|buffer$|documentbytes/i;
// Names that look like a finished digest / fingerprint — never raw bytes.
const SAFE_DIGEST_NAME_RE = /^(?:fingerprint|sha256|sha_256|digest|hash|hex|checksum)$/i;
// Encodings whose `.toString(enc)` output is a safe textual digest, not raw bytes.
const SAFE_TOSTRING_ENCODINGS = new Set(['hex', 'base64', 'base64url']);
// Encodings (and the no-arg form) that re-expose raw document content.
const RAW_TOSTRING_ENCODINGS = new Set(['utf8', 'utf-8', 'latin1', 'binary', 'ascii', 'ucs2', 'ucs-2', 'utf16le']);

const BUFFER_PRODUCER_METHODS = new Set(['from', 'concat', 'alloc', 'allocUnsafe', 'allocUnsafeSlow']);
const TYPED_ARRAY_CTORS = new Set([
  'Uint8Array',
  'Uint8ClampedArray',
  'Uint16Array',
  'Uint32Array',
  'Int8Array',
  'Int16Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'BigInt64Array',
  'BigUint64Array',
]);

const SENTRY_SINK_METHODS = new Set([
  'captureException',
  'captureMessage',
  'captureEvent',
  'addBreadcrumb',
  'setContext',
  'setExtra',
  'setExtras',
]);

const LOGGER_LEVEL_METHODS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

// Member-expression "safe metadata" terminals: `<x>.byteLength`, `<x>.length`.
const SAFE_BYTE_METADATA_PROPS = new Set(['byteLength', 'length']);

function propName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function memberPropName(member) {
  if (!member || member.type !== 'MemberExpression') return null;
  if (member.computed) {
    return member.property.type === 'Literal' && typeof member.property.value === 'string'
      ? member.property.value
      : null;
  }
  return member.property.type === 'Identifier' ? member.property.name : null;
}

/**
 * Resolve a single-hop alias for an identifier within the sink's scope:
 *   const x = <init>;  // x referenced later at the sink
 * Returns the initializer node if found, else null. Bounded to ALIAS_HOP_CAP.
 *
 * `ctx.scope` is the scope-manager scope of the sink node (resolved once per
 * sink in the visitor), which lexically contains any same-function alias
 * declaration. ESLint's `context` object is not safe to stash state on, so the
 * scope is threaded through this `ctx` bag instead.
 */
function resolveAlias(node, ctx, hops) {
  if (hops > ALIAS_HOP_CAP) return null;
  if (!node || node.type !== 'Identifier') return null;
  const scope = ctx && ctx.scope;
  if (!scope) return null;
  let variable = null;
  let cur = scope;
  while (cur && !variable) {
    variable = cur.variables.find((v) => v.name === node.name) ?? null;
    cur = cur.upper;
  }
  if (!variable) return null;
  // Only resolve when there is exactly one defining write (a simple alias).
  const defs = variable.defs.filter((d) => d.node && d.node.type === 'VariableDeclarator');
  if (defs.length !== 1) return null;
  const init = defs[0].node.init;
  return init ?? null;
}

/**
 * Is `node` a statically-identifiable raw-bytes value?
 * `ctx` ({ scope }) enables a single-hop alias resolution.
 */
function isBytesNode(node, ctx, hops = 0) {
  if (!node) return false;

  switch (node.type) {
    case 'Identifier': {
      if (SAFE_DIGEST_NAME_RE.test(node.name)) return false;
      if (BYTEISH_NAME_RE.test(node.name)) return true;
      // Single-hop alias: const x = documentBytes; ...x...
      const aliased = resolveAlias(node, ctx, hops + 1);
      return aliased ? isBytesNode(aliased, ctx, hops + 1) : false;
    }

    case 'MemberExpression': {
      const prop = memberPropName(node);
      if (prop && SAFE_BYTE_METADATA_PROPS.has(prop)) return false; // .byteLength / .length
      if (prop && SAFE_DIGEST_NAME_RE.test(prop)) return false;
      if (prop && BYTEISH_NAME_RE.test(prop)) return true; // document.bytes, x.rawBuffer
      return false;
    }

    case 'NewExpression': {
      // new Uint8Array(...), new Buffer(...) (deprecated but byte-bearing)
      const callee = node.callee;
      if (callee && callee.type === 'Identifier') {
        if (TYPED_ARRAY_CTORS.has(callee.name)) return true;
        if (callee.name === 'Buffer') return true;
      }
      return false;
    }

    case 'CallExpression': {
      return isBytesProducingCall(node, ctx, hops);
    }

    case 'AwaitExpression':
      return isBytesNode(node.argument, ctx, hops);

    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
      return isBytesNode(node.expression, ctx, hops);

    default:
      return false;
  }
}

function isBytesProducingCall(node, ctx, hops) {
  const callee = node.callee;
  if (!callee) return false;

  if (callee.type === 'MemberExpression') {
    const method = memberPropName(callee);

    // Buffer.from(...) / Buffer.concat(...) / Buffer.alloc(...)
    if (
      callee.object.type === 'Identifier' &&
      callee.object.name === 'Buffer' &&
      method &&
      BUFFER_PRODUCER_METHODS.has(method)
    ) {
      return true;
    }

    // <expr>.toString(<enc>): raw byte→string unless a safe digest encoding.
    if (method === 'toString') {
      const encArg = node.arguments[0];
      const enc =
        encArg && encArg.type === 'Literal' && typeof encArg.value === 'string'
          ? encArg.value.toLowerCase()
          : undefined;
      if (enc && SAFE_TOSTRING_ENCODINGS.has(enc)) return false; // .toString('hex')
      // No-arg or an explicit raw encoding => re-exposes bytes, IF the receiver is byte-ish.
      if (enc === undefined || RAW_TOSTRING_ENCODINGS.has(enc)) {
        return isBytesNode(callee.object, ctx, hops);
      }
      return false;
    }

    // <hash>.digest('hex') / .digest() => a digest, NOT raw bytes.
    if (method === 'digest') return false;

    // <bytes>.subarray(...) / .slice(...) preserve byte-ness if receiver is byte-ish.
    if (method === 'subarray' || method === 'slice') {
      return isBytesNode(callee.object, ctx, hops);
    }

    return false;
  }

  return false;
}

/**
 * Walk an argument subtree and return the FIRST statically-identifiable bytes
 * node found (or null). Recurses through object property values, array
 * elements, template-literal expressions, conditional branches, and logical
 * expressions. Does NOT descend into nested function bodies (and skips nested
 * `JSON.stringify(...)` callees so those are owned by their own sink visit).
 * Bounded by WALK_DEPTH_CAP. Returning the leaf node lets the caller dedupe
 * by source range across overlapping sinks.
 */
function findBytesNode(node, ctx, depth = 0) {
  if (!node || depth > WALK_DEPTH_CAP) return null;

  if (isBytesNode(node, ctx)) return node;

  switch (node.type) {
    case 'ObjectExpression': {
      for (const prop of node.properties) {
        if (prop.type === 'SpreadElement') continue; // static blind spot (documented)
        if (prop.type !== 'Property') continue;
        const found = findBytesNode(prop.value, ctx, depth + 1);
        if (found) return found;
      }
      return null;
    }

    case 'ArrayExpression': {
      for (const el of node.elements) {
        const found = findBytesNode(el, ctx, depth + 1);
        if (found) return found;
      }
      return null;
    }

    case 'TemplateLiteral': {
      for (const expr of node.expressions) {
        const found = findBytesNode(expr, ctx, depth + 1);
        if (found) return found;
      }
      return null;
    }

    case 'ConditionalExpression':
      return (
        findBytesNode(node.consequent, ctx, depth + 1) ||
        findBytesNode(node.alternate, ctx, depth + 1)
      );

    case 'LogicalExpression':
      return (
        findBytesNode(node.left, ctx, depth + 1) ||
        findBytesNode(node.right, ctx, depth + 1)
      );

    case 'AwaitExpression':
    case 'TSAsExpression':
    case 'TSNonNullExpression':
    case 'TSSatisfiesExpression':
      return findBytesNode(node.argument ?? node.expression, ctx, depth + 1);

    default:
      return null;
  }
}

/** Is the callee a logger sink? `logger.info`, `child.warn`, `x.child(...).error`, etc. */
function isLoggerSink(callee) {
  if (!callee || callee.type !== 'MemberExpression') return false;
  const method = memberPropName(callee);
  if (!method || !LOGGER_LEVEL_METHODS.has(method)) return false;
  // Heuristic: receiver is named/derived from a logger. Accept common shapes:
  //   logger.info / log.warn / child.error / this.logger.info
  //   createRpcLogger(...).error / x.child({...}).warn
  return receiverLooksLikeLogger(callee.object);
}

function receiverLooksLikeLogger(obj) {
  if (!obj) return false;
  if (obj.type === 'Identifier') return /log(?:ger)?$/i.test(obj.name) || obj.name === 'log';
  if (obj.type === 'MemberExpression') {
    const p = memberPropName(obj);
    if (p && (/log(?:ger)?$/i.test(p) || p === 'log')) return true;
    return receiverLooksLikeLogger(obj.object);
  }
  if (obj.type === 'CallExpression') {
    const c = obj.callee;
    if (c && c.type === 'Identifier' && /log(?:ger)?$/i.test(c.name)) return true;
    if (c && c.type === 'MemberExpression') {
      const m = memberPropName(c);
      if (m === 'child') return receiverLooksLikeLogger(c.object); // logger.child({...})
      if (m && /log(?:ger)?$/i.test(m)) return true;
    }
  }
  return false;
}

/** Is the callee a Sentry sink? `Sentry.captureException`, `Sentry.addBreadcrumb`, etc. */
function isSentrySink(callee) {
  if (!callee || callee.type !== 'MemberExpression') return false;
  const method = memberPropName(callee);
  if (!method) return false;
  // Sentry.captureFoo OR the captureX / addBreadcrumb family on a Sentry-ish object.
  const objName = callee.object.type === 'Identifier' ? callee.object.name : null;
  if (objName === 'Sentry') {
    return method.startsWith('capture') || SENTRY_SINK_METHODS.has(method);
  }
  return SENTRY_SINK_METHODS.has(method) && /sentry/i.test(objName ?? '');
}

/** Is the callee an fs write sink? `fs.writeFile`, `fs.writeFileSync`, `*.createWriteStream`. */
function isFsWriteSink(callee) {
  if (!callee || callee.type !== 'MemberExpression') return false;
  const method = memberPropName(callee);
  if (!method) return false;
  if (method === 'createWriteStream') return true;
  return /^write/i.test(method) && method !== 'writeHead'; // writeFile, writeFileSync, write, writev
}

/** Is the callee a Postgres write sink? `.insert` / `.update` / `.upsert`. */
function isDbWriteMethod(method) {
  return method === 'insert' || method === 'update' || method === 'upsert';
}

/**
 * A Postgres write passes a ROW object (or array of rows). The crypto-hash
 * `createHash(...).update(<bytes>)` call shares the `.update` name but takes a
 * Buffer/string, not an object — so only treat `.insert/.update/.upsert` as a
 * DB sink when the first argument is an object/array literal. This keeps the
 * fingerprint-producing `.update(documentBytes)` from being misread as a write.
 */
function isDbRowArg(arg) {
  return arg && (arg.type === 'ObjectExpression' || arg.type === 'ArrayExpression');
}

/** Is the callee a `failJob(...)` style last-error sink? */
function isFailJobSink(callee) {
  if (!callee) return false;
  if (callee.type === 'Identifier') return /^failjob$/i.test(callee.name);
  if (callee.type === 'MemberExpression') {
    const m = memberPropName(callee);
    return m ? /^failjob$/i.test(m) : false;
  }
  return false;
}

/** Is the callee a JSON.stringify sink? */
function isJsonStringifySink(callee) {
  return (
    callee &&
    callee.type === 'MemberExpression' &&
    callee.object.type === 'Identifier' &&
    callee.object.name === 'JSON' &&
    memberPropName(callee) === 'stringify'
  );
}

function isErrorConstructorName(name) {
  return typeof name === 'string' && /Error$/.test(name);
}

/** @type {import('eslint').Rule.RuleModule} */
module.exports = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Raw connector document bytes (Buffer/Uint8Array/*.bytes/documentBytes) must never reach a logger, Sentry, an Error, last_error, a temp file, or Postgres (CLAUDE.md §1.6A / SCRUM-2492).',
      category: 'Security',
      // Static-only blind spots accepted by design:
      //   - object spreads ({ ...obj }) are not unrolled
      //   - cross-file / cross-module value flow is not tracked
      //   - only a single-hop same-scope alias is resolved (multi-hop reassignment is missed)
      //   - values returned from helper functions are not traced
      // These gaps are backstopped by the byte-safe error types, pino redaction,
      // type-based Sentry scrub, and last_error sanitizer (SCRUM-2492 L0-L4) plus
      // the multi-MB runtime leak test (L6).
    },
    messages: {
      bytesToSink:
        "connector-byte-safety: raw document bytes must not reach this {{sink}} (CLAUDE.md §1.6A). Pass only the fingerprint or `.byteLength`. See SCRUM-2492.",
    },
    schema: [],
  },

  create(context) {
    const sourceCode = context.sourceCode ?? (context.getSourceCode ? context.getSourceCode() : null);

    // Dedupe by the leaf bytes-node range so a single offending value reached
    // through two overlapping sinks (e.g. `last_error:` inside `.update({...})`,
    // or `JSON.stringify(bytes)` inside `new Error(...)`) reports exactly once.
    const reportedRanges = new Set();

    // Resolve the sink node's scope so single-hop aliases can be resolved
    // relative to the sink's lexical scope. ESLint's `context` is not safe to
    // stash state on, so the scope travels through an explicit `ctx` bag.
    function scopeFor(node) {
      if (sourceCode && typeof sourceCode.getScope === 'function') {
        try {
          return sourceCode.getScope(node);
        } catch {
          return null;
        }
      }
      return null;
    }

    function reportIfBytes(testNode, reportNode, sink) {
      const ctx = { scope: scopeFor(reportNode) };
      const bytesNode = findBytesNode(testNode, ctx);
      if (bytesNode) {
        const rangeKey = bytesNode.range ? `${bytesNode.range[0]}:${bytesNode.range[1]}` : null;
        if (rangeKey && reportedRanges.has(rangeKey)) return true;
        if (rangeKey) reportedRanges.add(rangeKey);
        context.report({ node: reportNode, messageId: 'bytesToSink', data: { sink } });
        return true;
      }
      return false;
    }

    return {
      // ── new Error(...) / new <Foo>Error(...) ───────────────────────────
      NewExpression(node) {
        const callee = node.callee;
        if (callee && callee.type === 'Identifier' && isErrorConstructorName(callee.name)) {
          for (const arg of node.arguments) {
            if (reportIfBytes(arg, node, 'Error')) break;
          }
        }
      },

      // ── throw <expr> (template literal or bytes directly) ──────────────
      ThrowStatement(node) {
        if (node.argument) {
          reportIfBytes(node.argument, node, 'throw');
        }
      },

      // ── last_error: <bytes> property assignment ────────────────────────
      Property(node) {
        const key = propName(node.key);
        if (key === 'last_error' && node.value) {
          reportIfBytes(node.value, node, 'last_error');
        }
      },

      // ── all call-expression sinks ──────────────────────────────────────
      CallExpression(node) {
        const callee = node.callee;

        // logger.info({ ...bytes }, 'msg') — scan every argument incl. nested keys.
        if (isLoggerSink(callee)) {
          for (const arg of node.arguments) {
            if (reportIfBytes(arg, node, 'logger')) return;
          }
          return;
        }

        // Sentry.captureException(bytes) / addBreadcrumb({ data: bytes }) / setContext(...)
        if (isSentrySink(callee)) {
          for (const arg of node.arguments) {
            if (reportIfBytes(arg, node, 'Sentry')) return;
          }
          return;
        }

        // fs.writeFile(path, bytes) / fs.createWriteStream(...) .write(bytes)
        if (isFsWriteSink(callee)) {
          for (const arg of node.arguments) {
            if (reportIfBytes(arg, node, 'fs write')) return;
          }
          return;
        }

        // failJob(jobId, bytes, ...) — last_error path.
        if (isFailJobSink(callee)) {
          for (const arg of node.arguments) {
            if (reportIfBytes(arg, node, 'last_error (failJob)')) return;
          }
          return;
        }

        // JSON.stringify(bytes)
        if (isJsonStringifySink(callee)) {
          if (node.arguments[0]) reportIfBytes(node.arguments[0], node, 'JSON.stringify');
          return;
        }

        // <query>.insert/.update/.upsert({ col: bytes }) — Postgres write.
        // Only when the argument is a row object/array (crypto `.update(bytes)`
        // takes a Buffer, not an object, so it is excluded).
        if (callee && callee.type === 'MemberExpression') {
          const method = memberPropName(callee);
          if (isDbWriteMethod(method)) {
            for (const arg of node.arguments) {
              if (isDbRowArg(arg) && reportIfBytes(arg, node, 'Postgres write')) return;
            }
          }
        }
      },
    };
  },
};
