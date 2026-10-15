import type { LanguageModel } from 'ai';

export enum LLMProvider {
    OPENROUTER = 'openrouter',
}

export enum OPENROUTER_MODELS {
    // Generate object does not work for Anthropic models https://github.com/OpenRouterTeam/ai-sdk-provider/issues/165
    // Cuanto: names kept for upstream compatibility; values point at models allowed by our OpenRouter workspace guardrail.
    CLAUDE_4_5_SONNET = 'anthropic/claude-sonnet-5.5',
    CLAUDE_3_5_HAIKU = 'anthropic/claude-haiku-5.5',
    OPEN_AI_GPT_5 = 'openai/gpt-6.1-sol',
    OPEN_AI_GPT_5_MINI = 'openai/gpt-6-luna',
    OPEN_AI_GPT_5_NANO = 'google/gemini-3.5-flash-lite',
}

interface ModelMapping {
    [LLMProvider.OPENROUTER]: OPENROUTER_MODELS;
}

export type InitialModelPayload = {
    [K in keyof ModelMapping]: {
        provider: K;
        model: ModelMapping[K];
    };
}[keyof ModelMapping];

export type ModelConfig = {
    model: LanguageModel;
    providerOptions?: Record<string, any>;
    headers?: Record<string, string>;
    maxOutputTokens: number;
};

export const MODEL_MAX_TOKENS = {
    [OPENROUTER_MODELS.CLAUDE_4_5_SONNET]: 200000,
    [OPENROUTER_MODELS.CLAUDE_3_5_HAIKU]: 200000,
    [OPENROUTER_MODELS.OPEN_AI_GPT_5_NANO]: 400000,
    [OPENROUTER_MODELS.OPEN_AI_GPT_5_MINI]: 400000,
    [OPENROUTER_MODELS.OPEN_AI_GPT_5]: 400000,
} as const;
