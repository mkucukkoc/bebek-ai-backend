import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/authMiddleware';
import { db } from '../firebase';
import { ensureUserInfo } from '../server/bebek/services/userInfoService';
import {
  createChildChatSession,
  handleChatMessage,
  handleChatMessageStream,
  listChatMessages,
  listChatSessions,
} from '../server/bebek/services/chatService';
import { logger } from '../utils/logger';
import { attachRouteLogger } from '../utils/routeLogger';

const DEFAULT_CHAT_SETTINGS = {
  tone: 'default',
  mood: 'cheerful',
  responseLength: 'balanced',
  emojiStyle: 'some',
};

export const createChatRouter = () => {
  const router = Router();
  attachRouteLogger(router, 'bebek-chat');

  router.post('/', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const { sessionId, message, context, stream, image } = req.body || {};
      if (!message) {
        res.status(400).json({ error: 'invalid_request', message: 'message is required' });
        return;
      }

      if (image) {
        const isImagePayloadValid = typeof image?.data === 'string' && typeof image?.mimeType === 'string';
        if (!isImagePayloadValid || !image.mimeType.startsWith('image/')) {
          res.status(400).json({ error: 'invalid_request', message: 'Only image attachments are supported' });
          return;
        }
      }

      const userInfo = await ensureUserInfo(authReq.user.id, {
        name: authReq.user.name,
        email: authReq.user.email
      });

      const imagePayload = image ? { data: image.data, mimeType: image.mimeType } : null;

      if (stream) {
        const streamSetup = await handleChatMessageStream({
          user: userInfo,
          sessionId,
          message,
          contextTags: context || null,
          imagePayload
        });
        res.json({
          streaming: true,
          messageId: streamSetup.messageId,
          sessionId: streamSetup.sessionId
        });
        void streamSetup.run().catch((error) => {
          logger.error({ err: error, sessionId: streamSetup.sessionId }, 'Chat stream failed');
        });
        return;
      }

      const result = await handleChatMessage({
        user: userInfo,
        sessionId,
        message,
        contextTags: context || null,
        imagePayload
      });

      res.json(result);
    } catch (error) {
      logger.error({ err: error }, 'Chat request failed');
      res.status(500).json({ error: 'internal_error', message: 'Chat request failed' });
    }
  });

  router.get('/sessions', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const sessions = await listChatSessions(authReq.user.id);
      res.json({ sessions });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list chat sessions');
      res.status(500).json({ error: 'internal_error', message: 'Failed to list chat sessions' });
    }
  });

  router.get('/sessions/:id/messages', authenticateToken, async (req, res) => {
    try {
      const messages = await listChatMessages(req.params.id);
      res.json({ messages });
    } catch (error) {
      logger.error({ err: error }, 'Failed to list chat messages');
      res.status(500).json({ error: 'internal_error', message: 'Failed to list chat messages' });
    }
  });

  router.post('/sessions/child', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const { childId, childName } = req.body || {};
      if (!childId || !childName) {
        res.status(400).json({ error: 'invalid_request', message: 'childId and childName are required' });
        return;
      }

      logger.info(
        { userId: authReq.user.id, childId, childName, step: 'create_child_chat_session_request' },
        'Creating child chat session',
      );
      const session = await createChildChatSession({
        userId: authReq.user.id,
        childId: String(childId),
        childName: String(childName),
      });

      logger.info(
        { userId: authReq.user.id, childId, childName, sessionId: session.id, step: 'create_child_chat_session_success' },
        'Child chat session created successfully',
      );
      res.json({ success: true, session });
    } catch (error) {
      logger.error({ err: error, step: 'create_child_chat_session_error' }, 'Failed to create child chat session');
      res.status(500).json({ error: 'internal_error', message: 'Failed to create child chat session' });
    }
  });

  router.get('/settings/assistant', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      logger.info({ userId: authReq.user.id, step: 'get_assistant_settings_request' }, 'Fetching assistant settings');
      const settingsDoc = await db.collection('ChatSettings').doc(authReq.user.id).get();
      if (!settingsDoc.exists) {
        logger.info({ userId: authReq.user.id, step: 'get_assistant_settings_default' }, 'No settings found, returning defaults');
        res.json({ success: true, exists: false, settings: DEFAULT_CHAT_SETTINGS });
        return;
      }

      const data = settingsDoc.data() || {};
      const settings = {
        tone: data.tone || DEFAULT_CHAT_SETTINGS.tone,
        mood: data.mood || DEFAULT_CHAT_SETTINGS.mood,
        responseLength: data.responseLength || DEFAULT_CHAT_SETTINGS.responseLength,
        emojiStyle: data.emojiStyle || DEFAULT_CHAT_SETTINGS.emojiStyle,
      };
      logger.info({ userId: authReq.user.id, step: 'get_assistant_settings_success', settings }, 'Assistant settings loaded');
      res.json({ success: true, exists: true, settings });
    } catch (error) {
      logger.error({ err: error, step: 'get_assistant_settings_error' }, 'Failed to fetch assistant settings');
      res.status(500).json({ error: 'internal_error', message: 'Failed to fetch assistant settings' });
    }
  });

  router.post('/settings/assistant', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const { tone, mood, responseLength, emojiStyle } = req.body || {};
      const now = new Date().toISOString();
      const settings = {
        tone: typeof tone === 'string' && tone.trim() ? tone.trim() : DEFAULT_CHAT_SETTINGS.tone,
        mood: typeof mood === 'string' && mood.trim() ? mood.trim() : DEFAULT_CHAT_SETTINGS.mood,
        responseLength:
          typeof responseLength === 'string' && responseLength.trim()
            ? responseLength.trim()
            : DEFAULT_CHAT_SETTINGS.responseLength,
        emojiStyle:
          typeof emojiStyle === 'string' && emojiStyle.trim() ? emojiStyle.trim() : DEFAULT_CHAT_SETTINGS.emojiStyle,
      };

      logger.info({ userId: authReq.user.id, step: 'save_assistant_settings_request', settings }, 'Saving assistant settings');
      await db.collection('ChatSettings').doc(authReq.user.id).set(
        {
          userId: authReq.user.id,
          ...settings,
          updatedAt: now,
          createdAt: now,
        },
        { merge: true },
      );

      logger.info({ userId: authReq.user.id, step: 'save_assistant_settings_success' }, 'Assistant settings saved');
      res.json({ success: true, settings });
    } catch (error) {
      logger.error({ err: error, step: 'save_assistant_settings_error' }, 'Failed to save assistant settings');
      res.status(500).json({ error: 'internal_error', message: 'Failed to save assistant settings' });
    }
  });

  return router;
};
