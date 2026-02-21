import { Router } from 'express';
import { authenticateToken, AuthRequest } from '../middleware/authMiddleware';
import { db } from '../firebase';
import { ensureUserInfo } from '../server/bebek/services/userInfoService';
import {
  createChildChatSession,
  deleteChatSession,
  handleChatMessage,
  handleChatMessageStream,
  listChatMessages,
  listChatSessions,
  renameChatSession,
} from '../server/bebek/services/chatService';
import { logger } from '../utils/logger';
import { attachRouteLogger } from '../utils/routeLogger';

const DEFAULT_CHAT_SETTINGS = {
  tone: 'varsayilan',
  mood: 'neseli',
  responseLength: 'dengeli',
  emojiStyle: 'dengeli',
};

const normalizeAssistantSettingValue = (value: unknown, fallback: string) => {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim();
  return normalized || fallback;
};

const normalizeAssistantSettingsInput = (payload: any) => {
  const toneRaw = normalizeAssistantSettingValue(payload?.tone, DEFAULT_CHAT_SETTINGS.tone).toLowerCase();
  const moodRaw = normalizeAssistantSettingValue(payload?.mood, DEFAULT_CHAT_SETTINGS.mood).toLowerCase();
  const responseLengthRaw = normalizeAssistantSettingValue(
    payload?.responseLength,
    DEFAULT_CHAT_SETTINGS.responseLength,
  ).toLowerCase();
  const emojiStyleRaw = normalizeAssistantSettingValue(payload?.emojiStyle, DEFAULT_CHAT_SETTINGS.emojiStyle).toLowerCase();

  const toneMap: Record<string, string> = {
    default: 'varsayilan',
    varsayilan: 'varsayilan',
    'varsayılan': 'varsayilan',
    friendly: 'cana_yakin',
    cana_yakin: 'cana_yakin',
    buddy: 'arkadas_gibi',
    arkadas_gibi: 'arkadas_gibi',
    inspiring: 'ilham_verici',
    ilham_verici: 'ilham_verici',
    joyful: 'neseli',
    neseli: 'neseli',
    'neşeli': 'neseli',
    listener: 'iyi_dinleyici',
    iyi_dinleyici: 'iyi_dinleyici',
    concise: 'net_ve_kisa',
    net_ve_kisa: 'net_ve_kisa',
    formal: 'profesyonel',
    profesyonel: 'profesyonel',
  };
  const moodMap: Record<string, string> = {
    cheerful: 'neseli',
    neseli: 'neseli',
    'neşeli': 'neseli',
    calm: 'sakin',
    sakin: 'sakin',
    playful: 'oyuncu',
    oyuncu: 'oyuncu',
    serious: 'ciddi',
    ciddi: 'ciddi',
    angry: 'sinirli',
    sinirli: 'sinirli',
    'sinirli ': 'sinirli',
  };
  const responseMap: Record<string, string> = {
    short: 'kisa',
    kisa: 'kisa',
    'kısa': 'kisa',
    balanced: 'dengeli',
    dengeli: 'dengeli',
    detailed: 'detayli',
    detayli: 'detayli',
    'detaylı': 'detayli',
  };
  const emojiMap: Record<string, string> = {
    none: 'emoji_yok',
    yok: 'emoji_yok',
    emoji_yok: 'emoji_yok',
    some: 'dengeli',
    dengeli: 'dengeli',
    rich: 'bol_emoji',
    bol_emoji: 'bol_emoji',
  };

  return {
    tone: toneMap[toneRaw] || DEFAULT_CHAT_SETTINGS.tone,
    mood: moodMap[moodRaw] || DEFAULT_CHAT_SETTINGS.mood,
    responseLength: responseMap[responseLengthRaw] || DEFAULT_CHAT_SETTINGS.responseLength,
    emojiStyle: emojiMap[emojiStyleRaw] || DEFAULT_CHAT_SETTINGS.emojiStyle,
  };
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

  router.delete('/sessions/:id', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }
      const sessionId = String(req.params.id || '').trim();
      if (!sessionId) {
        res.status(400).json({ error: 'invalid_request', message: 'session id is required' });
        return;
      }

      const result = await deleteChatSession(authReq.user.id, sessionId);
      if (!result.deleted && result.reason === 'not_found') {
        res.status(404).json({ error: 'not_found', message: 'Session not found' });
        return;
      }
      if (!result.deleted && result.reason === 'forbidden') {
        res.status(403).json({ error: 'forbidden', message: 'Session does not belong to user' });
        return;
      }
      res.json({ success: true, id: sessionId, messagesDeleted: result.messagesDeleted || 0 });
    } catch (error) {
      logger.error({ err: error }, 'Failed to delete chat session');
      res.status(500).json({ error: 'internal_error', message: 'Failed to delete chat session' });
    }
  });

  router.patch('/sessions/:id/title', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }
      const sessionId = String(req.params.id || '').trim();
      const title = String(req.body?.title || '').trim();
      if (!sessionId || !title) {
        res.status(400).json({ error: 'invalid_request', message: 'session id and title are required' });
        return;
      }

      const result = await renameChatSession(authReq.user.id, sessionId, title);
      if (!result.updated && result.reason === 'not_found') {
        res.status(404).json({ error: 'not_found', message: 'Session not found' });
        return;
      }
      if (!result.updated && result.reason === 'forbidden') {
        res.status(403).json({ error: 'forbidden', message: 'Session does not belong to user' });
        return;
      }
      res.json({ success: true, id: sessionId, title });
    } catch (error) {
      logger.error({ err: error }, 'Failed to rename chat session');
      res.status(500).json({ error: 'internal_error', message: 'Failed to rename chat session' });
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
      const settings = normalizeAssistantSettingsInput(data);
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

      const now = new Date().toISOString();
      const settings = normalizeAssistantSettingsInput(req.body || {});

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
