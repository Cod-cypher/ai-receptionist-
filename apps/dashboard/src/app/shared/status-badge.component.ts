import { Component, Input } from '@angular/core';

/** Lead and callback status pill. The class name drives the colour. */
@Component({
  selector: 'app-status-badge',
  standalone: true,
  template: `<span class="badge {{ status }}">{{ label }}</span>`,
})
export class StatusBadgeComponent {
  @Input({ required: true }) status!: string;

  get label(): string {
    return this.status.charAt(0).toUpperCase() + this.status.slice(1);
  }
}
