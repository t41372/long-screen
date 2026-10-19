/** A translation catalogue with exactly the zh catalogue's shape: same keys at every level, every leaf a string.
 *  Typing each non-zh catalogue section as `Catalog<typeof zhSection>` makes a missing or extra key a compile error.
 *
 *  Plurals: the canonical catalogue carries `key_one` / `key_other`. Other languages may add the CLDR categories
 *  they need; the catalogue test requires every category reported by Intl.PluralRules for that language. */
export type Catalog<T> =
  & { [K in keyof T]: T[K] extends string ? string : Catalog<T[K]> }
  & { [K in keyof T as K extends `${infer Base}_other` ? `${Base}_${'zero' | 'two' | 'few' | 'many'}` : never]?: string };
