import { Component, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthService } from '../../core/auth.service';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="login-shell">
      <div class="panel login-card">
        <header>{{ mode() === 'login' ? 'Sign in' : 'Create an account' }}</header>
        <div class="body">
          @if (error()) {
            <div class="error">{{ error() }}</div>
          }

          <form (ngSubmit)="submit()">
            @if (mode() === 'register') {
              <label>
                <span>Towing company name</span>
                <input name="businessName" [(ngModel)]="businessName" required />
              </label>
              <label>
                <span>Your name</span>
                <input name="name" [(ngModel)]="name" required />
              </label>
            }

            <label>
              <span>Email</span>
              <input type="email" name="email" [(ngModel)]="email" required />
            </label>

            <label>
              <span>Password</span>
              <input type="password" name="password" [(ngModel)]="password" required />
              @if (mode() === 'register') {
                <small class="muted">At least 12 characters.</small>
              }
            </label>

            <button class="primary" type="submit" [disabled]="busy()" style="width:100%">
              {{ busy() ? 'Working…' : mode() === 'login' ? 'Sign in' : 'Create account' }}
            </button>
          </form>

          <p class="muted" style="margin-top:14px;margin-bottom:0;font-size:13px">
            @if (mode() === 'login') {
              No account yet?
              <a href="#" (click)="switchTo('register', $event)">Create one</a>
            } @else {
              Already have an account?
              <a href="#" (click)="switchTo('login', $event)">Sign in</a>
            }
          </p>
        </div>
      </div>
    </div>
  `,
})
export class LoginPage {
  protected readonly mode = signal<'login' | 'register'>('login');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected email = '';
  protected password = '';
  protected businessName = '';
  protected name = '';

  constructor(
    private readonly auth: AuthService,
    private readonly router: Router,
  ) {}

  protected switchTo(mode: 'login' | 'register', event: Event): void {
    event.preventDefault();
    this.mode.set(mode);
    this.error.set(null);
  }

  protected async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);

    try {
      if (this.mode() === 'login') {
        await this.auth.login(this.email, this.password);
      } else {
        await this.auth.register({
          businessName: this.businessName,
          email: this.email,
          password: this.password,
          name: this.name,
          // The operator's own clock is what call times should read in.
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC',
        });
      }
      await this.router.navigate(['/overview']);
    } catch (error: unknown) {
      this.error.set(readError(error));
    } finally {
      this.busy.set(false);
    }
  }
}

function readError(error: unknown): string {
  const body = (error as { error?: { message?: string | string[] } })?.error;
  const message = body?.message;
  if (Array.isArray(message)) return message.join(', ');
  if (typeof message === 'string') return message;
  return 'Something went wrong. Please try again.';
}
