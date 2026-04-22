import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';

interface ApiResponse<T> {
  data: T;
}

@Injectable({
  providedIn: 'root'
})
export class ExampleService {
  private http = inject(HttpClient);
  private readonly apiUrl = '/api/v1';

  getItems<T>() {
    return this.http.get<ApiResponse<T[]>>(`${this.apiUrl}/items`);
  }

  getItem<T>(id: string) {
    return this.http.get<ApiResponse<T>>(`${this.apiUrl}/items/${id}`);
  }

  createItem<T>(payload: Partial<T>) {
    return this.http.post<ApiResponse<T>>(`${this.apiUrl}/items`, payload);
  }

  updateItem<T>(id: string, payload: Partial<T>) {
    return this.http.put<ApiResponse<T>>(`${this.apiUrl}/items/${id}`, payload);
  }

  deleteItem(id: string) {
    return this.http.delete(`${this.apiUrl}/items/${id}`);
  }
}
