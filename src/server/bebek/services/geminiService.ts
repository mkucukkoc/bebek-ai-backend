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

const DEFAULT_VEO_VIDEO_MODEL = process.env.GEMINI_VEO_MODEL || 'veo-3.1-generate-preview';

const shortPreview = (value: string | undefined | null, max = 180) => {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}...` : value;
};

const extractVideoUrlFromVeoResponse = (payload: any): string | null => {
  if (!payload || typeof payload !== 'object') return null;

  const direct =
    payload?.video?.uri
    || payload?.videoUrl
    || payload?.output?.url
    || payload?.result?.video?.uri
    || payload?.response?.video?.uri
    || payload?.response?.videoUrl
    || payload?.response?.output?.url
    || payload?.response?.result?.video?.uri;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim();
  }

  const candidates = Array.isArray(payload?.generatedVideos) ? payload.generatedVideos : [];
  for (const item of candidates) {
    const candidateUrl = item?.video?.uri || item?.uri || item?.url;
    if (typeof candidateUrl === 'string' && candidateUrl.trim().length > 0) {
      return candidateUrl.trim();
    }
  }

  return null;
};

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

type GeminiModelListResponse = {
  models?: Array<{
    name?: string;
    supportedGenerationMethods?: string[];
  }>;
};

const listGeminiModels = async (apiKey: string) => {
  const url = `${GEMINI_BASE_URL}/models?key=${apiKey}`;
  const response = await axios.get<GeminiModelListResponse>(url, {
    timeout: Number(process.env.GEMINI_MODEL_LIST_TIMEOUT_MS || 30000),
    validateStatus: () => true,
  });
  return response;
};

const pollLongRunningOperation = async (params: {
  apiKey: string;
  operationName: string;
  veoRequestId: string;
}) => {
  const { apiKey, operationName, veoRequestId } = params;
  const maxPollCount = Number(process.env.GEMINI_VEO_POLL_MAX || 20);
  const pollIntervalMs = Number(process.env.GEMINI_VEO_POLL_INTERVAL_MS || 3000);
  const opName = operationName.startsWith('operations/')
    ? operationName
    : operationName.replace(/^\/+/, '');
  const opUrl = `${GEMINI_BASE_URL}/${opName}?key=${apiKey}`;

  for (let attempt = 1; attempt <= maxPollCount; attempt += 1) {
    const response = await axios.get(opUrl, {
      timeout: Number(process.env.GEMINI_VEO_TIMEOUT_MS || 120000),
      validateStatus: () => true,
    });
    const pollPayload = response.data as any;

    logger.info(
      {
        veoRequestId,
        step: 'veo_operation_poll_response',
        operationName: opName,
        pollAttempt: attempt,
        status: response.status,
        done: Boolean(pollPayload?.done),
        data: pollPayload,
      },
      'VEO operation poll response received'
    );

    if (response.status < 200 || response.status >= 300) {
      return {
        ok: false,
        status: response.status,
        data: response.data,
      };
    }

    if (pollPayload?.done) {
      return {
        ok: true,
        status: response.status,
        data: pollPayload,
      };
    }

    await sleep(pollIntervalMs);
  }

  return {
    ok: false,
    status: null as number | null,
    data: { error: 'operation_timeout', message: 'VEO operation polling timed out' },
  };
};

export const generateStyledVideoWithVeo = async (params: {
  styleId: string | null;
  userImageUrl: string;
  referenceVideoUrl: string;
  requestId?: string | null;
  model?: string;
}) => {
  const { styleId, userImageUrl, referenceVideoUrl, requestId } = params;
  let resolvedModel = params.model || DEFAULT_VEO_VIDEO_MODEL;
  const apiKey = getApiKey();
  const veoRequestId = requestId || `veo-${Date.now()}`;
  let endpoint = `${GEMINI_BASE_URL}/models/${resolvedModel}:predictLongRunning?key=${apiKey}`;

  const requestBody = {
    instances: [
      {
        prompt:
          'Create a vertical 9:16 baby-style cinematic video. Keep identity consistency from the input baby image, and follow the motion/style from the reference video.',
        inputImage: {
          uri: userImageUrl,
        },
        referenceVideo: {
          uri: referenceVideoUrl,
        },
      },
    ],
    parameters: {
      aspectRatio: '9:16',
    },
  };

  logger.info(
    {
      veoRequestId,
      step: 'veo_request_prepared',
      styleId,
      model: resolvedModel,
      userImageUrlPreview: shortPreview(userImageUrl),
      referenceVideoUrlPreview: shortPreview(referenceVideoUrl),
      requestBody,
      hasApiKey: Boolean(apiKey),
    },
    'VEO request prepared'
  );

  if (!apiKey) {
    logger.warn(
      {
        veoRequestId,
        step: 'veo_skipped_missing_api_key',
        styleId,
      },
      'GEMINI_API_KEY missing; using fallback video URL'
    );
    return {
      outputVideoUrl: referenceVideoUrl,
      providerText: 'Fallback video URL used because GEMINI_API_KEY is missing.',
      providerStatus: null as number | null,
      usedFallback: true,
      providerRaw: null as any,
    };
  }

  try {
    const modelsResponse = await listGeminiModels(apiKey);
    const allModels = Array.isArray(modelsResponse.data?.models) ? modelsResponse.data.models : [];
    const videoCapableModels = allModels
      .filter(
        model =>
          Array.isArray(model?.supportedGenerationMethods)
          && (
            model!.supportedGenerationMethods!.includes('predictLongRunning')
            || model!.supportedGenerationMethods!.includes('generateVideos')
          )
      )
      .map(model => model?.name)
      .filter((name): name is string => Boolean(name));

    const normalizedResolvedModel = resolvedModel.startsWith('models/')
      ? resolvedModel
      : `models/${resolvedModel}`;
    const hasRequestedModel = allModels.some(model => model?.name === normalizedResolvedModel);
    const hasRequestedVideoSupport = allModels.some(
      model =>
        model?.name === normalizedResolvedModel
        && Array.isArray(model?.supportedGenerationMethods)
        && (
          model.supportedGenerationMethods.includes('predictLongRunning')
          || model.supportedGenerationMethods.includes('generateVideos')
        )
    );

    logger.info(
      {
        veoRequestId,
        step: 'veo_model_discovery_completed',
        modelListStatus: modelsResponse.status,
        requestedModel: resolvedModel,
        requestedModelNormalized: normalizedResolvedModel,
        hasRequestedModel,
        hasRequestedVideoSupport,
        videoCapableModels,
      },
      'VEO model discovery completed'
    );

    if (modelsResponse.status >= 200 && modelsResponse.status < 300 && !hasRequestedVideoSupport && videoCapableModels.length > 0) {
      const fallbackModelName = videoCapableModels[0].replace(/^models\//, '');
      logger.warn(
        {
          veoRequestId,
          step: 'veo_model_auto_switch',
          fromModel: resolvedModel,
          toModel: fallbackModelName,
        },
        'Requested model not video-capable; auto-switching to available video model'
      );
      resolvedModel = fallbackModelName;
      endpoint = `${GEMINI_BASE_URL}/models/${resolvedModel}:predictLongRunning?key=${apiKey}`;
    }

    logger.info(
      {
        veoRequestId,
        step: 'veo_request_started',
        endpointWithoutKey: `${GEMINI_BASE_URL}/models/${resolvedModel}:predictLongRunning`,
        endpointPreview: shortPreview(endpoint.replace(/\?key=.*/, '?key=***'), 260),
      },
      'VEO request started'
    );

    const response = await axios.post(endpoint, requestBody, {
      headers: { 'Content-Type': 'application/json' },
      timeout: Number(process.env.GEMINI_VEO_TIMEOUT_MS || 120000),
      validateStatus: () => true,
    });

    logger.info(
      {
        veoRequestId,
        step: 'veo_response_received',
        status: response.status,
        statusText: response.statusText,
        data: response.data,
      },
      'VEO response received'
    );

    let resolvedPayload: any = response.data;
    const initialPayload = response.data as any;
    const operationName = typeof initialPayload?.name === 'string' ? initialPayload.name : null;

    if (response.status >= 200 && response.status < 300 && operationName) {
      logger.info(
        {
          veoRequestId,
          step: 'veo_operation_poll_started',
          operationName,
        },
        'VEO long-running operation polling started'
      );
      const pollResult = await pollLongRunningOperation({
        apiKey,
        operationName,
        veoRequestId,
      });
      if (pollResult.ok) {
        resolvedPayload = pollResult.data;
      } else {
        logger.warn(
          {
            veoRequestId,
            step: 'veo_operation_poll_failed',
            operationName,
            status: pollResult.status,
            data: pollResult.data,
          },
          'VEO operation polling failed; using fallback video URL'
        );
        return {
          outputVideoUrl: referenceVideoUrl,
          providerText: `VEO fallback used (poll failed, status: ${pollResult.status ?? 'timeout'})`,
          providerStatus: pollResult.status,
          usedFallback: true,
          providerRaw: pollResult.data,
        };
      }
    }

    const extractedVideoUrl = extractVideoUrlFromVeoResponse(resolvedPayload);
    if (response.status >= 200 && response.status < 300 && extractedVideoUrl) {
      logger.info(
        {
          veoRequestId,
          step: 'veo_video_url_extracted',
          outputVideoUrlPreview: shortPreview(extractedVideoUrl, 240),
        },
        'VEO output video URL extracted'
      );
      return {
        outputVideoUrl: extractedVideoUrl,
        providerText: null,
        providerStatus: response.status,
        usedFallback: false,
        providerRaw: resolvedPayload,
      };
    }

    logger.warn(
      {
        veoRequestId,
        step: 'veo_fallback_due_to_invalid_response',
        status: response.status,
        hasExtractedVideoUrl: Boolean(extractedVideoUrl),
      },
      'VEO response invalid for output URL; using fallback video URL'
    );
    return {
      outputVideoUrl: referenceVideoUrl,
      providerText: `VEO fallback used (status: ${response.status})`,
      providerStatus: response.status,
      usedFallback: true,
      providerRaw: resolvedPayload,
    };
  } catch (error: any) {
    logger.error(
      {
        err: error,
        veoRequestId,
        step: 'veo_request_failed',
        providerStatus: error?.response?.status || null,
        providerData: error?.response?.data || null,
      },
      'VEO request failed; using fallback video URL'
    );
    return {
      outputVideoUrl: referenceVideoUrl,
      providerText: `VEO request failed: ${error?.message || 'unknown error'}`,
      providerStatus: error?.response?.status || null,
      usedFallback: true,
      providerRaw: error?.response?.data || null,
    };
  }
};
