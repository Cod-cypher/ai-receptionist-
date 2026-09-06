import { inject } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { catchError, from, switchMap, throwError } from 'rxjs';

import { AuthService } from './auth.service';

/**
 * Attaches the bearer token, and refreshes once on a 401 so an expired access
 * token does not interrupt someone mid-task.
 */
export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);

  // The auth endpoints are what issue tokens; sending a stale one confuses them.
  if (req.url.includes('/api/auth/')) return next(req);

  const token = auth.accessToken;
  const authorised = token
    ? req.clone({ setHeaders: { Authorization: 'Bearer ' + token } })
    : req;

  return next(authorised).pipe(
    catchError((error: unknown) => {
      if (!(error instanceof HttpErrorResponse) || error.status !== 401) {
        return throwError(() => error);
      }

      return from(auth.refresh()).pipe(
        switchMap((refreshed) => {
          if (!refreshed) {
            auth.logout();
            return throwError(() => error);
          }
          return next(
            req.clone({
              setHeaders: { Authorization: 'Bearer ' + auth.accessToken },
            }),
          );
        }),
      );
    }),
  );
};
