import { Component, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

import { ApiService } from '../../core/api.service';
import type { BusinessProfile } from '../../core/api.types';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page-head">
      <h1>Settings</h1>
      <p>What the receptionist knows about your business.</p>
    </div>

    @if (error()) {
      <div class="error">{{ error() }}</div>
    }
    @if (saved()) {
      <div class="error" style="background:var(--success-soft);color:var(--success)">
        Saved.
      </div>
    }

    @if (profile(); as p) {
      <div class="panel">
        <header>Business details</header>
        <div class="body">
          <label>
            <span>Business name</span>
            <input [(ngModel)]="form.name" />
          </label>
          <label>
            <span>Phone</span>
            <input [(ngModel)]="form.phone" />
          </label>
          <label>
            <span>Website</span>
            <input [(ngModel)]="form.website" placeholder="https://…" />
          </label>
          <label>
            <span>Address</span>
            <input [(ngModel)]="form.address" />
          </label>
          <label>
            <span>Service areas (one per line)</span>
            <textarea [(ngModel)]="form.serviceAreas"></textarea>
          </label>
          <label>
            <span>Pricing information</span>
            <textarea [(ngModel)]="form.pricingInfo"></textarea>
            <small class="muted">
              The receptionist may read this out when asked about price. It will
              never invent a figure that is not written here.
            </small>
          </label>
          <label>
            <span>Emergency contact</span>
            <input [(ngModel)]="form.emergencyContact" />
          </label>
          <button class="primary" type="button" (click)="saveBusiness()">
            Save business details
          </button>
        </div>
      </div>

      <div class="panel">
        <header>WhatsApp notifications</header>
        <div class="body">
          <label>
            <span>WhatsApp number for new leads (E.164)</span>
            <input [(ngModel)]="form.whatsappNumber" placeholder="+923001234567" />
            <small class="muted">
              Every lead is sent here the moment it is captured. Leave blank to
              stop notifications; leads are still saved either way.
            </small>
          </label>
          <label>
            <span>Default country prefix for spoken numbers</span>
            <input [(ngModel)]="form.defaultRegionPrefix" placeholder="+92" />
          </label>
          <button class="primary" type="button" (click)="saveBusiness()">
            Save notification settings
          </button>
        </div>
      </div>

      <div class="panel">
        <header>Receptionist</header>
        <div class="body">
          <label>
            <span>Greeting</span>
            <input
              [(ngModel)]="form.greeting"
              placeholder="Thanks for calling. How can I help?"
            />
          </label>
          <label>
            <span>Tone</span>
            <select [(ngModel)]="form.tone">
              <option value="professional">Professional</option>
              <option value="friendly">Friendly</option>
              <option value="calm">Calm</option>
            </select>
          </label>
          <label>
            <span>Style guidance</span>
            <textarea [(ngModel)]="form.businessInstructions"></textarea>
            <small class="muted">
              Hints about wording only. These cannot change what the receptionist
              is allowed to say — it will never quote a price, promise an arrival
              time, or say a truck has been sent, whatever is written here.
            </small>
          </label>
          <label>
            <span>When it cannot help</span>
            <select [(ngModel)]="form.fallbackBehavior">
              <option value="callback">Take a callback request</option>
              <option value="emergency_contact">Read out the emergency contact</option>
            </select>
          </label>
          <button class="primary" type="button" (click)="saveSettings()">
            Save receptionist settings
          </button>
        </div>
      </div>

      <div class="panel">
        <header>Frequently asked questions</header>
        <div class="body">
          <p class="muted">
            The receptionist answers from these. Anything not covered becomes a
            callback request rather than a guess.
          </p>
          @for (entry of form.faq; track $index) {
            <div style="border:1px solid var(--border);border-radius:6px;padding:12px;margin-bottom:10px">
              <label>
                <span>Question</span>
                <input [(ngModel)]="entry.question" />
              </label>
              <label style="margin-bottom:8px">
                <span>Answer</span>
                <textarea [(ngModel)]="entry.answer"></textarea>
              </label>
              <button type="button" (click)="removeFaq($index)">Remove</button>
            </div>
          }
          <button type="button" (click)="addFaq()">Add question</button>
          <button class="primary" type="button" (click)="saveSettings()" style="margin-left:8px">
            Save questions
          </button>
        </div>
      </div>

      <div class="panel">
        <header>Services</header>
        <div class="body">
          <div class="table-wrap">
            <table>
              <thead>
                <tr><th>Service</th><th>Active</th><th></th></tr>
              </thead>
              <tbody>
                @for (service of p.services; track service.id) {
                  <tr>
                    <td>{{ service.name }}</td>
                    <td>{{ service.isActive ? 'Yes' : 'No' }}</td>
                    <td>
                      <button type="button" (click)="removeService(service.id)">Remove</button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
          <div class="filters" style="margin-top:12px">
            <input [(ngModel)]="newService" placeholder="Add a service" />
            <button type="button" (click)="addService()">Add</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <header>Phone numbers</header>
        <div class="body">
          <p class="muted">
            Calls to these numbers reach your receptionist. Forward your existing
            line here on no-answer.
          </p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Number</th><th>Provider</th></tr></thead>
              <tbody>
                @for (number of p.phoneNumbers; track number.id) {
                  <tr><td>{{ number.e164 }}</td><td>{{ number.provider }}</td></tr>
                }
              </tbody>
            </table>
          </div>
          <div class="filters" style="margin-top:12px">
            <input [(ngModel)]="newNumber" placeholder="+924235000001" />
            <button type="button" (click)="addNumber()">Attach number</button>
          </div>
        </div>
      </div>
    } @else if (!error()) {
      <div class="empty">Loading…</div>
    }
  `,
})
export class SettingsPage implements OnInit {
  protected readonly profile = signal<BusinessProfile | null>(null);
  protected readonly error = signal<string | null>(null);
  protected readonly saved = signal(false);

  protected newService = '';
  protected newNumber = '';

  protected form = {
    name: '',
    phone: '',
    website: '',
    address: '',
    serviceAreas: '',
    pricingInfo: '',
    emergencyContact: '',
    whatsappNumber: '',
    defaultRegionPrefix: '',
    greeting: '',
    tone: 'friendly' as 'professional' | 'friendly' | 'calm',
    businessInstructions: '',
    fallbackBehavior: 'callback' as 'callback' | 'emergency_contact',
    faq: [] as Array<{ question: string; answer: string }>,
  };

  constructor(private readonly api: ApiService) {}

  ngOnInit(): void {
    this.load();
  }

  private load(): void {
    this.api.businessProfile().subscribe({
      next: (profile) => {
        this.profile.set(profile);
        const b = profile.business;
        const s = profile.settings;
        this.form = {
          name: b.name,
          phone: b.phone ?? '',
          website: b.website ?? '',
          address: b.address ?? '',
          serviceAreas: (b.serviceAreas ?? []).join('\n'),
          pricingInfo: b.pricingInfo ?? '',
          emergencyContact: b.emergencyContact ?? '',
          whatsappNumber: b.whatsappNumber ?? '',
          defaultRegionPrefix: b.defaultRegionPrefix ?? '',
          greeting: s?.greeting ?? '',
          tone: s?.tone ?? 'friendly',
          businessInstructions: s?.businessInstructions ?? '',
          fallbackBehavior: s?.fallbackBehavior ?? 'callback',
          faq: (s?.faq ?? []).map((f) => ({ ...f })),
        };
      },
      error: () => this.error.set('Could not load your settings.'),
    });
  }

  protected saveBusiness(): void {
    // Empty strings mean "cleared", which the API expects as null.
    const payload = {
      name: this.form.name,
      phone: blankToNull(this.form.phone),
      website: blankToNull(this.form.website),
      address: blankToNull(this.form.address),
      serviceAreas: this.form.serviceAreas
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean),
      pricingInfo: blankToNull(this.form.pricingInfo),
      emergencyContact: blankToNull(this.form.emergencyContact),
      whatsappNumber: blankToNull(this.form.whatsappNumber),
      defaultRegionPrefix: blankToNull(this.form.defaultRegionPrefix),
    };

    this.api.updateBusiness(payload).subscribe({
      next: () => this.flashSaved(),
      error: (e) => this.error.set(readError(e)),
    });
  }

  protected saveSettings(): void {
    this.api
      .updateSettings({
        greeting: blankToNull(this.form.greeting),
        tone: this.form.tone,
        businessInstructions: blankToNull(this.form.businessInstructions),
        fallbackBehavior: this.form.fallbackBehavior,
        faq: this.form.faq.filter((f) => f.question.trim() && f.answer.trim()),
      })
      .subscribe({
        next: () => this.flashSaved(),
        error: (e) => this.error.set(readError(e)),
      });
  }

  protected addFaq(): void {
    this.form.faq = [...this.form.faq, { question: '', answer: '' }];
  }

  protected removeFaq(index: number): void {
    this.form.faq = this.form.faq.filter((_, i) => i !== index);
  }

  protected addService(): void {
    if (!this.newService.trim()) return;
    this.api.addService({ name: this.newService.trim() }).subscribe({
      next: () => {
        this.newService = '';
        this.load();
      },
      error: (e) => this.error.set(readError(e)),
    });
  }

  protected removeService(id: string): void {
    this.api.deleteService(id).subscribe({
      next: () => this.load(),
      error: (e) => this.error.set(readError(e)),
    });
  }

  protected addNumber(): void {
    if (!this.newNumber.trim()) return;
    this.api.addPhoneNumber(this.newNumber.trim()).subscribe({
      next: () => {
        this.newNumber = '';
        this.load();
      },
      error: (e) => this.error.set(readError(e)),
    });
  }

  private flashSaved(): void {
    this.error.set(null);
    this.saved.set(true);
    setTimeout(() => this.saved.set(false), 2500);
  }
}

function blankToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readError(error: unknown): string {
  const body = (error as { error?: { message?: string; details?: Array<{ message: string }> } })
    ?.error;
  if (body?.details?.length) return body.details.map((d) => d.message).join(', ');
  return body?.message ?? 'Could not save those changes.';
}
