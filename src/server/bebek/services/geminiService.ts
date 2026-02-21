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

export const generateWeddingStyledPhotoWithTemplate = async (params: {
  motherImageBase64: string;
  motherMimeType: string;
  fatherImageBase64: string;
  fatherMimeType: string;
  templateImageBase64: string;
  templateMimeType: string;
  prompt: string;
  model?: string;
}) => {
  const resolvedModel = params.model || DEFAULT_FAL_IMAGE_MODEL;
  const falKey = getFalKey();

  if (!falKey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('FAL_KEY missing; returning mother image as generated output in non-production');
      return {
        data: params.motherImageBase64,
        mimeType: params.motherMimeType,
        text: 'Mock response used because FAL_KEY is missing',
      };
    }
    throw new Error('FAL_KEY is not configured');
  }

  ensureFalConfigured();
  const motherDataUri = `data:${params.motherMimeType};base64,${params.motherImageBase64}`;
  const fatherDataUri = `data:${params.fatherMimeType};base64,${params.fatherImageBase64}`;
  const templateDataUri = `data:${params.templateMimeType};base64,${params.templateImageBase64}`;

  const finalPromptText =
    'TASK: Create a wedding portrait using two identity references and one scene template.\n\n' +
    'INPUTS:\n' +
    '1) MOTHER PHOTO -> preserve mother identity exactly.\n' +
    '2) FATHER PHOTO -> preserve father identity exactly.\n' +
    '3) TEMPLATE PHOTO -> copy only composition, pose and environment.\n\n' +
    `STYLE BRIEF:\n${params.prompt}\n\n` +
    'RULES:\n' +
    '- Keep both parents facial identity unchanged.\n' +
    '- Place both persons naturally into the template wedding scene.\n' +
    '- Keep realistic skin tones, anatomy and lighting.\n' +
    '- Do not create extra people.\n' +
    '- Keep result ultra realistic, premium wedding photography style.\n' +
    '- Return exactly one final image.';

  const falInput = {
    prompt: finalPromptText,
    image_urls: [motherDataUri, fatherDataUri, templateDataUri],
    image_size: 'portrait_16_9' as const,
    num_images: 1,
    max_images: 1,
    enhance_prompt_mode: 'standard' as const,
    enable_safety_checker: true,
  };

  const falDebugId = createFalDebugId();
  logger.info(
    {
      falDebugId,
      model: resolvedModel,
      finalPromptLength: finalPromptText.length,
      imageCount: falInput.image_urls.length,
      imageSummaries: falInput.image_urls.map(summarizeImageUrl),
    },
    'FAL wedding style generation request prepared',
  );

  const result: any = await fal.subscribe(resolvedModel, {
    input: falInput,
    logs: true,
  });
  const outputUrl = result?.data?.images?.[0]?.url as string | undefined;
  if (!outputUrl) {
    throw new Error('FAL returned no output image URL for wedding generation');
  }

  const outputResponse = await axios.get<ArrayBuffer>(outputUrl, { responseType: 'arraybuffer' });
  const outputMimeType = (outputResponse.headers['content-type'] as string) || 'image/png';
  const outputBase64 = Buffer.from(outputResponse.data as any).toString('base64');

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

const DEFAULT_FAL_VIDEO_MODEL = process.env.FAL_VIDEO_MODEL || 'fal-ai/pixverse/swap';

const shortPreview = (value: string | undefined | null, max = 180) => {
  if (!value) return null;
  return value.length > max ? `${value.slice(0, max)}...` : value;
};

const extractVideoUrlFromFalResponse = (payload: any): string | null => {
  if (!payload || typeof payload !== 'object') return null;

  const direct =
    payload?.video?.url
    || payload?.videoUrl
    || payload?.output?.url
    || payload?.result?.video?.url
    || payload?.response?.video?.url
    || payload?.response?.videoUrl
    || payload?.response?.output?.url
    || payload?.response?.result?.video?.url
    || payload?.data?.video?.url
    || payload?.response?.data?.video?.url
    || payload?.result?.data?.video?.url;
  if (typeof direct === 'string' && direct.trim().length > 0) {
    return direct.trim();
  }

  return null;
};

export const generateStyledVideoWithVeo = async (params: {
  styleId: string | null;
  userImageUrl: string;
  referenceVideoUrl: string;
  requestId?: string | null;
  model?: string;
}) => {
  const { styleId, userImageUrl, referenceVideoUrl, requestId } = params;
  const resolvedModel = params.model || DEFAULT_FAL_VIDEO_MODEL;
  const falKey = getFalKey();
  const videoRequestId = requestId || `video-${Date.now()}`;
  const pixverseResolution = (process.env.FAL_VIDEO_RESOLUTION || '720p') as '360p' | '540p' | '720p';
  const pixverseKeyframeId = Number(process.env.FAL_VIDEO_KEYFRAME_ID || 1);
  const enableBackgroundSwap = (process.env.FAL_VIDEO_ENABLE_BACKGROUND_SWAP || 'true') === 'true';
  const babyBackgroundImageUrl = process.env.FAL_VIDEO_BABY_BACKGROUND_IMAGE_URL || '';
  const framingPrompt =
    'Keep the baby face slightly farther from camera with medium-shot framing. Avoid extreme close-up facial framing. ' +
    'Remove any Instagram logo, watermark, username label, or platform text overlay from the final video.';

  logger.info(
    {
      videoRequestId,
      step: 'fal_video_request_prepared',
      styleId,
      model: resolvedModel,
      userImageUrlPreview: shortPreview(userImageUrl),
      referenceVideoUrlPreview: shortPreview(referenceVideoUrl),
      hasFalKey: Boolean(falKey),
    },
    'FAL video request prepared'
  );

  if (!falKey) {
    logger.warn(
      {
        videoRequestId,
        step: 'fal_video_skipped_missing_api_key',
        styleId,
      },
      'FAL key missing; using fallback video URL'
    );
    return {
      outputVideoUrl: referenceVideoUrl,
      providerText: 'Fallback video URL used because FAL_KEY is missing.',
      providerStatus: null as number | null,
      usedFallback: true,
      providerRaw: null as any,
    };
  }

  ensureFalConfigured();
  try {
    const runPixverseSwap = async (args: {
      mode: 'person' | 'object' | 'background';
      videoUrl: string;
      imageUrl: string;
      step: string;
      prompt?: string;
    }) => {
      const input: any = {
        video_url: args.videoUrl,
        image_url: args.imageUrl,
        mode: args.mode,
        keyframe_id: Number.isFinite(pixverseKeyframeId) ? pixverseKeyframeId : 1,
        resolution: pixverseResolution,
        original_sound_switch: true,
      };
      if (args.prompt) {
        input.prompt = args.prompt;
      }
      logger.info(
        {
          videoRequestId,
          step: `${args.step}_started`,
          model: resolvedModel,
          input: {
            ...input,
            video_url: shortPreview(input.video_url),
            image_url: shortPreview(input.image_url),
          },
        },
        'FAL Pixverse swap step started'
      );

      const result: any = await fal.subscribe(resolvedModel, {
        input,
        logs: true,
        onQueueUpdate: (update: any) => {
          logger.info(
            {
              videoRequestId,
              step: `${args.step}_queue_update`,
              model: resolvedModel,
              status: update?.status || null,
              queuePosition: update?.queue_position ?? null,
            },
            'FAL Pixverse queue update'
          );
        },
      });

      const outputVideoUrl = extractVideoUrlFromFalResponse(result);
      logger.info(
        {
          videoRequestId,
          step: `${args.step}_completed`,
          model: resolvedModel,
          requestId: result?.requestId || result?.request_id || null,
          outputVideoUrlPreview: shortPreview(outputVideoUrl || ''),
        },
        'FAL Pixverse swap step completed'
      );
      return { result, outputVideoUrl };
    };

    const personSwap = await runPixverseSwap({
      mode: 'person',
      videoUrl: referenceVideoUrl,
      imageUrl: userImageUrl,
      step: 'fal_pixverse_person_swap',
      prompt: framingPrompt,
    });
    if (!personSwap.outputVideoUrl) {
      logger.warn(
        { videoRequestId, step: 'fal_pixverse_person_swap_missing_output' },
        'Pixverse person swap missing output URL; using fallback'
      );
      return {
        outputVideoUrl: referenceVideoUrl,
        providerText: 'FAL fallback used (person swap response missing video URL)',
        providerStatus: 200,
        usedFallback: true,
        providerRaw: personSwap.result,
      };
    }

    let finalVideoUrl = personSwap.outputVideoUrl;
    let providerRaw: any = personSwap.result;
    let providerText: string | null = null;

    if (enableBackgroundSwap && babyBackgroundImageUrl) {
      try {
        const backgroundSwap = await runPixverseSwap({
          mode: 'background',
          videoUrl: personSwap.outputVideoUrl,
          imageUrl: babyBackgroundImageUrl,
          step: 'fal_pixverse_background_swap',
        });
        if (backgroundSwap.outputVideoUrl) {
          finalVideoUrl = backgroundSwap.outputVideoUrl;
          providerRaw = {
            personSwap: personSwap.result,
            backgroundSwap: backgroundSwap.result,
          };
        } else {
          providerText = 'Background swap skipped: response missing video URL, returning person swap output.';
          providerRaw = {
            personSwap: personSwap.result,
            backgroundSwap: backgroundSwap.result,
          };
        }
      } catch (backgroundError: any) {
        logger.warn(
          {
            videoRequestId,
            step: 'fal_pixverse_background_swap_failed',
            message: backgroundError?.message || 'unknown_error',
            providerData: backgroundError?.response?.data || backgroundError?.body || null,
          },
          'Pixverse background swap failed; returning person swap output'
        );
        providerText = 'Background swap failed; returning person swap output.';
      }
    }

    return {
      outputVideoUrl: finalVideoUrl,
      providerText,
      providerStatus: 200,
      usedFallback: false,
      providerRaw,
    };
  } catch (error: any) {
    logger.error(
      {
        err: error,
        videoRequestId,
        step: 'fal_video_request_failed',
        providerStatus: error?.response?.status || null,
        providerData: error?.response?.data || error?.body || null,
      },
      'FAL video request failed; using fallback video URL'
    );
    return {
      outputVideoUrl: referenceVideoUrl,
      providerText: `FAL request failed: ${error?.message || 'unknown error'}`,
      providerStatus: error?.response?.status || null,
      usedFallback: true,
      providerRaw: error?.response?.data || error?.body || null,
    };
  }
};
