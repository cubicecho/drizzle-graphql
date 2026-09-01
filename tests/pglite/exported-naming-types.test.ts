import { describe, expectTypeOf, it } from 'vitest';
import type {
  BuildSchemaConfig,
  DerivedTypeNameMapper,
  GeneratedTypeInfo,
  GeneratedTypeKind,
  SelectionOptions,
  TypeNameMapper,
} from '@/index';

// Type-only: nothing here touches a database, so there is no setup/teardown.
//
// `typeNameMapper` and `derivedTypeNameMapper` are the only build hooks a consumer has to hand
// over a second time — once to `buildSchema`, and again to `selectionToWith` / `resolveSelection`,
// which can only find a selection in `fieldsByTypeName` if they resolve the same type names the
// build did. That means the value gets declared once and passed twice, which needs a name for its
// type; the hook types were declared in the published `.d.ts` but left off the export list, so
// naming one from outside the package was impossible (issue #116).
//
// A missing export is invisible from inside the package — every internal import goes to the
// defining module — so these assertions import from the package root on purpose. They stop
// compiling if any of the four names drops off `src/index.ts` again, and `npm run typecheck`
// (a CI step, over tests/tsconfig.json) is what makes that bite.

const names: Record<string, { singular: string; plural: string }> = {
  Users: { singular: 'user', plural: 'users' },
};

describe('Type-naming hooks are nameable from the package root', () => {
  it('one TypeNameMapper value satisfies both buildSchema and selectionToWith', () => {
    const typeNameMapper: TypeNameMapper = (tableName) => names[tableName];

    // The round trip the export exists for: declared once, accepted by both entry points.
    const buildConfig: BuildSchemaConfig = { typeNameMapper };
    const selectionOptions: Pick<SelectionOptions, 'typeNameMapper'> = { typeNameMapper };

    expectTypeOf(buildConfig.typeNameMapper).toEqualTypeOf<'singularize' | TypeNameMapper | undefined>();
    expectTypeOf(selectionOptions.typeNameMapper).toEqualTypeOf<TypeNameMapper | undefined>();
  });

  it('BuildSchemaConfig and SelectionOptions spell the mapper the same way', () => {
    expectTypeOf<NonNullable<SelectionOptions['typeNameMapper']>>().toEqualTypeOf<TypeNameMapper>();
    expectTypeOf<
      Exclude<BuildSchemaConfig['typeNameMapper'], 'singularize' | undefined>
    >().toEqualTypeOf<TypeNameMapper>();
  });

  it('one DerivedTypeNameMapper value satisfies both entry points too', () => {
    const derivedTypeNameMapper: DerivedTypeNameMapper = ({ kind, defaultName }) =>
      kind === 'filter' ? `${defaultName}Where` : undefined;

    const buildConfig: BuildSchemaConfig = { derivedTypeNameMapper };
    const selectionOptions: Pick<SelectionOptions, 'derivedTypeNameMapper'> = { derivedTypeNameMapper };

    expectTypeOf(buildConfig.derivedTypeNameMapper).toEqualTypeOf<DerivedTypeNameMapper | undefined>();
    expectTypeOf(selectionOptions.derivedTypeNameMapper).toEqualTypeOf<DerivedTypeNameMapper | undefined>();
  });

  it('the derived mapper argument and its kind union are exported alongside it', () => {
    expectTypeOf<Parameters<DerivedTypeNameMapper>[0]>().toEqualTypeOf<GeneratedTypeInfo>();
    expectTypeOf<GeneratedTypeInfo['kind']>().toEqualTypeOf<GeneratedTypeKind>();
  });
});
