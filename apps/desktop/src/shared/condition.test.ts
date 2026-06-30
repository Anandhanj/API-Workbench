import { describe, expect, it } from 'vitest';
import { evaluateCondition, isTruthyValue } from './condition';

const VARS: Record<string, string> = {
  status: '200',
  count: '5',
  zero: '0',
  token: '',
  name: 'admin',
  plan: 'pro',
  hasMore: 'true',
  path: '/api/users',
};
const resolve = (t: string): string =>
  t.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_m, k: string) => VARS[k] ?? '');
const ev = (expr: string): boolean => evaluateCondition(expr, resolve);

describe('isTruthyValue', () => {
  it('treats empty / false-like strings as falsy', () => {
    for (const v of ['', ' ', 'false', 'FALSE', '0', 'no', 'null', 'undefined']) {
      expect(isTruthyValue(v)).toBe(false);
    }
  });
  it('treats anything else as truthy', () => {
    for (const v of ['true', '1', '200', 'admin']) expect(isTruthyValue(v)).toBe(true);
  });
});

describe('evaluateCondition — backward compatible bare terms', () => {
  it('uses truthiness when there is no operator', () => {
    expect(ev('{{hasMore}}')).toBe(true);
    expect(ev('{{token}}')).toBe(false); // empty
    expect(ev('{{zero}}')).toBe(false); // "0"
    expect(ev('true')).toBe(true);
    expect(ev('')).toBe(false);
  });
});

describe('evaluateCondition — comparisons', () => {
  it('equality (numeric and string, with optional quotes)', () => {
    expect(ev('{{status}} == 200')).toBe(true);
    expect(ev('{{status}} != 200')).toBe(false);
    expect(ev('{{name}} == admin')).toBe(true);
    expect(ev('{{name}} == "admin"')).toBe(true);
    expect(ev('{{name}} == user')).toBe(false);
  });

  it('numeric ordering', () => {
    expect(ev('{{count}} > 0')).toBe(true);
    expect(ev('{{count}} >= 5')).toBe(true);
    expect(ev('{{count}} < 3')).toBe(false);
    expect(ev('{{zero}} <= 0')).toBe(true);
  });

  it('string operators', () => {
    expect(ev('{{name}} contains adm')).toBe(true);
    expect(ev('{{name}} contains xyz')).toBe(false);
    expect(ev('{{path}} startsWith /api')).toBe(true);
    expect(ev('{{path}} endsWith users')).toBe(true);
    expect(ev('{{path}} matches ^/api/\\w+')).toBe(true);
    expect(ev('{{path}} matches ^/admin')).toBe(false);
  });

  it('invalid regex in matches is false, not a throw', () => {
    expect(ev('{{path}} matches (')).toBe(false);
  });
});

describe('evaluateCondition — logical combinators and negation', () => {
  it('&& binds tighter than ||', () => {
    expect(ev('{{status}} == 200 && {{count}} > 0')).toBe(true);
    expect(ev('{{status}} == 500 && {{plan}} == pro')).toBe(false);
    expect(ev('{{status}} == 500 || {{plan}} == pro')).toBe(true);
    expect(ev('{{status}} == 500 && {{count}} > 0 || {{plan}} == pro')).toBe(true);
  });

  it('leading ! negates a clause', () => {
    expect(ev('!{{token}}')).toBe(true); // empty → false → negated
    expect(ev('!{{hasMore}}')).toBe(false);
    expect(ev('!{{status}} == 200')).toBe(false); // !(200 == 200)
  });
});
