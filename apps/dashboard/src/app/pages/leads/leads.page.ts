import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';

import { ApiService } from '../../core/api.service';
import type { Lead, LeadStatus } from '../../core/api.types';
import { StatusBadgeComponent } from '../../shared/status-badge.component';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-leads',
  standalone: true,
  imports: [DatePipe, FormsModule, StatusBadgeComponent],
  template: `
    <div class="page-head">
      <h1>Leads</h1>
      <p>Towing requests captured by the receptionist.</p>
    </div>

    @if (error()) {
      <div class="error">{{ error() }}</div>
    }

    <div class="panel">
      <header>
        <div class="filters">
          <input
            placeholder="Search name, phone, location or vehicle"
            [(ngModel)]="search"
            (keyup.enter)="reload(0)"
          />
          <select [(ngModel)]="status" (change)="reload(0)">
            <option value="">All statuses</option>
            <option value="new">New</option>
            <option value="contacted">Contacted</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
          <button type="button" (click)="reload(0)">Search</button>
        </div>
        <span class="muted">{{ total() }} total</span>
      </header>

      @if (leads().length === 0) {
        <div class="empty">No leads match this filter.</div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Customer</th>
                <th>Phone</th>
                <th>Service</th>
                <th>Location</th>
                <th>Vehicle</th>
                <th>Movable</th>
                <th>Status</th>
                <th>Time</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              @for (lead of leads(); track lead.id) {
                <tr>
                  <td>{{ lead.customerName }}</td>
                  <td>{{ lead.customerPhone }}</td>
                  <td>{{ lead.service }}</td>
                  <td class="wrap">{{ lead.location }}</td>
                  <td>{{ vehicle(lead) }}</td>
                  <td>{{ movable(lead) }}</td>
                  <td><app-status-badge [status]="lead.status" /></td>
                  <td>{{ lead.createdAt | date: 'short' }}</td>
                  <td>
                    <select
                      [ngModel]="lead.status"
                      (ngModelChange)="changeStatus(lead, $event)"
                    >
                      <option value="new">New</option>
                      <option value="contacted">Contacted</option>
                      <option value="completed">Completed</option>
                      <option value="cancelled">Cancelled</option>
                    </select>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <div class="pager">
          <button type="button" [disabled]="offset() === 0" (click)="reload(offset() - pageSize)">
            Previous
          </button>
          <span class="muted">
            {{ offset() + 1 }}–{{ offset() + leads().length }} of {{ total() }}
          </span>
          <button
            type="button"
            [disabled]="offset() + pageSize >= total()"
            (click)="reload(offset() + pageSize)"
          >
            Next
          </button>
        </div>
      }
    </div>
  `,
})
export class LeadsPage implements OnInit {
  protected readonly leads = signal<Lead[]>([]);
  protected readonly total = signal(0);
  protected readonly offset = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly pageSize = PAGE_SIZE;

  protected search = '';
  protected status: LeadStatus | '' = '';

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.reload(0);
  }

  protected reload(offset: number): void {
    this.error.set(null);
    this.api
      .leads({
        status: this.status,
        search: this.search.trim(),
        limit: PAGE_SIZE,
        offset: Math.max(0, offset),
      })
      .subscribe({
        next: (page) => {
          this.leads.set(page.items);
          this.total.set(page.total);
          this.offset.set(page.offset);
        },
        error: () => this.error.set('Could not load leads.'),
      });
  }

  protected changeStatus(lead: Lead, status: LeadStatus): void {
    // Optimistic: the row updates immediately and reverts if the call fails,
    // because working a list of leads means changing many in quick succession.
    const previous = lead.status;
    this.leads.update((rows) =>
      rows.map((r) => (r.id === lead.id ? { ...r, status } : r)),
    );

    this.api.setLeadStatus(lead.id, status).subscribe({
      error: () => {
        this.error.set('Could not update that lead.');
        this.leads.update((rows) =>
          rows.map((r) => (r.id === lead.id ? { ...r, status: previous } : r)),
        );
      },
    });
  }

  protected vehicle(lead: Lead): string {
    const parts = [lead.vehicleMake, lead.vehicleModel].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
    return lead.vehicleType ?? '—';
  }

  protected movable(lead: Lead): string {
    if (lead.vehicleMovable === null) return '—';
    return lead.vehicleMovable ? 'Yes' : 'No';
  }
}
