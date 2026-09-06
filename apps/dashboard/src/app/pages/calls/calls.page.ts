import { Component, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import type { Call } from '../../core/api.types';
import { OutcomeBadgeComponent } from '../../shared/outcome-badge.component';

const PAGE_SIZE = 25;

@Component({
  selector: 'app-calls',
  standalone: true,
  imports: [DatePipe, RouterLink, OutcomeBadgeComponent],
  template: `
    <div class="page-head">
      <h1>Calls</h1>
      <p>Every call the receptionist has answered.</p>
    </div>

    @if (error()) {
      <div class="error">{{ error() }}</div>
    }

    <div class="panel">
      <header>
        Call history
        <span class="muted">{{ total() }} total</span>
      </header>

      @if (calls().length === 0) {
        <div class="empty">No calls yet.</div>
      } @else {
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>From</th>
                <th>To</th>
                <th>Started</th>
                <th>Duration</th>
                <th>Outcome</th>
                <th>Ended in</th>
              </tr>
            </thead>
            <tbody>
              @for (call of calls(); track call.id) {
                <tr>
                  <td><a [routerLink]="['/calls', call.id]">{{ call.fromNumber }}</a></td>
                  <td>{{ call.toNumber }}</td>
                  <td>{{ call.startedAt | date: 'medium' }}</td>
                  <td>{{ call.durationSeconds !== null ? call.durationSeconds + 's' : '—' }}</td>
                  <td><app-outcome-badge [outcome]="call.outcome" /></td>
                  <td class="muted">{{ call.finalState ?? '—' }}</td>
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
            {{ offset() + 1 }}–{{ offset() + calls().length }} of {{ total() }}
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
export class CallsPage implements OnInit {
  protected readonly calls = signal<Call[]>([]);
  protected readonly total = signal(0);
  protected readonly offset = signal(0);
  protected readonly error = signal<string | null>(null);
  protected readonly pageSize = PAGE_SIZE;

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.reload(0);
  }

  protected reload(offset: number): void {
    this.api.calls({ limit: PAGE_SIZE, offset: Math.max(0, offset) }).subscribe({
      next: (page) => {
        this.calls.set(page.items);
        this.total.set(page.total);
        this.offset.set(page.offset);
      },
      error: () => this.error.set('Could not load calls.'),
    });
  }
}
