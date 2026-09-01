/**
 * Matchers for graphql's own input-coercion validation errors.
 *
 * The suite runs against both graphql majors, and 17 reworded these messages: where 16 says
 * `Field "x" is not defined by type "T".`, 17 says `Expected value of type "T" not to include
 * unknown field "x", found: …`. The assertions care that the right field on the right type was
 * rejected, not which sentence the installed major phrases it in, so they match on the parts
 * the two wordings share.
 */

const quoteForRegex = (literal: string): string => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** An input field the type does not declare was supplied. */
export const unknownInputField = (field: string): RegExp =>
  new RegExp(`(?:Field "${quoteForRegex(field)}" is not defined|unknown field "${quoteForRegex(field)}")`, 'i');

/** A required input field was left out. */
export const missingRequiredInputField = (type: string, field: string): RegExp =>
  new RegExp(
    `(?:Field "${quoteForRegex(type)}\\.${quoteForRegex(field)}" of required type` +
      `|type "${quoteForRegex(type)}" to include required field "${quoteForRegex(field)}")`,
  );
