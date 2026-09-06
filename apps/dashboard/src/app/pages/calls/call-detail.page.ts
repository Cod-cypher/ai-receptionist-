import { Component, Input, OnInit, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';

import { ApiService } from '../../core/api.service';
import type { CallDetail } from '../../core/api.types';
import { OutcomeBadgeComponent } from '../../shared/outcome-badge.component';
import { StatusBadgeComponent } from '../../shared/status-badge.component';

/**
 * The page that makes a production call debuggable: what was said, what the
 * engine extracted from it, every state change it made, and what it produced.
 */
@Component({
  selector: 'app-call-detail',
  standalone: true,
  imports: [
    DatePipe,
    RouterLink,
    OutcomeBadgeComponent,
    StatusBadgeComponent,
  ],
  template: `
    <div class="page-head">
      <h1>Call detail</h1>
      <p><a routerLink="/calls">Back to calls</a></p>
    </div>

    @if (error()) {
      <div class="error">{{ error() }}</div>
    }

    @if (detail(); as d) {
      <div class="panel">
        <header>Summary</header>
        <div class="body">
          <dl class="kv">
            <dt>Customer</dt>
            <dd>{{ d.lead?.customerName ?? 'Not collected' }}</dd>
            <dt>Phone</dt>
            <dd>{{ d.call.fromNumber }}</dd>
            <dt>Received</dt>
            <dd>{{ d.call.startedAt | date: 'medium' }}</dd>
            <dt>Duration</dt>
            <dd>{{ d.call.durationSeconds !== null ? d.call.durationSeconds + 's' : '—' }}</dd>
            <dt>Outcome</dt>
            <dd><app-outcome-badge [outcome]="d.call.outcome" /></dd>
            <dt>Ended in state</dt>
            <dd class="muted">{{ d.call.finalState ?? '—' }}</dd>
          </dl>
        </div>
      </div>

      <div class="panel">
        <header>Transcript</header>
        <div class="body">
          @if (d.transcript.length === 0) {
            <div class="empty">Nothing was transcribed.</div>
          } @else {
            <div class="transcript">
              @for (turn of d.transcript; track turn.id) {
                <div class="turn {{ turn.speaker }}">
                  <div class="who">{{ turn.speaker === 'ai' ? 'Receptionist' : 'Caller' }}</div>
                  {{ turn.text }}
                </div>
              }
            </div>
          }
        </div>
      </div>

      <div class="panel">
        <header>Extracted information</header>
        <div class="body">
          @if (extractedEntries(d).length === 0) {
            <div class="empty">Nothing was extracted.</div>
          } @else {
            <dl class="kv">
              @for (entry of extractedEntries(d); track entry.key) {
                <dt>{{ entry.key }}</dt>
                <dd>{{ entry.value }}</dd>
              }
            </dl>
          }
        </div>
      </div>

      @if (d.lead) {
        <div class="panel">
          <header>
            Lead
            <app-status-badge [status]="d.lead.status" />
          </header>
          <div class="body">
            <dl class="kv">
              <dt>Service</dt>
              <dd>{{ d.lead.service }}</dd>
              <dt>Location</dt>
              <dd>{{ d.lead.location }}</dd>
              <dt>Destination</dt>
              <dd>{{ d.lead.destination ?? 'Not provided' }}</dd>
              <dt>Vehicle</dt>
              <dd>{{ vehicleOf(d) }}</dd>
              <dt>Movable</dt>
              <dd>{{ movableOf(d) }}</dd>
              <dt>Notes</dt>
              <dd>{{ d.lead.additionalNotes ?? 'None' }}</dd>
            </dl>
          </div>
        </div>
      }

      @if (d.callbackRequests.length > 0) {
        <div class="panel">
          <header>Callback requests</header>
          <div class="body">
            @for (cb of d.callbackRequests; track cb.id) {
              <p><strong>{{ cb.reason }}</strong></p>
            }
          </div>
        </div>
      }

      <div class="panel">
        <header>Event trail</header>
        <div class="body">
          <ul class="events" style="list-style:none;padding:0;margin:0">
            @for (event of d.events; track event.id) {
              <li>
                <b>{{ event.sequence }}. {{ event.type }}</b>
                @if (event.payload) {
                  — {{ summarise(event.payload) }}
                }
              </li>
            }
          </ul>
        </div>
      </div>
    } @else if (!error()) {
      <div class="empty">Loading…</div>
    }
  `,
})
export class CallDetailPage implements OnInit {
  /** Bound from the route via withComponentInputBinding. */
  @Input() id!: string;

  protected readonly detail = signal<CallDetail | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.api.call(this.id).subscribe({
      next: (detail) => this.detail.set(detail),
      error: () => this.error.set('Could not load that call.'),
    });
  }

  protected extractedEntries(d: CallDetail): Array<{ key: string; value: string }> {
    return Object.entries(d.extractedInformation)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => ({
        key: humanise(key),
        value: typeof value === 'boolean' ? (value ? 'Yes' : 'No') : String(value),
      }));
  }

  protected vehicleOf(d: CallDetail): string {
    if (!d.lead) return '—';
    const parts = [d.lead.vehicleMake, d.lead.vehicleModel].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
    return d.lead.vehicleType ?? '—';
  }

  protected movableOf(d: CallDetail): string {
    if (!d.lead || d.lead.vehicleMovable === null) return 'Not provided';
    return d.lead.vehicleMovable ? 'Yes' : 'No';
  }

  protected summarise(payload: Record<string, unknown>): string {
    return Object.entries(payload)
      .map(([key, value]) => key + '=' + String(value))
      .join(' ')
      .slice(0, 160);
  }
}

function humanise(key: string): string {
  const spaced = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}
