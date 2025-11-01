import axios from 'axios';
import { BaseEvent } from '../types/events';

export interface ScreenshotUploadBody {
  deviceId: string;
  domain: 'windows-desktop';
  username: string;
  screenshot: string; // data:image/png;base64,...
}

export class ApiClient {
  constructor(private readonly baseUrl: string) {}

  async sendActivityBatch(events: BaseEvent[]): Promise<void> {
    if (!this.baseUrl) return;
    await axios.post(`${this.baseUrl}/collect-activity`, { events });
  }

  async uploadScreenshot(body: ScreenshotUploadBody): Promise<void> {
    if (!this.baseUrl) return;
    await axios.post(`${this.baseUrl}/collect-screenshot`, body, {
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
  }
}


