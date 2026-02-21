import { Request, Router } from 'express';
import multer from 'multer';
import { authenticateToken, AuthRequest } from '../middleware/authMiddleware';
import { randomUUID } from 'crypto';
import { db, FieldValue, storage } from '../firebase';
import {
  generateStyledPhoto,
  generateStyledPhotoWithTemplate,
  generateStyledVideoWithVeo,
  generateCoupleStyledPhotoWithTemplate,
  generateWeddingStyledPhotoWithTemplate,
} from '../server/bebek/services/geminiService';
import { logger } from '../utils/logger';
import { attachRouteLogger } from '../utils/routeLogger';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

export const createStylesRouter = () => {
  const router = Router();
  attachRouteLogger(router, 'bebek-styles');

  const sanitizeFilename = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[^\w.\-]/g, '_')
      .replace(/_+/g, '_');

  const extFromMime = (mime: string) => {
    if (mime.includes('png')) return 'png';
    if (mime.includes('webp')) return 'webp';
    if (mime.includes('heic')) return 'heic';
    return 'jpg';
  };
  const extFromVideoMime = (mime: string) => {
    if (mime.includes('webm')) return 'webm';
    if (mime.includes('quicktime') || mime.includes('mov')) return 'mov';
    return 'mp4';
  };

  const LIFESTYLE_IDENTITY_SUFFIX =
    'Use the uploaded baby photo as the ONLY identity reference. Keep the same baby face and identity exactly: face shape, eyes, nose, lips, skin tone, and baby proportions must stay the same. Preserve eye state exactly (open stays open, closed stays closed) and keep the same facial expression. Do not create a new baby. Place this same baby naturally into the requested scene and style. Ultra-realistic family lifestyle photography.';
  const NEWBORN_IDENTITY_SUFFIX =
    'Use the uploaded baby photo as the ONLY identity reference. Keep the same baby face and identity exactly: face shape, eyes, nose, lips, skin tone, and baby proportions must stay the same. Preserve eye state exactly (open stays open, closed stays closed) and keep the same facial expression. Do not create a new baby. Place this same baby naturally into the requested newborn setup and style. Ultra-realistic newborn photography.';
  const STUDIO_IDENTITY_SUFFIX =
    'Use the uploaded baby photo as the ONLY identity reference. Keep the same baby face and identity exactly: face shape, eyes, nose, lips, skin tone, and baby proportions must stay the same. Preserve eye state exactly (open stays open, closed stays closed) and keep the same facial expression. Do not create a new baby. Place this same baby naturally into the requested studio scene and style. Ultra-realistic newborn photography.';
  const WEDDING_IDENTITY_SUFFIX =
    'Use mother and father uploaded photos as the ONLY identity references. Keep both faces and identities exactly, preserve facial structure and skin tone, and place both naturally into the wedding template scene. Ultra-realistic wedding photography.';
  const COUPLE_IDENTITY_SUFFIX =
    'Use two uploaded person photos as the ONLY identity references. Keep both faces and identities exactly, preserve facial structure and skin tone, and place both naturally into the couple template scene. Ultra-realistic couple photography.';
  const FRAMING_SUFFIX =
    'Use medium-shot framing with camera slightly farther from subjects. Keep faces fully visible and sharp. Do not crop faces.';

  const STYLE_PROMPT_BY_ID: Record<string, string> = {
    l1: `Vertical 9:16 elegant family portrait with baby, luxury classic interior, neutral beige tones, soft cinematic lighting, parents wearing modern formal clothing, baby centered, high fashion lifestyle photography, photorealistic, editorial style ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l2: `Vertical portrait 9:16 happy family holding baby in modern living room, warm natural light, emotional candid moment, lifestyle photography, realistic skin tones, soft focus background, premium editorial look, cozy home atmosphere ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l3: `Vertical 9:16 baby in stroller with parents walking in colorful neon city night background, cinematic urban atmosphere, glowing lights, realistic street photography style, vibrant colors, shallow depth of field, modern lifestyle aesthetic ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l4: `Vertical portrait 9:16 mother holding baby while sitting at a stylish cafe table, warm natural light, modern urban lifestyle photography, cinematic depth of field, realistic skin tones ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l5: `Vertical 9:16 baby walking with parent in a green park during golden hour sunset, cinematic warm lighting, lifestyle photography aesthetic, natural candid moment ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l6: `Vertical portrait baby walking with parents along a calm beach shoreline, soft pastel sunset sky, natural candid lifestyle photo, photorealistic, airy composition ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l7: `Vertical 9:16 baby sitting near glass balcony with city skyline background, modern apartment lifestyle, soft daylight, minimal luxury aesthetic ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l8: `Vertical 9:16 close-up baby and parent selfie style shot, handheld camera feeling, vlog lifestyle aesthetic, natural candid expression, cinematic mobile photography look ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l9: `Vertical 9:16 lifestyle family portrait with mother, father, toddler child and baby sitting together on a cozy sofa, modern Scandinavian living room, soft natural daylight, candid happy moment, ultra realistic photography, cinematic depth of field ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l10: `Vertical family lifestyle photo of parents walking in a green park holding toddler while baby is in stroller, golden hour sunlight, natural candid atmosphere, warm cinematic tones ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l11: `Vertical lifestyle family scene with parents sitting on floor playing with toddler while baby lies on soft blanket, bright playroom environment, cozy candid mood ${LIFESTYLE_IDENTITY_SUFFIX}`,
    l12: `Vertical 9:16 family birthday celebration scene, baby near cake, parents and child smiling together, warm festive lighting, candid lifestyle photography ${LIFESTYLE_IDENTITY_SUFFIX}`,
    s1: `Gokkusagi konseptinde profesyonel studio cekimi, temiz kompozisyon, vivid colors. ${STUDIO_IDENTITY_SUFFIX}`,
    n1: `Vertical 9:16 newborn baby sleeping wrapped in deep navy swaddle, lying on a crescent moon prop with small star decorations, soft studio lighting, dreamy night sky background, professional newborn photography style, pastel cinematic tones, ultra realistic, cozy atmosphere ${NEWBORN_IDENTITY_SUFFIX}`,
    n2: `Vertical portrait 9:16 newborn baby wrapped in white fabric, lying on fluffy soft white fur background, minimalistic newborn photography studio setup, soft diffused lighting, clean white aesthetic, photorealistic, gentle shadows, calm peaceful mood ${NEWBORN_IDENTITY_SUFFIX}`,
    n3: `Vertical 9:16 sleeping newborn baby wrapped in beige blanket, warm cozy studio environment, soft neutral background tones, bakery-style warm aesthetic, natural soft light, realistic baby photography, gentle depth of field, peaceful mood ${NEWBORN_IDENTITY_SUFFIX}`,
    n4: `Vertical 9:16 newborn baby sleeping wrapped in soft pastel fabric, lying on fluffy cloud-like pillows, dreamy soft studio lighting, minimal pastel background, professional newborn photography, ultra realistic skin detail, peaceful mood, shallow depth of field ${NEWBORN_IDENTITY_SUFFIX}`,
    n5: `Vertical 9:16 newborn baby sleeping inside a soft floral nest, pastel flowers around, bright soft daylight studio lighting, spring aesthetic, ultra realistic newborn photography, gentle color palette ${NEWBORN_IDENTITY_SUFFIX}`,
    n6: `Vertical portrait newborn baby wrapped in soft cream blanket, lying next to plush teddy bear, cozy warm studio environment, cinematic soft light, high detail newborn photography style ${NEWBORN_IDENTITY_SUFFIX}`,
    n7: `Vertical 9:16 newborn baby sleeping on soft fabric with warm golden sunset lighting effect, cinematic glow, dreamy warm tones, realistic newborn portrait, professional studio composition ${NEWBORN_IDENTITY_SUFFIX}`,
    n8: `Vertical newborn baby sleeping inside a small vintage basket, soft knitted blanket, warm neutral background, rustic newborn photography style, ultra detailed realistic baby portrait ${NEWBORN_IDENTITY_SUFFIX}`,
    n9: `Vertical 9:16 newborn baby sleeping wrapped in deep navy fabric floating in a dreamy galaxy background, soft stars and nebula colors, cinematic cosmic lighting, ultra realistic newborn photography, magical atmosphere, high detail ${NEWBORN_IDENTITY_SUFFIX}`,
    n10: `Vertical newborn baby sleeping on oversized plush toys, miniature toy world concept, colorful soft environment, dreamy cinematic lighting, ultra cute photorealistic newborn photography ${NEWBORN_IDENTITY_SUFFIX}`,
    n11: `Vertical 9:16 newborn baby wrapped in pastel blanket floating with soft balloons, airy dreamy studio background, soft sunlight glow, high-end newborn photography style ${NEWBORN_IDENTITY_SUFFIX}`,
    n12: `Vertical newborn baby sleeping on an open fairy tale book, magical soft glow, storybook fantasy style, warm cinematic lighting, whimsical newborn portrait ${NEWBORN_IDENTITY_SUFFIX}`,
    n13: `Vertical 9:16 newborn baby sleeping on soft neutral desert-toned fabrics, minimal boho aesthetic, warm earthy colors, cinematic soft shadows, luxury newborn photography ${NEWBORN_IDENTITY_SUFFIX}`,
    n14: `Vertical newborn baby styled as tiny astronaut, soft space-themed background, cinematic lighting, ultra cute futuristic newborn portrait, photorealistic ${NEWBORN_IDENTITY_SUFFIX}`,
  };
  const DEFAULT_VIDEO_REFERENCE_URL =
    'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fvideos%2Fucan.mp4?alt=media&token=2cfb0fc5-63aa-4a5c-9bea-51bfd78aeb28';
  const VIDEO_REFERENCE_URL_BY_STYLE_ID: Record<string, string> = {
    v1: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fvideos%2Fguzeloyun.mp4?alt=media',
    v2: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fvideos%2Fhavada.mp4?alt=media',
    v3: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fvideos%2Foyun.mp4?alt=media',
    v4: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fvideos%2Fucan.mp4?alt=media&token=2cfb0fc5-63aa-4a5c-9bea-51bfd78aeb28',
  };

  const resolveStylePrompt = (styleId: string | null) => {
    if (!styleId) return null;
    const base = STYLE_PROMPT_BY_ID[styleId] || null;
    if (!base) return null;
    return `${base} ${FRAMING_SUFFIX}`;
  };
  const resolveVideoReferenceUrl = (styleId: string | null) => {
    if (!styleId) return DEFAULT_VIDEO_REFERENCE_URL;
    return VIDEO_REFERENCE_URL_BY_STYLE_ID[styleId] || DEFAULT_VIDEO_REFERENCE_URL;
  };
  const preview = (value: string | null | undefined, max = 220) =>
    value ? value.slice(0, max) : null;
  const toWeddingTitle = (fileName: string) =>
    fileName
      .replace(/\.[^/.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || 'Dugun Stili';
  const toCoupleTitle = (fileName: string) =>
    fileName
      .replace(/\.[^/.]+$/, '')
      .replace(/[_-]+/g, ' ')
      .trim() || 'Cift Cekimi';

  const normalizeKey = (value: string) =>
    value
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\w]/g, '')
      .toLowerCase();

  const resolveStorageObjectPath = (input: string) => {
    const raw = input.trim();
    if (!raw) return null;

    if (raw.startsWith('gs://')) {
      const noPrefix = raw.slice(5); // remove gs://
      const slashIndex = noPrefix.indexOf('/');
      if (slashIndex < 0) return null;
      return noPrefix.slice(slashIndex + 1);
    }

    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      try {
        const parsed = new URL(raw);
        const marker = '/o/';
        const idx = parsed.pathname.indexOf(marker);
        if (idx >= 0) {
          const encodedPath = parsed.pathname.slice(idx + marker.length);
          return decodeURIComponent(encodedPath);
        }
      } catch {
        return null;
      }
      return null;
    }

    return raw;
  };

  const resolveExistingTemplatePath = async (bucket: any, input: string) => {
    const parsed = resolveStorageObjectPath(input);
    if (!parsed) {
      return null;
    }

    const directFile = bucket.file(parsed);
    const [exists] = await directFile.exists();
    if (exists) {
      return parsed;
    }

    const slashIdx = parsed.lastIndexOf('/');
    const prefix = slashIdx >= 0 ? `${parsed.slice(0, slashIdx + 1)}` : '';
    const fileName = slashIdx >= 0 ? parsed.slice(slashIdx + 1) : parsed;
    const targetKey = normalizeKey(fileName);

    if (!prefix) {
      return null;
    }

    const [files] = await bucket.getFiles({ prefix });
    const matched = files.find((file: any) => {
      const name = file.name.slice(prefix.length);
      return normalizeKey(name) === targetKey;
    });
    return matched?.name || null;
  };

  const downloadImageFromSource = async (bucket: any, source: string) => {
    const parsed = resolveStorageObjectPath(source);
    if (parsed) {
      const file = bucket.file(parsed);
      const [exists] = await file.exists();
      if (exists) {
        const [buffer] = await file.download();
        const mimeType = file.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
        return { buffer, mimeType, objectPath: parsed };
      }
    }

    if (source.startsWith('http://') || source.startsWith('https://')) {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Unable to download source image from URL (${response.status})`);
      }
      const arrayBuffer = await response.arrayBuffer();
      const responseMime = (response.headers.get('content-type') || '').toLowerCase().trim();
      const sourceLower = source.toLowerCase();
      const inferredMime =
        sourceLower.includes('.png') ? 'image/png'
          : sourceLower.includes('.webp') ? 'image/webp'
            : sourceLower.includes('.heic') ? 'image/heic'
              : sourceLower.includes('.jpg') || sourceLower.includes('.jpeg') ? 'image/jpeg'
                : 'image/jpeg';
      const mimeType = responseMime.startsWith('image/') ? responseMime : inferredMime;
      return { buffer: Buffer.from(arrayBuffer), mimeType, objectPath: null };
    }

    throw new Error('Source image could not be resolved from storage/url');
  };

  const downloadVideoFromSource = async (source: string) => {
    if (!source.startsWith('http://') && !source.startsWith('https://')) {
      throw new Error('Video source must be a valid URL');
    }

    const headers: Record<string, string> = {};
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(source);
    } catch {
      throw new Error('Video source URL could not be parsed');
    }

    // Gemini file download URLs require API key in header.
    if (parsedUrl.hostname === 'generativelanguage.googleapis.com') {
      const apiKey = process.env.GEMINI_API_KEY || '';
      if (!apiKey) {
        throw new Error('GEMINI_API_KEY is required to download Gemini video files');
      }
      headers['x-goog-api-key'] = apiKey;
    }

    const response = await fetch(source, { headers });
    if (!response.ok) {
      throw new Error(`Unable to download generated video (${response.status})`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const contentType = (response.headers.get('content-type') || '').toLowerCase().trim();
    const mimeType = contentType.startsWith('video/') ? contentType : 'video/mp4';
    return { buffer: Buffer.from(arrayBuffer), mimeType };
  };

  const getSignedOrPublicUrl = async (filePath: string) => {
    const bucket: any = storage.bucket();
    const file = bucket.file(filePath);
    try {
      const [signed] = await file.getSignedUrl({
        action: 'read',
        expires: '2099-12-31',
      });
      return signed;
    } catch {
      const bucketName = bucket.name;
      return `https://firebasestorage.googleapis.com/v0/b/${bucketName}/o/${encodeURIComponent(filePath)}?alt=media`;
    }
  };

  const loadWeddingTemplateItems = async () => {
    const bucket: any = storage.bucket();
    const [files] = await bucket.getFiles({ prefix: 'assets/wedding/' });
    const imageFiles = files.filter((file: any) => {
      const lower = String(file.name || '').toLowerCase();
      return (
        lower.startsWith('assets/wedding/') &&
        !lower.endsWith('/') &&
        (lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.png') ||
          lower.endsWith('.webp'))
      );
    });

    const sorted = imageFiles.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    const items = await Promise.all(
      sorted.map(async (file: any, index: number) => {
        const fileName = String(file.name).split('/').pop() || `wedding_${index + 1}.jpg`;
        const imageUrl = await getSignedOrPublicUrl(file.name);
        const styleId = `w${index + 1}`;
        return {
          id: styleId,
          styleId,
          title: toWeddingTitle(fileName),
          fileName,
          storagePath: file.name,
          imageUrl,
          prompt: `${toWeddingTitle(fileName)} dugun konsepti, premium kompozisyon. ${FRAMING_SUFFIX} ${WEDDING_IDENTITY_SUFFIX}`,
        };
      }),
    );
    return items;
  };
  const loadCoupleTemplateItems = async () => {
    const bucket: any = storage.bucket();
    const [files] = await bucket.getFiles({ prefix: 'assets/cift_cekimi/' });
    const imageFiles = files.filter((file: any) => {
      const lower = String(file.name || '').toLowerCase();
      return (
        lower.startsWith('assets/cift_cekimi/') &&
        !lower.endsWith('/') &&
        (lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') ||
          lower.endsWith('.png') ||
          lower.endsWith('.webp'))
      );
    });

    const sorted = imageFiles.sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
    const items = await Promise.all(
      sorted.map(async (file: any, index: number) => {
        const fileName = String(file.name).split('/').pop() || `couple_${index + 1}.jpg`;
        const imageUrl = await getSignedOrPublicUrl(file.name);
        const styleId = `c${index + 1}`;
        return {
          id: styleId,
          styleId,
          title: toCoupleTitle(fileName),
          fileName,
          storagePath: file.name,
          imageUrl,
          prompt: `${toCoupleTitle(fileName)} cift cekimi konsepti, premium kompozisyon. ${FRAMING_SUFFIX} ${COUPLE_IDENTITY_SUFFIX}`,
        };
      }),
    );
    return items;
  };

  router.post('/generate-photo', authenticateToken, upload.single('image'), async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const fileRequest = req as Request & { file?: Express.Multer.File };
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const styleId = typeof req.body?.style_id === 'string' ? req.body.style_id : null;
      const requestId = typeof req.body?.request_id === 'string'
        ? req.body.request_id
        : (req.header('x-request-id') || null);
      const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;
      const stylePrompt = resolveStylePrompt(styleId);

      logger.info({
        requestId,
        step: 'photo_generate_request_received',
        userId: authReq.user.id,
        styleId,
        hasImageFile: Boolean(fileRequest.file),
        imageMimeType: fileRequest.file?.mimetype || null,
        imageBytes: fileRequest.file?.size || null,
        model: requestedModel || process.env.FAL_IMAGE_MODEL || 'fal-ai/bytedance/seedream/v4/edit',
      }, 'Style photo generation request received');

      if (!fileRequest.file) {
        logger.warn({
          requestId,
          step: 'photo_generate_rejected_missing_image',
          userId: authReq.user.id,
          styleId,
        }, 'Style photo generation rejected due to missing image');
        res.status(400).json({ error: 'invalid_request', message: 'image file is required' });
        return;
      }
      if (!stylePrompt) {
        logger.warn({
          requestId,
          step: 'photo_generate_rejected_invalid_style',
          userId: authReq.user.id,
          styleId,
        }, 'Style photo generation rejected due to invalid style id');
        res.status(400).json({
          error: 'invalid_request',
          message: `A valid style_id is required (received: ${styleId || 'none'})`,
        });
        return;
      }

      const generated = await generateStyledPhoto({
        imageBase64: fileRequest.file.buffer.toString('base64'),
        mimeType: fileRequest.file.mimetype || 'image/jpeg',
        prompt: stylePrompt,
        model: requestedModel,
      });

      logger.info({
        requestId,
        step: 'photo_generate_provider_completed',
        userId: authReq.user.id,
        styleId,
        outputMimeType: generated.mimeType || null,
        outputBase64Length: generated.data?.length || 0,
      }, 'Style photo generation provider completed');

      res.json({
        request_id: requestId,
        style_id: styleId,
        prompt: stylePrompt,
        image: {
          data: generated.data,
          mimeType: generated.mimeType,
        },
        provider_text: generated.text || null,
      });
    } catch (error) {
      logger.error({
        err: error,
        step: 'photo_generate_failed',
        requestId: typeof req.body?.request_id === 'string' ? req.body.request_id : (req.header('x-request-id') || null),
      }, 'Style photo generation failed');
      const message = (error as Error)?.message || 'Style photo generation failed';
      const lowered = message.toLowerCase();
      const isConfigIssue = lowered.includes('gemini_api_key') || lowered.includes('fal_key');
      const status = isConfigIssue ? 503 : 500;
      res.status(status).json({
        error: isConfigIssue ? 'service_unavailable' : 'internal_error',
        message,
      });
    }
  });

  router.post('/newborn/generate-photo', authenticateToken, upload.single('image'), async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const fileRequest = req as Request & { file?: Express.Multer.File };

      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const userId = authReq.user.id;
      const styleId = typeof req.body?.style_id === 'string' ? req.body.style_id : null;
      const baseStylePrompt = resolveStylePrompt(styleId);
      const userImageSource =
        typeof req.body?.user_image_url === 'string'
          ? req.body.user_image_url
          : (typeof req.body?.user_image_path === 'string' ? req.body.user_image_path : '');
      const requestId = typeof req.body?.request_id === 'string'
        ? req.body.request_id
        : (req.header('x-request-id') || null);
      const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;

      logger.info({
        requestId,
        step: 'newborn_generate_request_received',
        userId,
        styleId,
        hasImageFile: Boolean(fileRequest.file),
        imageBytes: fileRequest.file?.size || null,
        userImageSourcePreview: preview(userImageSource),
        model: requestedModel || process.env.FAL_IMAGE_MODEL || 'fal-ai/bytedance/seedream/v4/edit',
      }, 'Newborn generation request received');

      if (!styleId || !styleId.startsWith('n') || !baseStylePrompt) {
        logger.warn({
          requestId,
          step: 'newborn_generate_rejected_invalid_style',
          userId,
          styleId,
        }, 'Newborn generation rejected due to invalid style id');
        res.status(400).json({
          error: 'invalid_request',
          message: `A valid newborn style_id is required (received: ${styleId || 'none'})`,
        });
        return;
      }
      if (!fileRequest.file && !userImageSource) {
        logger.warn({
          requestId,
          step: 'newborn_generate_rejected_missing_image',
          userId,
          styleId,
        }, 'Newborn generation rejected due to missing image input');
        res.status(400).json({ error: 'invalid_request', message: 'image file or user_image_url is required' });
        return;
      }

      const bucket: any = storage.bucket();
      const now = Date.now();
      let userMimeType = 'image/jpeg';
      let userInputPath = '';
      let userInputBuffer: Buffer | null = null;

      if (fileRequest.file) {
        userMimeType = fileRequest.file.mimetype || 'image/jpeg';
        const userExt = extFromMime(userMimeType);
        const uploadName = sanitizeFilename(fileRequest.file.originalname || `user.${userExt}`);
        userInputPath = `users/${userId}/uploads/newborn/${now}-${uploadName}`;
        userInputBuffer = fileRequest.file.buffer;

        await bucket.file(userInputPath).save(fileRequest.file.buffer, {
          contentType: userMimeType,
          resumable: false,
          metadata: {
            cacheControl: 'public,max-age=31536000',
          },
        });
      } else if (userImageSource) {
        const userResolved = await downloadImageFromSource(bucket, userImageSource);
        userMimeType = userResolved.mimeType || 'image/jpeg';
        userInputBuffer = userResolved.buffer;
        userInputPath = userResolved.objectPath || `users/${userId}/uploads/newborn/${now}-remote.jpg`;
      }

      if (!userInputBuffer) {
        logger.warn({
          requestId,
          step: 'newborn_generate_rejected_unresolved_image',
          userId,
          styleId,
          userImageSourcePreview: preview(userImageSource),
        }, 'Newborn generation rejected because user image could not be resolved');
        res.status(400).json({ error: 'invalid_request', message: 'User image could not be loaded' });
        return;
      }
      const promptForGeneration =
        `Transform the person in the photo into an adorable baby. ${baseStylePrompt}. ` +
        'Focus on maintaining facial identity while applying baby characteristics (larger eyes, rounder face, soft skin). ' +
        'High resolution, professional photography.';

      logger.info({
        userId,
        styleId,
        requestId,
        basePromptLength: baseStylePrompt.length,
        basePromptPreview: baseStylePrompt.slice(0, 180),
        promptForGenerationLength: promptForGeneration.length,
        promptForGenerationPreview: promptForGeneration.slice(0, 220),
        model: requestedModel || process.env.FAL_IMAGE_MODEL || 'fal-ai/bytedance/seedream/v4/edit',
        userImagePath: userInputPath,
        userImageBytes: userInputBuffer.length,
      }, 'Newborn generation request prepared');

      const generated = await generateStyledPhotoWithTemplate({
        userImageBase64: userInputBuffer.toString('base64'),
        userMimeType,
        prompt: promptForGeneration,
        model: requestedModel,
      });

      const generatedExt = extFromMime(generated.mimeType || 'image/png');
      const generatedId = randomUUID();
      const generatedPath = `users/${userId}/generated/newborn/${generatedId}.${generatedExt}`;
      const generatedBuffer = Buffer.from(generated.data, 'base64');

      await bucket.file(generatedPath).save(generatedBuffer, {
        contentType: generated.mimeType || 'image/png',
        resumable: false,
        metadata: {
          cacheControl: 'public,max-age=31536000',
        },
      });

      const inputUrl = await getSignedOrPublicUrl(userInputPath);
      const outputUrl = await getSignedOrPublicUrl(generatedPath);

      const recordId = generatedId;
      await db
        .collection('users')
        .doc(userId)
        .collection('generatedPhotos')
        .doc(recordId)
        .set({
          id: recordId,
          styleType: 'yenidogan',
          styleId,
          prompt: promptForGeneration,
          requestId,
          inputImagePath: userInputPath,
          inputImageUrl: inputUrl,
          outputImagePath: generatedPath,
          outputImageUrl: outputUrl,
          outputMimeType: generated.mimeType || 'image/png',
          providerText: generated.text || null,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

      logger.info({
        userId,
        styleId,
        requestId,
        generatedId: recordId,
        outputPath: generatedPath,
        outputBytes: generatedBuffer.length,
      }, 'Newborn generation completed and persisted');

      res.json({
        request_id: requestId,
        style_id: styleId,
        user_id: userId,
        prompt: promptForGeneration,
        input: {
          path: userInputPath,
          url: inputUrl,
        },
        output: {
          id: recordId,
          path: generatedPath,
          url: outputUrl,
          mimeType: generated.mimeType || 'image/png',
        },
        provider_text: generated.text || null,
      });
    } catch (error) {
      logger.error({
        err: error,
        step: 'newborn_generate_failed',
        requestId: typeof req.body?.request_id === 'string' ? req.body.request_id : (req.header('x-request-id') || null),
      }, 'Newborn style photo generation failed');
      const message = (error as Error)?.message || 'Newborn style photo generation failed';
      const lowered = message.toLowerCase();
      const isConfigIssue = lowered.includes('gemini_api_key') || lowered.includes('fal_key');
      const status = isConfigIssue ? 503 : 500;
      res.status(status).json({
        error: isConfigIssue ? 'service_unavailable' : 'internal_error',
        message,
      });
    }
  });

  router.get('/wedding/templates', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const items = await loadWeddingTemplateItems();
      logger.info(
        { userId: authReq.user.id, count: items.length, step: 'wedding_templates_list_success' },
        'Wedding templates listed',
      );
      res.json({ items });
    } catch (error) {
      logger.error({ err: error, step: 'wedding_templates_list_error' }, 'Failed to list wedding templates');
      res.status(500).json({ error: 'internal_error', message: 'Failed to list wedding templates' });
    }
  });

  router.post('/wedding/generate-photo', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const userId = authReq.user.id;
      const styleId = typeof req.body?.style_id === 'string' ? req.body.style_id : null;
      const motherImageSource =
        typeof req.body?.mother_image_url === 'string'
          ? req.body.mother_image_url
          : (typeof req.body?.mother_image_path === 'string' ? req.body.mother_image_path : '');
      const fatherImageSource =
        typeof req.body?.father_image_url === 'string'
          ? req.body.father_image_url
          : (typeof req.body?.father_image_path === 'string' ? req.body.father_image_path : '');
      const requestId = typeof req.body?.request_id === 'string'
        ? req.body.request_id
        : (req.header('x-request-id') || null);
      const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;

      if (!styleId || !motherImageSource || !fatherImageSource) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'style_id, mother_image_url and father_image_url are required',
        });
        return;
      }

      const weddingTemplates = await loadWeddingTemplateItems();
      const selectedTemplate = weddingTemplates.find(item => item.styleId === styleId) || null;
      if (!selectedTemplate) {
        res.status(400).json({ error: 'invalid_request', message: `Invalid wedding style_id: ${styleId}` });
        return;
      }

      const bucket: any = storage.bucket();
      const motherResolved = await downloadImageFromSource(bucket, motherImageSource);
      const fatherResolved = await downloadImageFromSource(bucket, fatherImageSource);
      const templateResolved = await downloadImageFromSource(bucket, selectedTemplate.storagePath);
      const now = Date.now();
      const motherExt = extFromMime(motherResolved.mimeType || 'image/jpeg');
      const fatherExt = extFromMime(fatherResolved.mimeType || 'image/jpeg');
      const motherInputPath = `users/${userId}/uploads/wedding/${now}-mother.${motherExt}`;
      const fatherInputPath = `users/${userId}/uploads/wedding/${now}-father.${fatherExt}`;

      await bucket.file(motherInputPath).save(motherResolved.buffer, {
        contentType: motherResolved.mimeType || 'image/jpeg',
        resumable: false,
        metadata: { cacheControl: 'public,max-age=31536000' },
      });
      await bucket.file(fatherInputPath).save(fatherResolved.buffer, {
        contentType: fatherResolved.mimeType || 'image/jpeg',
        resumable: false,
        metadata: { cacheControl: 'public,max-age=31536000' },
      });

      const generated = await generateWeddingStyledPhotoWithTemplate({
        motherImageBase64: motherResolved.buffer.toString('base64'),
        motherMimeType: motherResolved.mimeType || 'image/jpeg',
        fatherImageBase64: fatherResolved.buffer.toString('base64'),
        fatherMimeType: fatherResolved.mimeType || 'image/jpeg',
        templateImageBase64: templateResolved.buffer.toString('base64'),
        templateMimeType: templateResolved.mimeType || 'image/jpeg',
        prompt: selectedTemplate.prompt,
        model: requestedModel,
      });

      const generatedExt = extFromMime(generated.mimeType || 'image/png');
      const generatedId = randomUUID();
      const generatedPath = `users/${userId}/generated/wedding/${generatedId}.${generatedExt}`;
      const generatedBuffer = Buffer.from(generated.data, 'base64');
      await bucket.file(generatedPath).save(generatedBuffer, {
        contentType: generated.mimeType || 'image/png',
        resumable: false,
        metadata: { cacheControl: 'public,max-age=31536000' },
      });

      const outputUrl = await getSignedOrPublicUrl(generatedPath);
      const motherInputUrl = await getSignedOrPublicUrl(motherInputPath);
      const fatherInputUrl = await getSignedOrPublicUrl(fatherInputPath);
      const templateUrl = selectedTemplate.imageUrl;

      await db
        .collection('users')
        .doc(userId)
        .collection('generatedPhotos')
        .doc(generatedId)
        .set({
          id: generatedId,
          styleType: 'wedding',
          styleId,
          requestId,
          prompt: selectedTemplate.prompt,
          inputMotherImagePath: motherInputPath,
          inputMotherImageUrl: motherInputUrl,
          inputFatherImagePath: fatherInputPath,
          inputFatherImageUrl: fatherInputUrl,
          templateImagePath: selectedTemplate.storagePath,
          templateImageUrl: templateUrl,
          outputImagePath: generatedPath,
          outputImageUrl: outputUrl,
          outputMimeType: generated.mimeType || 'image/png',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

      logger.info(
        { userId, styleId, generatedId, requestId, step: 'wedding_generate_success' },
        'Wedding style generation completed',
      );
      res.json({
        request_id: requestId,
        style_id: styleId,
        user_id: userId,
        prompt: selectedTemplate.prompt,
        input: {
          mother_path: motherInputPath,
          mother_url: motherInputUrl,
          father_path: fatherInputPath,
          father_url: fatherInputUrl,
          template_path: selectedTemplate.storagePath,
          template_url: templateUrl,
        },
        output: {
          id: generatedId,
          path: generatedPath,
          url: outputUrl,
          mimeType: generated.mimeType || 'image/png',
        },
      });
    } catch (error) {
      logger.error(
        { err: error, step: 'wedding_generate_failed', requestId: req.header('x-request-id') || null },
        'Wedding style generation failed',
      );
      res.status(500).json({ error: 'internal_error', message: (error as Error)?.message || 'Wedding generation failed' });
    }
  });

  router.get('/couple/templates', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const items = await loadCoupleTemplateItems();
      logger.info(
        { userId: authReq.user.id, count: items.length, step: 'couple_templates_list_success' },
        'Couple templates listed',
      );
      res.json({ items });
    } catch (error) {
      logger.error({ err: error, step: 'couple_templates_list_error' }, 'Failed to list couple templates');
      res.status(500).json({ error: 'internal_error', message: 'Failed to list couple templates' });
    }
  });

  router.post('/couple/generate-photo', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const userId = authReq.user.id;
      const styleId = typeof req.body?.style_id === 'string' ? req.body.style_id : null;
      const templateImageSource =
        typeof req.body?.template_image_url === 'string'
          ? req.body.template_image_url
          : (typeof req.body?.template_image_path === 'string' ? req.body.template_image_path : '');
      const promptOverride = typeof req.body?.prompt === 'string' ? req.body.prompt : null;
      const firstImageSource =
        typeof req.body?.first_image_url === 'string'
          ? req.body.first_image_url
          : (typeof req.body?.first_image_path === 'string' ? req.body.first_image_path : '');
      const secondImageSource =
        typeof req.body?.second_image_url === 'string'
          ? req.body.second_image_url
          : (typeof req.body?.second_image_path === 'string' ? req.body.second_image_path : '');
      const requestId = typeof req.body?.request_id === 'string'
        ? req.body.request_id
        : (req.header('x-request-id') || null);
      const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;

      if (!firstImageSource || !secondImageSource || (!styleId && !templateImageSource)) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'first_image_url, second_image_url and (style_id or template_image_url/template_image_path) are required',
        });
        return;
      }

      const coupleTemplates = await loadCoupleTemplateItems();
      const selectedTemplate = styleId
        ? (coupleTemplates.find(item => item.styleId === styleId) || null)
        : null;
      if (styleId && !selectedTemplate && !templateImageSource) {
        res.status(400).json({ error: 'invalid_request', message: `Invalid couple style_id: ${styleId}` });
        return;
      }

      const bucket: any = storage.bucket();
      const firstResolved = await downloadImageFromSource(bucket, firstImageSource);
      const secondResolved = await downloadImageFromSource(bucket, secondImageSource);
      const templateSourceToUse = templateImageSource || selectedTemplate?.storagePath || '';
      if (!templateSourceToUse) {
        res.status(400).json({ error: 'invalid_request', message: 'Template image source could not be resolved' });
        return;
      }
      const templateResolved = await downloadImageFromSource(bucket, templateSourceToUse);
      const promptForGeneration =
        promptOverride
        || selectedTemplate?.prompt
        || 'Do not change the template background at all. Only face swap: apply mother and father faces from input photos onto the two people in template, while keeping composition, clothes, pose and lighting exactly the same.';
      const now = Date.now();
      const firstExt = extFromMime(firstResolved.mimeType || 'image/jpeg');
      const secondExt = extFromMime(secondResolved.mimeType || 'image/jpeg');
      const firstInputPath = `users/${userId}/uploads/cift_cekimi/${now}-first.${firstExt}`;
      const secondInputPath = `users/${userId}/uploads/cift_cekimi/${now}-second.${secondExt}`;

      await bucket.file(firstInputPath).save(firstResolved.buffer, {
        contentType: firstResolved.mimeType || 'image/jpeg',
        resumable: false,
        metadata: { cacheControl: 'public,max-age=31536000' },
      });
      await bucket.file(secondInputPath).save(secondResolved.buffer, {
        contentType: secondResolved.mimeType || 'image/jpeg',
        resumable: false,
        metadata: { cacheControl: 'public,max-age=31536000' },
      });

      const generated = await generateCoupleStyledPhotoWithTemplate({
        firstImageBase64: firstResolved.buffer.toString('base64'),
        firstMimeType: firstResolved.mimeType || 'image/jpeg',
        secondImageBase64: secondResolved.buffer.toString('base64'),
        secondMimeType: secondResolved.mimeType || 'image/jpeg',
        templateImageBase64: templateResolved.buffer.toString('base64'),
        templateMimeType: templateResolved.mimeType || 'image/jpeg',
        prompt: promptForGeneration,
        model: requestedModel,
      });

      const generatedExt = extFromMime(generated.mimeType || 'image/png');
      const generatedId = randomUUID();
      const generatedPath = `users/${userId}/generated/cift_cekimi/${generatedId}.${generatedExt}`;
      const generatedBuffer = Buffer.from(generated.data, 'base64');
      await bucket.file(generatedPath).save(generatedBuffer, {
        contentType: generated.mimeType || 'image/png',
        resumable: false,
        metadata: { cacheControl: 'public,max-age=31536000' },
      });

      const outputUrl = await getSignedOrPublicUrl(generatedPath);
      const firstInputUrl = await getSignedOrPublicUrl(firstInputPath);
      const secondInputUrl = await getSignedOrPublicUrl(secondInputPath);
      const templateStoragePath =
        selectedTemplate?.storagePath
        || resolveStorageObjectPath(templateSourceToUse)
        || null;
      const templateUrl =
        selectedTemplate?.imageUrl
        || (templateStoragePath ? await getSignedOrPublicUrl(templateStoragePath) : templateSourceToUse);

      await db
        .collection('users')
        .doc(userId)
        .collection('generatedPhotos')
        .doc(generatedId)
        .set({
          id: generatedId,
          styleType: 'cift_cekimi',
          styleId: styleId || selectedTemplate?.styleId || null,
          requestId,
          prompt: promptForGeneration,
          inputFirstImagePath: firstInputPath,
          inputFirstImageUrl: firstInputUrl,
          inputSecondImagePath: secondInputPath,
          inputSecondImageUrl: secondInputUrl,
          templateImagePath: templateStoragePath,
          templateImageUrl: templateUrl,
          outputImagePath: generatedPath,
          outputImageUrl: outputUrl,
          outputMimeType: generated.mimeType || 'image/png',
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

      logger.info(
        { userId, styleId, generatedId, requestId, step: 'couple_generate_success' },
        'Couple style generation completed',
      );
      res.json({
        request_id: requestId,
        style_id: styleId || selectedTemplate?.styleId || null,
        user_id: userId,
        prompt: promptForGeneration,
        input: {
          first_path: firstInputPath,
          first_url: firstInputUrl,
          second_path: secondInputPath,
          second_url: secondInputUrl,
          template_path: templateStoragePath,
          template_url: templateUrl,
        },
        output: {
          id: generatedId,
          path: generatedPath,
          url: outputUrl,
          mimeType: generated.mimeType || 'image/png',
        },
      });
    } catch (error) {
      logger.error(
        { err: error, step: 'couple_generate_failed', requestId: req.header('x-request-id') || null },
        'Couple style generation failed',
      );
      res.status(500).json({ error: 'internal_error', message: (error as Error)?.message || 'Couple generation failed' });
    }
  });

  router.post('/video/generate', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const userId = authReq.user.id;
      const styleId = typeof req.body?.style_id === 'string' ? req.body.style_id : null;
      const userImageSource =
        typeof req.body?.user_image_url === 'string'
          ? req.body.user_image_url
          : (typeof req.body?.user_image_path === 'string' ? req.body.user_image_path : '');
      const requestId = typeof req.body?.request_id === 'string'
        ? req.body.request_id
        : (req.header('x-request-id') || null);
      const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;

      const referenceVideoUrl = resolveVideoReferenceUrl(styleId);
      const resolvedByStyleMap = Boolean(styleId && VIDEO_REFERENCE_URL_BY_STYLE_ID[styleId]);
      logger.info({
        requestId,
        step: 'video_reference_resolved',
        userId,
        styleId,
        resolvedByStyleMap,
        usedDefaultReference: !resolvedByStyleMap,
        referenceVideoUrlPreview: preview(referenceVideoUrl),
      }, 'Video reference URL resolved');
      if (!referenceVideoUrl) {
        logger.warn({
          requestId,
          step: 'video_generate_rejected_missing_reference',
          userId,
          styleId,
        }, 'Video generation rejected due to unresolved reference URL');
        res.status(400).json({
          error: 'invalid_request',
          message: 'Video URL could not be resolved',
        });
        return;
      }

      if (!userImageSource) {
        logger.warn({
          requestId,
          step: 'video_generate_rejected_missing_user_image',
          userId,
          styleId,
        }, 'Video generation rejected due to missing user image');
        res.status(400).json({ error: 'invalid_request', message: 'user_image_url is required' });
        return;
      }

      logger.info({
        requestId,
        step: 'video_generate_request_received',
        userId,
        styleId,
        model: requestedModel || process.env.FAL_VIDEO_MODEL || 'fal-ai/pixverse/swap',
        userImageUrlPreview: preview(userImageSource),
        referenceVideoUrlPreview: preview(referenceVideoUrl),
      }, 'Video generation request received');

      const providerResult = await generateStyledVideoWithVeo({
        styleId,
        userImageUrl: userImageSource,
        referenceVideoUrl,
        requestId,
        model: requestedModel,
      });

      logger.info({
        requestId,
        step: 'video_generate_provider_completed',
        styleId,
        usedFallback: providerResult.usedFallback,
        providerStatus: providerResult.providerStatus,
        outputVideoUrlPreview: preview(providerResult.outputVideoUrl),
      }, 'Video generation provider step completed');

      const generatedId = randomUUID();
      const now = Date.now();
      const inputPath = resolveStorageObjectPath(userImageSource) || `users/${userId}/uploads/video/${now}-remote.jpg`;
      const bucket: any = storage.bucket();
      let outputVideoUrl = providerResult.outputVideoUrl;
      let outputVideoPath: string | null = null;
      let outputMimeType = 'video/mp4';

      // When provider returns a real generated video file, persist it under user storage.
      if (!providerResult.usedFallback) {
        const downloadedVideo = await downloadVideoFromSource(providerResult.outputVideoUrl);
        outputMimeType = downloadedVideo.mimeType || 'video/mp4';
        const videoExt = extFromVideoMime(outputMimeType);
        outputVideoPath = `users/${userId}/generated/video/${generatedId}.${videoExt}`;

        await bucket.file(outputVideoPath).save(downloadedVideo.buffer, {
          contentType: outputMimeType,
          resumable: false,
          metadata: {
            cacheControl: 'public,max-age=31536000',
          },
        });
        outputVideoUrl = await getSignedOrPublicUrl(outputVideoPath);

        logger.info({
          requestId,
          step: 'video_generate_output_uploaded',
          generatedId,
          outputVideoPath,
          outputBytes: downloadedVideo.buffer.length,
          outputMimeType,
        }, 'Generated video uploaded to user storage');
      }

      await db
        .collection('users')
        .doc(userId)
        .collection('generatedPhotos')
        .doc(generatedId)
        .set({
          id: generatedId,
          styleType: 'video',
          styleId,
          requestId,
          inputImagePath: inputPath,
          inputImageUrl: userImageSource,
          outputVideoUrl,
          outputVideoPath,
          outputImageUrl: null,
          outputMimeType,
          providerText: providerResult.providerText || null,
          providerStatus: providerResult.providerStatus || null,
          providerRaw: providerResult.providerRaw || null,
          usedFallback: providerResult.usedFallback,
          createdAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });

      logger.info({
        requestId,
        step: 'video_generate_persisted',
        userId,
        styleId,
        generatedId,
        inputPath,
        outputVideoPath,
        usedFallback: providerResult.usedFallback,
      }, 'Video generation result persisted');

      res.json({
        request_id: requestId,
        style_id: styleId,
        user_id: userId,
        input: {
          path: inputPath,
          url: userImageSource,
        },
        output: {
          id: generatedId,
          path: outputVideoPath,
          url: outputVideoUrl,
          mimeType: outputMimeType,
        },
        provider_text: providerResult.providerText || null,
      });
    } catch (error) {
      logger.error({
        err: error,
        step: 'video_generate_failed',
        requestId: typeof req.body?.request_id === 'string' ? req.body.request_id : (req.header('x-request-id') || null),
        styleId: typeof req.body?.style_id === 'string' ? req.body.style_id : null,
      }, 'Video generation request failed');
      const message = (error as Error)?.message || 'Video generation failed';
      res.status(500).json({
        error: 'internal_error',
        message,
      });
    }
  });

  router.get('/history', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      // Force fresh history payloads (avoid conditional 304 responses).
      delete req.headers['if-none-match'];
      delete req.headers['if-modified-since'];
      res.set({
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        Pragma: 'no-cache',
        Expires: '0',
        'Surrogate-Control': 'no-store',
      });

      const userId = authReq.user.id;
      logger.info({ userId, step: 'history_list_request_received' }, 'Generated history list request received');
      const snapshot = await db
        .collection('users')
        .doc(userId)
        .collection('generatedPhotos')
        .orderBy('createdAt', 'desc')
        .limit(200)
        .get();

      const items = snapshot.docs.map((doc: any) => {
        const data = doc.data() as any;
        const createdAtRaw = data?.createdAt;
        let createdAtIso: string | null = null;
        if (createdAtRaw && typeof createdAtRaw?.toDate === 'function') {
          createdAtIso = createdAtRaw.toDate().toISOString();
        } else if (createdAtRaw instanceof Date) {
          createdAtIso = createdAtRaw.toISOString();
        } else if (typeof createdAtRaw === 'string') {
          createdAtIso = createdAtRaw;
        }
        return {
          id: doc.id,
          styleType: data?.styleType || 'photo',
          styleId: data?.styleId || null,
          prompt: data?.prompt || null,
          outputImageUrl: data?.outputImageUrl || null,
          outputImagePath: data?.outputImagePath || null,
          outputVideoUrl: data?.outputVideoUrl || null,
          outputVideoPath: data?.outputVideoPath || null,
          outputMimeType: data?.outputMimeType || null,
          inputImageUrl: data?.inputImageUrl || null,
          createdAt: createdAtIso,
        };
      });

      logger.info({
        userId,
        step: 'history_list_completed',
        count: items.length,
      }, 'Generated history list completed');
      res.json({ items });
    } catch (error) {
      logger.error({ err: error }, 'Failed to fetch generated history');
      res.status(500).json({ error: 'internal_error', message: 'Failed to fetch history' });
    }
  });

  router.delete('/history/:id', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const userId = authReq.user.id;
      const id = req.params.id;
      if (!id) {
        res.status(400).json({ error: 'invalid_request', message: 'History id is required' });
        return;
      }
      logger.info({ userId, id, step: 'history_delete_request_received' }, 'Generated history delete request received');

      const ref = db.collection('users').doc(userId).collection('generatedPhotos').doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'not_found', message: 'History record not found' });
        return;
      }

      const data = snap.data() as any;
      const bucket: any = storage.bucket();
      const paths = [data?.outputImagePath, data?.outputVideoPath, data?.inputImagePath]
        .filter(Boolean) as string[];

      for (const path of paths) {
        try {
          await bucket.file(path).delete();
        } catch (err) {
          logger.warn({ err, userId, id, path }, 'Failed to delete storage object for history item');
        }
      }

      await ref.delete();
      logger.info({
        userId,
        id,
        step: 'history_delete_completed',
        deletedStoragePathsCount: paths.length,
      }, 'Generated history delete completed');
      res.json({ success: true, id });
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete generated history item');
      res.status(500).json({ error: 'internal_error', message: 'Failed to delete history record' });
    }
  });

  return router;
};
