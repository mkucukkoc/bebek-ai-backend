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

  const NEWBORN_TEMPLATE_URLS: Record<string, string> = {
    n1: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FY%C4%B1ld%C4%B1z%20Stu%CC%88dyo.png?alt=media&token=b32006cb-948e-4829-b598-13dff314088d',
    n2: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FBeyaz%20-%20Pelus%CC%A7.png?alt=media&token=84206847-1c7f-4536-b2c8-4343bdfec596',
    n3: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FKruvasan%20Stu%CC%88dyo.png?alt=media&token=764021f4-cea1-444d-915f-630036184222',
    n4: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FBulut%20Ru%CC%88ya%20Stu%CC%88dyo.png?alt=media&token=931dd6c5-c31e-4ce8-a33c-1a2f32a22791',
    n5: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FC%CC%A7ic%CC%A7ekli%20Bahar.png?alt=media&token=fa51b742-6afa-4a44-9d99-c49846c8af35',
    n6: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FAy%C4%B1c%C4%B1k%20Pelus%CC%A7.png?alt=media&token=5ec3457e-6d3e-445c-acec-9fef61b6c38c',
    n7: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FAlt%C4%B1n%20Gu%CC%88n%20Bat%C4%B1m%C4%B1.png?alt=media&token=5c1874f8-e0f0-4537-af42-f18953b993f2',
    n8: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FVintage%20Sepet.png?alt=media&token=d2a0ec3f-b99b-4b0b-ae43-d1a911088e05',
    n9: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FGalaksi%20Bebek.png?alt=media&token=92ac051b-4eea-4333-96d7-b617f5395be4',
    n10: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FDev%20Oyuncak%20Du%CC%88nyas%C4%B1.png?alt=media&token=90219c63-d2dd-4f53-a0ea-ed7cd9a24a23',
    n11: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FUc%CC%A7an%20Balon.png?alt=media&token=5f0d6af5-07eb-4b3a-bb10-b109f85f7c69',
    n12: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FMasal%20Kitab%C4%B1.png?alt=media&token=09b0d4da-0ec6-4c4b-86dc-a7bcba5ea7a5',
    n13: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FKum%20Ru%CC%88yas%C4%B1.png?alt=media&token=14ad8cf2-837a-4874-9128-8bda46fbde0a',
    n14: 'https://firebasestorage.googleapis.com/v0/b/bebek-ai.firebasestorage.app/o/assets%2Fyenidogan%2FUzay%20Astronot%20Bebek.png?alt=media&token=ec2b3586-03ea-4b1b-99b7-00a0694c1264',
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
      const requestedTemplateUrl = typeof req.body?.template_url === 'string' ? req.body.template_url.trim() : '';
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
      const resolvedTemplateUrl = requestedTemplateUrl || (styleId ? NEWBORN_TEMPLATE_URLS[styleId] : '');
      if (!resolvedTemplateUrl) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'A valid style_id (n1-n14) or template_url is required',
        });
        return;
      }
      if (!fileRequest.file && !userImageSource) {
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
        res.status(400).json({ error: 'invalid_request', message: 'User image could not be loaded' });
        return;
      }
      const templateResolved = await downloadImageFromSource(bucket, resolvedTemplateUrl);

      logger.info({
        userId,
        styleId,
        requestId,
        promptLength: prompt.length,
        promptPreview: prompt.slice(0, 180),
        model: requestedModel || process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image',
        userImagePath: userInputPath,
        userImageBytes: userInputBuffer.length,
        templateUrl: resolvedTemplateUrl,
        templateBytes: templateResolved.buffer.length,
      }, 'Newborn generation request prepared');

      const generated = await generateStyledPhotoWithTemplate({
        userImageBase64: userInputBuffer.toString('base64'),
        userMimeType,
        templateImageBase64: templateResolved.buffer.toString('base64'),
        templateMimeType: templateResolved.mimeType || 'image/png',
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
          templateUrl: resolvedTemplateUrl,
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
        template_url: resolvedTemplateUrl,
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
