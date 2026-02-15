import axios from 'axios';
import { logger } from '../../../utils/logger';
import { BIG_SYSTEM_PROMPT } from '../constants';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL
  || process.env.GEMINI_MODEL
  || 'gemini-2.5-pro';
const DEFAULT_GEMINI_SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL
  || process.env.GEMINI_MODEL
  || 'gemini-2.5-flash';

const getApiKey = () => process.env.GEMINI_API_KEY || '';

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          data?: string;
          mimeType?: string;
        };
      }>;
    };
  }>;
};

type ChatHistoryItem = {
  role: string;
  content: string;
};

type InlineImagePayload = {
  data: string;
  mimeType: string;
};

const extractCandidateText = (candidate?: any) => {
  if (!candidate?.content?.parts?.length) {
    return '';
  }
  return candidate.content.parts
    .map((part: { text?: string }) => part?.text || '')
    .join('')
    .trim();
};

const buildGeminiContents = (history: ChatHistoryItem[], image?: InlineImagePayload) => {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.map((item, index) => {
    const role = item.role === 'assistant' ? 'model' : 'user';
    const isLast = index === history.length - 1;
    const parts: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> = [];

    if (item.content) {
      parts.push({ text: item.content });
    }

    if (image && isLast && role === 'user') {
      parts.push({
        inlineData: {
          data: image.data,
          mimeType: image.mimeType,
        },
      });
    }

    if (!parts.length) {
      parts.push({ text: 'Kullanıcı bir görsel paylaştı.' });
    }

    return { role, parts };
  });
};

export const generateCoachResponse = async (
  context: string,
  history: Array<{ role: string; content: string }>,
  image?: InlineImagePayload
) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  logger.info({ historyCount: history.length }, 'Gemini coach response request started');
  const contents = buildGeminiContents(history, image);

  const requestBody = {
    systemInstruction: {
      parts: [{ text: `${BIG_SYSTEM_PROMPT}\n\nCONTEXT:\n${context}` }]
    },
    contents
  };

  const response = await axios.post<GeminiResponse>(
    `${GEMINI_BASE_URL}/models/${DEFAULT_GEMINI_CHAT_MODEL}:generateContent?key=${apiKey}`,
    requestBody
  );

  const text = response.data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
  if (!text) {
    logger.warn({ response: response.data }, 'Gemini chat returned empty response');
    throw new Error('Gemini returned empty response');
  }

  return text.trim();
};

export const generateStyledPhoto = async (params: {
  imageBase64: string;
  mimeType: string;
  prompt: string;
  model?: string;
}) => {
  const apiKey = getApiKey();
  const { imageBase64, mimeType, prompt } = params;
  const resolvedModel = params.model || process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

  if (!apiKey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('GEMINI_API_KEY missing; returning source image as generated output in non-production');
      return {
        data: imageBase64,
        mimeType,
        text: 'Mock response used because GEMINI_API_KEY is missing',
      };
    }
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              data: imageBase64,
              mimeType,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
    },
  };

  logger.info({ model: resolvedModel }, 'Gemini style photo generation request started');
  const response = await axios.post<GeminiResponse>(
    `${GEMINI_BASE_URL}/models/${resolvedModel}:generateContent?key=${apiKey}`,
    requestBody
  );

  const parts = response.data?.candidates?.flatMap(candidate => candidate?.content?.parts || []) || [];
  const generatedPart = parts.find(part => part?.inlineData?.data);
  if (!generatedPart?.inlineData?.data) {
    logger.warn({ response: response.data }, 'Gemini style photo generation returned no image part');
    throw new Error('Generated image could not be extracted from provider response');
  }

  const textOutput = parts
    .map(part => part?.text || '')
    .join('')
    .trim();

  return {
    data: generatedPart.inlineData.data,
    mimeType: generatedPart.inlineData.mimeType || 'image/png',
    text: textOutput || undefined,
  };
};

export const generateStyledPhotoWithTemplate = async (params: {
  userImageBase64: string;
  userMimeType: string;
  prompt: string;
  model?: string;
}) => {
  const apiKey = getApiKey();
  const {
    userImageBase64,
    userMimeType,
    prompt,
  } = params;
  const resolvedModel = params.model || process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';

  if (!apiKey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('GEMINI_API_KEY missing; returning source image as generated output in non-production');
      return {
        data: userImageBase64,
        mimeType: userMimeType,
        text: 'Mock response used because GEMINI_API_KEY is missing',
      };
    }
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              
              'Use only the SOURCE BABY IMAGE to produce a new photo.\n\n' +
              'TARGET SCENE:\n' +
              `${prompt}\n\n` +
              'RULES:\n' +
              '- Identity reference must be ONLY the source baby image.\n' +
              '- Preserve facial structure, eyes, nose, lips, skin tone, and body proportions.\n' +
              '- Do not create a new baby identity.\n' +
              '- Output should look like a professional studio photo with the source baby adapted to the target scene.\n' +
              '- Vertical 9:16 composition.\n' +
              '- Ultra realistic, high skin detail, natural newborn softness.\n' +
              '- Return exactly one image.',
          },
          {
            text: 'SOURCE BABY IMAGE (PRIMARY IDENTITY REFERENCE):',
          },
          {
            inlineData: {
              data: userImageBase64,
              mimeType: userMimeType,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT'],
      temperature: 0.2,
    },
  };

  const startedAt = Date.now();
  logger.info(
    {
      model: resolvedModel,
      promptLength: prompt.length,
      userMimeType,
      userImageBytesApprox: userImageBase64.length,
    },
    'Gemini newborn style generation request started'
  );

  let response;
  try {
    response = await axios.post<GeminiResponse>(
      `${GEMINI_BASE_URL}/models/${resolvedModel}:generateContent?key=${apiKey}`,
      requestBody
    );
  } catch (error: any) {
    const providerStatus = error?.response?.status;
    const providerData = error?.response?.data;
    logger.error(
      {
        err: error,
        model: resolvedModel,
        elapsedMs: Date.now() - startedAt,
        providerStatus,
        providerData,
      },
      'Gemini newborn style generation request failed'
    );
    throw error;
  }

  const parts = response.data?.candidates?.flatMap(candidate => candidate?.content?.parts || []) || [];
  const generatedPart = parts.find(part => part?.inlineData?.data);
  if (!generatedPart?.inlineData?.data) {
    logger.warn({ response: response.data }, 'Gemini newborn style generation returned no image part');
    throw new Error('Generated image could not be extracted from provider response');
  }

  const textOutput = parts
    .map(part => part?.text || '')
    .join('')
    .trim();

  logger.info(
    {
      model: resolvedModel,
      elapsedMs: Date.now() - startedAt,
      candidateCount: response.data?.candidates?.length || 0,
      outputMimeType: generatedPart.inlineData.mimeType || 'image/png',
      outputBytesApprox: generatedPart.inlineData.data?.length || 0,
      hasProviderText: Boolean(textOutput),
    },
    'Gemini newborn style generation completed'
  );

  return {
    data: generatedPart.inlineData.data,
    mimeType: generatedPart.inlineData.mimeType || 'image/png',
    text: textOutput || undefined,
  };
};

export const streamCoachResponse = async (params: {
  context: string;
  history: Array<{ role: string; content: string }>;
  image?: InlineImagePayload;
  onDelta: (delta: string, fullText: string) => void;
  onEvent?: (payload: any) => void;
}) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured');
  }

  const { context, history, image, onDelta, onEvent } = params;
  logger.info({ historyCount: history.length }, 'Gemini coach streaming request started');

  const contents = buildGeminiContents(history, image);
  const requestBody = {
    systemInstruction: {
      parts: [{ text: `${BIG_SYSTEM_PROMPT}\n\nCONTEXT:\n${context}` }],
    },
    contents,
  };

  const response = await axios.post(
    `${GEMINI_BASE_URL}/models/${DEFAULT_GEMINI_CHAT_MODEL}:streamGenerateContent?key=${apiKey}&alt=sse`,
    requestBody,
    {
      responseType: 'stream',
      headers: {
        Accept: 'text/event-stream',
      },
    }
  );

  return new Promise<string>((resolve, reject) => {
    let buffer = '';
    let fullText = '';
    const stream = response.data as NodeJS.ReadableStream;

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }

      let payloadText = trimmed;
      if (payloadText.startsWith('data:')) {
        payloadText = payloadText.replace(/^data:\s*/, '');
      }

      if (!payloadText || payloadText === '[DONE]') {
        return;
      }

      try {
        const parsed = JSON.parse(payloadText);
        onEvent?.(parsed);
        const candidate = parsed?.candidates?.[0];
        const candidateText = extractCandidateText(candidate);
        if (!candidateText) {
          return;
        }

        let delta = candidateText;
        if (fullText && candidateText.startsWith(fullText)) {
          delta = candidateText.slice(fullText.length);
        }

        if (delta) {
          fullText += delta;
          onDelta(delta, fullText);
        }
      } catch (error) {
        logger.debug({ line: trimmed, err: error }, 'Failed to parse Gemini stream payload');
      }
    };

    stream.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      lines.forEach(handleLine);
    });

    stream.on('end', () => {
      if (buffer.trim().length > 0) {
        handleLine(buffer);
      }
      resolve(fullText.trim());
    });

    stream.on('error', (error: any) => {
      reject(error);
    });
  });
};

export const generateSummary = async (summaryInput: string) => {
  const apiKey = getApiKey();
  if (!apiKey) {
    return null;
  }

  const requestBody = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text: `Aşağıdaki konuşmayı 3-4 cümlelik kısa bir hafıza özeti olarak yaz.\n\n${summaryInput}`
          }
        ]
      }
    ]
  };

  try {
    const response = await axios.post<GeminiResponse>(
      `${GEMINI_BASE_URL}/models/${DEFAULT_GEMINI_SUMMARY_MODEL}:generateContent?key=${apiKey}`,
      requestBody
    );
    return response.data?.candidates?.[0]?.content?.parts?.[0]?.text?.trim() || null;
  } catch (error) {
    logger.warn({ err: error }, 'Failed to generate summary');
    return null;
  }
};
