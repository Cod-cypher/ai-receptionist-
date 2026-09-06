import { Component, computed } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';

import { AuthService } from './core/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    @if (signedIn()) {
      <div class="layout">
        <aside class="sidebar">
          <div class="brand">Towing Receptionist</div>
          <nav>
            <a routerLink="/overview" routerLinkActive="active">Overview</a>
            <a routerLink="/leads" routerLinkActive="active">Leads</a>
            <a routerLink="/calls" routerLinkActive="active">Calls</a>
            <a routerLink="/callbacks" routerLinkActive="active">Callbacks</a>
            <a routerLink="/settings" routerLinkActive="active">Settings</a>
          </nav>
          <div class="foot">
            <div class="muted" style="font-size:12px;margin-bottom:8px">
              {{ auth.user()?.name }}
            </div>
            <button type="button" (click)="auth.logout()">Sign out</button>
          </div>
        </aside>
        <main class="content">
          <router-outlet />
        </main>
      </div>
    } @else {
      <router-outlet />
    }
  `,
})
export class AppComponent {
  protected readonly signedIn = computed(() => this.auth.isAuthenticated());

  constructor(protected readonly auth: AuthService) {}
}
