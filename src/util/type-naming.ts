// Type-level singular/plural, mirroring the `pluralize` rules that `singularizeMapper` runs
// at runtime — so `entities` can be keyed by the names a `typeNameMapper: 'singularize'`
// build actually publishes.
//
// TypeScript cannot call `pluralize`, so this is a transcription of its rule set rather than
// a call into it, and the transcription is deliberately *sound rather than complete*: a word
// these rules cannot decide resolves to `string`, which widens that one table's entity keys
// into an index signature instead of naming a field the build does not publish. Being loose
// costs autocomplete; being wrong costs a type error on correct code. So the rules only claim
// a name where the claim can be checked, and `tests/type-naming.test.ts` checks every word
// here against the real `pluralize`, in both directions.
//
// The rules read inverted from their source: `pluralize` applies the *last* matching rule in
// its list, so the conditionals below run from its highest-priority rule down to `s$`. Each
// one splits a fixed ending off with a single `infer` and then tests the stem — inferring
// against a union of stems instead would match several at once and yield a union of
// candidate words rather than one.

/** A word the rules decline to decide. Widens the keys derived from it rather than guessing. */
type Unresolved = string;

type Letter =
  | 'a'
  | 'b'
  | 'c'
  | 'd'
  | 'e'
  | 'f'
  | 'g'
  | 'h'
  | 'i'
  | 'j'
  | 'k'
  | 'l'
  | 'm'
  | 'n'
  | 'o'
  | 'p'
  | 'q'
  | 'r'
  | 's'
  | 't'
  | 'u'
  | 'v'
  | 'w'
  | 'x'
  | 'y'
  | 'z';
type Vowel = 'a' | 'e' | 'i' | 'o' | 'u';
/** `pluralize`'s `[^aou]` class, from the `[^aou]us` stem both directions share. */
type NotAOU = Exclude<Letter, 'a' | 'o' | 'u'>;

/** True when `S` ends with any member of the union `Suffix`. */
type EndsWith<S extends string, Suffix extends string> = Lowercase<S> extends `${string}${Suffix}` ? true : false;

/**
 * `pluralize`'s uncountable list: these are their own singular *and* plural. Trimmed to the
 * entries that could plausibly name a table; the corpus test pins the ones that are here.
 */
type Uncountable =
  | 'advice'
  | 'agenda'
  | 'aid'
  | 'aircraft'
  | 'alcohol'
  | 'ammo'
  | 'analytics'
  | 'anime'
  | 'athletics'
  | 'audio'
  | 'blood'
  | 'cash'
  | 'chassis'
  | 'chess'
  | 'clothing'
  | 'commerce'
  | 'cooperation'
  | 'corps'
  | 'debris'
  | 'digestion'
  | 'energy'
  | 'equipment'
  | 'expertise'
  | 'firmware'
  | 'fun'
  | 'garbage'
  | 'graffiti'
  | 'hardware'
  | 'headquarters'
  | 'health'
  | 'homework'
  | 'housework'
  | 'information'
  | 'jeans'
  | 'justice'
  | 'kudos'
  | 'labour'
  | 'literature'
  | 'machinery'
  | 'mail'
  | 'manga'
  | 'media'
  | 'mews'
  | 'music'
  | 'mud'
  | 'news'
  | 'personnel'
  | 'plankton'
  | 'pliers'
  | 'police'
  | 'pollution'
  | 'premises'
  | 'rain'
  | 'research'
  | 'rice'
  | 'scissors'
  | 'series'
  | 'sewage'
  | 'shambles'
  | 'software'
  | 'species'
  | 'staff'
  | 'tennis'
  | 'traffic'
  | 'transportation'
  | 'wealth'
  | 'welfare'
  | 'wildlife';

/** The same list's regex members, as the endings they stand for. */
type UncountableEnding =
  | 'fish'
  | 'deer'
  | 'sheep'
  | 'pox'
  | 'measles'
  | 'pokemon'
  | 'pokémon'
  | `${Exclude<Letter, Vowel>}ese`
  | `o${'i' | 'u'}s`;

/**
 * `pluralize`'s irregular pairs, minus the pronouns, plus the handful of words whose rule is
 * `\b`-anchored and so behaves as a whole word: `mice`/`lice` from `\b((?:tit)?m|l)ice$`,
 * `people` and `children` from their own rules, and `lives` from the guarded `li` in the
 * `-ves` rule that leaves `olives` alone.
 */
type IrregularPlurals = {
  anathema: 'anathemata';
  axe: 'axes';
  carve: 'carves';
  child: 'children';
  die: 'dice';
  dingo: 'dingoes';
  dogma: 'dogmata';
  eave: 'eaves';
  echo: 'echoes';
  foot: 'feet';
  genus: 'genera';
  goose: 'geese';
  groove: 'grooves';
  human: 'humans';
  lemma: 'lemmata';
  life: 'lives';
  louse: 'lice';
  man: 'men';
  mouse: 'mice';
  ox: 'oxen';
  passerby: 'passersby';
  person: 'people';
  pickaxe: 'pickaxes';
  proof: 'proofs';
  quiz: 'quizzes';
  schema: 'schemata';
  stigma: 'stigmata';
  stoma: 'stomata';
  thief: 'thieves';
  titmouse: 'titmice';
  tooth: 'teeth';
  tornado: 'tornadoes';
  torpedo: 'torpedoes';
  valve: 'valves';
  viscus: 'viscera';
  volcano: 'volcanoes';
  yes: 'yeses';
};
type IrregularSingulars = {
  anathemata: 'anathema';
  axes: 'axe';
  carves: 'carve';
  children: 'child';
  dice: 'die';
  dingoes: 'dingo';
  dogmata: 'dogma';
  eaves: 'eave';
  echoes: 'echo';
  feet: 'foot';
  geese: 'goose';
  genera: 'genus';
  grooves: 'groove';
  humans: 'human';
  lemmata: 'lemma';
  lice: 'louse';
  lives: 'life';
  men: 'man';
  mice: 'mouse';
  oxen: 'ox';
  passersby: 'passerby';
  people: 'person';
  pickaxes: 'pickaxe';
  proofs: 'proof';
  quizzes: 'quiz';
  schemata: 'schema';
  stigmata: 'stigma';
  stomata: 'stoma';
  teeth: 'tooth';
  thieves: 'thief';
  titmice: 'titmouse';
  tornadoes: 'tornado';
  torpedoes: 'torpedo';
  valves: 'valve';
  viscera: 'viscus';
  volcanoes: 'volcano';
  yeses: 'yes';
};

// ── singularization ─────────────────────────────────────────────────────────────

/**
 * The stems that keep their `ie` instead of collapsing to `y`. `pluralize` anchors this rule
 * at a word boundary, so these are whole stems and not endings: `ties` gives `tie` and
 * `cuties` gives `cutie`, but `oldies` gives `oldy` and `cookies` gives `cooky`. Guessing
 * from the ending is precisely what does not work here, hence the list.
 */
type IeWholeStem =
  | 'l'
  | 't'
  | 'neckt'
  | 'crosst'
  | 'coll'
  | 'faer'
  | 'food'
  | 'gen'
  | 'goon'
  | 'group'
  | 'lass'
  | 'talk'
  | 'goal'
  | 'p'
  | 'cut'
  | 'zomb';
/** `\b(mon|smil)ies$` — the two stems that take `ey` rather than `y` or `ie`. */
type EyWholeStem = 'mon' | 'smil';
/** `(movie|twelve|abuse|e[mn]u)s$` — words that just drop the `s`, ahead of the `ies` rule. */
type PlainSStem = 'movie' | 'twelve' | 'abuse' | `e${'m' | 'n'}u`;

/**
 * Stems the big `(x|ch|ss|sh|zz|…)(?:es)?$` rule strips `es` from — the ones expressible as a
 * plain ending. Its character-class members are {@link EsClassStem}, since a union of endings
 * cannot say "any letter but these".
 */
type EsStem = 'x' | 'ch' | 'ss' | 'sh' | 'zz' | 'tto' | 'go' | 'cho' | 'alias' | 'gas' | 'hero' | 'ato' | 'gro';
/** The same rule's character classes, expanded into the unions they stand for. */
type EsClassStem = `${NotAOU}us` | `t${'l' | 'm'}as` | `${Vowel}ris`;

/**
 * `(agend|addend|…|quor)(?:a|um)$` and `(apheli|…|automat)(?:a|on)$`. Both directions read
 * these as endings rather than whole words, so `metadata` gives `metadatum`.
 */
type AToUmStem =
  | 'agend'
  | 'addend'
  | 'millenni'
  | 'dat'
  | 'extrem'
  | 'bacteri'
  | 'desiderat'
  | 'strat'
  | 'candelabr'
  | 'errat'
  | 'ov'
  | 'symposi'
  | 'curricul'
  | 'quor';
type AToOnStem =
  | 'apheli'
  | 'hyperbat'
  | 'periheli'
  | 'asyndet'
  | 'noumen'
  | 'phenomen'
  | 'criteri'
  | 'organ'
  | 'prolegomen'
  | 'hedr'
  | 'automat';
/** `(ax|test)is$` -> `es`. */
type AxisStem = 'ax' | 'test';

/** `(analy|diagno|…)(?:sis|ses)$` — the `-sis` family, which keeps its `sis`. */
type SisStem = 'analy' | 'diagno' | 'parenthe' | 'progno' | 'synop' | 'the' | 'empha' | 'cri' | 'ne';

/**
 * `-ves` plurals that restore an `f` or `fe`. These are endings, not whole words, so
 * `bookshelves` gives `bookshelf` and `housewives` gives `housewife` — but `archives`,
 * `olives` and `sieves` match none of them and fall through to the plain `s` drop, which is
 * the whole point of listing the stems rather than keying off `ves`.
 */
type VesToFStem = 'ar' | 'wol' | 'al' | 'el' | 'ea' | 'eo' | 'oa' | 'oo';
type VesToFeStem = 'wi' | 'kni';
/** The same rule's `\b`-anchored `li`, which is why `lives` is `life` but `olives` is `olive`. */
type LiWholeStem = 'li' | `${'after' | 'half' | 'high' | 'low' | 'mid' | 'night' | 'non'}li`;

/** `(cod|mur|sil|vert|ind)ices$` -> `ex` and `(matr|append)ices$` -> `ix`. */
type IcesToExStem = 'cod' | 'mur' | 'sil' | 'vert' | 'ind';
type IcesToIxStem = 'matr' | 'append';

/** Latin plurals whose singular no ending-based rule recovers. */
type LatinSingulars = {
  addenda: 'addendum';
  algae: 'alga';
  alumnae: 'alumna';
  alumni: 'alumnus';
  bacteria: 'bacterium';
  cacti: 'cactus';
  candelabra: 'candelabrum';
  cherubim: 'cherub';
  criteria: 'criterion';
  curricula: 'curriculum';
  data: 'datum';
  errata: 'erratum';
  foci: 'focus';
  fungi: 'fungus';
  millennia: 'millennium';
  nuclei: 'nucleus';
  ova: 'ovum';
  phenomena: 'phenomenon';
  radii: 'radius';
  seraphim: 'seraph';
  strata: 'stratum';
  syllabi: 'syllabus';
  symposia: 'symposium';
  termini: 'terminus';
  testes: 'testis';
  vertebrae: 'vertebra';
};

/**
 * Endings the rules above leave undecided and the plain `s` drop would get wrong — Latin
 * stems and the `-is` family, mostly. A word ending in one of these that matched nothing
 * earlier is left unresolved rather than guessed at.
 */
type UndecidedSingularEnding = 'a' | 'i' | 'ae' | 'im' | 'ice' | 'ren' | 'eaux' | 'is';

/**
 * The singular of a table key, as `pluralize.singular` would return it — or `string` where
 * these rules decline to decide. Matching is case-insensitive, and the word's interior case
 * survives (`auditLogs` -> `auditLog`); a whole-word match comes back lower case, which is
 * immaterial since every caller re-cases the first letter anyway.
 */
export type Singularize<S extends string> =
  Lowercase<S> extends Uncountable
    ? Lowercase<S>
    : EndsWith<S, UncountableEnding> extends true
      ? S
      : Lowercase<S> extends keyof IrregularPlurals
        ? Lowercase<S>
        : Lowercase<S> extends keyof IrregularSingulars
          ? IrregularSingulars[Lowercase<S>]
          : Lowercase<S> extends keyof LatinSingulars
            ? LatinSingulars[Lowercase<S>]
            : S extends `${infer A}men`
              ? `${A}man`
              : S extends `${infer A}s`
                ? SingularizeS<S, A>
                : S extends `${infer A}a`
                  ? SingularizeA<A>
                  : EndsWith<S, EsStem | EsClassStem> extends true
                    ? S
                    : EndsWith<S, UndecidedSingularEnding> extends true
                      ? Unresolved
                      : S;

/** The `…s` forks, in `pluralize`'s priority order, each testing a stem it has already split. */
type SingularizeS<S extends string, A extends string> =
  EndsWith<A, PlainSStem> extends true
    ? A
    : S extends `${infer B}ies`
      ? SingularizeIes<S, B>
      : EndsWith<S, 'ss'> extends true
        ? S
        : S extends `${infer B}ses`
          ? SingularizeSes<S, B>
          : S extends `${infer B}ves`
            ? SingularizeVes<B>
            : S extends `${infer B}ices`
              ? SingularizeIces<B>
              : S extends `${infer B}es`
                ? SingularizeEs<S, B>
                : S extends `${infer B}sis`
                  ? SingularizeSis<S, B>
                  : EndsWith<S, EsStem | EsClassStem> extends true
                    ? S
                    : EndsWith<S, UndecidedSingularEnding> extends true
                      ? Unresolved
                      : A;

/** `(analy|…)sis$` is already singular; any other `-sis` word the rules leave alone. */
type SingularizeSis<S extends string, A extends string> = EndsWith<A, SisStem> extends true ? S : Unresolved;

/** `(agend|…)a$` -> `um` and `(apheli|…)a$` -> `on`, both read as endings. */
type SingularizeA<A extends string> =
  EndsWith<A, AToOnStem> extends true ? `${A}on` : EndsWith<A, AToUmStem> extends true ? `${A}um` : Unresolved;

/** `…ies` -> `y`, `ie` or `ey`, following `pluralize`'s three competing `ies` rules. */
type SingularizeIes<S extends string, A extends string> =
  Lowercase<A> extends EyWholeStem
    ? `${A}ey`
    : Lowercase<A> extends IeWholeStem
      ? `${A}ie`
      : EndsWith<S, 'ss'> extends true
        ? S
        : `${A}y`;

/**
 * The `…ses` fork. `(analy|…)(?:sis|ses)$` restores that family's `sis`; anything else ending
 * in `ses` is an ordinary `es` plural (`houses`, `roses`, `statuses`) and is handed on.
 */
type SingularizeSes<S extends string, A extends string> =
  EndsWith<A, SisStem> extends true ? `${A}sis` : S extends `${infer B}es` ? SingularizeEs<S, B> : Unresolved;

/** The `…ves` fork: `f`/`fe` for the listed stems, an ordinary `e` for everything else. */
type SingularizeVes<A extends string> =
  Lowercase<A> extends LiWholeStem
    ? `${A}fe`
    : EndsWith<A, VesToFeStem> extends true
      ? `${A}fe`
      : EndsWith<A, VesToFStem> extends true
        ? `${A}f`
        : `${A}ve`;

/** The `…ices` fork: `ex`, `ix`, or — for `invoices` and its like — an ordinary `e`. */
type SingularizeIces<A extends string> =
  EndsWith<A, IcesToExStem> extends true ? `${A}ex` : EndsWith<A, IcesToIxStem> extends true ? `${A}ix` : `${A}ice`;

/** The `…es` fork: strip `es` for the stems that call for it, else drop the trailing `s`. */
type SingularizeEs<S extends string, A extends string> =
  EndsWith<A, EsStem | EsClassStem> extends true
    ? A
    : EndsWith<S, UndecidedSingularEnding> extends true
      ? Unresolved
      : `${A}e`;

// ── pluralization ───────────────────────────────────────────────────────────────

/** `([^aeiouy]|qu)y$` -> `ies`. A vowel before the `y` keeps it: `days`, not `daies`. */
type ConsonantBeforeY = Exclude<Letter, Vowel | 'y'>;
/** `(x|ch|ss|sh|zz)$` and `(alias|t[lm]as|gas|ris)$`, both -> `es`. */
type PluralEsStem = 'x' | 'ch' | 'ss' | 'sh' | 'zz' | 'alias' | 'gas' | 'ris' | `t${'l' | 'm'}as`;
/** `(her|at|gr)o$` -> `oes`. */
type OesStem = 'hero' | 'ato' | 'gro';
/** `(matr|cod|mur|sil|vert|ind|append)(?:ix|ex)$` -> `ices`. */
type IcesStem = 'matr' | 'cod' | 'mur' | 'sil' | 'vert' | 'ind' | 'append';
/** `(?:(kni|wi|li)fe|(ar|l|ea|eo|oa|hoo)f)$` -> `ves`. */
type FToVesStem = 'ar' | 'l' | 'ea' | 'eo' | 'oa' | 'hoo';
type FeToVesStem = 'kni' | 'wi' | 'li';
/** `(apheli|…|criteri|organ|…|automat)(?:a|on)$` -> `a`. */
type OnToAStem =
  | 'apheli'
  | 'hyperbat'
  | 'periheli'
  | 'asyndet'
  | 'noumen'
  | 'phenomen'
  | 'criteri'
  | 'organ'
  | 'prolegomen'
  | 'hedr'
  | 'automat';
/** `(alumn|syllab|vir|…|strat)(?:us|i)$` -> `i`, which outranks the `[^aou]us` -> `es` rule. */
type UsToIStem =
  | 'alumn'
  | 'syllab'
  | 'vir'
  | 'radi'
  | 'nucle'
  | 'fung'
  | 'cact'
  | 'stimul'
  | 'termin'
  | 'bacill'
  | 'foc'
  | 'uter'
  | 'loc'
  | 'strat';
/** `(seraph|cherub)(?:im)?$` -> `im`. */
type ImStem = 'seraph' | 'cherub';

/**
 * Endings `pluralize` handles with rules these types do not reproduce: the Latin `-a`/`-um`
 * and `-ae` stems, the `([^l]ias|[aeiou]las|[ejzr]as|[iu]am)$` rule that leaves `atlas`
 * alone, `(ax|test)is$`, and `eaux$`. Left unresolved, not guessed.
 */
type UndecidedPluralEnding = 'ae' | 'i' | 'ias' | 'las' | `${'i' | 'u'}am` | 'eaux';

/**
 * The plural of a table key, as `pluralize.plural` would return it — or `string` where these
 * rules decline to decide. A key that is already plural comes back unchanged, because
 * `pluralize`'s base rule is `s?$` -> `s` rather than a bare append.
 */
export type Pluralize<S extends string> =
  Lowercase<S> extends Uncountable
    ? Lowercase<S>
    : EndsWith<S, UncountableEnding> extends true
      ? S
      : Lowercase<S> extends keyof IrregularPlurals
        ? IrregularPlurals[Lowercase<S>]
        : Lowercase<S> extends keyof IrregularSingulars
          ? Lowercase<S>
          : Lowercase<S> extends keyof LatinSingulars
            ? Lowercase<S>
            : S extends `${infer A}m${'a' | 'e'}n`
              ? `${A}men`
              : S extends `${infer A}${'ix' | 'ex'}`
                ? PluralizeIxEx<S, A>
                : S extends `${infer A}${'i' | 'e' | 'o'}${'l' | 'n'}ey`
                  ? PluralizeEy<S, A>
                  : S extends `${infer A}${ConsonantBeforeY}y`
                    ? PluralizeY<S, A>
                    : S extends `${infer A}fe`
                      ? PluralizeFe<S, A>
                      : S extends `${infer A}f`
                        ? PluralizeF<S, A>
                        : S extends `${infer A}sis`
                          ? `${A}ses`
                          : S extends `${infer A}on`
                            ? PluralizeOn<S, A>
                            : S extends `${infer A}um`
                              ? PluralizeUm<A>
                              : S extends `${infer A}a`
                                ? PluralizeA<A>
                                : S extends `${infer A}is`
                                  ? PluralizeIs<A>
                                  : S extends `${infer A}us`
                                    ? PluralizeUs<S, A>
                                    : EndsWith<S, ImStem> extends true
                                      ? `${S}im`
                                      : EndsWith<S, UndecidedPluralEnding> extends true
                                        ? Unresolved
                                        : EndsWith<S, OesStem> extends true
                                          ? `${S}es`
                                          : EndsWith<S, PluralEsStem> extends true
                                            ? `${S}es`
                                            : S extends `${infer A}s`
                                              ? `${A}s`
                                              : `${S}s`;

/** Re-attaches the consonant the ending split off, so `category` -> `categories`. */
type PluralizeY<S extends string, A extends string> = S extends `${A}${infer C}y` ? `${A}${C}ies` : Unresolved;

/** `([^ch][ieo][ln])ey$` -> `ies`; any other `-ey` word falls through to the `y` rules. */
type PluralizeEy<S extends string, A extends string> =
  EndsWith<A, Exclude<Letter, 'c' | 'h'>> extends true
    ? S extends `${A}${infer Mid}ey`
      ? `${A}${Mid}ies`
      : Unresolved
    : `${S}s`;

/** `(kni|wi|li)fe$` -> `ves`; any other `-fe` word just takes an `s`. */
type PluralizeFe<S extends string, A extends string> = EndsWith<A, FeToVesStem> extends true ? `${A}ves` : `${S}s`;

/** `(ar|l|ea|eo|oa|hoo)f$` -> `ves`; `belief`, `roof` and `chef` take an `s`. */
type PluralizeF<S extends string, A extends string> = EndsWith<A, FToVesStem> extends true ? `${A}ves` : `${S}s`;

/** `(matr|cod|…|append)(?:ix|ex)$` -> `ices`; `prefix` and `apex` fall to the `x` -> `es` rule. */
type PluralizeIxEx<S extends string, A extends string> = EndsWith<A, IcesStem> extends true ? `${A}ices` : `${S}es`;

/** `(agend|…)um$` -> `a`; `album` and `aquarium` take an `s`. */
type PluralizeUm<A extends string> = EndsWith<A, AToUmStem> extends true ? `${A}a` : `${A}ums`;

/** A word already in its Latin `-a` plural stays put; `area` and `villa` take an `s`. */
type PluralizeA<A extends string> = EndsWith<A, AToUmStem | AToOnStem> extends true ? `${A}a` : `${A}as`;

/** `(ax|test)is$` -> `es`; every other `-is` word is left undecided. */
type PluralizeIs<A extends string> = EndsWith<A, AxisStem> extends true ? `${A}es` : Unresolved;

/** `(criteri|phenomen|…)on$` -> `a`; `session` and `icon` take an `s`. */
type PluralizeOn<S extends string, A extends string> = EndsWith<A, OnToAStem> extends true ? `${A}a` : `${S}s`;

/**
 * The two `-us` rules, in priority order: the Latin stems take `i` (`focus` -> `foci`), and
 * `[^aou]us` takes `es` (`bus` -> `buses`, `status` -> `statuses`). A `-us` word that is
 * neither — one with `a`, `o` or `u` before the `us` — just takes an `s`.
 */
type PluralizeUs<S extends string, A extends string> =
  EndsWith<A, UsToIStem> extends true ? `${A}i` : EndsWith<S, `${NotAOU}us`> extends true ? `${S}es` : `${S}s`;

/**
 * How a build's `typeNameMapper` decides the keys of the generated entity maps.
 *
 * - `false` — no mapper. Every noun is the table key itself and the one-row operations keep
 *   their `Single` suffix, which is exactly what these types described before singularization
 *   existed.
 * - `'singularize'` — the built-in preset, whose two nouns {@link Singularize} and
 *   {@link Pluralize} replicate. The one-row operations take the singular noun and no suffix.
 * - `'loose'` — a mapper function, whose output no type can know. Every noun widens to
 *   `string`, so the entity maps fall back to an index signature rather than naming fields the
 *   build does not publish.
 */
export type TypeNaming = 'singularize' | 'loose' | false;

/** The naming modes whose nouns a type can actually name. */
type KnownNaming = Exclude<TypeNaming, 'loose'>;

/** The noun the plural (set-of-rows) operations are named from. */
type PluralNoun<TNaming extends KnownNaming, TName extends string> = TNaming extends 'singularize'
  ? Pluralize<TName>
  : TName;

/** The noun the singular (one-row) operations and the object type are named from. */
type SingularNoun<TNaming extends KnownNaming, TName extends string> = TNaming extends 'singularize'
  ? Singularize<TName>
  : TName;

// `Uncapitalize<string>` does not reduce to `string`, and a key of that shape is not one
// TypeScript will build an index signature from — the map would come out empty. So the loose
// case is answered before the case transform rather than inside the noun.

/** The plural noun as a root field name starts — `users` in `usersAggregate`. */
export type LowerPlural<TNaming extends TypeNaming, TName extends string> = TNaming extends 'loose'
  ? string
  : Uncapitalize<PluralNoun<Extract<TNaming, KnownNaming>, TName>>;

/** The plural noun as a field name continues — `Users` in `createUsers`. */
export type UpperPlural<TNaming extends TypeNaming, TName extends string> = TNaming extends 'loose'
  ? string
  : Capitalize<PluralNoun<Extract<TNaming, KnownNaming>, TName>>;

/** The singular noun as a root field name starts — `user` in `user(where:)`. */
export type LowerSingular<TNaming extends TypeNaming, TName extends string> = TNaming extends 'loose'
  ? string
  : Uncapitalize<SingularNoun<Extract<TNaming, KnownNaming>, TName>>;

/** The singular noun as a type or field name continues — `User` in `UserFilters`. */
export type UpperSingular<TNaming extends TypeNaming, TName extends string> = TNaming extends 'loose'
  ? string
  : Capitalize<SingularNoun<Extract<TNaming, KnownNaming>, TName>>;

export type SingleSuffix<TNaming extends TypeNaming> = TNaming extends 'singularize'
  ? ''
  : TNaming extends 'loose'
    ? string
    : 'Single';
