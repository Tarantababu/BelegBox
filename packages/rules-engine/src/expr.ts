/**
 * Arithmetic for `compute` actions.
 *
 * Deliberately its own tiny parser rather than `eval`, `new Function`, or any
 * expression library that reaches into objects. Rule YAML is authored by
 * tenants from F3 onwards, which makes an expression string untrusted input
 * that runs on our servers. The grammar below is the whole language:
 *
 *   expr   := term (('+' | '-') term)*
 *   term   := unary (('*' | '/') unary)*
 *   unary  := '-' unary | primary
 *   primary:= number | field | '(' expr ')'
 *   field  := ident ('.' ident)+
 *
 * No calls, no indexing, no property access. Field names resolve through the
 * same whitelist the conditions use, so an expression cannot reach anything a
 * condition could not.
 */

type Token =
  | { kind: "num"; value: number }
  | { kind: "field"; path: string }
  | { kind: "op"; value: "+" | "-" | "*" | "/" }
  | { kind: "paren"; value: "(" | ")" };

const MAX_EXPRESSION_LENGTH = 200;

export class ExpressionError extends Error {
  constructor(message: string, readonly expression: string) {
    super(`${message} in expression: ${expression}`);
    this.name = "ExpressionError";
  }
}

function tokenize(input: string): Token[] {
  if (input.length > MAX_EXPRESSION_LENGTH) {
    throw new ExpressionError("Expression is too long", input.slice(0, 40));
  }

  const tokens: Token[] = [];
  let i = 0;

  while (i < input.length) {
    const c = input[i] as string;

    if (/\s/.test(c)) {
      i += 1;
      continue;
    }
    if (c === "(" || c === ")") {
      tokens.push({ kind: "paren", value: c });
      i += 1;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/") {
      tokens.push({ kind: "op", value: c });
      i += 1;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const start = i;
      while (i < input.length && /[0-9.]/.test(input[i] as string)) i += 1;
      const raw = input.slice(start, i);
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        throw new ExpressionError(`"${raw}" is not a number`, input);
      }
      tokens.push({ kind: "num", value });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const start = i;
      while (i < input.length && /[A-Za-z0-9_.]/.test(input[i] as string)) i += 1;
      tokens.push({ kind: "field", path: input.slice(start, i) });
      continue;
    }
    throw new ExpressionError(`Unexpected character "${c}"`, input);
  }

  return tokens;
}

export type FieldResolver = (path: string) => unknown;

export function evaluateExpression(expression: string, resolve: FieldResolver): number {
  const tokens = tokenize(expression);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];

  function parseExpr(): number {
    let left = parseTerm();
    for (;;) {
      const t = peek();
      if (t?.kind !== "op" || (t.value !== "+" && t.value !== "-")) break;
      pos += 1;
      const right = parseTerm();
      left = t.value === "+" ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t?.kind !== "op" || (t.value !== "*" && t.value !== "/")) break;
      pos += 1;
      const right = parseUnary();
      if (t.value === "/") {
        if (right === 0) {
          throw new ExpressionError("Division by zero", expression);
        }
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }

  function parseUnary(): number {
    const t = peek();
    if (t?.kind === "op" && t.value === "-") {
      pos += 1;
      return -parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary(): number {
    const t = peek();
    if (!t) throw new ExpressionError("Unexpected end of expression", expression);

    if (t.kind === "num") {
      pos += 1;
      return t.value;
    }
    if (t.kind === "field") {
      pos += 1;
      const value = resolve(t.path);
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string") {
        const n = Number(value.replace(",", "."));
        if (Number.isFinite(n)) return n;
      }
      // A missing field is not zero. Treating it as zero is how a computed VAT
      // gap silently becomes 0.00 and the finding reads as harmless.
      throw new ExpressionError(`Field "${t.path}" is not a number`, expression);
    }
    if (t.kind === "paren" && t.value === "(") {
      pos += 1;
      const value = parseExpr();
      const close = peek();
      if (close?.kind !== "paren" || close.value !== ")") {
        throw new ExpressionError("Missing closing parenthesis", expression);
      }
      pos += 1;
      return value;
    }
    throw new ExpressionError("Unexpected token", expression);
  }

  const result = parseExpr();
  if (pos !== tokens.length) {
    throw new ExpressionError("Trailing tokens", expression);
  }
  if (!Number.isFinite(result)) {
    throw new ExpressionError("Result is not finite", expression);
  }
  return result;
}

/** Field paths an expression references, for load-time validation. */
export function expressionFields(expression: string): string[] {
  return tokenize(expression)
    .filter((t): t is Extract<Token, { kind: "field" }> => t.kind === "field")
    .map((t) => t.path);
}
