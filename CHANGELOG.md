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
