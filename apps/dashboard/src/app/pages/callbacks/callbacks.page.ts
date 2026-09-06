import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import type { CallbackRequest, NotificationRecord } from '../../core/api.types';
import { StatusBadgeComponent } from '../../shared/status-badge.component';

@Component({
  selector: 'app-callbacks',
  standalone: true,
  imports: [DatePipe, FormsModule, RouterLink, StatusBadgeComponent],
  template: `
    <div class="page-head">
      <h1>Callbacks</h1>
      <p>Questions the receptionist would not answer on its own.</p>
    </div>

    @if (error()) {
      <div class="error">{{ error() }}</div>
    }

    <div class="panel">
      <header>
        <div class="filters">
          <select [(ngModel)]="status" (change)="reload()">
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
            <option value="">All</option>
          </select>
        </div>
        <span class="muted">{{ total() }} total</span>
      </header>

      @if (items().length === 0) {
        <div class="empty">Nothing here.</div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>Reason</th>
                <th>Status</th>
                <th>Received</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (item of items(); track item.id) {
                <tr>
                  <td>{{ item.customerName ?? 'Not given' }}</td>
                  <td>{{ item.customerPhone }}</td>
                  <td class="wrap">{{ item.reason }}</td>
                  <td><app-status-badge [status]="item.status" /></td>
                  <td>{{ item.createdAt | date: 'short' }}</td>
                  <td>
                    @if (item.callId) {
                      <a [routerLink]="['/calls', item.callId]">Call</a>
                    }
                    <button type="button" (click)="toggle(item)" style="margin-left:8px">
                      {{ item.status === 'open' ? 'Resolve' : 'Reopen' }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>

    <div class="panel">
      <header>
        WhatsApp delivery
        <span class="muted">Notifications that need attention</span>
      </header>
      @if (notifications().length === 0) {
        <div class="empty">Every notification has been delivered.</div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>To</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Last error</th>
                <th>Created</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (n of notifications(); track n.id) {
                <tr>
                  <td>{{ n.target }}</td>
                  <td><app-status-badge [status]="n.status" /></td>
                  <td>{{ n.attempts }}</td>
                  <td class="wrap muted">{{ n.lastError ?? '—' }}</td>
                  <td>{{ n.createdAt | date: 'short' }}</td>
                  <td>
                    <button type="button" (click)="retry(n)" [disabled]="retrying() === n.id">
                      {{ retrying() === n.id ? 'Sending…' : 'Resend' }}
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    </div>
  `,
})
export class CallbacksPage implements OnInit {
  protected readonly items = signal<CallbackRequest[]>([]);
  protected readonly notifications = signal<NotificationRecord[]>([]);
  protected readonly total = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly retrying = signal<string | null>(null);

  protected status: 'open' | 'resolved' | '' = 'open';

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.reload();
    this.loadNotifications();
  }

  protected reload(): void {
    this.api.callbacks({ status: this.status }).subscribe({
      next: (page) => {
        this.items.set(page.items);
        this.total.set(page.total);
      },
      error: () => this.error.set('Could not load callback requests.'),
    });
  }

  /** Only the ones an operator can act on: everything else is noise here. */
  private loadNotifications(): void {
    this.api.notifications({}).subscribe({
      next: (page) =>
        this.notifications.set(
          page.items.filter((n) => n.status === 'failed' || n.status === 'dead'),
        ),
      error: () => undefined,
    });
  }

  protected toggle(item: CallbackRequest): void {
    const next = item.status === 'open' ? 'resolved' : 'open';
    this.api.setCallbackStatus(item.id, next).subscribe({
      next: () => this.reload(),
      error: () => this.error.set('Could not update that request.'),
    });
  }

  protected retry(notification: NotificationRecord): void {
    this.retrying.set(notification.id);
    this.api.retryNotification(notification.id).subscribe({
      next: () => {
        this.retrying.set(null);
        this.loadNotifications();
      },
      error: () => {
        this.retrying.set(null);
        this.error.set('That notification could not be sent.');
      },
    });
  }
}
