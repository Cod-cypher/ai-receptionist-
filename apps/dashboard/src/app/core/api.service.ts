import { Injectable } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Observable } from 'rxjs';

import type {
  BusinessProfile,
  CallDetail,
  Call,
  CallbackRequest,
  Lead,
  LeadStatus,
  NotificationRecord,
  Overview,
  Paged,
} from './api.types';

/**
 * The API surface the dashboard uses.
 *
 * Note what is absent: no endpoint takes a business id. Scope comes from the
 * access token on the server, so there is no request the UI could make that
 * would reach another towing company's data.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  constructor(private readonly http: HttpClient) {}

  overview(days = 30): Observable<Overview> {
    return this.http.get<Overview>('/api/dashboard/overview', {
      params: new HttpParams().set('days', days),
    });
  }

  leads(query: {
    status?: LeadStatus | '';
    search?: string;
    limit?: number;
    offset?: number;
  }): Observable<Paged<Lead>> {
    let params = new HttpParams()
      .set('limit', query.limit ?? 25)
      .set('offset', query.offset ?? 0);
    if (query.status) params = params.set('status', query.status);
    if (query.search) params = params.set('search', query.search);

    return this.http.get<Paged<Lead>>('/api/leads', { params });
  }

  lead(id: string): Observable<Lead> {
    return this.http.get<Lead>('/api/leads/' + id);
  }

  setLeadStatus(id: string, status: LeadStatus): Observable<Lead> {
    return this.http.patch<Lead>('/api/leads/' + id + '/status', { status });
  }

  calls(query: { limit?: number; offset?: number } = {}): Observable<Paged<Call>> {
    return this.http.get<Paged<Call>>('/api/calls', {
      params: new HttpParams()
        .set('limit', query.limit ?? 25)
        .set('offset', query.offset ?? 0),
    });
  }

  call(id: string): Observable<CallDetail> {
    return this.http.get<CallDetail>('/api/calls/' + id);
  }

  callbacks(query: {
    status?: 'open' | 'resolved' | '';
    limit?: number;
    offset?: number;
  }): Observable<Paged<CallbackRequest>> {
    let params = new HttpParams()
      .set('limit', query.limit ?? 25)
      .set('offset', query.offset ?? 0);
    if (query.status) params = params.set('status', query.status);

    return this.http.get<Paged<CallbackRequest>>('/api/callbacks', { params });
  }

  setCallbackStatus(
    id: string,
    status: 'open' | 'resolved',
  ): Observable<CallbackRequest> {
    return this.http.patch<CallbackRequest>('/api/callbacks/' + id + '/status', {
      status,
    });
  }

  notifications(query: { status?: string } = {}): Observable<Paged<NotificationRecord>> {
    let params = new HttpParams().set('limit', 50);
    if (query.status) params = params.set('status', query.status);
    return this.http.get<Paged<NotificationRecord>>('/api/notifications', { params });
  }

  retryNotification(id: string): Observable<{ status: string }> {
    return this.http.post<{ status: string }>(
      '/api/notifications/' + id + '/retry',
      {},
    );
  }

  businessProfile(): Observable<BusinessProfile> {
    return this.http.get<BusinessProfile>('/api/business');
  }

  updateBusiness(input: Record<string, unknown>): Observable<unknown> {
    return this.http.put('/api/business', input);
  }

  updateSettings(input: Record<string, unknown>): Observable<unknown> {
    return this.http.put('/api/business/settings', input);
  }

  addService(input: { name: string; description?: string | null }): Observable<unknown> {
    return this.http.post('/api/business/services', input);
  }

  updateService(id: string, input: Record<string, unknown>): Observable<unknown> {
    return this.http.patch('/api/business/services/' + id, input);
  }

  deleteService(id: string): Observable<unknown> {
    return this.http.delete('/api/business/services/' + id);
  }

  addPhoneNumber(e164: string): Observable<unknown> {
    return this.http.post('/api/business/phone-numbers', { e164 });
  }
}
