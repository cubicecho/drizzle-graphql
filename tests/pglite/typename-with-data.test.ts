import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type Context, createCtx, setupServer, setupTables, teardownServer, teardownTables } from './common';

const DATA_DIR = `./tests/.temp/pgdata-typename-with-data-${Date.now()}`;

const ctx: Context = createCtx();

beforeAll(async () => {
  await setupServer(ctx, 4015, DATA_DIR);
});

afterAll(async () => {
  await teardownServer(ctx, DATA_DIR);
});

beforeEach(async () => {
  await setupTables(ctx);
});

afterEach(async () => {
  await teardownTables(ctx);
});

describe.sequential('__typename with data tests', async () => {
  it(`Select single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				user {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					__typename
				}

				post {
					id
					authorId
					content
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        user: {
          a: [1, 5, 10, 25, 40],
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          __typename: 'User',
        },
        post: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
          __typename: 'Post',
        },
      },
    });
  });

  it(`Select array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					__typename
				}

				posts {
					id
					authorId
					content
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            __typename: 'User',
          },
          {
            a: null,
            id: 2,
            name: 'SecondUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            __typename: 'User',
          },
          {
            a: null,
            id: 5,
            name: 'FifthUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            __typename: 'User',
          },
        ],
        posts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
            __typename: 'Post',
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            __typename: 'Post',
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            __typename: 'Post',
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            __typename: 'Post',
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            __typename: 'Post',
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            __typename: 'Post',
          },
        ],
      },
    });
  });

  it(`Select single with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				user {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					__typename
					posts {
						id
						authorId
						content
						__typename
					}
				}

				post {
					id
					authorId
					content
					__typename
					author {
						a
						id
						name
						email
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
						isConfirmed
						__typename
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        user: {
          a: [1, 5, 10, 25, 40],
          id: 1,
          name: 'FirstUser',
          email: 'userOne@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'FirstUserProf',
          initials: 'FU',
          isConfirmed: true,
          __typename: 'User',
          posts: [
            {
              id: 1,
              authorId: 1,
              content: '1MESSAGE',
              __typename: 'Post',
            },
            {
              id: 2,
              authorId: 1,
              content: '2MESSAGE',
              __typename: 'Post',
            },
            {
              id: 3,
              authorId: 1,
              content: '3MESSAGE',
              __typename: 'Post',
            },

            {
              id: 6,
              authorId: 1,
              content: '4MESSAGE',
              __typename: 'Post',
            },
          ],
        },
        post: {
          id: 1,
          authorId: 1,
          content: '1MESSAGE',
          __typename: 'Post',
          author: {
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            __typename: 'User',
          },
        },
      },
    });
  });

  it(`Select array with relations`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			{
				users {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					__typename
					posts {
						id
						authorId
						content
						__typename
					}
				}

				posts {
					id
					authorId
					content
					__typename
					author {
						a
						id
						name
						email
						birthdayString
						birthdayDate
						createdAt
						role
						roleText
						roleText2
						profession
						initials
						isConfirmed
						__typename
					}
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        users: [
          {
            a: [1, 5, 10, 25, 40],
            id: 1,
            name: 'FirstUser',
            email: 'userOne@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'FirstUserProf',
            initials: 'FU',
            isConfirmed: true,
            __typename: 'User',
            posts: [
              {
                id: 1,
                authorId: 1,
                content: '1MESSAGE',
                __typename: 'Post',
              },
              {
                id: 2,
                authorId: 1,
                content: '2MESSAGE',
                __typename: 'Post',
              },
              {
                id: 3,
                authorId: 1,
                content: '3MESSAGE',
                __typename: 'Post',
              },
              {
                id: 6,
                authorId: 1,
                content: '4MESSAGE',
                __typename: 'Post',
              },
            ],
          },
          {
            a: null,
            id: 2,
            name: 'SecondUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            __typename: 'User',
            posts: [],
          },
          {
            a: null,
            id: 5,
            name: 'FifthUser',
            email: null,
            birthdayString: null,
            birthdayDate: null,
            createdAt: '2024-04-02T06:44:41.785Z',
            role: null,
            roleText: null,
            roleText2: 'user',
            profession: null,
            initials: null,
            isConfirmed: null,
            __typename: 'User',
            posts: [
              {
                id: 4,
                authorId: 5,
                content: '1MESSAGE',
                __typename: 'Post',
              },
              {
                id: 5,
                authorId: 5,
                content: '2MESSAGE',
                __typename: 'Post',
              },
            ],
          },
        ],
        posts: [
          {
            id: 1,
            authorId: 1,
            content: '1MESSAGE',
            __typename: 'Post',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              __typename: 'User',
            },
          },
          {
            id: 2,
            authorId: 1,
            content: '2MESSAGE',
            __typename: 'Post',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              __typename: 'User',
            },
          },
          {
            id: 3,
            authorId: 1,
            content: '3MESSAGE',
            __typename: 'Post',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              __typename: 'User',
            },
          },
          {
            id: 4,
            authorId: 5,
            content: '1MESSAGE',
            __typename: 'Post',
            author: {
              a: null,
              id: 5,
              name: 'FifthUser',
              email: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:41.785Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
              __typename: 'User',
            },
          },
          {
            id: 5,
            authorId: 5,
            content: '2MESSAGE',
            __typename: 'Post',
            author: {
              a: null,
              id: 5,
              name: 'FifthUser',
              email: null,
              birthdayString: null,
              birthdayDate: null,
              createdAt: '2024-04-02T06:44:41.785Z',
              role: null,
              roleText: null,
              roleText2: 'user',
              profession: null,
              initials: null,
              isConfirmed: null,
              __typename: 'User',
            },
          },
          {
            id: 6,
            authorId: 1,
            content: '4MESSAGE',
            __typename: 'Post',
            author: {
              a: [1, 5, 10, 25, 40],
              id: 1,
              name: 'FirstUser',
              email: 'userOne@notmail.com',
              birthdayString: '2024-04-02',
              birthdayDate: '2024-04-02T00:00:00.000Z',
              createdAt: '2024-04-02T06:44:41.785Z',
              role: 'admin',
              roleText: null,
              roleText2: 'user',
              profession: 'FirstUserProf',
              initials: 'FU',
              isConfirmed: true,
              __typename: 'User',
            },
          },
        ],
      },
    });
  });

  it(`Insert single`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createUser(
					values: {
						a: [1, 5, 10, 25, 40]
						id: 3
						name: "ThirdUser"
						email: "userThree@notmail.com"
						birthdayString: "2024-04-02T06:44:41.785Z"
						birthdayDate: "2024-04-02T06:44:41.785Z"
						createdAt: "2024-04-02T06:44:41.785Z"
						role: admin
						roleText: null
						profession: "ThirdUserProf"
						initials: "FU"
						isConfirmed: true
					}
				) {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUser: {
          a: [1, 5, 10, 25, 40],
          id: 3,
          name: 'ThirdUser',
          email: 'userThree@notmail.com',
          birthdayString: '2024-04-02',
          birthdayDate: '2024-04-02T00:00:00.000Z',
          createdAt: '2024-04-02T06:44:41.785Z',
          role: 'admin',
          roleText: null,
          roleText2: 'user',
          profession: 'ThirdUserProf',
          initials: 'FU',
          isConfirmed: true,
          __typename: 'User',
        },
      },
    });
  });

  it(`Insert array`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				createUsers(
					values: [
						{
							a: [1, 5, 10, 25, 40]
							id: 3
							name: "ThirdUser"
							email: "userThree@notmail.com"
							birthdayString: "2024-04-02T06:44:41.785Z"
							birthdayDate: "2024-04-02T06:44:41.785Z"
							createdAt: "2024-04-02T06:44:41.785Z"
							role: admin
							roleText: null
							profession: "ThirdUserProf"
							initials: "FU"
							isConfirmed: true
						}
						{
							a: [1, 5, 10, 25, 40]
							id: 4
							name: "FourthUser"
							email: "userFour@notmail.com"
							birthdayString: "2024-04-04"
							birthdayDate: "2024-04-04T00:00:00.000Z"
							createdAt: "2024-04-04T06:44:41.785Z"
							role: user
							roleText: null
							roleText2: user
							profession: "FourthUserProf"
							initials: "SU"
							isConfirmed: false
						}
					]
				) {
					a
					id
					name
					email
					birthdayString
					birthdayDate
					createdAt
					role
					roleText
					roleText2
					profession
					initials
					isConfirmed
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        createUsers: [
          {
            a: [1, 5, 10, 25, 40],
            id: 3,
            name: 'ThirdUser',
            email: 'userThree@notmail.com',
            birthdayString: '2024-04-02',
            birthdayDate: '2024-04-02T00:00:00.000Z',
            createdAt: '2024-04-02T06:44:41.785Z',
            role: 'admin',
            roleText: null,
            roleText2: 'user',
            profession: 'ThirdUserProf',
            initials: 'FU',
            isConfirmed: true,
            __typename: 'User',
          },
          {
            a: [1, 5, 10, 25, 40],
            id: 4,
            name: 'FourthUser',
            email: 'userFour@notmail.com',
            birthdayString: '2024-04-04',
            birthdayDate: '2024-04-04T00:00:00.000Z',
            createdAt: '2024-04-04T06:44:41.785Z',
            role: 'user',
            roleText: null,
            roleText2: 'user',
            profession: 'FourthUserProf',
            initials: 'SU',
            isConfirmed: false,
            __typename: 'User',
          },
        ],
      },
    });
  });

  it(`Update`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				updateCustomers(set: { isConfirmed: true, address: "Edited" }) {
					id
					address
					isConfirmed
					registrationDate
					userId
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        updateCustomers: [
          {
            id: 1,
            address: 'Edited',
            isConfirmed: true,
            registrationDate: '2024-03-27T03:54:45.235Z',
            userId: 1,
            __typename: 'Customer',
          },
          {
            id: 2,
            address: 'Edited',
            isConfirmed: true,
            registrationDate: '2024-03-27T03:55:42.358Z',
            userId: 2,
            __typename: 'Customer',
          },
        ],
      },
    });
  });

  it(`Delete`, async () => {
    const res = await ctx.gql.queryGql(/* GraphQL */ `
			mutation {
				deleteCustomers {
					id
					address
					isConfirmed
					registrationDate
					userId
					__typename
				}
			}
		`);

    expect(res).toStrictEqual({
      data: {
        deleteCustomers: [
          {
            id: 1,
            address: 'AdOne',
            isConfirmed: false,
            registrationDate: '2024-03-27T03:54:45.235Z',
            userId: 1,
            __typename: 'Customer',
          },
          {
            id: 2,
            address: 'AdTwo',
            isConfirmed: false,
            registrationDate: '2024-03-27T03:55:42.358Z',
            userId: 2,
            __typename: 'Customer',
          },
        ],
      },
    });
  });
});
