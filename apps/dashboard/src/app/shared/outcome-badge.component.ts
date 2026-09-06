import { Component, Input } from '@angular/core';

import type { CallOutcome } from '../core/api.types';

const LABELS: Record<CallOutcome, string> = {
  lead_created: 'Lead',
  callback_created: 'Callback',
  faq_answered: 'Question answered',
  abandoned: 'Abandoned',
  error: 'Error',
};

/** How a call ended, from the operator's point of view. */
@Component({
  selector: 'app-outcome-badge',
  standalone: true,
  template: `<span class="badge {{ cssClass }}">{{ label }}</span>`,
})
export class OutcomeBadgeComponent {
  @Input({ required: true }) outcome!: CallOutcome | null;

  get label(): string {
    return this.outcome ? LABELS[this.outcome] : 'In progress';
  }

  get cssClass(): string {
    switch (this.outcome) {
      case 'lead_created':
        return 'completed';
      case 'callback_created':
        return 'contacted';
      case 'error':
        return 'cancelled';
      default:
        return '';
    }
  }
}
