import axios, { AxiosInstance } from 'axios';
import { config } from '../utils/config';
import { logger } from '../utils/logger';

class ChainInsightService {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      headers: {
        'Content-Type': 'application/json',
        'api-key': config.apiKey,
        'language': 'en'
      },
      timeout: 10000
    });
  }

  async post(endpoint: string, data: any) {
    try {
      console.log('ChainInsight request', endpoint, data);
      const response = await this.client.post(endpoint, data);
      console.log('ChainInsight response', response.data);
      if (response.data.code !== 0) {
        throw new Error(`ChainInsight API error: ${response.data.msg || 'Unknown error'}`);
      }
      return response.data.data;
    } catch (error) {
      logger.error(`ChainInsight API call failed to ${endpoint}`, error);
      throw error;
    }
  }
}

export const chainInsightService = new ChainInsightService();