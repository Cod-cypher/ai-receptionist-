import type { Routes } from '@angular/router';

import { authGuard } from './core/auth.guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'overview' },
  {
    path: 'login',
    loadComponent: () => import('./pages/login/login.page').then((m) => m.LoginPage),
  },
  {
    path: 'overview',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/overview/overview.page').then((m) => m.OverviewPage),
  },
  {
    path: 'leads',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/leads/leads.page').then((m) => m.LeadsPage),
  },
  {
    path: 'calls',
    canActivate: [authGuard],
    loadComponent: () => import('./pages/calls/calls.page').then((m) => m.CallsPage),
  },
  {
    path: 'calls/:id',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/calls/call-detail.page').then((m) => m.CallDetailPage),
  },
  {
    path: 'callbacks',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/callbacks/callbacks.page').then((m) => m.CallbacksPage),
  },
  {
    path: 'settings',
    canActivate: [authGuard],
    loadComponent: () =>
      import('./pages/settings/settings.page').then((m) => m.SettingsPage),
  },
  { path: '**', redirectTo: 'overview' },
];
