## [18.1.2](https://github.com/cubicecho/drizzle-graphql/compare/v18.1.1...v18.1.2) (2026-10-28)

### Bug Fixes

* hand MySQL string-mode bigint values to resolvers as strings ([baf20d9](https://github.com/cubicecho/drizzle-graphql/commit/baf20d93df8b0b4006edc377f0b108160949485b)), closes [#237](https://github.com/cubicecho/drizzle-graphql/issues/237)
* narrow Single writes on tables without a primary key by a unique key ([652ad2e](https://github.com/cubicecho/drizzle-graphql/commit/652ad2ec4467dedfd3619dbb93c39015c2d4f2c2)), closes [#230](https://github.com/cubicecho/drizzle-graphql/issues/230)
* page number-mode bigint columns by their exact value past 2^53 ([1374eef](https://github.com/cubicecho/drizzle-graphql/commit/1374eefd984e4af68be63bea687176e4068b726d)), closes [#237](https://github.com/cubicecho/drizzle-graphql/issues/237)
* page past a SQLite integer timestamp too large for a JS Date ([207ff47](https://github.com/cubicecho/drizzle-graphql/commit/207ff47eefe260337899a009f1566b7d4a1a51f4)), closes [#235](https://github.com/cubicecho/drizzle-graphql/issues/235)
* refuse a nested write that must match on a key a JS Date cannot hold ([a793737](https://github.com/cubicecho/drizzle-graphql/commit/a793737f35680c9bb31d443f3a593d0a7cb45ebb)), closes [#235](https://github.com/cubicecho/drizzle-graphql/issues/235)
* tiebreak every ordered list by primary key, not only cursor pages ([1b4c172](https://github.com/cubicecho/drizzle-graphql/commit/1b4c1720d3238dce00ac8d2102fe9ae6dc7a17bb)), closes [#236](https://github.com/cubicecho/drizzle-graphql/issues/236)

## [18.1.1](https://github.com/cubicecho/drizzle-graphql/compare/v18.1.0...v18.1.1) (2026-10-28)

### Bug Fixes

* keep the auto-transaction per execution, off the context ([264dd71](https://github.com/cubicecho/drizzle-graphql/commit/264dd71292465a65ec5302143de5fbc963cd2b08)), closes [#231](https://github.com/cubicecho/drizzle-graphql/issues/231)

## [18.1.0](https://github.com/cubicecho/drizzle-graphql/compare/v18.0.0...v18.1.0) (2026-10-28)

### Features

* accept null as no hook in onWrite ([92e6b78](https://github.com/cubicecho/drizzle-graphql/commit/92e6b780b39c37d038eb605210b6adc38180965d))
* register write hooks per operation ([efcf251](https://github.com/cubicecho/drizzle-graphql/commit/efcf2518b13ee81c190b0d8f078a8ef7872dad63))

### Bug Fixes

* refuse a nested upsert's bad onConflict before its before hook ([afec2cc](https://github.com/cubicecho/drizzle-graphql/commit/afec2ccbd2463d2b570efa69da991c5a1dbc7448))

## [18.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v17.0.2...v18.0.0) (2026-10-28)

### ⚠ BREAKING CHANGES

* a soft-deleting table whose `update` feature is off no
longer gets `restore<Table>` / `restore<Table>Single` mutations. The
README previously said they were generated regardless.
* Postgres array columns' object-type fields change from `[T!]`
to `[T]` (and `[[T!]!]` to `[[T]]` for two dimensions); create/update inputs
and array filters are unchanged.
* MySQL `decimal({ unsigned: true })` columns change from
`String` to `Decimal` in object fields, inputs and aggregates; their filter is
`DecimalFilter` instead of `StringFilter`, and with fieldUpdateOperations their
update field is `DecimalFieldUpdate`.
* `bigint({ mode: 'string' })` columns change from `String` to
`BigInt` in object fields, inputs, aggregates and arguments; their filter is
`BigIntFilter` instead of `StringFilter` (no `like`/`ilike`), and with
fieldUpdateOperations their update field is `BigIntFieldUpdate`.
* MySQL `int({ unsigned: true })` and `serial()` columns change
from `Int` to `Float` in object fields, create/update inputs, key arguments,
filters (`FloatFilter`), aggregates and field updates (`FloatFieldUpdate`).
* generatedAlwaysAs columns (PG, MySQL, SQLite) and PG
generatedAlwaysAsIdentity columns no longer appear in Create/Update/Upsert
inputs, nested-create payloads or the <Type>UpdateColumn conflict enum; the
soft-delete marker also leaves that conflict enum.

### Bug Fixes

* alias every column in the paginated many-to-many subquery ([88ab3e9](https://github.com/cubicecho/drizzle-graphql/commit/88ab3e9864875e55805b67ef55ab6e62431a610c))
* compare MySQL float operands at single precision ([acc7090](https://github.com/cubicecho/drizzle-graphql/commit/acc7090f3b8512f6c007f1bd06ded7aaf8249420))
* convert write arguments into a copy instead of in place ([e666285](https://github.com/cubicecho/drizzle-graphql/commit/e6662856eb84137a52e136fd4c3d9580caa740d7))
* decide field-update operations afresh on every build ([9eed1bc](https://github.com/cubicecho/drizzle-graphql/commit/9eed1bcfd7bc424e3a1d9f26109e5e23b339ea1a))
* detect relation orderBy entries when the target has a direction column ([8511ba5](https://github.com/cubicecho/drizzle-graphql/commit/8511ba55c819fa770eac2561ea3d4bedc8d00bc0))
* drop generated and identity-ALWAYS columns from write inputs ([ccead9f](https://github.com/cubicecho/drizzle-graphql/commit/ccead9ff5c03947948c06ee3c0ff87ec4a149ec6))
* fail a related row whose compared column is NULL in an every filter ([232a505](https://github.com/cubicecho/drizzle-graphql/commit/232a505a51069785ca1cb1cd8ace5704213c8dc0))
* gate nested many-to-many links on a soft-deleting junction's update ([c39e16f](https://github.com/cubicecho/drizzle-graphql/commit/c39e16f58e7c2a88a1dc9f3815315024565ef2a2))
* give resolveSelection's build-less read the dialect's NULL order and unique keys ([76d1b90](https://github.com/cubicecho/drizzle-graphql/commit/76d1b90e0be02eeab8f4f3062b85f1f0a09fd839))
* keep a failed relation re-fetch from rolling back a Postgres write ([fd16029](https://github.com/cubicecho/drizzle-graphql/commit/fd1602990cd15fa0614ced645cb2df6a8945efe2))
* keep NaN and Infinity in cursors ([cabdc7a](https://github.com/cubicecho/drizzle-graphql/commit/cabdc7ac6b4567c2b1a1db2afb97e16a53057310))
* key auto-transaction state on the execution ([2b8f816](https://github.com/cubicecho/drizzle-graphql/commit/2b8f8168205b3401f9a2737a3b8047c302d39785))
* key the per-request field memo and loaders on the execution ([b597f6f](https://github.com/cubicecho/drizzle-graphql/commit/b597f6fd3c6019d7396462797ab76a1d548a3190))
* leave pgvector sparsevec columns out of min / max aggregates ([7ac56b9](https://github.com/cubicecho/drizzle-graphql/commit/7ac56b95ac10fbf6f26e66708e909a819e0947cd))
* let Postgres array elements be null in output types ([ac71530](https://github.com/cubicecho/drizzle-graphql/commit/ac71530a9bbce67f015f15871c259931b51080cd))
* list and page rows whose mode date values a JS Date cannot hold ([68fd73e](https://github.com/cubicecho/drizzle-graphql/commit/68fd73eabadeda11411587a2e5932c4aba223880))
* match JSON path NUMBER and BOOLEAN reads only on that JSON type ([5e553b3](https://github.com/cubicecho/drizzle-graphql/commit/5e553b310c249bf5a07334ada16404b8e38a680e))
* match re-read self-referencing parent rows by keyString ([e7bc621](https://github.com/cubicecho/drizzle-graphql/commit/e7bc621f44860a0690097c529276d3ee1b712344))
* offer restore mutations only where the table allows updates ([77a94cb](https://github.com/cubicecho/drizzle-graphql/commit/77a94cb5c7c76729030a4408da85d98726cd85df))
* rank case-insensitive inArray matches under matchFilterOrder ([319222d](https://github.com/cubicecho/drizzle-graphql/commit/319222d226928d52b4f2c6864b764dcb1f3861dc))
* refuse a nested to-one attach that would leave two rows attached ([13bba3b](https://github.com/cubicecho/drizzle-graphql/commit/13bba3b6e29b1266c43767ac0fd46860de9bd894))
* refuse cursor values their column cannot hold ([b4afb6b](https://github.com/cubicecho/drizzle-graphql/commit/b4afb6ba7da08a494237022147c09e03514aa18c))
* refuse cursor values whose format their column cannot hold ([50a950a](https://github.com/cubicecho/drizzle-graphql/commit/50a950a561edb6ea648e0f4d0f8f8f6ed37b29f8))
* refuse invalid write arguments before the before hook on every path ([173dc70](https://github.com/cubicecho/drizzle-graphql/commit/173dc70433cad571c7a5c54e8e09b975770a8695))
* reject filters that match every row under requireWhere ([0104b4b](https://github.com/cubicecho/drizzle-graphql/commit/0104b4b867d0e64ec2d5bc69cd5941cdaf79685b))
* reject forged cursor values as DRIZZLE_INVALID_CURSOR ([4f372f3](https://github.com/cubicecho/drizzle-graphql/commit/4f372f303e1999f5ada08852f1b19f3fa853dce1))
* resolve a relation field's cursor to null under matchFilterOrder ([2c81c61](https://github.com/cubicecho/drizzle-graphql/commit/2c81c611524fdc602cbd76087bd5a07727573d0b))
* round lt and gte operands up on SQLite second timestamps ([88794fd](https://github.com/cubicecho/drizzle-graphql/commit/88794fd6247a8c582574775474a49514167d6fac))
* treat a null nested write operation as absent ([74edb4a](https://github.com/cubicecho/drizzle-graphql/commit/74edb4a144a9a227ce7c23e373cbfe6d3e94bd18))
* type bigint string mode as BigInt with number filters ([5f62d9c](https://github.com/cubicecho/drizzle-graphql/commit/5f62d9cc302b2047299210e9578138e3e2ec86fd))
* type MySQL unsigned decimal as Decimal ([ad64e04](https://github.com/cubicecho/drizzle-graphql/commit/ad64e04fd0d6e462706536413a72c3aa2c586ae0))
* type MySQL unsigned int and serial as Float ([4bef4a2](https://github.com/cubicecho/drizzle-graphql/commit/4bef4a2e930cecfa80bcfc02d1050bcf3f838011))
* write only the row a Single update/delete checked ([5dbb161](https://github.com/cubicecho/drizzle-graphql/commit/5dbb161720c707782a2f66abcb2cc02aa3f2ed7f))

## [17.0.2](https://github.com/cubicecho/drizzle-graphql/compare/v17.0.1...v17.0.2) (2026-10-27)

### Bug Fixes

* batch nested child-side writes across the parent rows of an update ([7752cc8](https://github.com/cubicecho/drizzle-graphql/commit/7752cc8256480b211f3f542341ad88123fb8fbab))
* run the distinct pass as a subquery instead of binding its keys ([b3cd30b](https://github.com/cubicecho/drizzle-graphql/commit/b3cd30b111a83c326c6737c8c90ec169589df3ff))

## [17.0.1](https://github.com/cubicecho/drizzle-graphql/compare/v17.0.0...v17.0.1) (2026-10-27)

### Bug Fixes

* keep a hidden key on an upsert's conflict branch, as update does ([73e9d7f](https://github.com/cubicecho/drizzle-graphql/commit/73e9d7f9287f68a69a8c0a3678c5f70aff0d753c)), closes [#222](https://github.com/cubicecho/drizzle-graphql/issues/222)
* let cursor pagination predicates use indexes ([5b7e27a](https://github.com/cubicecho/drizzle-graphql/commit/5b7e27af25102ba3d81232bf7203d42f07a31cd4))
* make schema build linear on cyclic relation graphs ([b88b542](https://github.com/cubicecho/drizzle-graphql/commit/b88b5423252cfa2d895e8d92aebe96e63485eb89))

## [17.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v16.0.1...v17.0.0) (2026-10-27)

### ⚠ BREAKING CHANGES

* with features.upsert and features.nestedWrites on, the
upsert mutations of a table with writable relations take
Upsert<Table>Input instead of Create<Table>Input. Clients that declare
the values variable by type name must switch to the new name.

### Features

* give upsert its own nested relation inputs ([f4b1df6](https://github.com/cubicecho/drizzle-graphql/commit/f4b1df600a5b800ed1c83d9930894e2fbf18e6ac)), closes [#219](https://github.com/cubicecho/drizzle-graphql/issues/219)

## [16.0.1](https://github.com/cubicecho/drizzle-graphql/compare/v16.0.0...v16.0.1) (2026-10-27)

### Bug Fixes

* alias SQLite numeric columns inside the window and distinct subqueries ([9a9409d](https://github.com/cubicecho/drizzle-graphql/commit/9a9409d97aebeca2617be749655555e316db0ae9))
* apply a junction's own scope and soft delete to many-to-many nested writes ([37711f1](https://github.com/cubicecho/drizzle-graphql/commit/37711f1fa1240fbb4e7ca60060e4ba25ac602234))
* bind MySQL date cursors as a calendar day so paging ends outside UTC ([49d6f36](https://github.com/cubicecho/drizzle-graphql/commit/49d6f36d91c3d0954183a129f1e842e414fda246))
* chunk the parent-key reads of nested writes over large updates ([f91b9a2](https://github.com/cubicecho/drizzle-graphql/commit/f91b9a2cfe5578486223bfe0f346f8ae9cf280a0))
* identifyRows only reports a complete target for a non-null key equality ([4493b0f](https://github.com/cubicecho/drizzle-graphql/commit/4493b0f840ab8e75267dce72a7d49592d6da430a))
* keep a many-to-many whose junction's NOT NULL column is stamped on insert ([9860d8c](https://github.com/cubicecho/drizzle-graphql/commit/9860d8c5f07a513f64ef46ed7bebb8b6a690d988))
* keep field update arithmetic exact on MySQL numerics and SQLite blob bigints ([79c48e2](https://github.com/cubicecho/drizzle-graphql/commit/79c48e26f4d353a4fd9235c5c54bb1f35d4bd4d6))
* keep MySQL onConflict NOTHING and select-builder scopes correct ([5afd6e1](https://github.com/cubicecho/drizzle-graphql/commit/5afd6e17968d3feec0e6ddb6b3ed76d15db95e58))
* match pattern escapes, case folding and JSON path quoting on SQLite ([8050fca](https://github.com/cubicecho/drizzle-graphql/commit/8050fca5527c6525606b1f7123d4442501f5f656))
* never rewrite a target's primary key from a shared-key one-to-one connect ([847dfc3](https://github.com/cubicecho/drizzle-graphql/commit/847dfc383a84e1d99c7bab214547047194e819f3))
* read a boolean branch that restricts nothing as matching every row ([98584b3](https://github.com/cubicecho/drizzle-graphql/commit/98584b39bfe4cf81fbde9a9bf4d321c876340373))
* read graphql 17 variables and fragment arguments correctly ([c0a7367](https://github.com/cubicecho/drizzle-graphql/commit/c0a7367c3f231e051ec5f9be9ae0bdca49ec9a21))
* read min/max like their column for MySQL enums and SQLite numeric bigints ([18f9f6e](https://github.com/cubicecho/drizzle-graphql/commit/18f9f6eeaaca7823b602905e94d6576077c6bee3))
* regroup MySQL relation rows by the key column's collation ([ea3babb](https://github.com/cubicecho/drizzle-graphql/commit/ea3babbd4b4751ffc70f572c257300ad1f25171b))
* stamp a 'string'-mode date soft-delete marker in the column's own text form ([9b004bf](https://github.com/cubicecho/drizzle-graphql/commit/9b004bf3fdec46c548978056fdf24d0fa48ee721))
* stamp a NOT NULL soft-delete marker's restored value on insert ([8234cc4](https://github.com/cubicecho/drizzle-graphql/commit/8234cc4532087661358ddac52a2bb8b6a0877432))
* tiebreak root list pages and relation distinct by primary key ([9d1f2e5](https://github.com/cubicecho/drizzle-graphql/commit/9d1f2e5a1147339e37b0bca2ce1a42dd27715384))
* treat offset 0 as no offset on every read path ([f700c9a](https://github.com/cubicecho/drizzle-graphql/commit/f700c9a54cae26724f47fe5dd739bfbc79a2776a))

## [16.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v15.1.6...v16.0.0) (2026-10-23)

### ⚠ BREAKING CHANGES

* with features.requireWhere on, an update<Table>Many entry
without a `where`, or with one that has no filters, is now rejected.
* on SQLite, `contains`, `startsWith`, `endsWith`, `like` and
`notLike` are case-sensitive. Queries that relied on SQLite's case folding
must use the `i`-prefixed operator or `insensitive: true`.
* SQLite `integer()` columns in number mode change from Int to
Float in output, create / update input, primary-key and unique-key argument,
filter (IntFilter -> FloatFilter), aggregate min / max, group-key and field
update (IntFieldUpdate -> FloatFieldUpdate) positions. Documents declaring an
Int variable for these fields must declare Float.
* <Type>OrderBy no longer has fields for JSON columns or SQLite blob bigint columns, and <Type>DistinctColumn no longer lists JSON columns. A query that ordered or made distinct on one is now a validation error, and defaults.orderBy naming one throws at build time.

### Bug Fixes

* allow MySQL writes filtered through a self-referencing relation ([84662c2](https://github.com/cubicecho/drizzle-graphql/commit/84662c27efebb72cc04ff36f3bef3ad42ce27f8a))
* append the primary-key tiebreak to an ordered eager relation page ([f5fc2d4](https://github.com/cubicecho/drizzle-graphql/commit/f5fc2d4a07be50b175bf199058ecb101ca1ffb06))
* apply a junction's scope and soft delete to relation fields and aggregates ([b981382](https://github.com/cubicecho/drizzle-graphql/commit/b981382a9322bcbc8f9236dfd69581fa687e55ed))
* apply features.requireWhere to update<Table>Many entries ([a53bd35](https://github.com/cubicecho/drizzle-graphql/commit/a53bd357a4eec553c9fd0af7f82a10c7e28a2c66))
* average as DOUBLE on MySQL so avg keeps its fraction ([4c8b2d7](https://github.com/cubicecho/drizzle-graphql/commit/4c8b2d7f37ad4117d88f7807d3b86f9cf9b05019))
* balance the key OR that narrows a distinct read ([5cbd1b7](https://github.com/cubicecho/drizzle-graphql/commit/5cbd1b7bf4c86d18402009126c12a9b19acdfde6))
* compare having operands as numeric on PostgreSQL ([f155d35](https://github.com/cubicecho/drizzle-graphql/commit/f155d35245bbb60574093132c3c9f0b9ee0b1503))
* compare whole JSON documents in eq / ne on every dialect ([abf9846](https://github.com/cubicecho/drizzle-graphql/commit/abf9846a6e19c0eb447666b8907e0f455afaa707))
* compile ilike and notIlike through lower() on MySQL and SQLite ([7c87f7e](https://github.com/cubicecho/drizzle-graphql/commit/7c87f7ef6487ac7b0d963a78e91b57b87d6a1b81))
* enforce a relation's own where on parent-side nested writes ([550bdf8](https://github.com/cubicecho/drizzle-graphql/commit/550bdf86cfd381042ae2ca7602c27c355765dc4f))
* keep JSON booleans apart from 1 / 0 in SQLite path filters ([a9a4648](https://github.com/cubicecho/drizzle-graphql/commit/a9a46486bfd10d5afc4cac31da7dcd9f9e75c061))
* key the per-request field memo on every merged field node ([1359667](https://github.com/cubicecho/drizzle-graphql/commit/1359667c8f8547f5b23b25941092d96aceb27bd9))
* leave JSON columns out of orderBy and distinct ([9d5ea3f](https://github.com/cubicecho/drizzle-graphql/commit/9d5ea3f93932aa7ccf6fbb19eb395096f9779365))
* leave types without a usable min / max out of min / max ([3bbfc8e](https://github.com/cubicecho/drizzle-graphql/commit/3bbfc8ea4a0590c20f716b6863488801a78c4081))
* make SQLite upserts on a partial unique index work ([44843a8](https://github.com/cubicecho/drizzle-graphql/commit/44843a8a79fc196a2b3f65a8a9b280e0de395879))
* match case in SQLite's case-sensitive pattern operators ([6eb9a23](https://github.com/cubicecho/drizzle-graphql/commit/6eb9a2390318d31c5518b365d75ba48583ab4fa1))
* name enum values and types GraphQL does not allow as written ([5ed08b7](https://github.com/cubicecho/drizzle-graphql/commit/5ed08b7506fd83e1f4838d7a93742c50802acc2e))
* omit an empty OrderBy and its orderBy argument ([ef5e3ab](https://github.com/cubicecho/drizzle-graphql/commit/ef5e3abb9192d56dbe5f052e6fa945a0713a23a5))
* page MySQL cursors over an ENUM by declaration order ([22bb9af](https://github.com/cubicecho/drizzle-graphql/commit/22bb9af4aae3b0000140d2960de45c431b358a7f))
* price an omitted limit at maxLimit when the policy sets only maxLimit ([a4dead0](https://github.com/cubicecho/drizzle-graphql/commit/a4dead0657021af6d533032ada198f7a5e877b17))
* read a SQLite blob holding 0 apart from a NULL one ([65e0337](https://github.com/cubicecho/drizzle-graphql/commit/65e03370a16f38f81dbcbcb5e11b56fdc78c4f2c))
* refuse onWrite on a synchronous SQLite driver ([96122f6](https://github.com/cubicecho/drizzle-graphql/commit/96122f67694f9301a827cce339ae6c052eadeeeb))
* return the join columns of lazily-resolved relations from writes ([10eb7dc](https://github.com/cubicecho/drizzle-graphql/commit/10eb7dc2dc874e2db22a30e592bdc75fa9068f8f))
* send a limit with an offset-only page on SQLite and MySQL ([13822de](https://github.com/cubicecho/drizzle-graphql/commit/13822de77d5d8ed600130fd6d94d3c4d60a70146))
* settle auto transactions on timeout overflow and uncoercible fields ([50d143c](https://github.com/cubicecho/drizzle-graphql/commit/50d143cbea827cadff07254a7cff0626648bfb95))
* skip only duplicate keys on a MySQL onConflict NOTHING ([5d300f1](https://github.com/cubicecho/drizzle-graphql/commit/5d300f19e1036a4882f421fb2481732ea0a68640))
* type SQLite integer columns as Float, not Int ([c6c7362](https://github.com/cubicecho/drizzle-graphql/commit/c6c73622d945d95af4c7f33dfce77a4860069ea3))
* write array, byte and geometric column values ([ddbba91](https://github.com/cubicecho/drizzle-graphql/commit/ddbba9109c5ae54e90cda5f48311bd753f6ab9df))

## [15.1.6](https://github.com/cubicecho/drizzle-graphql/compare/v15.1.5...v15.1.6) (2026-10-23)

### Bug Fixes

* correlate relation reads on the parent's stored join values ([dc52407](https://github.com/cubicecho/drizzle-graphql/commit/dc52407b1062ab64737177a6bdcd97a87e0442cf))
* keep a split upsert atomic on a synchronous SQLite driver ([879e3bb](https://github.com/cubicecho/drizzle-graphql/commit/879e3bb4bdd29806de1a1ac629da7c6746701fd9))
* split large relation batches and balance multi-column key conditions ([d01c70e](https://github.com/cubicecho/drizzle-graphql/commit/d01c70e375d46896098466ac4fdb7815d987e0fb))

## [15.1.5](https://github.com/cubicecho/drizzle-graphql/compare/v15.1.4...v15.1.5) (2026-10-23)

### Bug Fixes

* confine nested writes to the rows a relation shows and the caller can reach ([79b2dc1](https://github.com/cubicecho/drizzle-graphql/commit/79b2dc1472921e01ebcddbfbdb654584e7da9390))
* keep nested writes off relations keyed on a contextValues column ([925bbb2](https://github.com/cubicecho/drizzle-graphql/commit/925bbb2b66e40474166138ea0f5dafb633724b29))
* leave multi-column relations out of nested writes ([378c4a8](https://github.com/cubicecho/drizzle-graphql/commit/378c4a8c0ad60fccea05efae2aff5a29c06d4f3f))
* leave the soft-delete marker out of nested create payloads ([3b72321](https://github.com/cubicecho/drizzle-graphql/commit/3b7232157c14e4c95e11a500789f3932dc0ab5d7))
* require a child-side to-one connect to match exactly one row ([decc949](https://github.com/cubicecho/drizzle-graphql/commit/decc94982046b5baeb71249ec86adc0c8353fdba))
* roll back orphaned parent-side creates and return fresh rows ([f5e3bbd](https://github.com/cubicecho/drizzle-graphql/commit/f5e3bbde84680514314b935fd091d27636b35a12))

## [15.1.4](https://github.com/cubicecho/drizzle-graphql/compare/v15.1.3...v15.1.4) (2026-10-23)

### Bug Fixes

* read multi-column relations by every join column ([df6d272](https://github.com/cubicecho/drizzle-graphql/commit/df6d272cf5fdc708677e00d3a0b99e87b8fab14e))

## [15.1.3](https://github.com/cubicecho/drizzle-graphql/compare/v15.1.2...v15.1.3) (2026-10-23)

### Bug Fixes

* apply the build's row policies in resolveSelection and selectionToWith ([0c92e03](https://github.com/cubicecho/drizzle-graphql/commit/0c92e03ed348b532b164c947d6711881775f1a84))
* apply the target's scope and soft delete inside relation filters and relation ordering ([d74170e](https://github.com/cubicecho/drizzle-graphql/commit/d74170e6622170145708ab39d10fc27bb16ca5fc))
* reject a default ordering on an excluded column ([7c1f6b5](https://github.com/cubicecho/drizzle-graphql/commit/7c1f6b542414b4e2bd03f57dcf60e96c0ff4663f))

## [15.1.2](https://github.com/cubicecho/drizzle-graphql/compare/v15.1.1...v15.1.2) (2026-10-23)

### Bug Fixes

* an upsert's conflict branch writes only what an update would ([59468b2](https://github.com/cubicecho/drizzle-graphql/commit/59468b280b83b8c29151150d8da5d351fe437f10))
* identifyRows does not claim an upsert's keys are complete when it conflicts elsewhere ([e20d67b](https://github.com/cubicecho/drizzle-graphql/commit/e20d67bc3323368284d77cf6a307463b8ffc96db))

## [15.1.1](https://github.com/cubicecho/drizzle-graphql/compare/v15.1.0...v15.1.1) (2026-10-23)

### Bug Fixes

* bind false as a value for eq/ne and other value filter operators ([d6dcb49](https://github.com/cubicecho/drizzle-graphql/commit/d6dcb49fcf541bacdd2751fa7590571d80badb66))
* keep sub-millisecond precision in cursors over date-mode timestamps ([e0fe01c](https://github.com/cubicecho/drizzle-graphql/commit/e0fe01c74ad32df316f3ba53d736c24565fb9394))
* reject a negative limit or offset ([cb4dc21](https://github.com/cubicecho/drizzle-graphql/commit/cb4dc2100bf2d4180a3f342ff9e837205a98ab36))

## [15.1.0](https://github.com/cubicecho/drizzle-graphql/compare/v15.0.0...v15.1.0) (2026-10-23)

### Features

* pass the drizzle table to describeTable ([1fa68de](https://github.com/cubicecho/drizzle-graphql/commit/1fa68de93e1b0d2b62671c2101bcee2b2640b4de))

### Bug Fixes

* count many-to-many relation aggregates through the junction ([40c8ce3](https://github.com/cubicecho/drizzle-graphql/commit/40c8ce3a5b68a724f338d97df90c3dccbfc06b85))
* lazy relation fields honour junctions and a relation's own where ([fb43641](https://github.com/cubicecho/drizzle-graphql/commit/fb43641eb47b612afca68f0a10958ab8459cccf0))

## [15.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v14.0.0...v15.0.0) (2026-10-19)

### ⚠ BREAKING CHANGES

* smallint, smallserial, tinyint, mediumint and year
columns (and MySQL smallint) change from Float to Int in output, input
and filter positions (FloatFilter -> IntFilter). Documents declaring a
Float variable for these fields must declare Int, and a fractional input
is now rejected.
* for SQLite integer timestamp columns, fields, inputs and
min/max/group-key fields change from JSON to DateTime, and filters from
JSONFilter to DateTimeFilter (path is gone; lt/lte/gt/gte/inArray/notInArray
are new). Input must be an ISO-8601 date-time. Reads and stored values are
unchanged.
* MySQL `timestamp` / `datetime` fields change GraphQL type.
`mode: 'date'` columns go from `JSON` / `JSONFilter` to `DateTime` /
`DateTimeFilter`; `mode: 'string'` columns go from `String` /
`StringFilter` to `DateTime` / `DateTimeFilter`. Input must be an ISO 8601
date-time. A `mode: 'string'` column used to read `2026-09-15 10:00:00`
and now reads `2026-09-15T10:00:00.000Z`.
* date columns change GraphQL type. Inputs typed `String` or
`DateTime` and filters typed `StringFilter`, `DateTimeFilter` or `JSONFilter`
on a date column become `Date` and `DateFilter`. Datetime strings such as
`2026-09-15T00:00:00.000Z` sent to a date column used to be truncated to the
day and are now rejected. A `mode: 'date'` column reads `2026-09-15` instead
of `2026-09-15T00:00:00.000Z`. The exported `GraphQLDate` is now this
library's scalar; a column override using graphql-scalars' `GraphQLDate`
next to a natural date column fails to build (two types named `Date`).
Map `scalars: { Date: 'string' }` in graphql-codegen.

### Bug Fixes

* serialize Postgres string-mode timestamps as DateTime ([9b29fe5](https://github.com/cubicecho/drizzle-graphql/commit/9b29fe540c4044b5dd888843ac57707345fb140f)), closes [#193](https://github.com/cubicecho/drizzle-graphql/issues/193)
* support drizzle-orm rc.5 snapshots (omit undefined where, isFilterReversed, not() typing) ([cebc1e1](https://github.com/cubicecho/drizzle-graphql/commit/cebc1e184ac5f3548e01e75c1d625f8efb9ab24f)), closes [#186](https://github.com/cubicecho/drizzle-graphql/issues/186)
* type every date column as the Date scalar, in every position ([6e3b93d](https://github.com/cubicecho/drizzle-graphql/commit/6e3b93d0ee128e7e311d7acc747d67796be57d1c)), closes [#174](https://github.com/cubicecho/drizzle-graphql/issues/174)
* type MySQL timestamp and datetime columns as DateTime ([ecd4361](https://github.com/cubicecho/drizzle-graphql/commit/ecd436190145e863d3005356330a82132da1d38a)), closes [#188](https://github.com/cubicecho/drizzle-graphql/issues/188)
* type small integer columns and MySQL year as Int, not Float ([edf157f](https://github.com/cubicecho/drizzle-graphql/commit/edf157f355e5fbefd08112ddb7e71c3c6dd6e211)), closes [#195](https://github.com/cubicecho/drizzle-graphql/issues/195)
* type SQLite integer timestamp columns as DateTime ([61fc79b](https://github.com/cubicecho/drizzle-graphql/commit/61fc79ba927e3449126806e2b2a1996425124ec0)), closes [#194](https://github.com/cubicecho/drizzle-graphql/issues/194)
* unwrap drizzle rc.5 relation columns so relation aggregates and nested inputs are built ([ea20303](https://github.com/cubicecho/drizzle-graphql/commit/ea2030337fbe833d44a9ca4efa45eef4ecedf2ad)), closes [#179](https://github.com/cubicecho/drizzle-graphql/issues/179)

## [14.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v13.1.1...v14.0.0) (2026-10-19)

### ⚠ BREAKING CHANGES

* **nestedWrites:** with features.nestedWrites on, onWrite hooks registered on a
nested write's target (or junction) table now fire for the rows nested
writes create, attach, detach, link and unlink; previously only the root
field's table's hooks ran. A hook that should ignore them can return early
when `payload.nested` is set. Nested inputs whose target table has the
required insert / update / delete feature turned off (or whose junction table
is excluded) are now removed from the generated input types instead of
remaining writable, and a relation field with no input left is removed
entirely.

### Features

* **nestedWrites:** run the target table's onWrite hooks and follow its features ([bbbc033](https://github.com/cubicecho/drizzle-graphql/commit/bbbc033d8c65d373fa1ace3d4389f6fbf7b97d5e)), closes [#176](https://github.com/cubicecho/drizzle-graphql/issues/176)

## [13.1.1](https://github.com/cubicecho/drizzle-graphql/compare/v13.1.0...v13.1.1) (2026-10-19)

### Bug Fixes

* apply scope, softDelete, contextValues and onWrite to count mutations ([cfbb225](https://github.com/cubicecho/drizzle-graphql/commit/cfbb2251da2ceeb5b2e922a9ca6284036cf178af)), closes [#182](https://github.com/cubicecho/drizzle-graphql/issues/182)

## [13.1.0](https://github.com/cubicecho/drizzle-graphql/compare/v13.0.0...v13.1.0) (2026-10-18)

### Features

* add enumValueNameMapper for generated enum value names ([39b05fd](https://github.com/cubicecho/drizzle-graphql/commit/39b05fd0e73b7242ad76bf1f909a5fbedbe3999a)), closes [#178](https://github.com/cubicecho/drizzle-graphql/issues/178)
* **onWrite:** let an after hook name the columns its rows need ([18a4cec](https://github.com/cubicecho/drizzle-graphql/commit/18a4cecd8a2d18179865c58babd2ac1369c0f344)), closes [#177](https://github.com/cubicecho/drizzle-graphql/issues/177)

### Bug Fixes

* write NULL for an explicit null on a nullable column ([3d5e535](https://github.com/cubicecho/drizzle-graphql/commit/3d5e53531abf1313b9458f1621b4c33d2bde3e9d)), closes [#173](https://github.com/cubicecho/drizzle-graphql/issues/173)

## [13.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v12.0.1...v13.0.0) (2026-09-03)

### ⚠ BREAKING CHANGES

* under a `typeNameMapper`, the update/delete/restore mutations
are renamed. The list form takes the plural noun (`updateUser` -> `updateUsers`,
`deleteUser` -> `deleteUsers`) and the single form takes the singular noun with
no suffix (`updateUserSingle` -> `updateUser`, `deleteUserSingle` ->
`deleteUser`). Builds without a mapper keep every name they had.

### Features

* name update/delete/restore by arity, not by suffix ([2925759](https://github.com/cubicecho/drizzle-graphql/commit/29257594e92fc24531f8bfb749bb9245e4bc457c)), closes [#171](https://github.com/cubicecho/drizzle-graphql/issues/171)
* **types:** key the generated entities through the naming config ([9cfa99a](https://github.com/cubicecho/drizzle-graphql/commit/9cfa99a0b5af8f8ae73c3ed47b9cfaf921564ebb)), closes [#171](https://github.com/cubicecho/drizzle-graphql/issues/171)

## [12.0.1](https://github.com/cubicecho/drizzle-graphql/compare/v12.0.0...v12.0.1) (2026-09-03)

### Bug Fixes

* publish the internal write-builder refactors ([98f8ab3](https://github.com/cubicecho/drizzle-graphql/commit/98f8ab3f4ed1104fdf96ff12f80a205ba01df912)), closes [167-#170](https://github.com/cubicecho/167-/issues/170)

## [12.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v11.0.2...v12.0.0) (2026-09-03)

### ⚠ BREAKING CHANGES

* `BooleanFilter` and the generated `*EnumFilter`s no
longer accept the string pattern operators (`like`, `ilike`, `startsWith`,
`contains`, their `i`-prefixed forms, `insensitive`) or the ordering
operators (`lt`, `lte`, `gt`, `gte`); `DateTimeFilter` no longer accepts
the pattern operators. Sending one is now a validation error. `eq`, `ne`,
`inArray`, `notInArray`, `isNull`, `isNotNull`, `AND`/`OR`/`NOT` and
ordering on timestamps are unchanged.

### Features

* give each column type the filter operators it can actually use ([#166](https://github.com/cubicecho/drizzle-graphql/issues/166)) ([1bdf0bc](https://github.com/cubicecho/drizzle-graphql/commit/1bdf0bcb341a4ae4b510c7c335f9454003f04f1f))

## [11.0.2](https://github.com/cubicecho/drizzle-graphql/compare/v11.0.1...v11.0.2) (2026-09-03)

### Performance Improvements

* read only the columns a lazy relation selection needs ([#163](https://github.com/cubicecho/drizzle-graphql/issues/163)) ([2e69675](https://github.com/cubicecho/drizzle-graphql/commit/2e69675360c4c5805bd0d2809b65eb85ec8d25e9)), closes [#129](https://github.com/cubicecho/drizzle-graphql/issues/129)
* read only the keys a nested write uses ([#161](https://github.com/cubicecho/drizzle-graphql/issues/161)) ([bf81911](https://github.com/cubicecho/drizzle-graphql/commit/bf81911a032c9049b5ddcf46685b32b83decde9d)), closes [#147](https://github.com/cubicecho/drizzle-graphql/issues/147)

## [11.0.1](https://github.com/cubicecho/drizzle-graphql/compare/v11.0.0...v11.0.1) (2026-09-03)

### Performance Improvements

* parse a relation aggregate's selection once per request ([8b16e2a](https://github.com/cubicecho/drizzle-graphql/commit/8b16e2a6ac9e04bc27175f61c44c6a31ecbe4f38)), closes [#144](https://github.com/cubicecho/drizzle-graphql/issues/144)

## [11.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v10.0.3...v11.0.0) (2026-09-03)

### ⚠ BREAKING CHANGES

* builds that set a non-default `suffixes.list` get renamed list
mutations (`createUsers` → `createUsersAll` for `{ list: 'All' }`), and builds
that set `suffixes.single: ''` alongside a different `list` suffix get
`updateUsers`/`deleteUsers` where they had `updateUsersSingle`/`deleteUsersSingle`.
The default naming is unchanged. A naming config that puts two generated
operations on one field name now throws at build time instead of silently
dropping one of them.

### Bug Fixes

* apply both suffixes to the mutations, and catch name collisions ([8f06feb](https://github.com/cubicecho/drizzle-graphql/commit/8f06feb9b272e949546ec42d401862a161414e98)), closes [#155](https://github.com/cubicecho/drizzle-graphql/issues/155)

### Performance Improvements

* compute a relation field's loader key once per request ([d44e99f](https://github.com/cubicecho/drizzle-graphql/commit/d44e99f6a7f9cc22b5fd135ad92764b8a860c4eb)), closes [#132](https://github.com/cubicecho/drizzle-graphql/issues/132)

## [10.0.3](https://github.com/cubicecho/drizzle-graphql/compare/v10.0.2...v10.0.3) (2026-09-03)

### Performance Improvements

* group the parent's selections once in extractRelationsParams ([9078aee](https://github.com/cubicecho/drizzle-graphql/commit/9078aee9562e9470a1466a47588eaa77aeb76875)), closes [#141](https://github.com/cubicecho/drizzle-graphql/issues/141)

## [10.0.2](https://github.com/cubicecho/drizzle-graphql/compare/v10.0.1...v10.0.2) (2026-09-03)

### Performance Improvements

* hand out the narrowed relation filter context instead of rebuilding it ([f3e37d0](https://github.com/cubicecho/drizzle-graphql/commit/f3e37d0f528a881f56fc7d6dabd1ef676cc46c24)), closes [#148](https://github.com/cubicecho/drizzle-graphql/issues/148)

## [10.0.1](https://github.com/cubicecho/drizzle-graphql/compare/v10.0.0...v10.0.1) (2026-09-02)

### Bug Fixes

* pick a usable fallback column when a selection names none ([f9c37e1](https://github.com/cubicecho/drizzle-graphql/commit/f9c37e174fdcaa2dd43919f9e445e2fc92785b7b))

### Performance Improvements

* cache the dialect getTableConfig per table ([6f88b56](https://github.com/cubicecho/drizzle-graphql/commit/6f88b56127edd0eb6dfbbadec53baa9c377b9777))
* hoist per-request invariants out of hot paths ([fce00f2](https://github.com/cubicecho/drizzle-graphql/commit/fce00f22cbc3a98a234ca8b7965f0ad70bfbbbe3)), closes [#138](https://github.com/cubicecho/drizzle-graphql/issues/138) [#149](https://github.com/cubicecho/drizzle-graphql/issues/149) [#150](https://github.com/cubicecho/drizzle-graphql/issues/150) [#140](https://github.com/cubicecho/drizzle-graphql/issues/140) [#143](https://github.com/cubicecho/drizzle-graphql/issues/143) [#138](https://github.com/cubicecho/drizzle-graphql/issues/138) [#140](https://github.com/cubicecho/drizzle-graphql/issues/140) [#143](https://github.com/cubicecho/drizzle-graphql/issues/143) [#149](https://github.com/cubicecho/drizzle-graphql/issues/149) [#150](https://github.com/cubicecho/drizzle-graphql/issues/150)

## [10.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v9.1.1...v10.0.0) (2026-09-01)

### ⚠ BREAKING CHANGES

* **deps:** the `graphql` peer range is now `>=16.4.0`. It admits graphql
17, which the previous range excluded, but it also drops graphql 16.3.0 — the
vendored resolve-info parser calls `getArgumentValues`, which 16.3.0 exposes
only at an internal path. Consumers on 16.3.0 must move to 16.4.0 or later.
`graphql-parse-resolve-info` is no longer a peer dependency and can be removed
from consumer installs.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01DbQroMwKrEdCsANtuCn4Gv
* an update whose `set` gives a `NOT NULL` column an explicit
`null` now fails with `DRIZZLE_NOT_NULL` and writes nothing, where it
previously dropped the key and carried on. A client that serializes every
field of a form — sending `null` for the ones it is not changing — used to get
a partial write reported as a success and now gets an error on every such
update. To leave a column alone, omit it from the `set`; `null` means "write
null". Inserts, upserts and nested `create`s are unchanged: an explicit `null`
for a `NOT NULL` column that has a default still lets the default apply.

### Features

* **deps:** support graphql 17 and drop the graphql-parse-resolve-info peer ([66838e4](https://github.com/cubicecho/drizzle-graphql/commit/66838e45f8c166a1897551e7b168ea94f20947fd))
* vendor the resolve-info parser ([98b54ae](https://github.com/cubicecho/drizzle-graphql/commit/98b54aeae8dcc6a9fd08b5e9cf312152025e698a))

### Bug Fixes

* refuse an update that sets a NOT NULL column to null ([5e1be43](https://github.com/cubicecho/drizzle-graphql/commit/5e1be4347f5b07d0abdcb4f0b9c1f3941c23fd59)), closes [#119](https://github.com/cubicecho/drizzle-graphql/issues/119)

## [9.1.1](https://github.com/cubicecho/drizzle-graphql/compare/v9.1.0...v9.1.1) (2026-09-01)

### Bug Fixes

* **build:** pack from the root, and stop copying the manifest into dist ([b9fd7a2](https://github.com/cubicecho/drizzle-graphql/commit/b9fd7a2d0da0132f4be7e3e345eaa2f8f89f8c12)), closes [#123](https://github.com/cubicecho/drizzle-graphql/issues/123)
* **types:** point the CJS types condition at the file the build emits ([aece7a6](https://github.com/cubicecho/drizzle-graphql/commit/aece7a6cfeb78f63c16c9c07b159c77b6be9929d)), closes [#124](https://github.com/cubicecho/drizzle-graphql/issues/124)

## [9.1.0](https://github.com/cubicecho/drizzle-graphql/compare/v9.0.0...v9.1.0) (2026-09-01)

### Features

* export the type-naming hook types from the package root ([55af5df](https://github.com/cubicecho/drizzle-graphql/commit/55af5df18ebf714158bc57c86e90040d627ce889)), closes [#116](https://github.com/cubicecho/drizzle-graphql/issues/116)

## [9.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v8.2.1...v9.0.0) (2026-08-29)

### ⚠ BREAKING CHANGES

* **release:** the drizzle-orm peer range is `^1.0.0-rc.4`. rc.2 and rc.3 do
not work: rc.4 renamed `MySqlDatabase` to `MySqlAsyncDatabase` and
`BaseSQLiteDatabase` to `SQLiteAsyncDatabase`, dropped the MySQL `mode` option,
and removed the drizzle constructor's separate `schema` argument along with
`_.fullSchema`. This landed in 8.2.1 but was released as a patch because of the
preset bug above, so this release restates it at the correct version. The
`graphql` peer range is also now bounded below 17, since
`graphql-parse-resolve-info` — a required peer here — has no graphql 17 support.

### Bug Fixes

* **release:** detect breaking changes marked with `!` ([b3f2aa5](https://github.com/cubicecho/drizzle-graphql/commit/b3f2aa5ed0c5fe0e55613ce5712e4af8f7502fdf))
* **release:** pin the conventionalcommits preset to v9 ([ef264e8](https://github.com/cubicecho/drizzle-graphql/commit/ef264e8f05da0c9d3e6161970cf034cd7392ce0e))

## [8.2.1](https://github.com/cubicecho/drizzle-graphql/compare/v8.2.0...v8.2.1) (2026-08-28)


### Bug Fixes

* **deps:** bound the graphql peer below 17 ([4fe4135](https://github.com/cubicecho/drizzle-graphql/commit/4fe41354ff4592eb648e434d5ce64d21da76b5a2))

# [8.2.0](https://github.com/cubicecho/drizzle-graphql/compare/v8.1.0...v8.2.0) (2026-08-28)


### Features

* **deps:** admit graphql-scalars 2 in the peer range ([29a0bca](https://github.com/cubicecho/drizzle-graphql/commit/29a0bca6ef4d0fa41a58dbc9419e9ae728fae322))

# [8.1.0](https://github.com/cubicecho/drizzle-graphql/compare/v8.0.0...v8.1.0) (2026-08-28)


### Features

* **errors:** classify the value-coercion errors a client can hit ([5eed98c](https://github.com/cubicecho/drizzle-graphql/commit/5eed98c3de2d88fa9443f5d0fcadb7a88c570ece)), closes [#106](https://github.com/cubicecho/drizzle-graphql/issues/106)

# [8.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.9.1...v8.0.0) (2026-08-27)


### Bug Fixes

* name the real cause when a schema table is missing from the relations config ([564865d](https://github.com/cubicecho/drizzle-graphql/commit/564865dd927c964ebbf7f8a48d9804d192b4b122))
* **nested-writes:** keep nested payload types out of the root input namespace ([6b05817](https://github.com/cubicecho/drizzle-graphql/commit/6b05817c75a94bd068b22343c500ceb357a39ad3)), closes [#95](https://github.com/cubicecho/drizzle-graphql/issues/95)
* **soft-delete:** honour deletedValue on a nullable marker column ([91f1854](https://github.com/cubicecho/drizzle-graphql/commit/91f185447053b568665256d676d39cf6fc071588))
* **test:** pass buildRelations a config object, not a thunk ([a6ad560](https://github.com/cubicecho/drizzle-graphql/commit/a6ad56034a5777c08443477b78d5bb032835b1d9)), closes [#98](https://github.com/cubicecho/drizzle-graphql/issues/98)
* **types:** correct the public type surface and put tests/ under tsc ([f205642](https://github.com/cubicecho/drizzle-graphql/commit/f205642bfb0e5ff38e3102d50a199f5cdbea562e))


### Features

* **errors:** classify library errors with extensions.code and drizzle context ([c1d2eb7](https://github.com/cubicecho/drizzle-graphql/commit/c1d2eb7ff284baba9dd8bbd4f0f6b3199534982b)), closes [#92](https://github.com/cubicecho/drizzle-graphql/issues/92)
* **filters:** case-insensitive comparisons via an `insensitive` flag ([54675d0](https://github.com/cubicecho/drizzle-graphql/commit/54675d02236dc4c1f031ad7136b950b64d5d1ac0))
* **filters:** look a row up by a named compound unique constraint ([3f824aa](https://github.com/cubicecho/drizzle-graphql/commit/3f824aae6ac071a861419ab739f6e267dd01f462)), closes [#90](https://github.com/cubicecho/drizzle-graphql/issues/90)
* **naming:** let every derived type name be renamed, not just table types ([f56824a](https://github.com/cubicecho/drizzle-graphql/commit/f56824a665ddadd49d1f46251e82aa7249e505e8)), closes [#93](https://github.com/cubicecho/drizzle-graphql/issues/93)
* **soft-delete:** control whether relation fields are scoped ([78d129c](https://github.com/cubicecho/drizzle-graphql/commit/78d129c7f15b41e53b63679f49bf3022e0c54154))
* **soft-delete:** opt-in hard delete on a soft-deleting table ([417eca4](https://github.com/cubicecho/drizzle-graphql/commit/417eca4502f5003d502119923e5d990233757af7)), closes [#100](https://github.com/cubicecho/drizzle-graphql/issues/100)


### BREAKING CHANGES

* **nested-writes:** the nested-write payload input type is renamed from
`Create<Type><Relation>Input` to `<Type><Relation>NestedCreatePayloadInput`.
Only builds with `features.nestedWrites` on generate it; a document that names
the type (a variable declaration, a codegen artefact) has to be regenerated.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

## [7.9.1](https://github.com/cubicecho/drizzle-graphql/compare/v7.9.0...v7.9.1) (2026-08-27)


### Bug Fixes

* **types:** remove [@ts-nocheck](https://github.com/ts-nocheck) from src and repair the drizzle 1.0 type drift ([be7d678](https://github.com/cubicecho/drizzle-graphql/commit/be7d678e4efed3c90103e41c09607ec72cee5151))

# [7.9.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.8.0...v7.9.0) (2026-08-27)


### Features

* per-table default orderBy ([3830f15](https://github.com/cubicecho/drizzle-graphql/commit/3830f15f9500c9c781ccf1e2fd6d56b089d45018))

# [7.8.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.7.0...v7.8.0) (2026-08-27)


### Features

* `onWrite`, a hook that runs inside the mutation's transaction ([57a3cb8](https://github.com/cubicecho/drizzle-graphql/commit/57a3cb8521a0a0b2e7ea036a7be9da29f6f2a09f))
* **nested-writes:** write through many-to-many relations ([e07118b](https://github.com/cubicecho/drizzle-graphql/commit/e07118bc3c5020a28b8ce9c5196a590672230368)), closes [#77](https://github.com/cubicecho/drizzle-graphql/issues/77)

# [7.7.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.6.0...v7.7.0) (2026-08-27)


### Features

* soft delete, with restore mutations and a `deleted` read argument ([ce91e26](https://github.com/cubicecho/drizzle-graphql/commit/ce91e26c91e56e7486b456394b66313e1ec9b2cf))

# [7.6.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.5.0...v7.6.0) (2026-08-27)


### Features

* row scoping and server-owned column values ([e2d33fc](https://github.com/cubicecho/drizzle-graphql/commit/e2d33fcfe08fe194bb2af92aef7bc910e3f92a32))

# [7.5.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.4.0...v7.5.0) (2026-08-27)


### Features

* publish generated-field identity and export the selection translation ([fe75b2c](https://github.com/cubicecho/drizzle-graphql/commit/fe75b2c68501b3a51564809ffe57ffa7c21042f1)), closes [#69](https://github.com/cubicecho/drizzle-graphql/issues/69)

# [7.4.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.3.0...v7.4.0) (2026-08-27)


### Features

* per-table operation selection and a 'singularize' typeNameMapper preset ([db18b2d](https://github.com/cubicecho/drizzle-graphql/commit/db18b2d32b20acefa36a03065242371fbe8f8fdb))

# [7.3.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.2.0...v7.3.0) (2026-08-27)


### Features

* JSON path filters, list-order sorting and empty-list operators ([83262cb](https://github.com/cubicecho/drizzle-graphql/commit/83262cb2ae361123c6dfe8a4f7b8b053c46acfef)), closes [#61](https://github.com/cubicecho/drizzle-graphql/issues/61) [#73](https://github.com/cubicecho/drizzle-graphql/issues/73)

# [7.2.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.1.0...v7.2.0) (2026-08-27)


### Features

* exclude tables and columns from the generated schema ([58b1cd5](https://github.com/cubicecho/drizzle-graphql/commit/58b1cd5a297e0b6a87b60c59f0db494fa9262edf))

# [7.1.0](https://github.com/cubicecho/drizzle-graphql/compare/v7.0.0...v7.1.0) (2026-08-27)


### Features

* page-size limits for list queries and to-many relations ([fa61564](https://github.com/cubicecho/drizzle-graphql/commit/fa615643eea92c4fabe2285f194274a97d73e149)), closes [#46](https://github.com/cubicecho/drizzle-graphql/issues/46)

# [7.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v6.0.0...v7.0.0) (2026-08-26)


### Features

* atomic column updates, relation pagination parity, mutation return shapes ([723e83b](https://github.com/cubicecho/drizzle-graphql/commit/723e83bab6968276bf296081990f7b079c590168)), closes [#57](https://github.com/cubicecho/drizzle-graphql/issues/57) [#58](https://github.com/cubicecho/drizzle-graphql/issues/58) [#62](https://github.com/cubicecho/drizzle-graphql/issues/62)


### BREAKING CHANGES

* `createRelationResolverFactory` takes the dialect's null
ordering as its third argument, before `filterCtx` — `'nulls-largest'` for
PostgreSQL, `'nulls-smallest'` for MySQL and SQLite. The keyset predicate behind
a relation's `after` argument has to agree with the dialect's native `ORDER BY`
placement for `NULL`, or rows with a `NULL` in an ordered column are skipped
rather than paged through, and there is no correct default. Callers that build
custom relation resolvers must pass it.
* `create<Table>Single` returns `Table!` rather than `Table`
unless the `conflictDoNothing` option is set. Clients that spread the result into
a nullable position are unaffected, but a schema diff will show the change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

# [6.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v5.6.0...v6.0.0) (2026-08-26)


### Features

* documentation hooks, shared enum types, and nested writes ([434849a](https://github.com/cubicecho/drizzle-graphql/commit/434849a6f49a07e4c0dcf84d9c93a1926716a8a0)), closes [#59](https://github.com/cubicecho/drizzle-graphql/issues/59) [#60](https://github.com/cubicecho/drizzle-graphql/issues/60) [#56](https://github.com/cubicecho/drizzle-graphql/issues/56) [#59](https://github.com/cubicecho/drizzle-graphql/issues/59) [#60](https://github.com/cubicecho/drizzle-graphql/issues/60) [#56](https://github.com/cubicecho/drizzle-graphql/issues/56) [#55](https://github.com/cubicecho/drizzle-graphql/issues/55)


### BREAKING CHANGES

* a column backed by a named pgEnum now takes its GraphQL enum
type from the enum's own name rather than from the table and column, so
UsersRoleEnum becomes RoleEnum and is shared with every other table using that
enum. Pass enumNameMapper: (info) => info.enumName ?
`${info.tableName}${capitalize(info.columnName)}Enum` : undefined to restore the
previous names. Two different enums that previously produced two distinct type
names may now collide on one; that is reported as a build-time error.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>

# [5.6.0](https://github.com/cubicecho/drizzle-graphql/compare/v5.5.0...v5.6.0) (2026-08-26)


### Features

* **schema:** per-column scalar overrides via scalars map and mapColumnType ([0cd0ba6](https://github.com/cubicecho/drizzle-graphql/commit/0cd0ba6045850dabaefeb33d2164dbb572bcddab))

# [5.5.0](https://github.com/cubicecho/drizzle-graphql/compare/v5.4.0...v5.5.0) (2026-08-26)


### Features

* **mutations:** wrap multi-mutation requests in an automatic transaction ([4845f70](https://github.com/cubicecho/drizzle-graphql/commit/4845f70cdd90116b141098f5bc1e16c1f287eca3)), closes [#9](https://github.com/cubicecho/drizzle-graphql/issues/9)

# [5.4.0](https://github.com/cubicecho/drizzle-graphql/compare/v5.3.0...v5.4.0) (2026-08-26)


### Features

* **mutations:** add update<Table>Many batch update with per-row values ([a2f6ca7](https://github.com/cubicecho/drizzle-graphql/commit/a2f6ca713d775b34ec51518a71f79d8c128bf1cc)), closes [#26](https://github.com/cubicecho/drizzle-graphql/issues/26)

# [5.3.0](https://github.com/cubicecho/drizzle-graphql/compare/v5.2.0...v5.3.0) (2026-08-26)


### Features

* **query:** add cursor (keyset) pagination to list queries ([9317db6](https://github.com/cubicecho/drizzle-graphql/commit/9317db66e5c62cad730044aa681fe781e9ed00ed)), closes [#25](https://github.com/cubicecho/drizzle-graphql/issues/25)

# [5.2.0](https://github.com/cubicecho/drizzle-graphql/compare/v5.1.0...v5.2.0) (2026-08-26)


### Features

* **query:** add JSON and array column filter operators ([9b5e1b7](https://github.com/cubicecho/drizzle-graphql/commit/9b5e1b76142e29894c8e14b4aa441228dd998771))

# [5.1.0](https://github.com/cubicecho/drizzle-graphql/compare/v5.0.0...v5.1.0) (2026-08-26)


### Features

* **schema:** pick column filters by data type instead of column name ([3ec61ac](https://github.com/cubicecho/drizzle-graphql/commit/3ec61ac7c85382cceeb5e47b00508a603faa0d5c)), closes [#22](https://github.com/cubicecho/drizzle-graphql/issues/22)

# [5.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v4.2.0...v5.0.0) (2026-08-26)


* feat!: support recursive AND, NOT and OR boolean filter tree ([974ad87](https://github.com/cubicecho/drizzle-graphql/commit/974ad878c3cb0e0f4bc79864bd4260ae82ec6dcf))


### Bug Fixes

* **builders:** restore isFilterableRelation lost in through-relation merge ([9a36177](https://github.com/cubicecho/drizzle-graphql/commit/9a361778c22b50460d3137fc272397b6fa8a503c)), closes [throu#relation](https://github.com/throu/issues/relation) [#52](https://github.com/cubicecho/drizzle-graphql/issues/52) [#47](https://github.com/cubicecho/drizzle-graphql/issues/47)
* type string-array columns as [String!] and give them a String-typed filter ([30bebe3](https://github.com/cubicecho/drizzle-graphql/commit/30bebe35e78f19bd854963bb0d23e6c3b2a920fe)), closes [#15](https://github.com/cubicecho/drizzle-graphql/issues/15)


### Features

* add named Decimal scalar for numeric/decimal columns ([c5a4386](https://github.com/cubicecho/drizzle-graphql/commit/c5a4386168f8d041fa2e87298fcf405c7f9923cd)), closes [#17](https://github.com/cubicecho/drizzle-graphql/issues/17)
* **mutations:** add updateSingle/deleteSingle variants and requireWhere option ([ce2235a](https://github.com/cubicecho/drizzle-graphql/commit/ce2235a6b440065a8e6ee46fc9c5cac4352137c4)), closes [#24](https://github.com/cubicecho/drizzle-graphql/issues/24)
* orderBy through to-one relations and nulls first/last ([7f32433](https://github.com/cubicecho/drizzle-graphql/commit/7f32433b8e364c37bca1ac7ba4b7a965463b94a9))
* **query:** add injection-safe startsWith/endsWith/contains string operators ([df433de](https://github.com/cubicecho/drizzle-graphql/commit/df433de53b964be75b1969b7431ec35b3226b8c2))
* **query:** support relation filters for .through() many-to-many relations ([636e612](https://github.com/cubicecho/drizzle-graphql/commit/636e6122cf4afe2e7906619f1968d191ddbfa9da)), closes [#19](https://github.com/cubicecho/drizzle-graphql/issues/19)
* **schema:** emit non-null to-one relation fields for optional: false relations ([c5c94c2](https://github.com/cubicecho/drizzle-graphql/commit/c5c94c2dc54a7d521180418ce1e12972ac5b1eb7)), closes [#16](https://github.com/cubicecho/drizzle-graphql/issues/16)
* throw on unknown filter keys and operators instead of silently dropping them ([e80369e](https://github.com/cubicecho/drizzle-graphql/commit/e80369e4a3a30401cd577a42498b18137fae4e91)), closes [#18](https://github.com/cubicecho/drizzle-graphql/issues/18)


### BREAKING CHANGES

* the generated `${Table}FiltersOr` and `${Type}FilterOr`
input types no longer exist — `OR` branches now take the filter input
type itself. Operations that referenced those type names in variable
definitions must use the corresponding `${Table}Filters` /
`${Type}Filter` types instead. The "Cannot specify both fields and 'OR'"
errors are gone; siblings and `OR` now compose with an implicit AND.

# [4.2.0](https://github.com/cubicecho/drizzle-graphql/compare/v4.1.0...v4.2.0) (2026-08-26)


### Features

* **query:** add groupBy and having to aggregate queries ([#28](https://github.com/cubicecho/drizzle-graphql/issues/28)) ([c0308a9](https://github.com/cubicecho/drizzle-graphql/commit/c0308a9639bc215d5c08da103b6e68590754e235)), closes [#10](https://github.com/cubicecho/drizzle-graphql/issues/10)

# [4.1.0](https://github.com/cubicecho/drizzle-graphql/compare/v4.0.0...v4.1.0) (2026-08-26)


### Features

* **schema:** publish per-field complexity hints ([#14](https://github.com/cubicecho/drizzle-graphql/issues/14)) ([377410a](https://github.com/cubicecho/drizzle-graphql/commit/377410a976527aafdbb30490616ea931addf68c4)), closes [#11](https://github.com/cubicecho/drizzle-graphql/issues/11)

# [4.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v3.0.0...v4.0.0) (2026-08-26)


* fix(types)!: swap InsertResolver and InsertArrResolver shapes ([#13](https://github.com/cubicecho/drizzle-graphql/issues/13)) ([e0a776f](https://github.com/cubicecho/drizzle-graphql/commit/e0a776fd2d08b2e0aa8cf2fd42e29f6af09b3ea5)), closes [#12](https://github.com/cubicecho/drizzle-graphql/issues/12)


### BREAKING CHANGES

* `InsertResolver` and `InsertArrResolver` have swapped
meanings. Code annotating a single-row resolver with `InsertArrResolver`
(or an array resolver with `InsertResolver`) must swap the two.

# [3.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v2.0.0...v3.0.0) (2026-08-26)


* feat!: add a features toggle map and a context executor, fix SQLite conflicts ([79062b8](https://github.com/cubicecho/drizzle-graphql/commit/79062b8e010efefca02f2d1a481e691f8453fddd))
* feat(scalars)!: map json, bigint and uuid columns to real GraphQL scalars ([9411cc6](https://github.com/cubicecho/drizzle-graphql/commit/9411cc63de27b8572b50243f889cb409473db1c0))


### Features

* add aggregate queries (count/avg/sum/min/max) ([58474c7](https://github.com/cubicecho/drizzle-graphql/commit/58474c78f0a5e600b4e4beef76228a78ed18e776))
* **aggregates:** add per-column countNonNull and countDistinct ([ce049ac](https://github.com/cubicecho/drizzle-graphql/commit/ce049ace0e4356778458db9cf9bee90936dda98a))
* **aggregates:** aggregate a relation without fetching its rows ([2dcc4e6](https://github.com/cubicecho/drizzle-graphql/commit/2dcc4e6724af5e5be8cbd253e9d8a48548c5518a))
* **errors:** sanitize resolver errors by default and add an onError hook ([409ce84](https://github.com/cubicecho/drizzle-graphql/commit/409ce84919c40e5643adc850132a493d6baabf0c))
* **filters:** filter rows by their relations ([4e9425b](https://github.com/cubicecho/drizzle-graphql/commit/4e9425b306aeb79347896fb181c660b667870a37))
* **mutations:** add opt-in upsert with per-request conflict handling ([f993145](https://github.com/cubicecho/drizzle-graphql/commit/f9931456d07c4ee03f8eb94e26b76f76947ff38a))
* **queries:** default unordered paginated queries to primary key order ([e31b098](https://github.com/cubicecho/drizzle-graphql/commit/e31b09894fe7b0d17e72335b1d36bbe6dd476801))
* **query:** add distinct to list queries ([0b81595](https://github.com/cubicecho/drizzle-graphql/commit/0b81595283f4e7a620431a63894e6963a129f936))


### BREAKING CHANGES

* SQLite inserts no longer append `onConflictDoNothing()`
unconditionally. They honour `config.conflictDoNothing` like PostgreSQL does, so a
conflicting insert now raises an error by default instead of silently inserting
nothing. Set `conflictDoNothing: true` to keep the old behaviour.
* **errors:** database error messages are no longer surfaced to clients by
default. Pass `onError: (error) => error as Error` to restore the old behavior.
* json/jsonb columns (and `mode: 'json'` on SQLite/MySQL) now
read and write the parsed value instead of a JSON string. `{"a":1}` becomes
`{ a: 1 }` in responses, and mutations take a literal or variable rather than
a string of JSON.

# [2.0.0](https://github.com/cubicecho/drizzle-graphql/compare/v1.0.3...v2.0.0) (2026-08-13)


* feat!: replace singularTypes with typeNameMapper; change default mutation prefixes ([b65d44b](https://github.com/cubicecho/drizzle-graphql/commit/b65d44bf0358e66b44cce427f23368e14b6f1455))


### Bug Fixes

* batch per-parent paginated relations via window function ([0c74f9c](https://github.com/cubicecho/drizzle-graphql/commit/0c74f9c085120961c597b1ce38c8628da7ebbf79))
* default paginated relations to primary-key order for deterministic slices ([a0d4476](https://github.com/cubicecho/drizzle-graphql/commit/a0d447605f8140e791a726843ba0cf2c686defb6))
* deterministic pagination & efficient re-fetch for composite-PK relations ([7943dc6](https://github.com/cubicecho/drizzle-graphql/commit/7943dc6d2a82f3416df654e3139e81c92e2f75dc))
* don't guess a column named `id` as the primary key ([d8a4a55](https://github.com/cubicecho/drizzle-graphql/commit/d8a4a55ffc4a5cda6b4e666e2600d8ec78b4d64c))
* harden mutation eager-load against missing/bigint PKs and re-fetch failures ([133727b](https://github.com/cubicecho/drizzle-graphql/commit/133727bf177878e28c29ee2ba89feba2d1040a14))
* only preserve null for to-one relations in remap ([fe36c7c](https://github.com/cubicecho/drizzle-graphql/commit/fe36c7ce54fb278c559bb40bd39b5c47a7e4b72f))
* replace WeakMap<Object> with WeakMap<object> (noBannedTypes lint) ([99f614a](https://github.com/cubicecho/drizzle-graphql/commit/99f614ae38dc315c6ca4d6afd6d5340d564b6e1a))
* rewrite extractFiltersColumn switch as operator lookup maps ([c96ddc7](https://github.com/cubicecho/drizzle-graphql/commit/c96ddc7efae8db0cb101ded6d855f0bf8a39d7d5))
* tighten mutation eager-load and null-relation handling ([7b7a19c](https://github.com/cubicecho/drizzle-graphql/commit/7b7a19c5cec1a7cf67c4be768c00e26d29ae4c9a))
* validate equal suffixes regardless of relationsDepthLimit ([0df90be](https://github.com/cubicecho/drizzle-graphql/commit/0df90be6f731f67af00e7ae9e8ef431c19279309))


### Features

* add eagerLoadRelations config to opt relations out of `with:` prefetch ([a7e76b3](https://github.com/cubicecho/drizzle-graphql/commit/a7e76b3ca18a6f999c99f24fbcb39a3df1fe0342))
* eager-load mutation relations to avoid N+1 (incl. composite PKs) ([ca00098](https://github.com/cubicecho/drizzle-graphql/commit/ca0009824c8059b1742feb52a6748149b77627a8))
* export createRelationResolverFactory, RelationResolverFactory, extractRelationJoinColumns ([bd6df26](https://github.com/cubicecho/drizzle-graphql/commit/bd6df26cba38d954b5fd79acf325a04fd7d7f335))
* export TableNamedRelations; fix src/index.ts formatting ([e7449d4](https://github.com/cubicecho/drizzle-graphql/commit/e7449d46f8ca8bbae662f46617ed51844b579501))
* generate relation field resolvers with request-scoped N+1 batching ([daebede](https://github.com/cubicecho/drizzle-graphql/commit/daebede15709100c9cf8e1deb7fc120c95840b3b))


### Performance Improvements

* derive mutation primary-key columns once at build time ([7ccefd6](https://github.com/cubicecho/drizzle-graphql/commit/7ccefd68f22157739946de1913fd22c20bd26c9d))
* mutation eager-load refetches only the primary key + relations ([91e67aa](https://github.com/cubicecho/drizzle-graphql/commit/91e67aa4a9348596ba28bb5078ba646a76be6aee))


### BREAKING CHANGES

* default mutation names changed; singularTypes option removed

## [1.0.3](https://github.com/vantreeseba/drizzle-graphql/compare/v1.0.2...v1.0.3) (2026-05-06)


### Bug Fixes

* restore PG schema access for drizzle-orm v1 rc.2 ([ed07546](https://github.com/vantreeseba/drizzle-graphql/commit/ed07546470095303444e936ec82ce1b84221ef1c))

## [1.0.2](https://github.com/vantreeseba/drizzle-graphql/compare/v1.0.1...v1.0.2) (2026-05-06)


### Bug Fixes

* Remove dist from git, add to .gitignore ([e13cde0](https://github.com/vantreeseba/drizzle-graphql/commit/e13cde0663070b395893ed5141369a661b4312c7))

## [1.0.1](https://github.com/vantreeseba/drizzle-graphql/compare/v1.0.0...v1.0.1) (2026-05-05)


### Bug Fixes

* disable semantic-release GitHub PR/issue comments ([f8829f5](https://github.com/vantreeseba/drizzle-graphql/commit/f8829f5a3b3724b011fbdfd9934cf05d37080134)), closes [#9](https://github.com/vantreeseba/drizzle-graphql/issues/9)

# 1.0.0 (2026-05-05)


### Bug Fixes

* align type names, add drizzle-orm v1 relations support, and per-call type cache ([592965f](https://github.com/vantreeseba/drizzle-graphql/commit/592965f2f9ef0eca9684c68cf1b49971ba76232e))
* apply singularTypes/suffix options correctly in query name generation ([c2c4884](https://github.com/vantreeseba/drizzle-graphql/commit/c2c4884b7b79a53c01b89cc2d41e3a2e0a66f530))
* create tests/.temp directory before running tests in CI ([c0c4f6d](https://github.com/vantreeseba/drizzle-graphql/commit/c0c4f6d6345537fc8b0f3a00a43975250514f534))
* Fix drizzle kit version in package json. ([f4b9d8c](https://github.com/vantreeseba/drizzle-graphql/commit/f4b9d8c7d34835471e0e52c6f49500e0fb8d6e4a))
* Fix semver ~ to ^ on orm beta. ([c38aca7](https://github.com/vantreeseba/drizzle-graphql/commit/c38aca73d393f67ec615b1610a5f43abde1eb345))
* Force release. ([5137872](https://github.com/vantreeseba/drizzle-graphql/commit/5137872fcfb52e67640a066233c4c34e7c7bfa7a))
* Handle case where input undefined in case ops. ([ae0e737](https://github.com/vantreeseba/drizzle-graphql/commit/ae0e737fe5926be17e8b96fc39f2440e10b9cfff))
* resolve TypeScript type check errors ([160b07e](https://github.com/vantreeseba/drizzle-graphql/commit/160b07eac56a9f8a8a3367967d11866bac5b1257))
* Revert. ([da71f55](https://github.com/vantreeseba/drizzle-graphql/commit/da71f5516c84646fd7c855895ad7768d033a8bd8))
* use tsx to run build script instead of node ([c736bc4](https://github.com/vantreeseba/drizzle-graphql/commit/c736bc40101b6b5d8592f6525b38dd3e0a675d47))


### Features

* add singularTypes option to BuildSchemaConfig ([5ae8b2a](https://github.com/vantreeseba/drizzle-graphql/commit/5ae8b2a6c534faa927bba4374408807d39d65be3))
* export from TypeScript source, add graphql-scalars dependency ([633486b](https://github.com/vantreeseba/drizzle-graphql/commit/633486be96ff3bdef911f0e8bb740429b2152e90))
* input type names now reflect mutation prefix ([d00a06f](https://github.com/vantreeseba/drizzle-graphql/commit/d00a06f01bd0f5d2f2bd5d7224e9f59cf73c1090))
* Make graphql a peer dep. ([cfecb9e](https://github.com/vantreeseba/drizzle-graphql/commit/cfecb9e868f1031f0454adb47c21f99487e49ef4))
* merge philotes vendor fork changes ([17819c3](https://github.com/vantreeseba/drizzle-graphql/commit/17819c345eb9bbb89ed7b7a59c9748855c29631d))
* simplify GraphQL type names, add pluralize dep, consolidate relation helpers, and support PG array/date columns ([57711fc](https://github.com/vantreeseba/drizzle-graphql/commit/57711fcb62812f81055bf4b5cb35de81502776c3))
* upgrade to drizzle-orm 1.0.0-beta, fix package exports for CJS/ESM ([864630f](https://github.com/vantreeseba/drizzle-graphql/commit/864630fc6cabbc3b3cdddf7c634a6638edb10e84))
