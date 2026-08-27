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
