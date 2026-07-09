import { Notice } from 'obsidian';
import { AICallSettings, CallMessage, LLMReply, MessageContext } from '../types';

export interface GenerateReplyInput {
  messages: CallMessage[];
  persona: string;
  temperature?: number;
  signal?: AbortSignal;
  /** Called for every streamed token delta. */
  onDelta?: (delta: string) => void;
}

export class LLMClient {
  constructor(private getSettings: () => AICallSettings) {}

  /**
   * Stream an assistant reply via OpenAI-compatible /chat/completions SSE.
   * Returns the full text once the stream closes.
   */
  async generateReplyStream(input: GenerateReplyInput): Promise<LLMReply> {
    const settings = this.getSettings();

    if (!settings.llmApiKey.trim() && !this.looksLikeLocalEndpoint(settings.llmBaseUrl)) {
      throw new Error('LLM API Key is empty');
    }

    const url = `${settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;
    console.log('[llm-tts] generateReplyStream URL:', url);

    const body = {
      model: settings.llmModel,
      messages: this.buildMessages(input),
      temperature: input.temperature ?? settings.temperature,
      stream: true,
    };
    console.log('[llm-tts] generateReplyStream body:', body);

    let response: Response;
    try {
      console.log('[llm-tts] generateReplyStream fetching...');
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.llmApiKey
            ? { Authorization: `Bearer ${settings.llmApiKey}` }
            : {}),
        },
        body: JSON.stringify(body),
        signal: input.signal,
      });
      console.log('[llm-tts] generateReplyStream fetch response ok:', response.ok, 'status:', response.status);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new Error(
        `LLM request failed: ${(err as Error).message}. ` +
          `If you hit CORS, set a base URL that allows browser fetch, or run inside the desktop app.`,
      );
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM ${response.status}: ${text || response.statusText}`);
    }

    if (!response.body) {
      throw new Error('LLM response has no body');
    }

    console.log('[llm-tts] generateReplyStream consuming stream...');
    const full = await this.consumeSseStream(response.body, input.onDelta, input.signal);
    console.log('[llm-tts] generateReplyStream finished. Length:', full.length);

    const reply = full.trim();
    if (!reply) throw new Error('LLM returned empty response');

    return { reply };
  }

  private buildMessages(input: GenerateReplyInput) {
    const history = input.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({
        role: m.role,
        content: m.context
          ? `${formatContextBlock(m.context)}\n\n${m.text}`
          : m.text,
      }));

    return [{ role: 'system', content: input.persona }, ...history];
  }

  private looksLikeLocalEndpoint(baseUrl: string): boolean {
    const lower = baseUrl.toLowerCase();
    return (
      lower.includes('localhost') ||
      lower.includes('127.0.0.1') ||
      lower.includes('0.0.0.0')
    );
  }

  /**
   * Parse OpenAI-style SSE: lines starting with "data: ".
   * Each data line is either "[DONE]" or a JSON chunk with
   * choices[0].delta.content.
   */
  private async consumeSseStream(
    body: ReadableStream<Uint8Array>,
    onDelta: ((delta: string) => void) | undefined,
    signal?: AbortSignal,
  ): Promise<string> {
    const reader = body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let full = '';

    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        let nlIndex: number;
        while ((nlIndex = buffer.indexOf('\n')) !== -1) {
          const rawLine = buffer.slice(0, nlIndex);
          buffer = buffer.slice(nlIndex + 1);
          const line = rawLine.replace(/\r$/, '').trim();

          if (!line) continue;
          if (line.startsWith(':')) continue; // comment / keep-alive
          if (!line.startsWith('data:')) continue;

          const data = line.slice(5).trim();
          if (data === '[DONE]') {
            return full;
          }

          const delta = this.extractDelta(data);
          if (delta) {
            full += delta;
            onDelta?.(delta);
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* noop */
      }
    }

    return full;
  }

  private extractDelta(data: string): string {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return '';
    }

    const choices = (parsed as { choices?: Array<{ delta?: { content?: string } }> })?.choices;
    const delta = choices?.[0]?.delta?.content;
    return typeof delta === 'string' ? delta : '';
  }

  /**
   * Translate a detailed technical reply into a pure spoken text suitable for TTS,
   * using a fixed instruction prompt.
   */
  async translateToTTS(
    technicalText: string,
    signal?: AbortSignal,
    onDelta?: (delta: string) => void,
  ): Promise<string> {
    const settings = this.getSettings();
    if (!settings.llmApiKey.trim() && !this.looksLikeLocalEndpoint(settings.llmBaseUrl)) {
      throw new Error('LLM API Key is empty');
    }

    const url = `${settings.llmBaseUrl.replace(/\/$/, '')}/chat/completions`;

    const systemPrompt = `你是一位经验丰富、正在一对一辅导学生的 CPA 会计名师。请把我提供的一段含有排版、分录的硬核技术拆解，翻译改写为适合 TTS 语音朗读的纯口语语料。

要求与规则：
1. **内容不打折**：100%保留原文中提到的所有核心技术观点、商业实质、防造假/操纵负债利润的逻辑 and 具体分录，绝对不能删减核心内容。
2. **名师口语化**：转换为轻松、亲切的聊天讲解语气，多用“你想啊”、“对吧”、“也就是说”等自然的口语连接词，听起来像老师在耳边跟自己对话。
3. **口头念出分录**：遇到“借：交易性金融资产，贷：投资收益”这类会计分录，必须将其翻译成用嘴念出来的文字，例如：“咱们要借记交易性金融资产，贷记投资收益”。
4. **剔除排版与怪异字符**：
   - 严禁输出任何 Markdown 符号（如 #、**、-、*、数字列表）、代码块、括号和引号。
   - 如果原文有表格，请将其改写为自然顺畅的段落对比论述，严禁输出表格格式或制表符（如 |）。
   - 如果遇到大写英文简称（如 OCI、FV、FVTPL），请口语化改写为它们的中文含义（如其他综合收益、公允价值）。
   - 全靠逗号和句号做自然的呼吸停顿，直接输出翻译改写后的纯文本正文。`;

    const body = {
      model: settings.llmModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: technicalText }
      ],
      temperature: 0.7,
      stream: true,
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(settings.llmApiKey ? { Authorization: `Bearer ${settings.llmApiKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') throw err;
      throw new Error(`LLM translation failed: ${(err as Error).message}`);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`LLM ${response.status}: ${text || response.statusText}`);
    }

    if (!response.body) {
      throw new Error('LLM response has no body');
    }

    return this.consumeSseStream(response.body, onDelta, signal);
  }

  /** Show a non-blocking error notice for caller convenience. */
  notifyError(err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message === 'Aborted' || (err as Error)?.name === 'AbortError') return;
    new Notice(`LLM error: ${message}`, 6000);
    console.error('[llm-tts] LLM error', err);
  }
}

/**
 * Render an attached heading-block as an XML-style chunk. Tag name depends on
 * scope so the model knows whether it's looking at a single knowledge point,
 * a whole section, or the entire chapter outline.
 */
export function formatContextBlock(ctx: MessageContext): string {
  const headingChain = ctx.headingPath.length
    ? ctx.headingPath.join(' › ')
    : '(无标题)';

  let prefix = '';
  if (ctx.scope === 'h3-single') {
    prefix = `【CPA 教材参考上下文 - 单个知识点】\n大纲路径: ${headingChain}\n`;
    return `${prefix}\n<knowledge_point path="${ctx.path}">\n${ctx.content}\n</knowledge_point>`;
  }

  if (ctx.scope === 'h2-block') {
    prefix = `【CPA 教材参考上下文 - 整节大纲】\n大纲路径: ${headingChain}\n`;
    return `${prefix}\n<section path="${ctx.path}">\n${ctx.content}\n</section>`;
  }

  // all-h3
  prefix = `【CPA 教材参考上下文 - 整章所有知识点】\n`;
  return `${prefix}\n<chapter_outline path="${ctx.path}">\n${ctx.content}\n</chapter_outline>`;
}
