import { requestUrl } from 'obsidian';
import { AICallSettings, TTSAudioResult } from '../types';

export interface VolcanoSynthesizeOptions {
  text: string;
  signal?: AbortSignal;
}

export class VolcanoTTSClient {
  constructor(private getSettings: () => AICallSettings) {}

  async synthesize(
    options: VolcanoSynthesizeOptions,
  ): Promise<TTSAudioResult> {
    const settings = this.getSettings();
    const apiKey = settings.volcanoApiKey?.trim();
    const resourceId = settings.volcanoResourceId?.trim() || 'seed-tts-2.0';
    const speaker = settings.volcanoSpeaker?.trim();
    const sampleRate = settings.volcanoSampleRate || 24000;

    if (!apiKey) {
      throw new Error('火山 API Key 未设置');
    }
    if (!speaker) {
      throw new Error('火山 Speaker ID (音色) 未设置');
    }

    const response = await requestUrl({
      url: 'https://openspeech.bytedance.com/api/v3/tts/unidirectional',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId
      },
      body: JSON.stringify({
        user: {
          uid: 'obsidian-user'
        },
        req_params: {
          text: options.text,
          speaker: speaker,
          audio_params: {
            format: 'mp3',
            sample_rate: sampleRate
          }
        }
      }),
      throw: false
    });

    if (response.status >= 400) {
      const detail = typeof response.text === 'string' ? response.text : JSON.stringify(response.json);
      throw new Error(`Volcano V3 TTS 失败 ${response.status}: ${detail}`);
    }

    const arrayBuffer = response.arrayBuffer;
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('火山引擎未返回任何数据');
    }

    // Decode the response as text to inspect if it is a JSON response
    const decoder = new TextDecoder('utf-8');
    const text = decoder.decode(arrayBuffer);
    
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const binaryChunks: Uint8Array[] = [];
    let isJson = false;

    for (const line of lines) {
      if (line.startsWith('{')) {
        isJson = true;
        try {
          const parsed = JSON.parse(line);
          const isSuccess = parsed.code === 0 || parsed.code === 20000000;
          if (!isSuccess) {
            throw new Error(`火山引擎接口报错 (${parsed.code}): ${parsed.message || '未知错误'}`);
          }
          if (parsed.data) {
            const chunk = base64ToUint8Array(parsed.data);
            binaryChunks.push(chunk);
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes('火山引擎接口报错')) throw e;
          console.warn('[llm-tts] Failed to parse JSON line:', line, e);
        }
      }
    }

    if (isJson) {
      if (binaryChunks.length === 0) {
        throw new Error('火山引擎未返回任何音频数据 (所有数据块的 data 字段均为空)');
      }
      
      // Concatenate all binary chunks
      let totalLength = 0;
      for (const chunk of binaryChunks) {
        totalLength += chunk.length;
      }
      const concatenated = new Uint8Array(totalLength);
      let offset = 0;
      for (const chunk of binaryChunks) {
        concatenated.set(chunk, offset);
        offset += chunk.length;
      }

      return {
        kind: 'audio',
        blob: new Blob([concatenated.buffer], { type: 'audio/mpeg' }),
        mimeType: 'audio/mpeg'
      };
    }

    // Fallback in case raw binary audio is returned directly
    return {
      kind: 'audio',
      blob: new Blob([arrayBuffer], { type: 'audio/mpeg' }),
      mimeType: 'audio/mpeg'
    };
  }
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
