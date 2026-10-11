// One place that decides which LLM provider Bulwark talks to. Both speak the
// Anthropic Messages API, so the same SDK and the same neatlogs wrapper work:
//   - Anthropic direct (ANTHROPIC_API_KEY)
//   - 0G Compute Router (ZG_ROUTER_API_KEY), which serves Claude over /v1/messages
// Anthropic direct wins if both are set.

import Anthropic from '@anthropic-ai/sdk';
import { wrapAnthropic } from 'neatlogs';

export type LlmProvider = 'anthropic' | '0g';

const DEFAULT_MODELS: Record<LlmProvider, { fixer: string; agent: string }> = {
  anthropic: { fixer: 'claude-sonnet-5-5', agent: 'claude-haiku-5-5' },
  '0g': { fixer: 'claude-sonnet-5', agent: 'claude-sonnet-5' },
};

export function llmProvider(): LlmProvider | undefined {
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.ZG_ROUTER_API_KEY) return '0g';
  return undefined;
}

export function llmLabel(): string {
  const p = llmProvider();
  return p === '0g' ? '0G Router' : p === 'anthropic' ? 'Anthropic' : 'none';
}

export function createLlmClient(): Anthropic {
  const provider = llmProvider();
  if (provider === '0g') {
    return wrapAnthropic(
      new Anthropic({
        apiKey: null,
        authToken: process.env.ZG_ROUTER_API_KEY,
        baseURL: process.env.ZG_ROUTER_BASE_URL || 'https://router-api.0g.ai',
      }),
    );
  }
  if (provider === 'anthropic') return wrapAnthropic(new Anthropic());
  throw new Error('No LLM configured: set ZG_ROUTER_API_KEY or ANTHROPIC_API_KEY in .env');
}

export function defaultModel(role: 'fixer' | 'agent'): string {
  const override = role === 'fixer' ? process.env.BULWARK_MODEL : process.env.REFUNDBOT_MODEL;
  return override || DEFAULT_MODELS[llmProvider() ?? 'anthropic'][role];
}
