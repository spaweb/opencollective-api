import * as Sentry from '@sentry/node';
import config from 'config';
import { isEqual } from 'lodash';

export const plugSentryToApp = (): void => {
  if (!config.sentry?.dsn) {
    return;
  }

  Sentry.init({
    dsn: config.sentry.dsn,
    environment: config.env,
    attachStacktrace: true,
    enabled: config.env !== 'test',
  });
};

const IGNORED_GQL_ERRORS = [
  {
    path: ['Collective'],
    message: /^No collective found with slug/,
  },
  {
    path: ['allMembers'],
    message: /^Invalid collectiveSlug \(not found\)$/,
  },
  {
    path: ['createOrder'],
    message: /^Your card was declined.$/,
  },
];

const isIgnoredGQLError = err => {
  return IGNORED_GQL_ERRORS.some(ignoredError => {
    return (!ignoredError.path || isEqual(ignoredError.path, err.path)) && err.message?.match(ignoredError.message);
  });
};

export const SentryGraphQLPlugin = {
  requestDidStart(): Record<string, unknown> {
    return {
      didEncounterErrors(ctx): void {
        // If we couldn't parse the operation, don't do anything here
        if (!ctx.operation) {
          return;
        }

        for (const err of ctx.errors) {
          // Only report internal server errors, all errors extending ApolloError should be user-facing
          if (err.extensions?.code || isIgnoredGQLError(err)) {
            continue;
          }

          // Add scoped report details and send to Sentry
          Sentry.withScope(scope => {
            // Annotate whether failing operation was query/mutation/subscription
            scope.setTag('kind', ctx.operation.operation);

            // Log query and variables as extras
            scope.setExtra('query', ctx.request.query);
            scope.setExtra('variables', JSON.stringify(ctx.request.variables));

            // Add logged in user (if any)
            if (ctx.context.remoteUser) {
              scope.setUser({
                id: ctx.context.remoteUser.id,
                CollectiveId: ctx.context.remoteUser.CollectiveId,
              });
            }

            if (err.path) {
              // We can also add the path as breadcrumb
              scope.addBreadcrumb({
                category: 'query-path',
                message: err.path.join(' > '),
                level: Sentry.Severity.Debug,
              });
            }

            Sentry.captureException(err);
          });
        }
      },
    };
  },
};
