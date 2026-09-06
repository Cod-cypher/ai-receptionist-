import { Injectable, computed, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';

import type { AuthResponse } from './api.types';

/**
 * Session state.
 *
 * The token is held in a signal and mirrored to localStorage only so a page
 * refresh does not log an operator out mid-shift. No provider API key of any
 * kind reaches the browser — every Twilio, WhatsApp and model call is made
 * server-side.
 */
const STORAGE_KEY = 'towai.session';

interface Session {
  accessToken: string;
  refreshToken: string;
  businessId: string;
  user: AuthResponse['user'];
}

function restore(): Session | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Session) : null;
  } catch {
    return null;
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly session = signal<Session | null>(restore());

  readonly isAuthenticated = computed(() => this.session() !== null);
  readonly user = computed(() => this.session()?.user ?? null);

  constructor(
    private readonly http: HttpClient,
    private readonly router: Router,
  ) {}

  get accessToken(): string | null {
    return this.session()?.accessToken ?? null;
  }

  async login(email: string, password: string): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<AuthResponse>('/api/auth/login', { email, password }),
    );
    this.persist(response);
  }

  async register(input: {
    businessName: string;
    email: string;
    password: string;
    name: string;
    timezone: string;
  }): Promise<void> {
    const response = await firstValueFrom(
      this.http.post<AuthResponse>('/api/auth/register', input),
    );
    this.persist(response);
  }

  /** Exchanges the refresh token. Returns false when the session is truly over. */
  async refresh(): Promise<boolean> {
    const current = this.session();
    if (!current) return false;

    try {
      const tokens = await firstValueFrom(
        this.http.post<{ accessToken: string; refreshToken: string }>(
          '/api/auth/refresh',
          { refreshToken: current.refreshToken },
        ),
      );
      const next = { ...current, ...tokens };
      this.session.set(next);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  }

  logout(): void {
    const current = this.session();
    if (current) {
      // Best effort: server-side revocation matters more than the response.
      this.http
        .post('/api/auth/logout', { refreshToken: current.refreshToken })
        .subscribe({ error: () => undefined });
    }
    this.session.set(null);
    localStorage.removeItem(STORAGE_KEY);
    void this.router.navigate(['/login']);
  }

  private persist(response: AuthResponse): void {
    const session: Session = {
      accessToken: response.accessToken,
      refreshToken: response.refreshToken,
      businessId: response.businessId,
      user: response.user,
    };
    this.session.set(session);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  }
}
