/** Runtime prelude embedded into every generated JS file. */
export const PRELUDE = `// NOVA runtime prelude (generated). Do not edit.
function __arr(items) { return { tag: 'array', items }; }
function __map(entries) {
  const m = { tag: 'map', entries: new Map() };
  for (let i = 0; i < entries.length; i += 2) m.entries.set(entries[i], entries[i + 1]);
  return m;
}
function __ok(value) { return { tag: 'result', ok: true, value }; }
function __err(value) { return { tag: 'result', ok: false, value }; }
function __unwrap(v) {
  if (v && typeof v === 'object' && v.tag === 'result' && !v.ok) {
    throw { __nova_propagate: true, value: v };
  }
  if (v === null) throw { __nova_propagate: true, value: null };
  return v;
}
function __struct(name, fields, values) {
  const map = new Map();
  for (const f of fields) map.set(f, null);
  for (let i = 0; i < values.length; i += 2) {
    if (!map.has(values[i])) throw new Error("struct '" + name + "' has no field '" + values[i] + "'");
    map.set(values[i], values[i + 1]);
  }
  return { tag: 'struct', structName: name, fields: map };
}
function __enum(name, variant) { return { tag: 'enum', enumName: name, variant }; }
function __field(obj, name) {
  if (obj && typeof obj === 'object') {
    if (obj.tag === 'struct') {
      if (!obj.fields.has(name)) throw new Error("struct '" + obj.structName + "' has no field '" + name + "'");
      return obj.fields.get(name);
    }
    if (obj.tag === 'map') return obj.entries.get(name) ?? null;
  }
  throw new Error("cannot access field '" + name + "' on " + __stringify(obj));
}
function __index(obj, i) {
  if (obj && typeof obj === 'object') {
    if (obj.tag === 'array') {
      if (!Number.isInteger(i)) throw new Error('array index must be an integer');
      if (i < 0 || i >= obj.items.length) throw new Error('array index ' + i + ' out of bounds (length ' + obj.items.length + ')');
      return obj.items[i];
    }
    if (obj.tag === 'map') {
      if (typeof i !== 'string') throw new Error('map keys must be strings');
      return obj.entries.get(i) ?? null;
    }
  }
  throw new Error('cannot index into ' + __stringify(obj));
}
function __setField(obj, name, v) {
  if (obj && typeof obj === 'object') {
    if (obj.tag === 'struct') {
      if (!obj.fields.has(name)) throw new Error("struct '" + obj.structName + "' has no field '" + name + "'");
      obj.fields.set(name, v);
      return;
    }
    if (obj.tag === 'map') { obj.entries.set(name, v); return; }
  }
  throw new Error('can only assign to fields of structs and maps');
}
function __setIndex(obj, i, v) {
  if (obj && typeof obj === 'object') {
    if (obj.tag === 'array') {
      if (!Number.isInteger(i)) throw new Error('array index must be an integer');
      if (i < 0 || i >= obj.items.length) throw new Error('array index ' + i + ' out of bounds');
      obj.items[i] = v;
      return;
    }
    if (obj.tag === 'map') {
      if (typeof i !== 'string') throw new Error('map keys must be strings');
      obj.entries.set(i, v);
      return;
    }
  }
  throw new Error('can only index arrays and maps');
}
function __iter(v) {
  if (v && typeof v === 'object') {
    if (v.tag === 'array') return v.items;
    if (v.tag === 'map') return [...v.entries.keys()];
  }
  throw new Error('cannot iterate over ' + __stringify(v));
}
function __valuesEqual(a, b) {
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return a === b;
  if (a.tag === 'enum' && b.tag === 'enum') return a.enumName === b.enumName && a.variant === b.variant;
  if (a.tag === 'struct' && b.tag === 'struct') {
    if (a.structName !== b.structName) return false;
    for (const [k, v] of a.fields) {
      if (!b.fields.has(k) || !__valuesEqual(v, b.fields.get(k))) return false;
    }
    return true;
  }
  if (a.tag === 'result' && b.tag === 'result') return a.ok === b.ok && __valuesEqual(a.value, b.value);
  if (a.tag === 'array' && b.tag === 'array') {
    return a.items.length === b.items.length && a.items.every((v, i) => __valuesEqual(v, b.items[i]));
  }
  return a === b;
}
function __stringify(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return v;
  if (v.tag === 'array') return '[' + v.items.map(__stringify).join(', ') + ']';
  if (v.tag === 'map') return '{' + [...v.entries].map(([k, x]) => k + ': ' + __stringify(x)).join(', ') + '}';
  if (v.tag === 'struct') return v.structName + '(' + [...v.fields].map(([k, x]) => k + ': ' + __stringify(x)).join(', ') + ')';
  if (v.tag === 'enum') return v.enumName + '.' + v.variant;
  if (v.tag === 'result') return v.ok ? 'ok(' + __stringify(v.value) + ')' : 'err(' + __stringify(v.value) + ')';
  return '<fn>';
}
function __print(...args) { console.log(args.map(__stringify).join(' ')); }
function __len(v) {
  if (typeof v === 'string') return v.length;
  if (v && typeof v === 'object') {
    if (v.tag === 'array') return v.items.length;
    if (v.tag === 'map') return v.entries.size;
    if (v.tag === 'struct') return v.fields.size;
  }
  throw new Error('len() expects a string, array, map or struct');
}
function __range(n) {
  if (!Number.isInteger(n) || n < 0) throw new Error('range() expects a non-negative Int');
  return __arr(Array.from({ length: n }, (_, i) => i));
}
function __keys(m) {
  if (!m || typeof m !== 'object' || m.tag !== 'map') throw new Error('keys() expects a map');
  return __arr([...m.entries.keys()]);
}
function __values(m) {
  if (!m || typeof m !== 'object' || m.tag !== 'map') throw new Error('values() expects a map');
  return __arr([...m.entries.values()]);
}
function __expect(v) { if (v !== true) throw new Error('expectation failed: expected true, found ' + __stringify(v)); }
function __expectEq(a, b) { if (!__valuesEqual(a, b)) throw new Error('expectation failed: ' + __stringify(a) + ' != ' + __stringify(b)); }
function __push(a, v) {
  if (!a || typeof a !== 'object' || a.tag !== 'array') throw new Error('push() expects an array');
  a.items.push(v);
}
function __has(m, k) {
  if (!m || typeof m !== 'object' || m.tag !== 'map') throw new Error('has() expects a map');
  return m.entries.has(k);
}
function __remove(m, k) {
  if (!m || typeof m !== 'object' || m.tag !== 'map') throw new Error('remove() expects a map');
  m.entries.delete(k);
}
function __int(v) {
  if (typeof v === 'number') return Math.trunc(v);
  if (typeof v === 'string' && /^-?\\d+$/.test(v.trim())) return parseInt(v, 10);
  throw new Error('int() cannot convert ' + __stringify(v));
}
function __float(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && !Number.isNaN(Number(v))) return Number(v);
  throw new Error('float() cannot convert ' + __stringify(v));
}
function __pop(a) {
  if (!a || typeof a !== 'object' || a.tag !== 'array') throw new Error('pop() expects an array');
  if (a.items.length === 0) throw new Error('pop() on empty array');
  return a.items.pop();
}
function __first(a) {
  if (!a || typeof a !== 'object' || a.tag !== 'array') throw new Error('first() expects an array');
  if (a.items.length === 0) throw new Error('first() on empty array');
  return a.items[0];
}
function __last(a) {
  if (!a || typeof a !== 'object' || a.tag !== 'array') throw new Error('last() expects an array');
  if (a.items.length === 0) throw new Error('last() on empty array');
  return a.items[a.items.length - 1];
}
function __slice(v, start, end) {
  if (typeof v === 'string') return v.slice(start, end);
  if (v && typeof v === 'object' && v.tag === 'array') return __arr(v.items.slice(start, end));
  throw new Error('slice() expects a string or array');
}
function __contains(v, item) {
  if (typeof v === 'string' && typeof item === 'string') return v.includes(item);
  if (v && typeof v === 'object' && v.tag === 'array') return v.items.some((x) => __valuesEqual(x, item));
  throw new Error('contains() expects a string or array');
}
function __join(a, sep) {
  if (!a || typeof a !== 'object' || a.tag !== 'array') throw new Error('join() expects an array');
  return a.items.map(__stringify).join(sep || '');
}
function __merge(m1, m2) {
  if (!m1 || typeof m1 !== 'object' || m1.tag !== 'map') throw new Error('merge() expects a map');
  if (!m2 || typeof m2 !== 'object' || m2.tag !== 'map') throw new Error('merge() expects a map');
  return { tag: 'map', entries: new Map([...m1.entries, ...m2.entries]) };
}
function __typeof(v) {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? 'Int' : 'Float';
  if (typeof v === 'string') return 'String';
  if (typeof v === 'boolean') return 'Bool';
  if (v && typeof v === 'object') {
    if (v.tag === 'array') return 'Array';
    if (v.tag === 'map') return 'Map';
    if (v.tag === 'struct') return 'Struct';
    if (v.tag === 'enum') return 'Enum';
    if (v.tag === 'result') return 'Result';
  }
  return 'unknown';
}
`;
