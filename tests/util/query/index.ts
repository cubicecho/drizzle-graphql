import { Agent } from 'node:http';
import axios, { type AxiosError } from 'axios';

/**
 * Node's global agent keeps sockets alive between requests, and a Node HTTP server closes an
 * idle one after five seconds. A suite that pauses longer than that between requests — a slow
 * neighbouring test, a loaded CI runner — can hand axios a socket the server is closing at that
 * moment, which surfaces as a response-less ECONNRESET and a test asserting on `undefined`.
 * A fresh connection per request costs nothing here and takes the race away.
 */
const agent = new Agent({ keepAlive: false });

export class GraphQLClient {
  constructor(private url: string) {}

  /**
   * `variables` and `operationName` are parts of the GraphQL-over-HTTP request body, not
   * decoration: a real client sends its arguments as variables rather than interpolating
   * them into the document text, and names an operation whenever the document holds more
   * than one. Both default to the single-anonymous-operation shape existing callers use.
   */
  public queryGql = async (query: string, variables: Record<string, unknown> = {}, operationName?: string) => {
    try {
      const res = await axios.post(
        this.url,
        JSON.stringify({
          query: query,
          variables: variables,
          ...(operationName === undefined ? {} : { operationName }),
        }),
        {
          headers: {
            accept: 'application/graphql-response+json, application/json',
            'content-type': 'application/json',
          },
          httpAgent: agent,
        },
      );

      return res.data;
    } catch (e) {
      const err = e as AxiosError<any>;

      if (!err.response) {
        // No response at all — a transport failure, not a GraphQL error. Say so, rather than
        // returning `undefined` and letting the assertion report a mysterious missing body.
        throw new Error(`Drizzle-GraphQL test client: request to ${this.url} failed with ${err.code ?? err.message}`);
      }

      console.warn(err.status, err.response.data?.errors);
      return err.response.data;
    }
  };
}
