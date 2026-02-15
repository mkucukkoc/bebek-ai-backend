import { Request, Router } from 'express';
import multer from 'multer';
import { authenticateToken, AuthRequest } from '../middleware/authMiddleware';
import { randomUUID } from 'crypto';
import { db, FieldValue, storage } from '../firebase';
import { generateStyledPhoto, generateStyledPhotoWithTemplate } from '../server/bebek/services/geminiService';
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
      const mimeType = response.headers.get('content-type') || 'image/jpeg';
      return { buffer: Buffer.from(arrayBuffer), mimeType, objectPath: null };
    }

    throw new Error('Source image could not be resolved from storage/url');
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

  router.post('/generate-photo', authenticateToken, upload.single('image'), async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      const fileRequest = req as Request & { file?: Express.Multer.File };
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      const styleId = typeof req.body?.style_id === 'string' ? req.body.style_id : null;
      const requestId = typeof req.body?.request_id === 'string'
        ? req.body.request_id
        : (req.header('x-request-id') || null);
      const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;

      if (!fileRequest.file) {
        res.status(400).json({ error: 'invalid_request', message: 'image file is required' });
        return;
      }
      if (!prompt) {
        res.status(400).json({ error: 'invalid_request', message: 'prompt is required' });
        return;
      }

      const generated = await generateStyledPhoto({
        imageBase64: fileRequest.file.buffer.toString('base64'),
        mimeType: fileRequest.file.mimetype || 'image/jpeg',
        prompt,
        model: requestedModel,
      });

      res.json({
        request_id: requestId,
        style_id: styleId,
        prompt,
        image: {
          data: generated.data,
          mimeType: generated.mimeType,
        },
        provider_text: generated.text || null,
      });
    } catch (error) {
      logger.error({ err: error }, 'Style photo generation failed');
      const message = (error as Error)?.message || 'Style photo generation failed';
      const lowered = message.toLowerCase();
      const isConfigIssue = lowered.includes('gemini_api_key');
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
      const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
      const styleId = typeof req.body?.style_id === 'string' ? req.body.style_id : null;
      const templatePathInput =
        typeof req.body?.template_path === 'string'
          ? req.body.template_path
          : (typeof req.body?.template_url === 'string' ? req.body.template_url : '');
      const userImageSource =
        typeof req.body?.user_image_url === 'string'
          ? req.body.user_image_url
          : (typeof req.body?.user_image_path === 'string' ? req.body.user_image_path : '');
      const requestId = typeof req.body?.request_id === 'string'
        ? req.body.request_id
        : (req.header('x-request-id') || null);
      const requestedModel = typeof req.body?.model === 'string' ? req.body.model : undefined;

      if (!prompt) {
        res.status(400).json({ error: 'invalid_request', message: 'prompt is required' });
        return;
      }
      if (!templatePathInput) {
        res.status(400).json({ error: 'invalid_request', message: 'template_path (or template_url) is required' });
        return;
      }
      if (!fileRequest.file && !userImageSource) {
        res.status(400).json({ error: 'invalid_request', message: 'image file or user_image_url is required' });
        return;
      }

      const bucket: any = storage.bucket();
      const templateObjectPath = await resolveExistingTemplatePath(bucket, templatePathInput);
      if (!templateObjectPath) {
        res.status(400).json({ error: 'invalid_request', message: 'template path/url is invalid' });
        return;
      }

      const templateFile = bucket.file(templateObjectPath);
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
        res.status(400).json({ error: 'invalid_request', message: 'User image could not be loaded' });
        return;
      }

      const [templateBuffer] = await templateFile.download();
      const templateMimeType = templateFile.name.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';

      logger.info({
        userId,
        styleId,
        requestId,
        model: requestedModel || process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
        templatePath: templateObjectPath,
        userImagePath: userInputPath,
        userImageBytes: userInputBuffer.length,
        templateBytes: templateBuffer.length,
      }, 'Newborn generation request prepared');

      const generated = await generateStyledPhotoWithTemplate({
        userImageBase64: userInputBuffer.toString('base64'),
        userMimeType,
        templateImageBase64: templateBuffer.toString('base64'),
        templateMimeType,
        prompt,
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
      const templateUrl = await getSignedOrPublicUrl(templateObjectPath);
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
          prompt,
          requestId,
          inputImagePath: userInputPath,
          inputImageUrl: inputUrl,
          templatePath: templateObjectPath,
          templateUrl,
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
        prompt,
        template_path: templateObjectPath,
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
      logger.error({ err: error }, 'Newborn style photo generation failed');
      const message = (error as Error)?.message || 'Newborn style photo generation failed';
      const lowered = message.toLowerCase();
      const isConfigIssue = lowered.includes('gemini_api_key');
      const status = isConfigIssue ? 503 : 500;
      res.status(status).json({
        error: isConfigIssue ? 'service_unavailable' : 'internal_error',
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

      const userId = authReq.user.id;
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
          outputMimeType: data?.outputMimeType || null,
          inputImageUrl: data?.inputImageUrl || null,
          templateUrl: data?.templateUrl || null,
          createdAt: createdAtIso,
        };
      });

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

      const ref = db.collection('users').doc(userId).collection('generatedPhotos').doc(id);
      const snap = await ref.get();
      if (!snap.exists) {
        res.status(404).json({ error: 'not_found', message: 'History record not found' });
        return;
      }

      const data = snap.data() as any;
      const bucket: any = storage.bucket();
      const paths = [data?.outputImagePath, data?.inputImagePath].filter(Boolean) as string[];

      for (const path of paths) {
        try {
          await bucket.file(path).delete();
        } catch (err) {
          logger.warn({ err, userId, id, path }, 'Failed to delete storage object for history item');
        }
      }

      await ref.delete();
      res.json({ success: true, id });
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete generated history item');
      res.status(500).json({ error: 'internal_error', message: 'Failed to delete history record' });
    }
  });

  return router;
};
