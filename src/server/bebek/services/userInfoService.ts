import { db } from '../../../firebase';
import { DEFAULT_TIMEZONE } from '../utils/timezone';
import { logger } from '../../../utils/logger';

export interface UserInfo {
  id: string;
  email?: string;
  name?: string;
  gender?: 'male' | 'female' | 'other';
  birth_date?: string;
  height_cm?: number;
  current_weight_kg?: number;
  target_weight_kg?: number;
  activity_level?: 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
  goal?: 'lose' | 'maintain' | 'gain';
  language?: 'tr' | 'en';
  timezone?: string;
  onboarding_completed?: boolean;
  onboarding_device_id?: string;
  onboarding_completed_at?: string;
  created_at?: string;
  updated_at?: string;
}

export const getUserInfo = async (userId: string): Promise<UserInfo | null> => {
  const snapshot = await db.collection('users_info').doc(userId).get();
  if (!snapshot.exists) {
    return null;
  }
  const data = snapshot.data() || {};
  return {
    id: snapshot.id,
    ...data
  } as UserInfo;
};

export const ensureUserInfo = async (userId: string, fallback: Partial<UserInfo> = {}): Promise<UserInfo> => {
  const existing = await getUserInfo(userId);
  if (existing) {
    return {
      ...existing,
      timezone: existing.timezone || DEFAULT_TIMEZONE,
      language: existing.language || 'tr'
    };
  }

  const now = new Date().toISOString();
  const userInfo: UserInfo = {
    id: userId,
    name: fallback.name,
    email: fallback.email,
    timezone: fallback.timezone || DEFAULT_TIMEZONE,
    language: fallback.language || 'tr',
    goal: fallback.goal || 'maintain',
    activity_level: fallback.activity_level || 'sedentary',
    created_at: now,
    updated_at: now
  };

  await db.collection('users_info').doc(userId).set(userInfo, { merge: true });
  logger.info({ userId }, 'users_info created with defaults');
  return userInfo;
};

export const updateUserInfo = async (userId: string, updates: Partial<UserInfo>): Promise<UserInfo> => {
  const now = new Date().toISOString();
  await db.collection('users_info').doc(userId).set({ ...updates, updated_at: now }, { merge: true });
  const updated = await getUserInfo(userId);
  return updated || {
    id: userId,
    ...updates,
    updated_at: now,
    timezone: updates.timezone || DEFAULT_TIMEZONE,
    language: updates.language || 'tr'
  };
};

