import axios, { type AxiosError } from 'axios';

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
        },
      );

      return res.data;
    } catch (e) {
      const err = e as AxiosError<any>;

      console.warn(err.status, err.response?.data.errors);
      return err.response?.data;
    }
  };
}
