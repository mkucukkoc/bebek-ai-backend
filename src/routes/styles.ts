import { Request, Router } from 'express';
import multer from 'multer';
import { authenticateToken, AuthRequest } from '../middleware/authMiddleware';
import { generateStyledPhoto } from '../server/bebek/services/geminiService';
import { logger } from '../utils/logger';
import { attachRouteLogger } from '../utils/routeLogger';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024 },
});

export const createStylesRouter = () => {
  const router = Router();
  attachRouteLogger(router, 'bebek-styles');

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

  return router;
};
