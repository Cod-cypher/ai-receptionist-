import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import type { Overview } from '../../core/api.types';
import { OutcomeBadgeComponent } from '../../shared/outcome-badge.component';
import { StatusBadgeComponent } from '../../shared/status-badge.component';

@Component({
  selector: 'app-overview',
  standalone: true,
  imports: [DatePipe, RouterLink, OutcomeBadgeComponent, StatusBadgeComponent],
  template: `
    <div class="page-head">
      <h1>Overview</h1>
      <p>Last 30 days</p>
    </div>

    @if (error()) {
      <div class="error">{{ error() }}</div>
    }

    @if (data(); as d) {
      <div class="cards">
        <div class="card">
          <div class="label">Calls received</div>
          <div class="value">{{ d.callsReceived }}</div>
        </div>
        <div class="card">
          <div class="label">AI answered</div>
          <div class="value">{{ d.aiAnsweredCalls }}</div>
        </div>
        <div class="card">
          <div class="label">Leads captured</div>
          <div class="value">{{ d.leadsCaptured }}</div>
        </div>
        <div class="card">
          <div class="label">Open callbacks</div>
          <div class="value">{{ d.openCallbackRequests }}</div>
        </div>
      </div>

      <div class="panel">
        <header>
          Recent calls
          <a routerLink="/calls">View all</a>
        </header>
        @if (d.recentCalls.length === 0) {
          <div class="empty">No calls yet.</div>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>From</th>
                  <th>Time</th>
                  <th>Duration</th>
                  <th>Outcome</th>
                </tr>
              </thead>
              <tbody>
                @for (call of d.recentCalls; track call.id) {
                  <tr>
                    <td><a [routerLink]="['/calls', call.id]">{{ call.fromNumber }}</a></td>
                    <td>{{ call.startedAt | date: 'medium' }}</td>
                    <td>{{ call.durationSeconds !== null ? call.durationSeconds + 's' : '—' }}</td>
                    <td><app-outcome-badge [outcome]="call.outcome" /></td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>

      <div class="panel">
        <header>
          Latest leads
          <a routerLink="/leads">View all</a>
        </header>
        @if (d.recentLeads.length === 0) {
          <div class="empty">No leads yet.</div>
        } @else {
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Service</th>
                  <th>Location</th>
                  <th>Status</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                @for (lead of d.recentLeads; track lead.id) {
                  <tr>
                    <td>{{ lead.customerName }}</td>
                    <td>{{ lead.customerPhone }}</td>
                    <td>{{ lead.service }}</td>
                    <td class="wrap">{{ lead.location }}</td>
                    <td><app-status-badge [status]="lead.status" /></td>
                    <td>{{ lead.createdAt | date: 'short' }}</td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </div>
    } @else if (!error()) {
      <div class="empty">Loading…</div>
    }
  `,
})
export class OverviewPage implements OnInit {
  protected readonly data = signal<Overview | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.api.overview(30).subscribe({
      next: (data) => this.data.set(data),
      error: () => this.error.set('Could not load the overview.'),
    });
  }
}
