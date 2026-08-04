import { ProviderRegistry } from './base/ProviderRegistry.js';
import { DeepSeekProvider } from './deepseek/DeepSeekProvider.js';

export * from './base/AIProvider.js';
export * from './base/ProviderRegistry.js';
export * from './deepseek/DeepSeekProvider.js';

export function initializeProviders(): ProviderRegistry {
  const registry = ProviderRegistry.getInstance();

  // Register DeepSeek Provider as default
  const deepseekProvider = new DeepSeekProvider();
  registry.registerProvider(deepseekProvider);
  registry.setDefaultProvider('deepseek');

  return registry;
}
