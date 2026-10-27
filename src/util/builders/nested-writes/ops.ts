import type { NestedWriteOp } from '../common/write-hooks.ts';

/** The nested operations of one mutation input, keyed by relation name. */
export type NestedOps = Record<string, Record<string, any>>;

/**
 * The request a nested write runs for. `context` drives the scope and the context values;
 * all three are what the target table's `onWrite` hooks are handed alongside the rows.
 */
export type NestedWriteRequest = { context?: any; args?: any; info?: any };

/**
 * The union of the relation names a batch of entries writes through — enough to decide which
 * join columns the whole batch's RETURNING clause needs, without inspecting each row's write.
 */
export const mergedOps = (entries: { ops: NestedOps }[]): NestedOps =>
  Object.assign({}, ...entries.map((entry) => entry.ops));

export const asArray = (value: any): any[] => (Array.isArray(value) ? value : supplied(value) ? [value] : []);

export const supplied = (value: any) => value !== undefined && value !== null;

/** The nested inputs whose operands are filters selecting target rows. */
export const FILTER_OPERATIONS = ['connect', 'disconnect', 'set'] as const;

/**
 * A relation's operations without the ones given as `null`. Every operation is a nullable
 * input field, and an explicit `null` means the same as leaving it out — so a `{ create: null }`
 * is the no-op `{}`, never a blank row.
 */
export const suppliedOps = (op: Record<string, any>): Record<string, any> =>
  Object.fromEntries(Object.entries(op).filter(([, value]) => supplied(value)));

/** The input that attaches a row to a to-one, which detaches whatever was attached before. */
export const attachingOp = (op: Record<string, any>): NestedWriteOp | undefined =>
  supplied(op['connect']) ? 'connect' : supplied(op['create']) ? 'create' : undefined;
