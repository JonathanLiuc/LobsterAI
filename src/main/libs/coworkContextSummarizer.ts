/**
 * Context summarizer for Cowork sessions.
 *
 * When a session's estimated token usage exceeds a configured threshold
 * (default 80% of contextWindow), this module calls the current LLM to
 * generate a concise summary of older messages and replaces them with a
 * single system-level summary message, keeping the last few turns intact.
 */

import type { CoworkMessage } from '../coworkStore';
import type { CoworkApiConfig } from './coworkConfigStore';
import { coworkLog } from './coworkLogger';

/** Fraction of contextWindow that triggers summarization (0–1). */
export const CONTEXT_SUMMARY_THRESHOLD = 0.8;

/** Number of recent message pairs (user+assistant) to keep verbatim after summarization. */
const KEEP_RECENT_TURNS = 3;

/**
 * Estimate the token count for a list of messages using the simple heuristic
 * of chars / 4 (industry-accepted approximation).
 */
export function estimateTokenCount(messages: CoworkMessage[]): number {
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  return Math.round(totalChars / 4);
}

/**
 * Returns true when the session history has exceeded the summarization
 * threshold and should be compacted.
 *
 * @param messages   Current session messages.
 * @param contextWindow  The provider's configured context window in tokens.
 */
export function shouldSummarize(messages: CoworkMessage[], contextWindow: number): boolean {
  if (contextWindow <= 0 || messages.length === 0) return false;
  const estimated = estimateTokenCount(messages);
  return estimated / contextWindow >= CONTEXT_SUMMARY_THRESHOLD;
}

/** Summary marker embedded in the summary message content so it can be detected later. */
const SUMMARY_MARKER = '[CONTEXT_SUMMARY]';

/**
 * Build the LLM request body for Anthropic-compatible endpoints.
 */
function buildAnthropicSummaryRequest(
  config: CoworkApiConfig,
  historyText: string,
): object {
  return {
    model: config.model,
    max_tokens: 2048,
    temperature: 0,
    system:
      'You are a concise summarizer. Given a conversation history, produce a brief but comprehensive summary that preserves key facts, decisions, task context, file paths, and any unresolved issues. Output plain text only.',
    messages: [
      {
        role: 'user',
        content: `Please summarize the following conversation history:\n\n${historyText}`,
      },
    ],
  };
}

/**
 * Build the LLM request body for OpenAI-compatible endpoints.
 */
function buildOpenAISummaryRequest(
  config: CoworkApiConfig,
  historyText: string,
): object {
  return {
    model: config.model,
    max_tokens: 2048,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You are a concise summarizer. Given a conversation history, produce a brief but comprehensive summary that preserves key facts, decisions, task context, file paths, and any unresolved issues. Output plain text only.',
      },
      {
        role: 'user',
        content: `Please summarize the following conversation history:\n\n${historyText}`,
      },
    ],
  };
}

function extractTextFromResponse(payload: unknown, apiType: 'anthropic' | 'openai'): string | null {
  if (apiType === 'anthropic') {
    // Anthropic format: { content: [{ type: 'text', text: '...' }] }
    const p = payload as { content?: Array<{ type: string; text?: string }> };
    return p?.content?.find(b => b.type === 'text')?.text ?? null;
  }
  // OpenAI format: { choices: [{ message: { content: '...' } }] }
  const p = payload as { choices?: Array<{ message?: { content?: string } }> };
  return p?.choices?.[0]?.message?.content ?? null;
}

/**
 * Call the LLM to summarize the given history text.
 * Returns the summary string, or null on failure.
 */
async function callLlmForSummary(
  config: CoworkApiConfig,
  historyText: string,
): Promise<string | null> {
  const isAnthropic = config.apiType === 'anthropic';
  const url = isAnthropic
    ? `${config.baseURL}/v1/messages`
    : `${config.baseURL}/chat/completions`;

  const body = isAnthropic
    ? buildAnthropicSummaryRequest(config, historyText)
    : buildOpenAISummaryRequest(config, historyText);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (isAnthropic) {
    headers['x-api-key'] = config.apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers['Authorization'] = `Bearer ${config.apiKey}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      coworkLog('WARN', 'ContextSummarizer', `LLM request failed with status ${response.status}`);
      return null;
    }

    const payload = await response.json();
    return extractTextFromResponse(payload, config.apiType as 'anthropic' | 'openai');
  } catch (err) {
    coworkLog('ERROR', 'ContextSummarizer', `LLM request error: ${String(err)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Format a list of messages into a human-readable transcript for the LLM.
 */
function formatMessagesForSummary(messages: CoworkMessage[]): string {
  return messages
    .filter(m => m.type === 'user' || m.type === 'assistant')
    .map(m => `${m.type === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 4000)}`)
    .join('\n\n');
}

export interface SummarizeResult {
  /** Messages to retain (old messages replaced by summary + recent turns). */
  newMessages: Array<Omit<CoworkMessage, 'id' | 'timestamp'>>;
  summaryText: string;
}

/**
 * Generate a summary for the session's message history.
 *
 * Strategy:
 *  1. Keep the last KEEP_RECENT_TURNS user+assistant exchanges verbatim.
 *  2. Summarize everything before that with an LLM call.
 *  3. Return a new message list: [summary_system_message, ...recentMessages].
 *
 * Returns null if summarization fails or is not needed.
 */
export async function summarizeSessionHistory(
  messages: CoworkMessage[],
  config: CoworkApiConfig,
): Promise<SummarizeResult | null> {
  // Separate messages that can be summarized vs recent turns to keep.
  const conversationMessages = messages.filter(
    m => m.type === 'user' || m.type === 'assistant',
  );
  const otherMessages = messages.filter(
    m => m.type !== 'user' && m.type !== 'assistant',
  );

  // Determine split point: keep last KEEP_RECENT_TURNS * 2 conversation messages
  const keepCount = KEEP_RECENT_TURNS * 2;
  if (conversationMessages.length <= keepCount) {
    // Not enough history to summarize meaningfully
    return null;
  }

  const toSummarize = conversationMessages.slice(0, conversationMessages.length - keepCount);
  const recentConversation = conversationMessages.slice(conversationMessages.length - keepCount);

  const historyText = formatMessagesForSummary(toSummarize);
  coworkLog('INFO', 'ContextSummarizer', `Summarizing ${toSummarize.length} messages (~${Math.round(historyText.length / 4)} tokens)`);

  const summaryText = await callLlmForSummary(config, historyText);
  if (!summaryText) {
    coworkLog('WARN', 'ContextSummarizer', 'Failed to obtain summary from LLM');
    return null;
  }

  const summaryMessage: Omit<CoworkMessage, 'id' | 'timestamp'> = {
    type: 'system',
    content: `${SUMMARY_MARKER}\n\n${summaryText}`,
    metadata: { isSummary: true, summarizedCount: toSummarize.length },
  };

  const newMessages: Array<Omit<CoworkMessage, 'id' | 'timestamp'>> = [
    summaryMessage,
    ...otherMessages.map(m => ({ type: m.type, content: m.content, metadata: m.metadata })),
    ...recentConversation.map(m => ({ type: m.type, content: m.content, metadata: m.metadata })),
  ];

  coworkLog('INFO', 'ContextSummarizer', `Summary complete: ${toSummarize.length} messages -> 1 summary + ${recentConversation.length} recent`);
  return { newMessages, summaryText };
}
