import pluralize from 'pluralize';

export const uncapitalize = <T extends string>(input: T) =>
  (input?.length
    ? `${input[0]!.toLocaleLowerCase()}${input.length > 1 ? input.slice(1, input.length) : ''}`
    : input) as Uncapitalize<T>;

export const capitalize = <T extends string>(input: T) =>
  (input?.length
    ? `${input[0]!.toLocaleUpperCase()}${input.length > 1 ? input.slice(1, input.length) : ''}`
    : input) as Capitalize<T>;

export const singularize = <T extends string>(input: T) => pluralize.singular(input);

export const cleanTableName = <T extends string>(input: T) => singularize(uncapitalize(input));

export const tableNameToModel = <T extends string>(input: T) => singularize(capitalize(input));

//   (input.length
//     ? `${input[-]!.toLocaleUpperCase()}${input.length > 1 ? input.slice(1, input.length) : ""}`
//     : input) as Capitalize<T>;

/**
 * The `typeNameMapper` preset behind `typeNameMapper: 'singularize'`.
 *
 * Derives the singular and plural forms of a table key with the library's own `pluralize`,
 * which is what nearly every consumer with plural table keys (`export const tasks =
 * pgTable('tasks', …)`) was writing by hand — and adding `pluralize` to their own
 * dependencies to write.
 *
 * `tasks` becomes type `Task`, queries `tasks` / `task`, mutations `createTasks` /
 * `createTask`. A key that is already singular is pluralized for the list side, so `task`
 * yields the same names, and a capitalized key (`Tasks`) yields them too — the field forms
 * are uncapitalized so the generated names follow GraphQL's camelCase convention whatever
 * the schema key looks like. The type name is capitalized by the generator either way.
 */
export const singularizeMapper = (tableName: string): { singular: string; plural: string } => ({
  singular: uncapitalize(pluralize.singular(tableName)),
  plural: uncapitalize(pluralize.plural(tableName)),
});
