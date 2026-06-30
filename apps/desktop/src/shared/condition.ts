/**
 * Boolean expression evaluator for workflow Condition (and Loop "while") nodes.
 *
 * The expression is resolved against the run's variables and evaluated to a
 * boolean. It supports:
 *  - comparisons: `==` `!=` `>` `>=` `<` `<=` (numeric when both sides are
 *    numbers, string otherwise)
 *  - string ops (space-delimited, case-insensitive keyword): `contains`,
 *    `startsWith`, `endsWith`, `matches` (regex)
 *  - logical combinators `&&` and `||` (no parentheses), `&&` binding tighter
 *  - leading `!` to negate a clause
 *  - quoted literals: `'x'` / `"x"`
 *  - a bare term (no operator) is truthy unless it resolves to an empty string
 *    or one of false/0/no/null/undefined (the original behaviour)
 *
 * Operands are `{{template}}`-resolved independently, so values never need
 * escaping and a missing variable simply resolves to an empty string.
 */

export type ConditionResolver = (template: string) => string;

const FALSY = new Set(['', 'false', '0', 'no', 'null', 'undefined']);

/** The original truthiness rule for a resolved scalar string. */
export function isTruthyValue(value: string): boolean {
  return !FALSY.has(value.trim().toLowerCase());
}

const WORD_OP_RE = /\s+(contains|startsWith|endsWith|matches)\s+/i;
const SYMBOL_OPS = ['>=', '<=', '==', '!=', '>', '<'] as const;

function stripQuotes(raw: string): string {
  const t = raw.trim();
  if (t.length >= 2) {
    const a = t[0];
    const b = t[t.length - 1];
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1);
  }
  return t;
}

function findSymbolOp(clause: string): { op: string; index: number } | null {
  for (let i = 0; i < clause.length; i++) {
    for (const op of SYMBOL_OPS) {
      if (clause.startsWith(op, i)) return { op, index: i };
    }
  }
  return null;
}

function compare(op: string, lhs: string, rhs: string): boolean {
  const ln = Number(lhs);
  const rn = Number(rhs);
  const bothNum = lhs.trim() !== '' && rhs.trim() !== '' && !Number.isNaN(ln) && !Number.isNaN(rn);
  const numericEqual = bothNum && ln === rn;
  switch (op.toLowerCase()) {
    case '==':
      return lhs === rhs || numericEqual;
    case '!=':
      return !(lhs === rhs || numericEqual);
    case '>':
      return bothNum ? ln > rn : lhs > rhs;
    case '>=':
      return bothNum ? ln >= rn : lhs >= rhs;
    case '<':
      return bothNum ? ln < rn : lhs < rhs;
    case '<=':
      return bothNum ? ln <= rn : lhs <= rhs;
    case 'contains':
      return lhs.includes(rhs);
    case 'startswith':
      return lhs.startsWith(rhs);
    case 'endswith':
      return lhs.endsWith(rhs);
    case 'matches':
      try {
        return new RegExp(rhs).test(lhs);
      } catch {
        return false;
      }
    default:
      return false;
  }
}

/** Quotes are stripped from the raw operand, then its `{{templates}}` resolved. */
function operand(raw: string, resolve: ConditionResolver): string {
  return resolve(stripQuotes(raw));
}

function evalComparison(clause: string, resolve: ConditionResolver): boolean {
  const word = clause.match(WORD_OP_RE);
  if (word && word.index !== undefined) {
    const lhs = operand(clause.slice(0, word.index), resolve);
    const rhs = operand(clause.slice(word.index + word[0].length), resolve);
    return compare(word[1], lhs, rhs);
  }
  const sym = findSymbolOp(clause);
  if (sym) {
    const lhs = operand(clause.slice(0, sym.index), resolve);
    const rhs = operand(clause.slice(sym.index + sym.op.length), resolve);
    return compare(sym.op, lhs, rhs);
  }
  return isTruthyValue(operand(clause, resolve));
}

function evalClause(clause: string, resolve: ConditionResolver): boolean {
  let c = clause.trim();
  let negate = false;
  while (c.startsWith('!') && !c.startsWith('!=')) {
    negate = !negate;
    c = c.slice(1).trim();
  }
  const result = evalComparison(c, resolve);
  return negate ? !result : result;
}

/**
 * Evaluates a condition expression to a boolean. `||` separates OR groups, each
 * an AND of clauses. An empty expression is false.
 */
export function evaluateCondition(expression: string, resolve: ConditionResolver): boolean {
  const expr = (expression ?? '').trim();
  if (expr === '') return false;
  return expr
    .split('||')
    .some((orPart) => orPart.split('&&').every((clause) => evalClause(clause, resolve)));
}
