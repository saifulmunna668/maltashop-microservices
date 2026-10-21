'use strict';
// Tiny contract matcher shared by the consumer and provider contract tests (no dependencies).
// "<string>" / "<integer>" match any value of that type; other values must be equal. Extra fields
// in the actual body are allowed: a provider may add fields without breaking its consumers.
function matches(expected, actual, path = 'body') {
  if (expected === '<string>') return typeof actual === 'string' && actual.length > 0 ? [] : [`${path}: expected a string`];
  if (expected === '<integer>') return Number.isInteger(actual) ? [] : [`${path}: expected an integer`];
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object') return [`${path}: expected an object`];
    return Object.keys(expected).flatMap((k) => matches(expected[k], actual[k], `${path}.${k}`));
  }
  return expected === actual ? [] : [`${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

module.exports = { matches };
