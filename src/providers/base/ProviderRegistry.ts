import { AIProvider, ProviderId, HealthCheckResult } from '../../types/index.js';
import { logger } from '../../logging/logger.js';

export class ProviderRegistry {
  private static instance: ProviderRegistry;
  private providers: Map<ProviderId, AIProvider> = new Map();
  private defaultProviderId: ProviderId = 'deepseek';

  private constructor() {}

  public static getInstance(): ProviderRegistry {
    if (!ProviderRegistry.instance) {
      ProviderRegistry.instance = new ProviderRegistry();
    }
    return ProviderRegistry.instance;
  }

  public registerProvider(provider: AIProvider): void {
    this.providers.set(provider.id, provider);
    logger.info(`[ProviderRegistry] Registered provider '${provider.name}' (${provider.id})`);
  }

  public getProvider(id?: ProviderId): AIProvider {
    const targetId = id || this.defaultProviderId;
    const provider = this.providers.get(targetId);

    if (!provider) {
      throw new Error(`Provider '${targetId}' is not registered. Available providers: ${Array.from(this.providers.keys()).join(', ')}`);
    }

    return provider;
  }

  public setDefaultProvider(id: ProviderId): void {
    if (!this.providers.has(id)) {
      throw new Error(`Cannot set default provider to unregistered provider '${id}'`);
    }
    this.defaultProviderId = id;
    logger.info(`[ProviderRegistry] Default provider set to '${id}'`);
  }

  public getDefaultProviderId(): ProviderId {
    return this.defaultProviderId;
  }

  public listProviders(): Array<{ id: string; name: string }> {
    return Array.from(this.providers.values()).map((p) => ({ id: p.id, name: p.name }));
  }

  public async checkAllHealth(): Promise<HealthCheckResult[]> {
    const results: HealthCheckResult[] = [];
    for (const provider of this.providers.values()) {
      try {
        const health = await provider.health();
        results.push(health);
      } catch (err: any) {
        results.push({
          status: 'down',
          providerId: provider.id,
          message: err.message || 'Health check failed',
        });
      }
    }
    return results;
  }
}
