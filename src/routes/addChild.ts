import { Router } from 'express';
import type { DocumentData, QueryDocumentSnapshot } from 'firebase-admin/firestore';
import { authenticateToken, AuthRequest } from '../middleware/authMiddleware';
import { db } from '../firebase';
import { logger } from '../utils/logger';
import { attachRouteLogger } from '../utils/routeLogger';

type ChildGender = 'Kiz' | 'Erkek';

const isValidGender = (value: unknown): value is ChildGender => value === 'Kiz' || value === 'Erkek';

export const createAddChildRouter = () => {
  const router = Router();
  attachRouteLogger(router, 'add-child');

  router.post('/', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      const { name, gender, birthDate, avatarUri } = req.body || {};
      logger.info(
        {
          userId: authReq.user.id,
          hasName: Boolean(name),
          hasGender: Boolean(gender),
          hasBirthDate: Boolean(birthDate),
          hasAvatarUri: Boolean(avatarUri),
          step: 'add_child_request_received',
        },
        'AddChild request received',
      );

      if (!name || !isValidGender(gender) || !birthDate || !avatarUri) {
        res.status(400).json({
          error: 'invalid_request',
          message: 'name, gender, birthDate and avatarUri are required',
        });
        return;
      }

      const now = new Date().toISOString();
      const payload = {
        parentUuid: authReq.user.id,
        parentEmail: authReq.user.email,
        name: String(name).trim(),
        gender,
        birthDate: String(birthDate).trim(),
        avatarUri: String(avatarUri).trim(),
        createdAt: now,
        updatedAt: now,
      };

      const ref = await db.collection('AddChild').add(payload);
      const child = { id: ref.id, ...payload };
      logger.info(
        { userId: authReq.user.id, childId: ref.id, childName: payload.name, step: 'add_child_saved' },
        'AddChild saved to Firebase',
      );
      res.json({ success: true, child });
    } catch (error) {
      logger.error({ err: error, step: 'add_child_error' }, 'AddChild failed');
      res.status(500).json({ error: 'internal_error', message: 'AddChild failed' });
    }
  });

  router.get('/', authenticateToken, async (req, res) => {
    try {
      const authReq = req as AuthRequest;
      if (!authReq.user) {
        res.status(401).json({ error: 'access_denied', message: 'Authentication required' });
        return;
      }

      logger.info({ userId: authReq.user.id, step: 'list_children_request_received' }, 'List children request received');
      const snapshot = await db
        .collection('AddChild')
        .where('parentUuid', '==', authReq.user.id)
        .get();

      const children = snapshot.docs
        .map((doc: QueryDocumentSnapshot<DocumentData>) => ({
          id: doc.id,
          ...(doc.data() as any),
        }))
        .sort((a: any, b: any) => {
          const aTs = typeof a?.createdAt === 'string' ? Date.parse(a.createdAt) : 0;
          const bTs = typeof b?.createdAt === 'string' ? Date.parse(b.createdAt) : 0;
          return bTs - aTs;
        });
      logger.info(
        { userId: authReq.user.id, childrenCount: children.length, step: 'list_children_success' },
        'Children list loaded',
      );
      res.json({ success: true, children });
    } catch (error) {
      logger.error({ err: error, step: 'list_children_error' }, 'List children failed');
      res.status(500).json({ error: 'internal_error', message: 'List children failed' });
    }
  });

  return router;
};

