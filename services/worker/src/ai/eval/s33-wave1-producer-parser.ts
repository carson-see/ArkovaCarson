/** Literal-only parser shared by the Wave-1 producer and dual-DAG verifiers. */

import ts from 'typescript';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type ProducerDeclaration = Readonly<{ initializer: ts.Expression; isConst: boolean }>;

interface ProducerArrayContext {
  declarations: ReadonlyMap<string, ProducerDeclaration>;
  evaluated: Map<string, Record<string, unknown>[]>;
  evaluating: Set<string>;
  sourcePath: string;
}

const MAX_WAVE1_PRODUCER_ROWS = 81;
const NOT_PRIMITIVE = Symbol('not-primitive');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unwrapExpression(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isSatisfiesExpression(current)
    || ts.isParenthesizedExpression(current)
    || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function propertyName(name: ts.PropertyName, label: string): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
    return name.text;
  }
  throw new Error(`${label} uses a computed or unsupported property name`);
}

function finiteNumber(text: string, label: string): number {
  const number = Number(text);
  if (!Number.isFinite(number)) throw new Error(`${label} contains a non-finite number`);
  return number;
}

function parseSignedNumber(
  value: ts.Expression,
  label: string,
): number | typeof NOT_PRIMITIVE {
  if (!ts.isPrefixUnaryExpression(value) || !ts.isNumericLiteral(value.operand)) {
    return NOT_PRIMITIVE;
  }
  if (value.operator === ts.SyntaxKind.MinusToken) {
    return finiteNumber(`-${value.operand.text}`, label);
  }
  if (value.operator === ts.SyntaxKind.PlusToken) return finiteNumber(value.operand.text, label);
  return NOT_PRIMITIVE;
}

function parsePrimitiveLiteral(
  value: ts.Expression,
  label: string,
): null | boolean | number | string | typeof NOT_PRIMITIVE {
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return finiteNumber(value.text, label);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  return parseSignedNumber(value, label);
}

function parseLiteralArray(value: ts.ArrayLiteralExpression, label: string): JsonValue[] {
  return value.elements.map((element, index) => {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) {
      throw new Error(`${label}[${index}] may not be spread or omitted data`);
    }
    return parseLiteralExpression(element, `${label}[${index}]`);
  });
}

function parseLiteralObject(value: ts.ObjectLiteralExpression, label: string): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = Object.create(null) as Record<string, JsonValue>;
  for (const property of value.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${label} may contain only explicit property assignments`);
    }
    const key = propertyName(property.name, label);
    if (Object.hasOwn(result, key)) throw new Error(`${label} contains duplicate property ${key}`);
    result[key] = parseLiteralExpression(property.initializer, `${label}.${key}`);
  }
  return result;
}

function parseLiteralExpression(expression: ts.Expression, label: string): JsonValue {
  const value = unwrapExpression(expression);
  const primitive = parsePrimitiveLiteral(value, label);
  if (primitive !== NOT_PRIMITIVE) return primitive;
  if (ts.isArrayLiteralExpression(value)) return parseLiteralArray(value, label);
  if (ts.isObjectLiteralExpression(value)) return parseLiteralObject(value, label);
  throw new Error(`${label} must be literal producer data; executable/computed syntax is forbidden`);
}

function hasExportModifier(statement: ts.VariableStatement): boolean {
  return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

export function assertS33SourceParseDiagnostics(source: ts.SourceFile, sourcePath: string): void {
  const parseDiagnostics = (source as ts.SourceFile & {
    readonly parseDiagnostics?: readonly ts.Diagnostic[];
  }).parseDiagnostics;
  if (!Array.isArray(parseDiagnostics)) {
    throw new Error(`${sourcePath} TypeScript parser diagnostics API is unavailable`);
  }
  if (parseDiagnostics.length > 0) {
    throw new Error(`${sourcePath} contains TypeScript parse diagnostics`);
  }
}

function collectProducerDeclarations(
  source: ts.SourceFile,
  sourcePath: string,
): Readonly<{ declarations: Map<string, ProducerDeclaration>; exported: Set<string> }> {
  const declarations = new Map<string, ProducerDeclaration>();
  const exported = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const isExported = hasExportModifier(statement);
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const name = declaration.name.text;
      if (declarations.has(name)) throw new Error(`${sourcePath} contains duplicate declaration ${name}`);
      declarations.set(name, {
        initializer: declaration.initializer,
        isConst: (statement.declarationList.flags & ts.NodeFlags.Const) !== 0,
      });
      if (isExported) exported.add(name);
    }
  }
  return { declarations, exported };
}

function appendProducerRows(
  context: ProducerArrayContext,
  target: Record<string, unknown>[],
  additions: readonly Record<string, unknown>[],
  label: string,
): void {
  if (target.length + additions.length > MAX_WAVE1_PRODUCER_ROWS) {
    throw new Error(`${context.sourcePath} ${label} exceeds the maximum 81-row Wave-1 corpus`);
  }
  target.push(...additions);
}

function resolveProducerArray(
  context: ProducerArrayContext,
  name: string,
): Record<string, unknown>[] {
  const declaration = context.declarations.get(name);
  if (!declaration) throw new Error(`${context.sourcePath} references unknown array ${name}`);
  if (!declaration.isConst) throw new Error(`${context.sourcePath} array ${name} must be declared const`);
  const cached = context.evaluated.get(name);
  if (cached) return cached;
  if (context.evaluating.has(name)) throw new Error(`${context.sourcePath} contains cyclic array ${name}`);
  context.evaluating.add(name);
  const result = evaluateProducerArray(context, declaration.initializer, name);
  context.evaluating.delete(name);
  context.evaluated.set(name, result);
  return result;
}

function appendProducerElement(
  context: ProducerArrayContext,
  result: Record<string, unknown>[],
  element: ts.Expression | ts.OmittedExpression | ts.SpreadElement,
  index: number,
  label: string,
): void {
  if (ts.isSpreadElement(element)) {
    const additions = evaluateProducerArray(context, element.expression, `${label}[${index}] spread`);
    appendProducerRows(context, result, additions, label);
    return;
  }
  if (ts.isOmittedExpression(element)) {
    throw new Error(`${context.sourcePath} ${label} contains an omitted row`);
  }
  const parsed = parseLiteralExpression(element, `${context.sourcePath} ${label}[${index}]`);
  if (!isRecord(parsed)) throw new Error(`${context.sourcePath} ${label}[${index}] must be an object`);
  appendProducerRows(context, result, [parsed], label);
}

function evaluateProducerArray(
  context: ProducerArrayContext,
  expression: ts.Expression,
  label: string,
): Record<string, unknown>[] {
  const value = unwrapExpression(expression);
  if (ts.isIdentifier(value)) return resolveProducerArray(context, value.text);
  if (!ts.isArrayLiteralExpression(value)) {
    throw new Error(`${context.sourcePath} ${label} must resolve to a literal array graph`);
  }
  const result: Record<string, unknown>[] = [];
  value.elements.forEach((element, index) => {
    appendProducerElement(context, result, element, index, label);
  });
  return result;
}

/** Parse only the named exported array graph; producer code is never evaluated. */
export function parseS33ProducerModule(
  sourceText: string,
  sourcePath: string,
  exportName: string,
): Record<string, unknown>[] {
  const source = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  assertS33SourceParseDiagnostics(source, sourcePath);
  const { declarations, exported } = collectProducerDeclarations(source, sourcePath);
  if (!exported.has(exportName)) throw new Error(`${sourcePath} must directly export const ${exportName}`);
  const exportedDeclaration = declarations.get(exportName)!;
  if (!exportedDeclaration.isConst) throw new Error(`${sourcePath} must directly export const ${exportName}`);
  return evaluateProducerArray({
    declarations,
    evaluated: new Map(),
    evaluating: new Set(),
    sourcePath,
  }, exportedDeclaration.initializer, exportName);
}
