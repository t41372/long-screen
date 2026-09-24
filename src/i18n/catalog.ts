/** A translation catalogue with exactly the zh catalogue's shape: same keys at every level, every leaf a string.
 *  Typing each non-zh catalogue section as `Catalog<typeof zhSection>` makes a missing or extra key a compile error.
 *
 *  Plurals: English needs `key_one` / `key_other` (picked by `t(key, { count })`); the zh catalogue carries the same
 *  pair, both worded the same, so the shapes stay identical. */
export type Catalog<T> = { [K in keyof T]: T[K] extends string ? string : Catalog<T[K]> };
