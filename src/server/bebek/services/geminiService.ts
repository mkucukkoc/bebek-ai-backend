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
const ENFORCED_MULTI_REFERENCE_FACE_SWAP_MODEL = 'half-moon-ai/ai-face-swap/faceswapimage';
const DEFAULT_FAL_WEDDING_IMAGE_MODEL = ENFORCED_MULTI_REFERENCE_FACE_SWAP_MODEL;
const DEFAULT_FAL_COUPLE_IMAGE_MODEL = ENFORCED_MULTI_REFERENCE_FACE_SWAP_MODEL;

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

const extractImageUrlFromFalResponse = (payload: any): string | undefined => {
  const url =
    payload?.data?.image?.url
    || payload?.image?.url
    || payload?.data?.images?.[0]?.url
    || payload?.images?.[0]?.url;
  if (typeof url === 'string' && url.trim().length > 0) {
    return url.trim();
  }
  return undefined;
};

const runHalfMoonFaceSwap = async (params: {
  model: string;
  sourceFaceUrl: string;
  targetImageUrl: string;
  enableOcclusionPrevention?: boolean;
  falDebugId: string;
  step: string;
}) => {
  const input = {
    source_face_url: params.sourceFaceUrl,
    target_image_url: params.targetImageUrl,
    enable_occlusion_prevention: Boolean(params.enableOcclusionPrevention),
  };
  logger.info(
    {
      falDebugId: params.falDebugId,
      step: `${params.step}_request_prepared`,
      model: params.model,
      input: {
        source_face_url: summarizeImageUrl(input.source_face_url),
        target_image_url: summarizeImageUrl(input.target_image_url),
        enable_occlusion_prevention: input.enable_occlusion_prevention,
      },
    },
    'FAL half-moon face swap request prepared',
  );
  const result: any = await fal.subscribe(params.model, {
    input,
    logs: true,
  });
  logger.info(
    {
      falDebugId: params.falDebugId,
      step: `${params.step}_response_received`,
      model: params.model,
      requestId: result?.requestId || result?.request_id || null,
      rawResult: result,
    },
    'FAL half-moon face swap response received',
  );
  const outputUrl = extractImageUrlFromFalResponse(result);
  if (!outputUrl) {
    logger.error({ falDebugId: params.falDebugId, step: params.step, result }, 'FAL half-moon face swap missing output URL');
    throw new Error('FAL returned no output image URL for half-moon face swap');
  }
  return outputUrl;
};

const downloadImageAsBase64 = async (url: string) => {
  const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer' });
  const mimeType = (response.headers['content-type'] as string) || 'image/jpeg';
  const data = Buffer.from(response.data as any).toString('base64');
  return { data, mimeType };
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
    '- Use medium-shot framing with camera slightly farther.\n' +
    '- Keep full face visible and sharp. Do not crop face.\n' +
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
  motherImageUrl: string;
  fatherImageUrl: string;
  templateImageUrl: string;
  prompt: string;
  model?: string;
}) => {
  const resolvedModel = DEFAULT_FAL_WEDDING_IMAGE_MODEL;
  if (params.model && params.model !== resolvedModel) {
    logger.warn(
      {
        requestedModel: params.model,
        forcedModel: resolvedModel,
      },
      'Wedding generation model override ignored; face-swap model is enforced',
    );
  }
  const falKey = getFalKey();

  if (!falKey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('FAL_KEY missing; returning mother image as generated output in non-production');
      const fallback = await downloadImageAsBase64(params.motherImageUrl);
      return {
        data: fallback.data,
        mimeType: fallback.mimeType,
        text: 'Mock response used because FAL_KEY is missing',
      };
    }
    throw new Error('FAL_KEY is not configured');
  }

  ensureFalConfigured();

  const finalPromptText =
    'Verilen template fotograftaki sahneyi, arka plani, isigi, pozisyonu, kamera acisini ve kiyafetleri tamamen koru.\n\n' +
    'Sadece yuz degisimi yap:\n' +
    '- Anne referans fotografindaki yuzu kadin karakterin yuzune uygula.\n' +
    '- Baba referans fotografindaki yuzu erkek karakterin yuzune uygula.\n\n' +
    'Yuz oranlari dogal olmali.\n' +
    'Cilt tonu sahne isigina uyumlu olmali.\n' +
    'Boyun ve sac cizgileri dogal gecis yapmali.\n' +
    "Yuz ifadeleri template'teki mimikle ayni kalmali.\n" +
    'Kamera biraz daha geriden olsun; asiri yakin plan kullanma.\n' +
    'Orta cekim (medium shot) kadraj kullan; iki yuz de ekrana tam sigsin.\n' +
    'Iki yuz de net ve keskin gorunsun, blur veya crop olmasin.\n' +
    'Kiyafet, arka plan, poz ve kadraj kesinlikle degismemeli.\n' +
    'Ekstra detay ekleme, sahneyi yeniden olusturma.\n' +
    'Sadece yuz swap islemi yap.\n\n' +
    `Template stili notu: ${params.prompt}\n\n` +
    'Ultra gercekci, yuksek cozunurluk, dogal cilt dokusu.';

  const falDebugId = createFalDebugId();
  logger.info(
    {
      falDebugId,
      model: resolvedModel,
      finalPromptLength: finalPromptText.length,
      promptForwardedToModel: false,
      imageCount: 3,
      imageSummaries: [
        summarizeImageUrl(params.motherImageUrl),
        summarizeImageUrl(params.fatherImageUrl),
        summarizeImageUrl(params.templateImageUrl),
      ],
    },
    'FAL wedding style generation request prepared',
  );

  // half-moon image endpoint expects single source_face_url + target_image_url.
  // For two-identity templates, run two sequential swaps.
  const firstSwapUrl = await runHalfMoonFaceSwap({
    model: resolvedModel,
    sourceFaceUrl: params.motherImageUrl,
    targetImageUrl: params.templateImageUrl,
    enableOcclusionPrevention: false,
    falDebugId,
    step: 'wedding_swap_mother',
  });
  const outputUrl = await runHalfMoonFaceSwap({
    model: resolvedModel,
    sourceFaceUrl: params.fatherImageUrl,
    targetImageUrl: firstSwapUrl,
    enableOcclusionPrevention: false,
    falDebugId,
    step: 'wedding_swap_father',
  });

  const outputResponse = await axios.get<ArrayBuffer>(outputUrl, { responseType: 'arraybuffer' });
  const outputMimeType = (outputResponse.headers['content-type'] as string) || 'image/png';
  const outputBase64 = Buffer.from(outputResponse.data as any).toString('base64');

  return {
    data: outputBase64,
    mimeType: outputMimeType,
    text: undefined,
  };
};

export const generateCoupleStyledPhotoWithTemplate = async (params: {
  firstImageUrl: string;
  secondImageUrl: string;
  templateImageUrl: string;
  prompt: string;
  model?: string;
}) => {
  const resolvedModel = DEFAULT_FAL_COUPLE_IMAGE_MODEL;
  if (params.model && params.model !== resolvedModel) {
    logger.warn(
      {
        requestedModel: params.model,
        forcedModel: resolvedModel,
      },
      'Couple generation model override ignored; face-swap model is enforced',
    );
  }
  const falKey = getFalKey();

  if (!falKey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.warn('FAL_KEY missing; returning first person image as generated output in non-production');
      const fallback = await downloadImageAsBase64(params.firstImageUrl);
      return {
        data: fallback.data,
        mimeType: fallback.mimeType,
        text: 'Mock response used because FAL_KEY is missing',
      };
    }
    throw new Error('FAL_KEY is not configured');
  }

  ensureFalConfigured();

  const finalPromptText =
    'Verilen template fotograftaki sahneyi, arka plani, isigi, pozisyonu, kamera acisini ve kiyafetleri tamamen koru.\n\n' +
    'Sadece yuz degisimi yap:\n' +
    '- Anne referans fotografindaki yuzu kadin karakterin yuzune uygula.\n' +
    '- Baba referans fotografindaki yuzu erkek karakterin yuzune uygula.\n\n' +
    'Yuz oranlari dogal olmali.\n' +
    'Cilt tonu sahne isigina uyumlu olmali.\n' +
    'Boyun ve sac cizgileri dogal gecis yapmali.\n' +
    "Yuz ifadeleri template'teki mimikle ayni kalmali.\n" +
    'Kamera biraz daha geriden olsun; asiri yakin plan kullanma.\n' +
    'Orta cekim (medium shot) kadraj kullan; iki yuz de ekrana tam sigsin.\n' +
    'Iki yuz de net ve keskin gorunsun, blur veya crop olmasin.\n' +
    'Kiyafet, arka plan, poz ve kadraj kesinlikle degismemeli.\n' +
    'Ekstra detay ekleme, sahneyi yeniden olusturma.\n' +
    'Sadece yuz swap islemi yap.\n\n' +
    `Template stili notu: ${params.prompt}\n\n` +
    'Ultra gercekci, yuksek cozunurluk, dogal cilt dokusu.';

  const falDebugId = createFalDebugId();
  logger.info(
    {
      falDebugId,
      model: resolvedModel,
      finalPromptLength: finalPromptText.length,
      promptForwardedToModel: false,
      imageCount: 3,
      imageSummaries: [
        summarizeImageUrl(params.firstImageUrl),
        summarizeImageUrl(params.secondImageUrl),
        summarizeImageUrl(params.templateImageUrl),
      ],
      input: { enable_occlusion_prevention: false },
    },
    'FAL couple style generation request prepared',
  );
  const firstSwapUrl = await runHalfMoonFaceSwap({
    model: resolvedModel,
    sourceFaceUrl: params.firstImageUrl,
    targetImageUrl: params.templateImageUrl,
    enableOcclusionPrevention: false,
    falDebugId,
    step: 'couple_swap_first',
  });
  const outputUrl = await runHalfMoonFaceSwap({
    model: resolvedModel,
    sourceFaceUrl: params.secondImageUrl,
    targetImageUrl: firstSwapUrl,
    enableOcclusionPrevention: false,
    falDebugId,
    step: 'couple_swap_second',
  });

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
