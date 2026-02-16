import axios from 'axios';
import { fal } from '@fal-ai/client';
import { logger } from '../../../utils/logger';
import { BIG_SYSTEM_PROMPT } from '../constants';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_CHAT_MODEL = process.env.GEMINI_CHAT_MODEL
  || process.env.GEMINI_MODEL
  || 'gemini-2.5-pro';
const DEFAULT_GEMINI_SUMMARY_MODEL = process.env.GEMINI_SUMMARY_MODEL
  || process.env.GEMINI_MODEL
  || 'gemini-2.5-flash';
const DEFAULT_FAL_IMAGE_MODEL = process.env.FAL_IMAGE_MODEL || 'fal-ai/bytedance/seedream/v4/edit';

const getApiKey = () => process.env.GEMINI_API_KEY || '';
const getFalKey = () => process.env.FAL_KEY || process.env.FAL_API_KEY || '';

let falConfigured = false;
const ensureFalConfigured = () => {
  if (falConfigured) return;
  const key = getFalKey();
  if (!key) return;
  fal.config({ credentials: key });
  falConfigured = true;
};

const createFalDebugId = () => `fal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const summarizeImageUrl = (url: string) => {
  if (typeof url !== 'string') return { kind: 'unknown' };
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    const header = commaIndex > 0 ? url.slice(0, commaIndex) : url.slice(0, 80);
    const payloadLength = commaIndex > 0 ? url.length - commaIndex - 1 : 0;
    return {
      kind: 'data_uri',
      header,
      payloadLength,
      totalLength: url.length,
    };
  }
  return {
    kind: 'url',
    preview: url.slice(0, 180),
    totalLength: url.length,
  };
};

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
  const { imageBase64, mimeType, prompt } = params;
  const resolvedModel = params.model || DEFAULT_FAL_IMAGE_MODEL;
  const falKey = getFalKey();

  if (!falKey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('FAL_KEY missing; returning source image as generated output in non-production');
      return {
        data: imageBase64,
        mimeType,
        text: 'Mock response used because FAL_KEY is missing',
      };
    }
    throw new Error('FAL_KEY is not configured');
  }

  ensureFalConfigured();
  const sourceDataUri = `data:${mimeType};base64,${imageBase64}`;
  const falDebugId = createFalDebugId();
  const falInput = {
    prompt,
    image_urls: [sourceDataUri],
    image_size: 'portrait_16_9' as const,
    num_images: 1,
    max_images: 1,
    enhance_prompt_mode: 'standard' as const,
    enable_safety_checker: true,
  };

  logger.info(
    {
      falDebugId,
      model: resolvedModel,
      promptLength: prompt.length,
      promptPreview: prompt.slice(0, 220),
      imageCount: falInput.image_urls.length,
      imageSummaries: falInput.image_urls.map(summarizeImageUrl),
      input: {
        image_size: falInput.image_size,
        num_images: falInput.num_images,
        max_images: falInput.max_images,
        enhance_prompt_mode: falInput.enhance_prompt_mode,
        enable_safety_checker: falInput.enable_safety_checker,
      },
      falConfigured,
    },
    'FAL style photo generation request prepared'
  );
  logger.info({ falDebugId, model: resolvedModel }, 'FAL style photo generation submit started');
  const result: any = await fal.subscribe(resolvedModel, {
    input: falInput,
    logs: true,
    onQueueUpdate: (update: any) => {
      logger.info(
        {
          falDebugId,
          model: resolvedModel,
          status: update?.status,
          queuePosition: update?.queue_position ?? null,
          logs: Array.isArray(update?.logs)
            ? update.logs.map((log: any) => ({
              level: log?.level || null,
              message: log?.message || null,
              timestamp: log?.timestamp || null,
            }))
            : [],
        },
        'FAL style photo generation queue update'
      );
    },
  });
  logger.info(
    {
      falDebugId,
      model: resolvedModel,
      requestId: result?.requestId || result?.request_id || null,
      rawResult: result,
    },
    'FAL style photo generation response received'
  );
  const outputUrl = result?.data?.images?.[0]?.url as string | undefined;
  if (!outputUrl) {
    logger.error({ falDebugId, result }, 'FAL style photo generation missing output URL');
    throw new Error('FAL returned no output image URL');
  }
  logger.info({ falDebugId, outputUrlPreview: outputUrl.slice(0, 220), outputUrlLength: outputUrl.length }, 'FAL style photo output download started');
  const outputResponse = await axios.get<ArrayBuffer>(outputUrl, { responseType: 'arraybuffer' });
  const outputMimeType = (outputResponse.headers['content-type'] as string) || 'image/png';
  const outputBase64 = Buffer.from(outputResponse.data as any).toString('base64');
  logger.info(
    {
      falDebugId,
      outputMimeType,
      outputBytesApprox: outputBase64.length,
      responseHeaders: outputResponse.headers,
    },
    'FAL style photo output downloaded'
  );

  return {
    data: outputBase64,
    mimeType: outputMimeType,
    text: undefined,
  };
};

export const generateStyledPhotoWithTemplate = async (params: {
  userImageBase64: string;
  userMimeType: string;
  prompt: string;
  model?: string;
}) => {
  const {
    userImageBase64,
    userMimeType,
    prompt,
  } = params;
  const resolvedModel = params.model || DEFAULT_FAL_IMAGE_MODEL;
  const falKey = getFalKey();

  if (!falKey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('FAL_KEY missing; returning source image as generated output in non-production');
      return {
        data: userImageBase64,
        mimeType: userMimeType,
        text: 'Mock response used because FAL_KEY is missing',
      };
    }
    throw new Error('FAL_KEY is not configured');
  }

  ensureFalConfigured();
  const finalPromptText =
    'TASK: Identity-preserving scene adaptation using source image and style prompt.\n\n' +
    'You are given:\n' +
    '1) SOURCE IMAGE -> Contains the real baby. This is the ONLY identity reference.\n' +
    '2) STYLE PROMPT -> Defines desired pose, framing, camera distance, lighting and environment.\n' +
    '3) SCENE BRIEF -> Additional style notes.\n\n' +
    'SCENE BRIEF:\n' +
    `${prompt}\n\n` +
    'IMPORTANT:\n' +
    'This is NOT a new baby generation task.\n' +
    'This is an image editing and identity transfer task.\n\n' +
    'GOAL:\n' +
    'Place the SOURCE baby into the TEMPLATE scene while preserving 100% identity.\n\n' +
    'STRICT IDENTITY PRESERVATION (HIGHEST PRIORITY):\n' +
    '- Preserve exact facial structure.\n' +
    '- Preserve head shape and proportions.\n' +
    '- Preserve eyes, nose, lips exactly.\n' +
    '- Preserve skin tone.\n' +
    '- Preserve natural baby asymmetry.\n' +
    '- Preserve expression geometry.\n' +
    '- Preserve eye state exactly (open/closed must not change).\n' +
    '- Do NOT generate a new baby.\n' +
    '- Do NOT reinterpret the identity.\n' +
    '- Do NOT beautify or stylize the face.\n' +
    '- The baby must remain fully recognizable.\n\n' +
    'SCENE ADAPTATION:\n' +
    '- Match requested pose and camera distance from scene brief.\n' +
    '- Match lighting direction and softness.\n' +
    '- Match depth of field.\n' +
    '- Maintain natural body proportions.\n' +
    '- Keep realistic newborn skin texture.\n\n' +
    'If any conflict occurs, ALWAYS prioritize SOURCE identity over scene styling.\n\n' +
    'OUTPUT:\n' +
    '- Ultra realistic.\n' +
    '- Professional studio photograph look.\n' +
    '- Return exactly one final image.';
  const sourceDataUri = `data:${userMimeType};base64,${userImageBase64}`;
  const falDebugId = createFalDebugId();
  const falInput = {
    prompt: finalPromptText,
    image_urls: [sourceDataUri],
    image_size: 'portrait_16_9' as const,
    num_images: 1,
    max_images: 1,
    enhance_prompt_mode: 'standard' as const,
    enable_safety_checker: true,
  };
  const startedAt = Date.now();
  logger.info(
    {
      falDebugId,
      model: resolvedModel,
      promptLength: prompt.length,
      finalPromptLength: finalPromptText.length,
      finalPromptPreview: finalPromptText.slice(0, 250),
      userMimeType,
      userImageBytesApprox: userImageBase64.length,
      imageCount: falInput.image_urls.length,
      imageSummaries: falInput.image_urls.map(summarizeImageUrl),
      input: {
        image_size: falInput.image_size,
        num_images: falInput.num_images,
        max_images: falInput.max_images,
        enhance_prompt_mode: falInput.enhance_prompt_mode,
        enable_safety_checker: falInput.enable_safety_checker,
      },
      falConfigured,
    },
    'FAL newborn style generation request prepared'
  );

  let result: any;
  try {
    logger.info({ falDebugId, model: resolvedModel }, 'FAL newborn style generation submit started');
    result = await fal.subscribe(resolvedModel, {
      input: falInput,
      logs: true,
      onQueueUpdate: (update: any) => {
        logger.info(
          {
            falDebugId,
            model: resolvedModel,
            status: update?.status,
            queuePosition: update?.queue_position ?? null,
            logs: Array.isArray(update?.logs)
              ? update.logs.map((log: any) => ({
                level: log?.level || null,
                message: log?.message || null,
                timestamp: log?.timestamp || null,
              }))
              : [],
          },
          'FAL newborn style generation queue update'
        );
      },
    });
    logger.info(
      {
        falDebugId,
        model: resolvedModel,
        requestId: result?.requestId || result?.request_id || null,
        rawResult: result,
      },
      'FAL newborn style generation response received'
    );
  } catch (error: any) {
    const providerStatus = error?.status;
    const providerData = error?.body || error?.response?.data;
    logger.error(
      {
        falDebugId,
        err: error,
        model: resolvedModel,
        elapsedMs: Date.now() - startedAt,
        providerStatus,
        providerData,
      },
      'FAL newborn style generation request failed'
    );
    throw error;
  }

  const outputUrl = result?.data?.images?.[0]?.url as string | undefined;
  if (!outputUrl) {
    logger.warn({ falDebugId, result }, 'FAL newborn style generation returned no image URL');
    throw new Error('Generated image could not be extracted from FAL response');
  }
  logger.info(
    {
      falDebugId,
      outputUrlPreview: outputUrl.slice(0, 220),
      outputUrlLength: outputUrl.length,
    },
    'FAL newborn style output download started'
  );
  const outputResponse = await axios.get<ArrayBuffer>(outputUrl, { responseType: 'arraybuffer' });
  const outputMimeType = (outputResponse.headers['content-type'] as string) || 'image/png';
  const outputBase64 = Buffer.from(outputResponse.data as any).toString('base64');

  logger.info(
    {
      falDebugId,
      model: resolvedModel,
      elapsedMs: Date.now() - startedAt,
      outputMimeType,
      outputBytesApprox: outputBase64.length,
      hasProviderText: false,
      responseHeaders: outputResponse.headers,
    },
    'FAL newborn style generation completed'
  );

  return {
    data: outputBase64,
    mimeType: outputMimeType,
    text: undefined,
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
