import Promise from 'bluebird';
import config from 'config';
import { GraphQLBoolean, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { get, pick, uniq } from 'lodash';
import { isEmail } from 'validator';

import { roles } from '../../constants';
import { types as CollectiveTypes } from '../../constants/collectives';
import Algolia from '../../lib/algolia';
import { fetchCollectiveId } from '../../lib/cache';
import { getConsolidatedInvoicesData } from '../../lib/pdf';
import rawQueries from '../../lib/queries';
import { searchCollectivesByEmail, searchCollectivesInDB, searchCollectivesOnAlgolia } from '../../lib/search';
import { parseToBoolean, toIsoDateStr } from '../../lib/utils';
import models, { Op, sequelize } from '../../models';
import { Forbidden, NotFound, Unauthorized, ValidationFailed } from '../errors';

import { ApplicationType } from './Application';
import {
  CollectiveInterfaceType,
  CollectiveOrderFieldType,
  CollectiveSearchResultsType,
  HostCollectiveOrderFieldType,
  TypeOfCollectiveType,
} from './CollectiveInterface';
import { InvoiceInputType } from './inputTypes';
import {
  PaginatedTransactionsType,
  TransactionInterfaceType,
  TransactionOrder,
  TransactionType,
} from './TransactionInterface';
import {
  ExpenseStatusType,
  ExpenseType,
  InvoiceType,
  MemberInvitationType,
  MemberType,
  OrderByType,
  OrderDirectionType,
  OrderType,
  PaginatedExpensesType,
  PaymentMethodType,
  TierType,
  UpdateType,
  UserType,
} from './types';

const queries = {
  Collective: {
    type: CollectiveInterfaceType,
    args: {
      slug: { type: GraphQLString },
      id: { type: GraphQLInt },
      throwIfMissing: {
        type: GraphQLBoolean,
        defaultValue: true,
        description: 'If false, will return null instead of an error if collective is not found',
      },
    },
    resolve(_, args) {
      let collective;
      if (args.slug) {
        collective = models.Collective.findBySlug(args.slug.toLowerCase(), null, args.throwIfMissing);
      } else if (args.id) {
        collective = models.Collective.findByPk(args.id);
      } else {
        return new Error('Please provide a slug or an id');
      }
      if (!collective && args.throwIfMissing) {
        throw new NotFound('Collective not found');
      }
      return collective;
    },
  },

  Tier: {
    type: TierType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args) {
      return models.Tier.findByPk(args.id);
    },
  },

  LoggedInUser: {
    type: UserType,
    resolve(_, args, req) {
      return req.remoteUser;
    },
  },

  AuthenticatedUser: {
    type: CollectiveInterfaceType,
    resolve(_, args, req) {
      return models.Collective.findByPk(req.remoteUser.CollectiveId);
    },
  },

  allInvoices: {
    type: new GraphQLList(InvoiceType),
    args: {
      fromCollectiveSlug: { type: new GraphQLNonNull(GraphQLString) },
    },
    async resolve(_, args, req) {
      const fromCollective = await models.Collective.findOne({
        where: { slug: args.fromCollectiveSlug },
      });
      if (!fromCollective) {
        throw new NotFound('User or organization not found');
      }
      if (
        !req.remoteUser ||
        (!req.remoteUser.isAdmin(fromCollective.id) && !req.remoteUser.hasRole(roles.ACCOUNTANT, fromCollective.id))
      ) {
        throw new Unauthorized("You don't have permission to access invoices for this user");
      }

      const invoices = await getConsolidatedInvoicesData(fromCollective);

      return invoices;
    },
  },

  Invoice: {
    type: InvoiceType,
    deprecationReason: '2020-03-09: This field was deprecated after introducing InvoiceByDateRange',
    args: {
      invoiceSlug: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Slug of the invoice. Format: :year:2digitMonth.:hostSlug.:fromCollectiveSlug',
      },
    },
    async resolve(_, args, req) {
      const year = args.invoiceSlug.substr(0, 4);
      const month = args.invoiceSlug.substr(4, 2);
      const hostSlug = args.invoiceSlug.substring(7, args.invoiceSlug.lastIndexOf('.'));
      const fromCollectiveSlug = args.invoiceSlug.substr(args.invoiceSlug.lastIndexOf('.') + 1);
      if (!hostSlug || year < 2015 || month < 1 || month > 12) {
        throw new ValidationFailed(
          'Invalid invoiceSlug format. Should be :year:2digitMonth.:hostSlug.:fromCollectiveSlug',
        );
      }
      const fromCollective = await models.Collective.findOne({
        where: { slug: fromCollectiveSlug },
      });
      if (!fromCollective) {
        throw new NotFound(`User or organization not found for slug ${fromCollectiveSlug}`);
      }
      const host = await models.Collective.findBySlug(hostSlug);
      if (!host) {
        throw new NotFound('Host not found');
      }
      if (!req.remoteUser || !req.remoteUser.isAdmin(fromCollective.id)) {
        throw new Unauthorized("You don't have permission to access invoices for this user");
      }

      const startsAt = new Date(`${year}-${month}-01`);
      const endsAt = new Date(startsAt);
      endsAt.setMonth(startsAt.getMonth() + 1);

      const where = {
        [Op.or]: [
          { FromCollectiveId: fromCollective.id, UsingVirtualCardFromCollectiveId: null },
          { UsingVirtualCardFromCollectiveId: fromCollective.id },
        ],
        HostCollectiveId: host.id,
        createdAt: { [Op.gte]: startsAt, [Op.lt]: endsAt },
        type: 'CREDIT',
      };

      const order = [['createdAt', 'DESC']];
      const transactions = await models.Transaction.findAll({ where, order });
      if (transactions.length === 0) {
        throw new NotFound('No transactions found');
      }

      const invoice = {
        title: get(host, 'settings.invoiceTitle'),
        extraInfo: get(host, 'settings.invoice.extraInfo'),
        HostCollectiveId: host.id,
        slug: args.invoiceSlug,
        year,
        month,
      };
      let totalAmount = 0;
      transactions.map(transaction => {
        totalAmount += transaction.amountInHostCurrency;
        invoice.currency = transaction.hostCurrency;
      });
      invoice.FromCollectiveId = fromCollective.id;
      invoice.totalAmount = totalAmount;
      invoice.currency = invoice.currency || host.currency;
      invoice.transactions = transactions;
      return invoice;
    },
  },

  InvoiceByDateRange: {
    type: InvoiceType,
    deprecationReason: '2020-09-17: PDF service is now using the GQLV2 transactions endpoint',
    args: {
      invoiceInputType: {
        type: new GraphQLNonNull(InvoiceInputType),
        description:
          'Like the Slug of the invoice but spilt out into parts and includes dateFrom + dateTo for getting an invoice over a date range.',
      },
    },
    async resolve(_, args, req) {
      const { dateFrom, dateTo, fromCollectiveSlug, collectiveSlug } = args.invoiceInputType;

      if (!dateFrom || !dateTo) {
        throw new ValidationFailed('A valid date range must be provided');
      } else if (!fromCollectiveSlug || !collectiveSlug) {
        throw new ValidationFailed('You must provide a collective and a fromCollective');
      }

      const fromCollective = await models.Collective.findOne({
        where: { slug: fromCollectiveSlug },
      });
      if (!fromCollective) {
        throw new NotFound(`User or organization not found for slug ${args.fromCollective}`);
      }
      const host = await models.Collective.findBySlug(collectiveSlug);
      if (!host) {
        throw new NotFound('Host not found');
      }

      if (
        !req.remoteUser ||
        (!req.remoteUser.isAdmin(fromCollective.id) &&
          !req.remoteUser.hasRole(roles.ACCOUNTANT, fromCollective.id) &&
          !req.remoteUser.hasRole(roles.ACCOUNTANT, host.id))
      ) {
        throw new Unauthorized("You don't have permission to access invoices for this user");
      }

      if (dateTo < dateFrom) {
        throw new ValidationFailed('Invalid date object. dateFrom must be before dateTo');
      }

      const where = {
        [Op.or]: [
          { FromCollectiveId: fromCollective.id, UsingVirtualCardFromCollectiveId: null },
          { UsingVirtualCardFromCollectiveId: fromCollective.id },
        ],
        HostCollectiveId: host.id,
        createdAt: { [Op.gte]: dateFrom, [Op.lte]: dateTo },
        type: 'CREDIT',
      };

      const order = [['createdAt', 'DESC']];
      const transactions = await models.Transaction.findAll({ where, order });

      const invoice = {
        title: get(host, 'settings.invoiceTitle'),
        extraInfo: get(host, 'settings.invoice.extraInfo'),
        HostCollectiveId: host.id,
        FromCollectiveId: fromCollective.id,
        dateFrom: dateFrom,
        dateTo: dateTo,
        currency: host.currency,
        totalAmount: 0,
        transactions: transactions,
      };

      transactions.forEach(transaction => {
        invoice.currency = transaction.hostCurrency;
        invoice.totalAmount += transaction.amountInHostCurrency;
      });

      return invoice;
    },
  },

  /**
   * Get an invoice for a single transaction.
   * As we consider `uuid` to be private, we intentionally don't protect the
   * call so the URL can be sent easily.
   */
  TransactionInvoice: {
    type: InvoiceType,
    args: {
      transactionUuid: {
        type: new GraphQLNonNull(GraphQLString),
        description: 'Slug of the transaction.',
      },
    },
    async resolve(_, args) {
      // Fetch transaction
      const transaction = await models.Transaction.findOne({
        where: { uuid: args.transactionUuid },
      });

      if (!transaction) {
        throw new NotFound(`Transaction ${args.transactionUuid} doesn't exists`);
      }

      // If using a virtualcard, then billed collective will be the emitter
      const fromCollectiveId = transaction.paymentMethodProviderCollectiveId();

      // Load transaction host
      transaction.host = await transaction.getHostCollective();

      // Get total in host currency
      const totalAmountInHostCurrency =
        transaction.type === 'CREDIT' ? transaction.amount : transaction.netAmountInCollectiveCurrency * -1;

      const createdAtString = toIsoDateStr(transaction.createdAt ? new Date(transaction.createdAt) : new Date());
      // Generate invoice
      const invoice = {
        title: get(transaction.host, 'settings.invoiceTitle'),
        extraInfo: get(transaction.host, 'settings.invoice.extraInfo'),
        HostCollectiveId: get(transaction.host, 'id'),
        slug: `${transaction.host.name}_${createdAtString}_${args.transactionUuid}`,
        currency: transaction.hostCurrency,
        FromCollectiveId: fromCollectiveId,
        totalAmount: totalAmountInHostCurrency,
        transactions: [transaction],
        year: transaction.createdAt.getFullYear(),
        month: transaction.createdAt.getMonth() + 1,
        day: transaction.createdAt.getDate(),
      };

      return invoice;
    },
  },

  /*
   * Given a collective slug or id, returns all its transactions
   */
  allTransactions: {
    type: new GraphQLList(TransactionInterfaceType),
    description: `
    Given a collective, returns all its transactions:
    - Debit transactions made by collective without using a virtual card
    - Debit transactions made using a virtual card from collective
    - Credit transactions made to collective
    `,
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      type: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      dateFrom: { type: GraphQLString },
      dateTo: { type: GraphQLString },
      /** @deprecated since 2018-11-29: Virtual cards now included by default when necessary */
      includeVirtualCards: { type: GraphQLBoolean },
      includeExpenseTransactions: {
        type: GraphQLBoolean,
        default: true,
        description: 'If false, only the transactions not linked to an expense (orders/refunds) will be returned',
      },
      fetchDataFromLedger: { type: GraphQLBoolean }, // flag to go with either api or ledger transactions
      includeHostedCollectivesTransactions: {
        type: GraphQLBoolean,
      } /** flag to determine
        whether we should include the transactions of the collectives of that host(if it's a host collective) */,
    },
    async resolve(_, args) {
      // Load collective
      const { CollectiveId, collectiveSlug } = args;
      if (!CollectiveId && !collectiveSlug) {
        throw new Error('You must specify a collective ID or a Slug');
      }
      const where = CollectiveId ? { id: CollectiveId } : { slug: collectiveSlug };
      const collective = await models.Collective.findOne({ where });
      if (!collective) {
        throw new Error('This collective does not exist');
      }

      return collective.getTransactions({
        order: [['createdAt', 'DESC']],
        type: args.type,
        limit: args.limit,
        offset: args.offset,
        startDate: args.dateFrom,
        endDate: args.dateTo,
        includeExpenseTransactions: args.includeExpenseTransactions,
      });
    },
  },

  /*
   * Returns all transactions
   */
  transactions: {
    type: PaginatedTransactionsType,
    args: {
      limit: {
        defaultValue: 100,
        description: 'Defaults to 100',
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
      orderBy: {
        defaultValue: TransactionOrder.defaultValue,
        type: TransactionOrder,
      },
      type: {
        description: 'CREDIT or DEBIT are accepted values',
        type: TransactionType,
      },
    },
    async resolve(_, args) {
      const { limit, offset, orderBy, type } = args;
      const query = {
        limit,
        offset,
        order: [Object.values(orderBy)],
        where: {},
      };

      if (type) {
        query.where = { type };
      }

      const [total, transactions] = await Promise.all([
        models.Transaction.count({ where: query.where }),
        models.Transaction.findAll(query),
      ]);

      return {
        limit,
        offset,
        total,
        transactions,
      };
    },
  },

  Update: {
    type: UpdateType,
    args: {
      collectiveSlug: { type: GraphQLString },
      updateSlug: { type: GraphQLString },
      id: { type: GraphQLInt },
    },
    async resolve(_, args) {
      if (args.id) {
        return models.Update.findByPk(args.id);
      }
      const CollectiveId = await fetchCollectiveId(args.collectiveSlug);
      return models.Update.findOne({
        where: { CollectiveId, slug: args.updateSlug },
      });
    },
  },

  Application: {
    type: ApplicationType,
    args: {
      id: { type: GraphQLInt },
    },
    async resolve(_, args) {
      if (args.id) {
        return models.Application.findByPk(args.id);
      } else {
        return new Error('Please provide an id.');
      }
    },
  },

  /*
   * Given an ExpenseId or an UpdateId, returns all comments
   */
  allComments: {
    type: new GraphQLList(UpdateType),
    args: {
      ExpenseId: { type: GraphQLInt },
      UpdateId: { type: GraphQLInt },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve(_, args) {
      const query = { where: {} };
      if (args.ExpenseId) {
        query.where.ExpenseId = args.ExpenseId;
      }
      if (args.UpdateId) {
        query.where.UpdateId = args.UpdateId;
      }
      if (args.limit) {
        query.limit = args.limit;
      }
      if (args.offset) {
        query.offset = args.offset;
      }
      query.order = [['createdAt', 'ASC']];
      return models.Comment.findAll(query);
    },
  },

  /*
   * Given a collective slug, returns all updates
   */
  allUpdates: {
    type: new GraphQLList(UpdateType),
    args: {
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      includeHostedCollectives: { type: GraphQLBoolean },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    resolve(_, args, req) {
      const query = { where: {} };
      if (args.limit) {
        query.limit = args.limit;
      }
      if (args.offset) {
        query.offset = args.offset;
      }
      query.order = [
        ['publishedAt', 'DESC'],
        ['createdAt', 'DESC'],
      ];
      if (!req.remoteUser || !req.remoteUser.isAdmin(args.CollectiveId)) {
        query.where.publishedAt = { [Op.ne]: null };
      }
      return req.loaders.Collective.byId.load(args.CollectiveId).then(collective => {
        if (!collective) {
          throw new Error('Collective not found');
        }
        const getCollectiveIds = () => {
          // if is host, we get all the updates across all the hosted collectives
          if (args.includeHostedCollectives) {
            return models.Member.findAll({
              where: {
                MemberCollectiveId: collective.id,
                role: 'HOST',
              },
            }).map(member => member.CollectiveId);
          } else {
            return Promise.resolve([args.CollectiveId]);
          }
        };
        return getCollectiveIds().then(collectiveIds => {
          query.where.CollectiveId = { [Op.in]: collectiveIds };
          return models.Update.findAll(query);
        });
      });
    },
  },

  /*
   * Given a collective slug, returns all orders
   */
  allOrders: {
    type: new GraphQLList(OrderType),
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      includeHostedCollectives: { type: GraphQLBoolean },
      status: {
        type: GraphQLString,
        description: 'Filter by status (PAID, PENDING, ERROR, ACTIVE, CANCELLED)',
      },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args) {
      const query = { where: {} };
      const CollectiveId = args.CollectiveId || (await fetchCollectiveId(args.collectiveSlug));
      if (args.status) {
        query.where.status = args.status;
      }
      if (args.category) {
        query.where.category = { [Op.iLike]: args.category };
      }
      if (args.limit) {
        query.limit = args.limit;
      }
      if (args.offset) {
        query.offset = args.offset;
      }
      query.order = [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
      ];
      const getCollectiveIds = async () => {
        // if is host, we get all the orders across all the hosted collectives
        if (args.includeHostedCollectives) {
          return [
            CollectiveId,
            ...(await models.Member.findAll({
              attributes: ['CollectiveId'],
              where: {
                MemberCollectiveId: CollectiveId,
                role: 'HOST',
              },
            }).map(member => member.CollectiveId)),
          ];
        } else {
          return Promise.resolve([CollectiveId]);
        }
      };
      return getCollectiveIds().then(collectiveIds => {
        query.where.CollectiveId = { [Op.in]: collectiveIds };
        return models.Order.findAll(query);
      });
    },
  },

  /*
   * Given a collective slug, returns all expenses
   */
  allExpenses: {
    type: new GraphQLList(ExpenseType),
    args: {
      CollectiveId: { type: new GraphQLNonNull(GraphQLInt) },
      includeHostedCollectives: { type: GraphQLBoolean },
      status: { type: GraphQLString },
      category: { type: GraphQLString },
      FromCollectiveId: { type: GraphQLInt },
      fromCollectiveSlug: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args, req) {
      const query = { where: {} };
      if (args.fromCollectiveSlug && !args.FromCollectiveId) {
        args.FromCollectiveId = await fetchCollectiveId(args.fromCollectiveSlug);
      }
      if (args.FromCollectiveId) {
        const user = await models.User.findOne({
          attributes: ['id'],
          where: { CollectiveId: args.FromCollectiveId },
        });
        if (!user) {
          throw new Error('FromCollectiveId not found');
        }
        query.where.UserId = user.id;
      }
      if (args.status) {
        query.where.status = args.status;
      }
      if (args.category) {
        query.where[Op.and] = [sequelize.literal(`${sequelize.escape(args.category)} ILIKE ANY(tags)`)];
      }
      if (args.limit) {
        query.limit = args.limit;
      }
      if (args.offset) {
        query.offset = args.offset;
      }
      query.order = [['createdAt', 'DESC']];
      return req.loaders.Collective.byId.load(args.CollectiveId).then(collective => {
        if (!collective) {
          throw new Error('Collective not found');
        }
        const getCollectiveIds = () => {
          // if is host, we get all the expenses across all the hosted collectives that are active
          if (args.includeHostedCollectives) {
            return models.Collective.findAll({
              attributes: ['id'],
              where: {
                HostCollectiveId: collective.id,
                isActive: true,
              },
            }).map(c => c.id);
          } else {
            return Promise.resolve([args.CollectiveId]);
          }
        };
        return getCollectiveIds().then(collectiveIds => {
          query.where.CollectiveId = { [Op.in]: collectiveIds };
          return models.Expense.findAll(query);
        });
      });
    },
  },

  /*
   * Return all expenses, with optional collective slug
   */
  expenses: {
    type: PaginatedExpensesType,
    args: {
      CollectiveId: { type: GraphQLInt },
      CollectiveSlug: { type: GraphQLString },
      status: { type: ExpenseStatusType },
      category: { type: GraphQLString, deprecationReason: '2020-06-03: Expense are now using tags' },
      FromCollectiveId: { type: GraphQLInt },
      FromCollectiveSlug: { type: GraphQLString },
      limit: {
        defaultValue: 100,
        description: 'Defaults to 100',
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
      orderBy: {
        defaultValue: OrderByType.defaultValue,
        type: OrderByType,
      },
    },
    async resolve(_, args) {
      const {
        category,
        CollectiveId,
        CollectiveSlug,
        FromCollectiveId,
        FromCollectiveSlug,
        limit,
        offset,
        orderBy,
        status,
      } = args;
      const query = {
        limit,
        offset,
        order: [Object.values(orderBy)],
        where: {},
      };

      if (FromCollectiveId || FromCollectiveSlug) {
        query.where.FromCollectiveId = FromCollectiveId || (await fetchCollectiveId(FromCollectiveSlug));
      }

      if (category) {
        query.where.tags = { [Op.contains]: [category] };
      }

      if (status) {
        query.where.status = status;
      }

      if (CollectiveId || CollectiveSlug) {
        query.where.CollectiveId = CollectiveId || (await fetchCollectiveId(CollectiveSlug));
      }

      const { count: total, rows: expenses } = await models.Expense.findAndCountAll(query);
      return {
        expenses,
        limit,
        offset,
        total,
      };
    },
  },

  /*
   * Given an Expense id, returns the expense details
   */
  Expense: {
    type: ExpenseType,
    args: {
      id: { type: new GraphQLNonNull(GraphQLInt) },
    },
    resolve(_, args) {
      return models.Expense.findByPk(args.id);
    },
  },

  /*
   * Given a Transaction id, returns a transaction details
   */
  Transaction: {
    type: TransactionInterfaceType,
    args: {
      id: {
        type: GraphQLInt,
      },
      uuid: {
        type: GraphQLString,
      },
    },
    resolve(_, args) {
      return models.Transaction.findOne({ where: { ...args } });
    },
  },

  /*
   * Returns all collectives
   */
  allCollectives: {
    type: CollectiveSearchResultsType,
    args: {
      slugs: {
        type: new GraphQLList(GraphQLString),
        description: 'Fetch collectives with a list of collective slug',
      },
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'Fetch all collectives that match at least one of the tags',
      },
      type: {
        type: TypeOfCollectiveType,
        description: 'COLLECTIVE, USER, ORGANIZATION, EVENT',
      },
      HostCollectiveId: {
        type: GraphQLInt,
        description: 'Fetch all collectives hosted by HostCollectiveId',
      },
      hostCollectiveSlug: {
        type: GraphQLString,
        description: 'Fetch all collectives hosted by hostCollectiveSlug',
      },
      isActive: {
        description: 'Only return active collectives',
        type: GraphQLBoolean,
      },
      isPledged: {
        description: 'Only return pledged or non-pledged collectives',
        type: GraphQLBoolean,
      },
      memberOfCollectiveSlug: {
        type: GraphQLString,
        description: 'Fetch all collectives that `memberOfCollectiveSlug` is a member of',
      },
      minBackerCount: {
        description: 'Filter collectives with this minimum number of backers',
        type: GraphQLInt,
      },
      role: {
        type: GraphQLString,
        description: 'Only fetch the collectives where `memberOfCollectiveSlug` has the specified role',
      },
      ParentCollectiveId: {
        type: GraphQLInt,
        description: 'Fetch all collectives that are a child of `ParentCollectiveId`. Used for "SuperCollectives"',
      },
      orderBy: {
        defaultValue: 'name',
        type: CollectiveOrderFieldType,
      },
      orderDirection: {
        defaultValue: 'ASC',
        type: OrderDirectionType,
      },
      limit: {
        defaultValue: 10,
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
    },
    async resolve(_, args) {
      const query = {
        where: {},
        limit: args.limit,
        include: [],
      };

      if (args.slugs) {
        query.where.slug = { [Op.in]: args.slugs };
      }

      if (args.hostCollectiveSlug) {
        args.HostCollectiveId = await fetchCollectiveId(args.hostCollectiveSlug);
      }

      if (args.memberOfCollectiveSlug) {
        args.memberOfCollectiveId = await fetchCollectiveId(args.memberOfCollectiveSlug);
      }

      if (args.memberOfCollectiveId) {
        const memberCond = {
          model: models.Member,
          required: true,
          where: {
            MemberCollectiveId: args.memberOfCollectiveId,
          },
        };
        if (args.role) {
          memberCond.where.role = args.role.toUpperCase();
        }
        query.include.push(memberCond);
      }

      if (args.HostCollectiveId) {
        query.where.HostCollectiveId = args.HostCollectiveId;
      }
      if (args.ParentCollectiveId) {
        query.where.ParentCollectiveId = args.ParentCollectiveId;
      }
      if (args.type) {
        query.where.type = args.type;
      }
      if (args.tags) {
        query.where.tags = { [Op.overlap]: args.tags };
      }
      if (typeof args.isActive === 'boolean') {
        query.where.isActive = args.isActive;
      }
      if (typeof args.isPledged === 'boolean') {
        query.where.isPledged = args.isPledged;
      }

      if (args.orderBy === 'balance' && (args.ParentCollectiveId || args.HostCollectiveId || args.tags)) {
        const { total, collectives } = await rawQueries.getCollectivesWithBalance(query.where, args);
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      if (args.orderBy === 'monthlySpending') {
        const { total, collectives } = await rawQueries.getCollectivesOrderedByMonthlySpending({
          ...args,
          where: query.where,
        });
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      if (args.orderBy === 'totalDonations') {
        if (args.isPledged) {
          query.attributes = {
            include: [
              [
                sequelize.literal(`(
                  SELECT  COALESCE(SUM("totalAmount"), 0)
                  FROM    "Orders" o, "Collectives" c
                  WHERE   c."isPledged" IS TRUE
                  AND     o."CollectiveId" = "Collective".id
                )`),
                'totalDonations',
              ],
            ],
          };
          query.order = [[sequelize.col('totalDonations'), args.orderDirection]];
        } else {
          query.attributes = {
            include: [
              [
                sequelize.literal(`(
                  SELECT  COALESCE(SUM("netAmountInCollectiveCurrency"), 0)
                  FROM    "Transactions" t
                  WHERE   t."type" = 'CREDIT'
                  AND     t."CollectiveId" = "Collective".id
                  AND     t."deletedAt" IS NULL
                )`),
                'totalDonations',
              ],
            ],
          };
          query.order = [[sequelize.col('totalDonations'), args.orderDirection]];
        }
      } else if (args.orderBy === 'financialContributors') {
        query.attributes = {
          include: [
            [
              sequelize.literal(`(
                SELECT  COUNT(DISTINCT m."MemberCollectiveId")
                FROM    "Members" m
                WHERE   m."deletedAt" IS NULL
                AND     m."CollectiveId" = "Collective".id
                AND     m."role" = 'BACKER'
              )`),
              'contributors_count',
            ],
          ],
        };

        query.order = [[sequelize.col('contributors_count'), args.orderDirection]];
      } else {
        query.order = [[args.orderBy, args.orderDirection]];
      }

      if (args.minBackerCount) {
        const { total, collectives } = await rawQueries.getCollectivesWithMinBackers({
          ...args,
          where: query.where,
        });
        return { total, collectives, limit: args.limit, offset: args.offset };
      }

      if (args.offset) {
        query.offset = args.offset;
      }

      // this will elminate the odd test accounts and older data we need to cleanup
      query.where = {
        ...query.where,
        createdAt: {
          [Op.not]: null,
        },
        name: {
          [Op.ne]: '',
        },
      };
      const result = await models.Collective.findAndCountAll(query);

      return {
        total: result.count,
        collectives: result.rows,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },

  /*
   * Returns all hosts
   */
  allHosts: {
    type: CollectiveSearchResultsType,
    description: 'Returns all public hosts that are open for applications',
    args: {
      tags: {
        type: new GraphQLList(GraphQLString),
        description: 'Fetch all collectives that match at least one of the tags',
      },
      currency: {
        type: GraphQLString,
        description: 'Filter hosts by currency',
      },
      orderBy: {
        defaultValue: 'collectives',
        type: HostCollectiveOrderFieldType,
      },
      orderDirection: {
        defaultValue: 'DESC',
        type: OrderDirectionType,
      },
      limit: {
        defaultValue: 10,
        type: GraphQLInt,
      },
      offset: {
        defaultValue: 0,
        type: GraphQLInt,
      },
      onlyOpenHosts: {
        type: GraphQLBoolean,
        defaultValue: true,
      },
      minNbCollectivesHosted: {
        type: new GraphQLNonNull(GraphQLInt),
        defaultValue: 0,
      },
    },
    async resolve(_, args) {
      const { collectives, total } = await rawQueries.getHosts(args);
      return {
        total,
        collectives,
        limit: args.limit,
        offset: args.offset,
      };
    },
  },

  /**
   * Helper to get all tags used in collectives
   */
  allCollectiveTags: {
    type: new GraphQLList(GraphQLString),
    resolve: rawQueries.getUniqueCollectiveTags,
  },

  /**
   * Find a specific member. If multiple members match the given criteria, only
   * one will be returned.
   */
  member: {
    type: MemberType,
    deprecationReason: '2020-09-08: This endpoint does not seems to be used anymore',
    args: {
      id: { type: GraphQLInt },
      CollectiveId: { type: GraphQLInt },
      MemberCollectiveId: { type: GraphQLInt },
      TierId: { type: GraphQLInt },
    },
    async resolve(_, args, req) {
      if (!args.id && !(args.MemberCollectiveId && (args.CollectiveId || args.TierId))) {
        throw new ValidationFailed(
          'Must provide either an id, a pair of MemberCollectiveId/CollectiveId or a pair of MemberCollectiveId/TierId',
        );
      }

      const member = await models.Member.findOne({
        where: pick(args, ['id', 'CollectiveId', 'MemberCollectiveId', 'tierId']),
        include: [
          { model: models.Collective, as: 'collective' },
          { model: models.Collective, as: 'memberCollective' },
        ],
      });

      if (member.collective?.isIncognito && !req.remoteUser?.isAdmin(member.memberCollective?.id)) {
        return null;
      } else {
        return member;
      }
    },
  },

  /*
   * Given a collective slug, returns all members/memberships
   */
  allMembers: {
    type: new GraphQLList(MemberType),
    args: {
      CollectiveId: { type: GraphQLInt },
      collectiveSlug: { type: GraphQLString },
      includeHostedCollectives: {
        type: GraphQLBoolean,
        description:
          'Include the members of the hosted collectives. Useful to get the list of all users/organizations from a host.',
      },
      memberCollectiveSlug: { type: GraphQLString },
      TierId: { type: GraphQLInt },
      role: { type: GraphQLString },
      type: { type: GraphQLString },
      isActive: { type: GraphQLBoolean },
      orderBy: { type: GraphQLString },
      orderDirection: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
    },
    async resolve(_, args, req) {
      if (!args.CollectiveId && !args.collectiveSlug && !args.memberCollectiveSlug) {
        throw new Error('Please provide a CollectiveId, a collectiveSlug or a memberCollectiveSlug');
      }

      if (args.collectiveSlug) {
        args.CollectiveId = await fetchCollectiveId(args.collectiveSlug);
        if (!args.CollectiveId) {
          throw new Error('Invalid collectiveSlug (not found)');
        }
      }

      if (args.memberCollectiveSlug) {
        args.MemberCollectiveId = await fetchCollectiveId(args.memberCollectiveSlug);
        if (!args.MemberCollectiveId) {
          throw new Error('Invalid memberCollectiveSlug (not found)');
        }
      }

      const memberTable = args.MemberCollectiveId ? 'collective' : 'memberCollective';
      const attr = args.CollectiveId ? 'CollectiveId' : 'MemberCollectiveId';
      const where = { [attr]: args[attr] };
      if (args.role) {
        where.role = args.role.toUpperCase();
      }
      if (where.role === 'HOST') {
        where.HostCollectiveId = args.MemberCollectiveId;
      }

      const getCollectiveIds = () => {
        if (args.includeHostedCollectives) {
          return models.Member.findAll({
            where: {
              MemberCollectiveId: args.CollectiveId,
              role: 'HOST',
            },
          }).map(members => members.CollectiveId);
        } else {
          return Promise.resolve([args[attr]]);
        }
      };

      if (['totalDonations', 'balance'].indexOf(args.orderBy) !== -1) {
        const queryName = args.orderBy === 'totalDonations' ? 'getMembersWithTotalDonations' : 'getMembersWithBalance';
        const tiersById = {};

        const options = args.isActive ? { ...args, limit: args.limit * 2 } : args;

        return rawQueries[queryName](where, options)
          .then(results => {
            if (args.isActive) {
              const TierIds = uniq(results.map(r => r.dataValues.TierId));
              return models.Tier.findAll({
                where: { id: { [Op.in]: TierIds } },
              }).then(tiers => {
                tiers.map(t => (tiersById[t.id] = t.dataValues));
                return results
                  .filter(r => {
                    return models.Member.isActive({
                      tier: tiersById[r.dataValues.TierId],
                      lastDonation: r.dataValues.lastDonation,
                    });
                  })
                  .slice(0, args.limit);
              });
            }
            return results;
          })
          .map(collective => {
            const res = {
              id: collective.dataValues.MemberId,
              role: collective.dataValues.role,
              createdAt: collective.dataValues.createdAt,
              CollectiveId: collective.dataValues.CollectiveId,
              MemberCollectiveId: collective.dataValues.MemberCollectiveId,
              ParentCollectiveId: collective.dataValues.ParentCollectiveId,
              totalDonations: collective.dataValues.totalDonations,
              TierId: collective.dataValues.TierId,
            };
            res[memberTable] = collective;
            return res;
          });
      } else {
        const query = { where, include: [] };
        if (args.TierId) {
          query.where.TierId = args.TierId;
        }

        // If we request the data of the member, we do a JOIN query
        // that allows us to sort by Member.member.name
        const memberCond = {};
        if (req.body.query.match(/ member ?\{/) || args.type) {
          if (args.type) {
            const types = args.type.split(',');
            memberCond.type = { [Op.in]: types };
          }
          query.include.push({
            model: models.Collective,
            as: memberTable,
            required: true,
            where: memberCond,
          });
          query.order = [[sequelize.literal(`"${memberTable}".name`), 'ASC']];
        }
        if (args.limit) {
          query.limit = args.limit;
        }
        if (args.offset) {
          query.offset = args.offset;
        }

        return getCollectiveIds()
          .then(collectiveIds => {
            query.where[attr] = { [Op.in]: collectiveIds };
            query.where.role = { [Op.ne]: 'HOST' };
            return models.Member.findAll(query);
          })
          .then(members => {
            // also fetch the list of collectives that are members of the host
            if (args.includeHostedCollectives) {
              query.where = {
                MemberCollectiveId: args.CollectiveId,
                role: 'HOST',
              };
              query.order = [[sequelize.literal('collective.name'), 'ASC']];
              query.include = [
                {
                  model: models.Collective,
                  as: 'collective',
                  required: true,
                },
              ];

              return models.Member.findAll(query)
                .map(m => {
                  m.memberCollective = m.collective;
                  delete m.collective;
                  members.push(m);
                })
                .then(() => members);
            } else if (args.CollectiveId && !req.remoteUser?.isAdmin(args.CollectiveId)) {
              return members.filter(m => !m.collective?.isIncognito);
            } else {
              return members;
            }
          });
      }
    },
  },

  memberInvitations: {
    type: new GraphQLList(MemberInvitationType),
    description: '[AUTHENTICATED] Returns the pending invitations',
    args: {
      CollectiveId: { type: GraphQLInt },
      MemberCollectiveId: { type: GraphQLInt },
    },
    resolve(collective, args, { remoteUser }) {
      if (!remoteUser) {
        new Forbidden('Only collective admins can see pending invitations');
      }
      if (!args.CollectiveId && !args.MemberCollectiveId) {
        throw new ValidationFailed('You must either provide a CollectiveId or a MemberCollectiveId');
      }

      // Must be an admin to see pending invitations
      const isAdminOfCollective = args.CollectiveId && remoteUser.isAdmin(args.CollectiveId);
      const isAdminOfMemberCollective = args.MemberCollectiveId && remoteUser.isAdmin(args.MemberCollectiveId);
      if (!isAdminOfCollective && !isAdminOfMemberCollective) {
        new Forbidden('Only collective admins can see pending invitations');
      }

      const where = {};
      if (args.CollectiveId) {
        where.CollectiveId = args.CollectiveId;
      }
      if (args.MemberCollectiveId) {
        where.MemberCollectiveId = args.MemberCollectiveId;
      }

      return models.MemberInvitation.findAll({
        where,
        include: [
          { association: 'collective', required: true, attributes: [] },
          { association: 'memberCollective', required: true, attributes: [] },
        ],
      });
    },
  },

  /*
   * Given a collective slug, returns all events
   */
  allEvents: {
    type: new GraphQLList(CollectiveInterfaceType),
    args: {
      slug: { type: GraphQLString, description: 'Slug of the parent collective' },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      isArchived: {
        type: GraphQLBoolean,
        description:
          'If null, returns all events, if false returns only events that are not archived, if true only returns events that have been archived',
      },
    },
    resolve(_, args) {
      const where = { type: 'EVENT' };
      if (args.slug) {
        if (args.isArchived === true) {
          where.deactivatedAt = { [Op.not]: null };
        }
        if (args.isArchived === false) {
          where.deactivatedAt = null;
        }
        return models.Collective.findBySlug(args.slug, { attributes: ['id'] })
          .then(collective => {
            where.ParentCollectiveId = collective.id;
            return models.Collective.findAll({
              where,
              order: [
                ['startsAt', 'DESC'],
                ['createdAt', 'DESC'],
              ],
              limit: args.limit || 10,
              offset: args.offset || 0,
            });
          })
          .catch(() => {
            return [];
          });
      } else {
        return models.Collective.findAll({ where });
      }
    },
  },

  /*
   * Given a prepaid code, return validity and amount
   */
  PaymentMethod: {
    type: PaymentMethodType,
    args: {
      id: { type: GraphQLInt },
      code: { type: GraphQLString },
    },
    resolve(_, args) {
      if (args.id) {
        return models.PaymentMethod.findByPk(args.id);
      } else if (args.code) {
        const redeemCodeRegex = /^[a-zA-Z0-9]{8}$/;
        if (!redeemCodeRegex.test(args.code)) {
          throw Error(`Code "${args.code}" has invalid format`);
        }

        return models.PaymentMethod.findOne({
          where: sequelize.and(
            sequelize.where(sequelize.cast(sequelize.col('uuid'), 'text'), {
              [Op.like]: `${args.code}%`,
            }),
            { service: 'opencollective' },
            { type: 'virtualcard' },
          ),
        });
      } else {
        return new Error('Please provide an id or a code.');
      }
    },
  },

  /*
   * Given a search term, return a list of related Collectives
   */
  search: {
    type: CollectiveSearchResultsType,
    description: `Search for collectives. Results are returned with best matches first.`,
    args: {
      term: {
        type: GraphQLString,
        description: 'Fetch collectives related to this term based on name, description, tags, slug, and location',
      },
      hostCollectiveIds: {
        type: new GraphQLList(GraphQLInt),
        description: '[NON AVAILABLE WITH ALGOLIA] Limit the search to collectives under these hosts',
      },
      types: {
        type: new GraphQLList(TypeOfCollectiveType),
        description: 'Only return collectives of this type',
      },
      isHost: {
        type: GraphQLBoolean,
        description: 'Filter on wether account is a host',
      },
      limit: {
        type: GraphQLInt,
        description: 'Limit the amount of results. Defaults to 20',
        defaultValue: 20,
      },
      offset: {
        type: GraphQLInt,
        defaultValue: 0,
      },
      useAlgolia: {
        type: GraphQLBoolean,
        deprecationReason: '2020-11-18: Algolia is intended to be removed in a near future',
        defaultValue: parseToBoolean(config.algolia.useAsDefault),
        description: `
          If set to false, an internal query will be used to search the collective rather than Algolia.
          You **must** set this to false when searching for users/organizations.
        `,
      },
    },
    async resolve(_, args, req) {
      const { limit, offset, term, types, isHost, hostCollectiveIds, useAlgolia } = args;
      const cleanTerm = term ? term.trim() : '';
      const listToStr = list => (list ? list.join('_') : '');
      const generateResults = (collectives, total) => {
        const optionalParamsKey = `${listToStr(types)}-${listToStr(hostCollectiveIds)}`;
        return {
          id: `search-${optionalParamsKey}-${cleanTerm}-${offset}-${limit}-${useAlgolia ? 'algolia' : 'direct'}`,
          total,
          collectives,
          limit,
          offset,
        };
      };

      if (useAlgolia && Algolia.isAvailable()) {
        const [collectives, total] = await searchCollectivesOnAlgolia(cleanTerm, offset, limit, types, isHost);
        return generateResults(collectives, total);
      } else if (isEmail(cleanTerm) && req.remoteUser && (!types || types.includes(CollectiveTypes.USER))) {
        // If an email is provided, search in the user table. Users must be authenticated
        // because we limit the rate of queries for this feature.
        const [collectives, total] = await searchCollectivesByEmail(cleanTerm, req.remoteUser);
        return generateResults(collectives, total);
      } else {
        const [collectives, total] = await searchCollectivesInDB(
          cleanTerm,
          offset,
          limit,
          types,
          hostCollectiveIds,
          isHost,
        );
        return generateResults(collectives, total);
      }
    },
  },
  /** Gets the transactions of a payment method
   * @param {Object} args contains the parameters
   * @param {Number} args.uuid The Payment method id
   * @param {String} [args.type] The transaction type - Debit or Credit
   * @param {Number} [args.limit] The limit of records to be returned
   * @param {String} [args.offset] The offset of the query
   * @param {String} [args.dateFrom] The start date(field createdAt) to return the list of transactions
   * @param {String} [args.dateTo] The end date(field createdAt) to return the list of transactions
   * @returns {[models.Transaction]} returns an array of transactions.
   */
  allTransactionsFromPaymentMethod: {
    type: new GraphQLList(TransactionInterfaceType),
    args: {
      uuid: { type: new GraphQLNonNull(GraphQLString) },
      type: { type: GraphQLString },
      limit: { type: GraphQLInt },
      offset: { type: GraphQLInt },
      dateFrom: { type: GraphQLString },
      dateTo: { type: GraphQLString },
    },
    resolve: async (_, args) => {
      const paymentMethod = await models.PaymentMethod.findOne({
        where: { uuid: args.uuid },
      });
      if (!paymentMethod) {
        throw Error(`Payment Method with uuid ${args.uuid} not found.`);
      }
      const query = {
        where: {
          PaymentMethodId: paymentMethod.id,
        },
        order: [['createdAt', 'DESC']],
      };
      if (args.type) {
        query.where.type = args.type;
      }
      if (args.limit) {
        query.limit = args.limit;
      }
      if (args.offset) {
        query.offset = args.offset;
      }

      if (args.dateFrom || args.dateTo) {
        query.where.createdAt = {};
        if (args.dateFrom) {
          query.where.createdAt[Op.gte] = args.dateFrom;
        }
        if (args.dateTo) {
          query.where.createdAt[Op.lte] = args.dateTo;
        }
      }
      const transactions = await models.Transaction.findAll(query);
      return transactions;
    },
  },

  Order: {
    type: OrderType,
    args: {
      id: {
        type: new GraphQLNonNull(GraphQLInt),
      },
    },
    resolve: async (_, args) => {
      const order = await models.Order.findByPk(args.id);
      return order;
    },
  },
};

export default queries;
