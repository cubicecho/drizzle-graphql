// The cursor payload is a wire format: a client pages by handing back a string an earlier
// response gave it, so its bytes have to stay stable across releases. These pin the exact
// encoding rather than only the round trip, which would keep passing if both halves changed
// together and would silently invalidate every cursor already in flight.

import { describe, expect, it } from 'vitest';
import type { CursorOrderEntry } from '@/util/builders/common';
import { decodeCursor, encodeCursor } from '@/util/builders/common';

const entries: CursorOrderEntry[] = [
  ['createdAt', 'desc', 'last'],
  ['id', 'asc'],
];

describe('cursor encoding', () => {
  it('encodes a row to a stable string', () => {
    const cursor = encodeCursor(entries, { createdAt: new Date('2024-04-02T06:44:41.785Z'), id: 7 });

    expect(cursor).toBe(
      Buffer.from(
        '{"o":[["createdAt","desc","last"],["id","asc"]],"v":[{"$type":"date","value":"2024-04-02T06:44:41.785Z"},7]}',
        'utf8',
      ).toString('base64url'),
    );
  });

  it('round-trips the ordering values', () => {
    const row = { createdAt: new Date('2024-04-02T06:44:41.785Z'), id: 7n };

    expect(decodeCursor(encodeCursor(entries, row), entries)).toStrictEqual([row.createdAt, 7n]);
  });

  it('encodes a missing value as null', () => {
    expect(decodeCursor(encodeCursor(entries, { id: 7 }), entries)).toStrictEqual([null, 7]);
  });

  it('rejects a cursor issued for a different ordering', () => {
    const cursor = encodeCursor(entries, { createdAt: new Date(0), id: 1 });

    expect(() => decodeCursor(cursor, [['id', 'asc']])).toThrow(/different ordering/);
  });
});
